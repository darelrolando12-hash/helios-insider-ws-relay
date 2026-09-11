/**
 * chartBarsBackfill — real historical bars for HeliosChart, sourced from
 * Massive's NATIVE aggregates endpoint.
 *
 * ── What changed, and why (2026-09-05) ────────────────────────────────────
 * This module previously read raw 1-minute rows out of Supabase `bars_1m`
 * and let the chart re-aggregate all of history client-side on every ticker
 * or timeframe switch. Massive aggregates natively — /v2/aggs/ticker/{t}/
 * range/{multiplier}/{timespan}/... returns genuinely pre-computed 5m/15m/
 * 1h bars — so the rollup of historical data now happens server-side, at
 * the source, with Massive's own tested math.
 *
 * Two real wins beyond the arithmetic:
 *   1. It drops the chart's dependency on `bars1mIngestion` having run and
 *      being current. Supabase `bars_1m` is a DERIVED copy; Massive is the
 *      authoritative source and is always up to date. A chart that renders
 *      only as well as the last ingestion pass is a silent-staleness trap.
 *   2. Far less data over the wire at coarse intervals — a real 2-day SPY
 *      window is 1698 one-minute rows vs 32 one-hour bars for the same span.
 *
 * ── Two sources, deliberately, and the real reason ────────────────────────
 * `displayBars` (native aggregates at the selected interval) feeds candles
 * and the EMA stack. `minuteBars` (always 1-minute, regardless of the
 * selected interval) feeds VWAP and nothing else.
 *
 * That split is not redundancy — it is what makes VWAP interval-invariant.
 * VWAP is cumulative from the session open, so a point plotted at 14:00 on
 * a 1h chart necessarily includes a full hour of trades, while the 14:00
 * point on a 5m chart includes five minutes. Computed from the DISPLAYED
 * bars, the two would legitimately disagree at the same timestamp. Pinning
 * VWAP to a fixed 1-minute series makes it identical at every interval by
 * construction — see _computeVwapSeries in HeliosChart.tsx.
 *
 * ── The historical/live seam ──────────────────────────────────────────────
 * Verified live (2026-09-05), not assumed: when the requested range ends
 * mid-bucket, Massive DOES return a bar for the bucket containing `to`.
 * Queried against past data that bucket comes back complete (it aggregates
 * the whole period, including trades after `to`) — but during a live
 * session, where no trades past `now` exist yet, the same bucket can only
 * contain data up to now: a still-forming bar wearing a completed bar's
 * clothes. dropFormingBucket() below removes it unconditionally, so the
 * currently-forming candle is ALWAYS built from the live WS stream and
 * never from a half-baked historical one. Correct either way, without
 * depending on which behaviour a given query happens to hit.
 */

import { MassiveRestClient } from './massive/api';
import type { AggTimespan } from './massive/api';
import { ready, error, type Result } from '../stores/types';
import { INTERVAL_MINUTES, type ChartInterval } from './aggregateBars';
import { toCentralTime, toCTMidnight } from './time';
import type { Bar } from '../stores/types';

/**
 * Real (multiplier, timespan) pair per chart interval, each one live-verified
 * against the real endpoint — see AggTimespan's comment in massive/api.ts for
 * the per-granularity bar counts, t-deltas and alignment checks.
 *
 * 1h is `1/hour`, deliberately NOT `60/minute`: `hour` is the native timespan
 * for that bucket width, and it is the pair that was actually verified.
 */
const INTERVAL_TO_AGG: Record<ChartInterval, { multiplier: number; timespan: AggTimespan }> = {
  '1m':  { multiplier: 1,  timespan: 'minute' },
  '5m':  { multiplier: 5,  timespan: 'minute' },
  '15m': { multiplier: 15, timespan: 'minute' },
  '1h':  { multiplier: 1,  timespan: 'hour'   },
  '1d':  { multiplier: 1,  timespan: 'day'    },
};

