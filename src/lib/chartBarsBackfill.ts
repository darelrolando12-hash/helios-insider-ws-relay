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
};

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

  try {
    // At 1m the display series IS the minute series — one fetch, not two.
    const [displayRaw, minuteRaw] = interval === '1m'
      ? await (async () => {
          const b = await _client.fetchAggregateBars(ticker, 1, 'minute', fromMs, toMs);
          return [b, b] as const;
        })()
      : await Promise.all([
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
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    return error(`chartBarsBackfill: aggregates fetch failed for ${ticker} @ ${interval} — ${reason}`);
  }
}