// ── Daily bars — three real conventions, each measured, not assumed ──────────
//
// Captured 2026-09-10 against the real endpoint (1/day and 1/minute for the
// same session, rolled up both ways):
//
//   SPY 2026-09-09  daily   o 764.08  h 764.47  l 760.94  c 762.40
//                   RTH 1m  o 764.08  h 764.47  l 760.94  c 762.34  (390 bars, 08:30–14:59 CT)
//                   all 1m  o 766.82  h 767.13  l 760.94  c 763.14  (862 bars, 03:00–18:59 CT)
//   TSLA 2026-09-09 daily   o 368.25  h 375.44  l 366.00  c 367.81
//                   RTH 1m  o 368.25  h 375.44  l 366.00  c 367.80
//                   all 1m  o 368.29  h 375.44  l 363.70  c 367.22
//
// 1. A daily bar's OHLC is the REGULAR SESSION, not the extended-hours day
//    the minute bars cover. Open/high/low match the RTH roll-up exactly on
//    every sample; close is the official closing print (cents off the last
//    RTH minute's close). So today's still-forming daily candle must be rolled
//    from regular-session minutes only — rolled from every minute, SPY's
//    09-09 candle would have opened at 766.82 instead of 764.08, and TSLA's
//    low would read 363.70 instead of 366.00. See regularSessionOnly.
//
// 2. A daily bar is stamped at MIDNIGHT EASTERN (t = 2026-09-09T04:00:00Z).
//    Read through toCentralTime that is 23:00 CT on the 8th — the previous
//    day. Left alone, every historical daily candle would be keyed one day
//    early, and today's live-rolled candle (bucketed at CT midnight) would
//    never dedupe against Massive's own bar for the same day: the chart would
//    draw each day twice. See normalizeDailyBars.
//
// 3. `vw` is present on daily bars but is deliberately NOT used: it is a
//    different VWAP definition from the chart's (it includes prints that
//    never update OHLC). See plotVwap in HeliosChart's updateChartData.

/**
 * NYSE regular session, 9:30 AM – 4:00 PM ET = 8:30 AM – 3:00 PM CT, as
 * minutes from CT midnight. Eastern and Central share DST transitions, so the
 * offset is a constant one hour — the same source CLAUDE.md cites for
 * DEFAULT_FORCED_CLOSE (verified 2026-08-31). Also confirmed in the data
 * above: the RTH roll-up that matches Massive's daily bar exactly is the
 * 390 minutes from 08:30 to 14:59 CT.
 *
 * Regular schedule only. Early closes (1:00 PM ET) and holidays are not
 * modelled anywhere in this system — CLAUDE.md's known gap, inherited here.
 */
export const REGULAR_OPEN_CT_MIN  = 8 * 60 + 30; // 08:30 CT
export const REGULAR_CLOSE_CT_MIN = 15 * 60;     // 15:00 CT

const DAY_MS = 86_400_000;

/**
 * Re-key Massive daily bars onto the CT calendar-day frame every other
 * series in the chart uses. See convention 2 above.
 *
 * The UTC calendar date of the midnight-ET stamp IS the trading date (04:00Z
 * under EDT, 05:00Z under EST — the same UTC date either way), and
 * Date.UTC(that date) is exactly the key aggregateBars gives a CT-midnight
 * bucket (floor(tCT / day) * day). Pure and exported for direct testing.
 */
export function normalizeDailyBars(bars: Bar[]): Bar[] {
  return bars.map((b) => ({ ...b, tCT: Math.floor(b.tUtc / DAY_MS) * DAY_MS }));
}

/**
 * Drop today's daily bar while today's regular session is still running.
 *
 * The daily counterpart of dropFormingBucket. That one compares UTC bucket
 * boundaries, which is wrong for days: a daily bucket is keyed by trading
 * date (see normalizeDailyBars), and the candle is still forming until the
 * 15:00 CT close, not until any midnight. Mid-session, Massive's bar for today
 * is a partial — the live 1-minute stream builds today's candle instead, the
 * same principle as every other interval. After the close the bar is
 * complete and kept, so it wins over the live roll-up on overlap (see
 * _mergeDisplayBars) and today shows the official closing print.
 */
export function dropUnsettledDailyBar(bars: Bar[], nowMs: number): Bar[] {
  const ct = toCentralTime(nowMs);
  if (ct.hour * 60 + ct.minute >= REGULAR_CLOSE_CT_MIN) return bars;
  const todayKey = Date.UTC(ct.year, ct.month - 1, ct.day);
  return bars.filter((b) => b.tCT < todayKey);
}

/**
 * Keep only regular-session 1-minute bars (08:30 ≤ CT < 15:00). The input to
 * aggregateBars(…, '1d') for the live daily candle — see convention 1 above.
 *
 * tCT is a CT pseudo-epoch, so the time of day is read with UTC methods
 * (the same rule as the chart's tickMarkFormatter); re-converting through
 * toCentralTime would apply the offset twice.
 */
export function regularSessionOnly(bars: readonly Bar[]): Bar[] {
  return bars.filter((b) => {
    const minuteOfDay = Math.floor((b.tCT % DAY_MS) / 60_000);
    return minuteOfDay >= REGULAR_OPEN_CT_MIN && minuteOfDay < REGULAR_CLOSE_CT_MIN;
  });
}

/** Shared client — default constructor targets the relay's REST proxy, which
 *  injects the Massive API key server-side. The browser never holds a key. */
const _client = new MassiveRestClient();

export interface ChartBackfill {
  /** Native aggregates at the selected interval — candles + EMA. */
  displayBars: Bar[];
  /** Always 1-minute, whatever the interval — VWAP only. See header. */
  minuteBars:  Bar[];
}

/**
 * Drop any bar belonging to the bucket that is still forming at `nowMs`.
 *
 * Pure and exported for direct testing. Compares against the real bucket
 * boundary (bucketStart = floor(t / bucketMs) * bucketMs) computed on the
 * UTC epoch — verified live that Massive's own bucket starts are exact
 * multiples of the interval in BOTH the UTC and CT frames (the CT offset is
 * a whole number of hours, hence a multiple of 5/15/60 minutes), so this
 * boundary agrees with aggregateBars.ts's client-side CT bucketing and the
 * historical/live join lands seamlessly rather than a bucket off.
 */
export function dropFormingBucket(bars: Bar[], bucketMs: number, nowMs: number): Bar[] {
  const formingBucketStart = Math.floor(nowMs / bucketMs) * bucketMs;
  return bars.filter((b) => b.tUtc < formingBucketStart);
}

/**
 * Every 1-minute bar of the most recent session that has any — the session
 * a VWAP read "now" belongs to (VWAP resets at CT midnight; see
 * _computeVwapSeries in HeliosChart).
 *
 * Why this exists — measured 2026-09-10, market closed, SPY, last bar 18:59
 * CT. The 1m chart computed VWAP from the 500-bar live buffer alone, which by
 * then began at 10:07 CT, so the opening hours were simply missing:
 *
 *   chart legend at 1m, 18:59     758.23
 *   chart legend at 5m, 18:59     758.30
 *   Massive, all 860 minutes      758.3046   <- the real session VWAP
 *   Massive, last 500 minutes     758.2335   <- exactly what 1m showed
 *
 * The 5m/15m/1h backfill already carried full sessions, so only 1m (and the
 * new 1D view, which has no multi-day minute fetch) were affected — and
 * silently: 758.23 is a perfectly plausible VWAP.
 *
 * Four calendar days back reaches Friday from anywhere in a weekend with a
 * holiday to spare; at ~900 bars a day that is one page. Keeping only the
 * newest CT date present means a weekend returns Friday, and a weekday
 * returns today (pre-market included) once today has a single bar.
 */
async function _fetchLatestSessionMinutes(ticker: string, toMs: number): Promise<Bar[]> {
  // toCTMidnight is a pseudo-epoch — Date.UTC(CT date) — and _fetchBarRange
  // reads nothing from it but its UTC calendar date, i.e. the CT date.
  const fromMs = toCTMidnight(toMs) - 4 * DAY_MS;
  const bars = dropFormingBucket(
    await _client.fetchAggregateBars(ticker, 1, 'minute', fromMs, toMs),
    60_000,
    toMs,
  );
  if (bars.length === 0) return [];
  const dayOf = (b: Bar) => Math.floor(b.tCT / DAY_MS) * DAY_MS;
  const latest = dayOf(bars[bars.length - 1]);
  return bars.filter((b) => dayOf(b) === latest);
}

/**
 * Fetch real historical bars for `ticker` over [fromMs, toMs] at `interval`.
 *
 * Result<ChartBackfill> — the same discriminated union every other real query
 * in this codebase uses. A fetch failure is distinguishable from a genuine
 * empty range (a ticker with no real history in this window).
 */
export async function fetchChartBackfill(
  ticker:   string,
  interval: ChartInterval,
  fromMs:   number,
  toMs:     number,
): Promise<Result<ChartBackfill>> {
  const agg      = INTERVAL_TO_AGG[interval];
  const bucketMs = INTERVAL_MINUTES[interval] * 60_000;

  const attempt = async () => {
    if (interval === '1m') {
      // The latest session's minutes, as both the VWAP source (see
      // _fetchLatestSessionMinutes) and the candles' history. They used to be
      // VWAP-only, with the candles taken from the live buffer alone — which
      // is empty after a reload between ~01:30 CT and the 03:00 CT feed
      // start (barsStore's cold start asks for a date that has no bars yet).
      // Seen 2026-09-11 02:09 CT: META at 1m read "Waiting for bars…" and the
      // Key Levels VWAP was "—" over a session Massive had in full.
      const minutes = await _fetchLatestSessionMinutes(ticker, toMs);
      return ready({ displayBars: minutes, minuteBars: minutes }, toMs);
    }

    if (interval === '1d') {
      // Minutes for the latest session only. They build today's forming
      // candle and the session VWAP the Key Levels card shows; every earlier
      // day already has Massive's own settled bar. A year of 1-minute bars
      // (~220k) would be fetched only to be thrown away.
      const [dailyRaw, minuteBars] = await Promise.all([
        _client.fetchAggregateBars(ticker, 1, 'day', fromMs, toMs),
        _fetchLatestSessionMinutes(ticker, toMs),
      ]);
      return ready(
        {
          displayBars: dropUnsettledDailyBar(normalizeDailyBars(dailyRaw), toMs),
          minuteBars,
        },
        toMs,
      );
    }

    // 5m / 15m / 1h (1m and 1d returned above).
    const [displayRaw, minuteRaw] = await Promise.all([
      _client.fetchAggregateBars(ticker, agg.multiplier, agg.timespan, fromMs, toMs),
      _client.fetchAggregateBars(ticker, 1, 'minute', fromMs, toMs),
    ]);

    return ready(
      {
        displayBars: dropFormingBucket(displayRaw, bucketMs, toMs),
        // The minute series feeds VWAP only; its own forming 1-minute bar is
        // dropped on the same principle, and the live buffer supplies it.
        minuteBars:  dropFormingBucket(minuteRaw, 60_000, toMs),
      },
      toMs,
    );
  };

  // Real failure caught live (2026-09-09), not hypothetical: a QQQ 1h
  // backfill died on `MassiveREST timeout after 25s` against
  // /rest/v2/aggs/ticker/QQQ/range/1/hour/2026-08-23/2026-09-09, while the
  // relay was concurrently timing out chainAggregator polls for SPY, SPX,
  // NDX, IWM and AAPL. The chart's own fallback then rendered the 7-bar live
  // edge alone — which is what produced the "1h draws a white line with two
  // candles and no EMA values" report: 7 bars cannot seed EMA8/21/55 (they
  // need 8/21/55), while VWAP still drew from the separate 1-minute live
  // buffer. So the visible bug was never a rendering fault; it was this
  // timeout, swallowed silently.
  //
  // One bounded retry, because that timeout is transient relay-load, not a
  // bad request — the identical URL succeeds on a quiet relay (verified live
  // in the same session: 182 real 1h bars). CLAUDE.md's REST budget is
  // "unlimited, stay under 100 req/sec" against a real ~1/sec, so a single
  // extra attempt is well inside it. Deliberately NOT an unbounded retry
  // loop: if the relay is genuinely down, failing honestly and letting the
  // caller surface that beats hammering it.
  const RETRY_DELAY_MS = 1_500;
  try {
    return await attempt();
  } catch (firstError) {
    const firstReason = firstError instanceof Error ? firstError.message : String(firstError);
    console.warn(`[chartBarsBackfill] ${ticker} @ ${interval}: first attempt failed, retrying once in ${RETRY_DELAY_MS}ms — ${firstReason}`);
    await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
    try {
      return await attempt();
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      return error(`chartBarsBackfill: aggregates fetch failed for ${ticker} @ ${interval} after 2 attempts — ${reason}`);
    }
  }
}
