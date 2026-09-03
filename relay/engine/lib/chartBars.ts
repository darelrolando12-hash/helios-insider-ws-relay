/**
 * chartBars — pure, portable chart data-transform logic.
 *
 * The real gap this closes: the chart currently only accumulates bars from
 * the live WebSocket feed during an open session, with no REST/DB backfill
 * on load. Confirmed live, market closed, 2026-09-02: opening the app right
 * now shows zero bars — not stale-looking, genuinely empty. A real trading
 * chart shows the last complete session in full the moment it loads, live
 * feed or not, the same way a real broker shows Friday's full session over
 * a closed weekend.
 *
 * This module is intentionally free of store reads, REST calls, and any
 * framework dependency — every function is pure and takes its inputs
 * explicitly, matching the same contract as catalystGate.ts and
 * newsSentimentGate.ts (stateless, no store reads, no event emission) so it
 * can be fully unit-tested here and ported byte-for-byte into the browser's
 * HeliosChart without behavior drift. This is durable, timeless
 * infrastructure — unlike the scoring engines (which get deleted from the
 * browser wholesale at cutover), the same aggregation math is correct
 * whether it runs client-side today or server-side after cutover.
 *
 * ── Data source, resolved (not left as an open question) ──────────────────
 * bars_1m already holds up to 2 years of real, persisted 1-minute history
 * (bars1mIngestion.ts) and bars_daily already holds 5 years of daily bars
 * (barsIngestion.ts) — both real Supabase tables. Supabase's PostgREST layer
 * auto-generates a ranged-query REST API for every table with zero custom
 * endpoint work: `.eq('ticker', t).gte('t_utc', from).lte('t_utc', to)`.
 * No new endpoint is needed for either intraday or daily backfill — the
 * infrastructure already exists and already supports this.
 *
 * ── 1D is out of scope here, on purpose ─────────────────────────────────
 * bars_daily is a separate, already-real table — reconstructing a daily
 * candle from ~390 one-minute bars would be strictly worse (lossy on
 * pre/post-market activity bars_1m may not even retain at MAX_BARS_PER_TICKER
 * limits server-side, and far more data to move) than fetching the one real
 * daily row that already exists. ChartInterval below deliberately has no
 * '1D' member — a caller wanting a daily candle should query bars_daily
 * directly, not call aggregateBars().
 *
 * ── A real gap found while building this, fixed alongside it ──────────────
 * Both bars1mIngestion.ts's runBars1mBackfill and barsIngestion.ts's
 * runBarsDailyBackfill were wired laterOnce-only in index.ts — no periodic
 * refresh, identical bug shape already fixed twice this session (short
 * interest, ratios). A relay that runs for days without a redeploy would
 * silently stop persisting new bars, and this chart feature would silently
 * inherit that staleness one layer up. Fixed in the same commit as this
 * file — see index.ts's two new everyInterval(..., 24h) calls.
 */

import type { Bar } from '../stores/types.ts';

// ── Interval types ────────────────────────────────────────────────────────────

export type ChartInterval = '1m' | '5m' | '15m' | '1h';

/** Bucket width in minutes for each supported interval. */
export const INTERVAL_MINUTES: Readonly<Record<ChartInterval, number>> = {
  '1m': 1,
  '5m': 5,
  '15m': 15,
  '1h': 60,
};

// ── Generic time-bucketing core ─────────────────────────────────────────────

/**
 * Group `items` into consecutive buckets of `bucketMs` width, using
 * `getTimeMs` to read each item's timestamp. Deliberately generic over `T` —
 * not `Bar`-specific — so a future raw-tick aggregator (the structureEngine
 * roadmap item: tick-by-tick storage removing the "can only build larger
 * candles, never smaller than 1-minute" ceiling) can reuse this exact
 * grouping primitive without redesigning it. aggregateBars() below is the
 * only Bar-specific layer on top of this.
 *
 * Buckets by real elapsed wall-clock time (floor(t / bucketMs) * bucketMs),
 * NOT by counting every N raw items — this is the part that makes gaps safe.
 * If items arrive with a real gap (e.g. a halted ticker missing a minute),
 * naive "chunk every N" grouping would silently drift every subsequent
 * bucket's alignment off the true wall-clock boundary. Time-bucketing instead
 * just produces a bucket with fewer real items for that slot; every later
 * bucket stays correctly aligned regardless of what happened before it.
 */
export function groupByTimeBucket<T>(
  items: readonly T[],
  bucketMs: number,
  getTimeMs: (item: T) => number,
): T[][] {
  const buckets = new Map<number, T[]>();
  for (const item of items) {
    const bucketStart = Math.floor(getTimeMs(item) / bucketMs) * bucketMs;
    const group = buckets.get(bucketStart);
    if (group) {
      group.push(item);
    } else {
      buckets.set(bucketStart, [item]);
    }
  }
  return Array.from(buckets.keys())
    .sort((a, b) => a - b)
    .map((k) => buckets.get(k)!);
}

// ── aggregateBars ─────────────────────────────────────────────────────────────

/**
 * Roll 1-minute bars up into `interval`-wide candles.
 *
 * Bucketed by tCT (Central-time pseudo-epoch), not tUtc — Bar's own doc
 * comment is explicit that chart-axis code must use tCT, never tUtc, and
 * interval boundaries (a real 5-minute candle starting at 9:30, 9:35, ...)
 * are a wall-clock/session concept, not a UTC one.
 *
 * `interval: '1m'` is a real, tested identity passthrough — a caller that
 * always calls aggregateBars() regardless of the user's selected interval
 * doesn't need a special case for the 1-minute view.
 *
 * Per-bucket OHLCV:
 *   open   = first bar's open (by time within the bucket)
 *   close  = last bar's close
 *   high   = max of the group's highs
 *   low    = min of the group's lows
 *   volume = sum of the group's volumes
 *   vwap   = volume-weighted recombination (sum(vwap_i * volume_i) / sum(volume_i))
 *            ONLY when every source bar in the group has a real vwap —
 *            partial data producing a confidently-wrong number is worse
 *            than an honest `undefined`, same reasoning as every
 *            dataQuality decision elsewhere in this codebase.
 *   transactions = sum, same all-or-nothing rule as vwap.
 *
 * A trailing partial group (fewer than the full interval's worth of source
 * bars — end of available data, or a session that closed early) is included
 * as-is, not dropped and not padded. Because bucketing is by real wall-clock
 * time rather than raw item count, this requires no special-case detection:
 * whatever bars exist for that bucket's real time window are the real
 * candle for that window, whether the source data stopped because "that's
 * all we have yet" or "the exchange actually closed early that day."
 */
export function aggregateBars(bars: readonly Bar[], interval: ChartInterval): Bar[] {
  if (bars.length === 0) return [];
  if (interval === '1m') return [...bars];

  const bucketMs = INTERVAL_MINUTES[interval] * 60_000;
  const sorted = [...bars].sort((a, b) => a.tCT - b.tCT);
  const groups = groupByTimeBucket(sorted, bucketMs, (b) => b.tCT);

  return groups.map((group) => _mergeGroup(group, bucketMs));
}

function _mergeGroup(group: Bar[], bucketMs: number): Bar {
  const first = group[0];
  const last = group[group.length - 1];

  let high = -Infinity;
  let low = Infinity;
  let volume = 0;
  let vwapNumerator = 0;
  let allHaveVwap = true;
  let transactions = 0;
  let allHaveTransactions = true;

  for (const b of group) {
    if (b.high > high) high = b.high;
    if (b.low < low) low = b.low;
    volume += b.volume;

    if (b.vwap !== undefined) {
      vwapNumerator += b.vwap * b.volume;
    } else {
      allHaveVwap = false;
    }

    if (b.transactions !== undefined) {
      transactions += b.transactions;
    } else {
      allHaveTransactions = false;
    }
  }

  const bucketStartCT = Math.floor(first.tCT / bucketMs) * bucketMs;

  return {
    ticker: first.ticker,
    open: first.open,
    high,
    low,
    close: last.close,
    volume,
    vwap: allHaveVwap && volume > 0 ? vwapNumerator / volume : undefined,
    transactions: allHaveTransactions ? transactions : undefined,
    tCT: bucketStartCT,
    // tUtc has no equivalent "reconstruct from components" path the way ctMs
    // does (see time.ts) — the first source bar's real tUtc is the honest
    // origin timestamp for this bucket's start, same "bar timestamp = bar
    // start" convention already used throughout this codebase.
    tUtc: first.tUtc,
  };
}

// ── Backfill window ────────────────────────────────────────────────────────────

/**
 * Compute the real [fromMs, toMs] UTC range to query bars_1m over, given a
 * target number of real TRADING days of lookback (not calendar days).
 *
 * Converts trading days to a calendar-day range with real margin: 5 trading
 * days span 7 calendar days including a weekend (a 7/5 ratio), so a naive
 * same-number lookback would under-fetch by up to 2 days depending on which
 * weekday `nowMs` falls on. This deliberately over-fetches rather than risk
 * under-covering — bars_1m simply has no rows for non-trading days, so a
 * wider calendar window costs an empty query range, not wrong data.
 *
 * Does NOT know about market holidays — same documented, deliberate gap as
 * every other schedule in this codebase (see CLAUDE.md's KNOWN GAPS: no
 * holiday calendar exists anywhere in the system). A holiday inside the
 * lookback window just means slightly less real data comes back than the
 * calendar math implies, the same way isFeedScheduleActive's weekday-only
 * check already tolerates. This is not a new gap introduced here — it is
 * the existing one, inherited honestly rather than silently worked around.
 *
 * `toMs` defaults to `nowMs` — this function does not attempt to find "the
 * most recently completed session's close" as a boundary. That distinction
 * is unnecessary: querying straight through to right now is correct whether
 * the market is open (the live feed will also be covering the tail) or
 * closed (bars_1m simply has no rows after the real last trade, so the
 * query naturally stops at the true last bar without needing to know that
 * in advance).
 */
export function computeChartBackfillWindow(
  nowMs: number,
  tradingDaysLookback: number = 7,
): { fromMs: number; toMs: number } {
  // Scale by the real 7/5 calendar-to-trading-day ratio, then add a fixed
  // 3-day safety margin (covers starting the lookback mid-week — worst
  // case, a Monday lookback needs to reach back through the prior weekend
  // to find its Nth prior trading day — plus one extra day of slack).
  const calendarDaysLookback = Math.ceil((tradingDaysLookback * 7) / 5) + 3;
  const fromMs = nowMs - calendarDaysLookback * 24 * 60 * 60 * 1000;
  return { fromMs, toMs: nowMs };
}

// ── Live-feed handoff ────────────────────────────────────────────────────────

/**
 * Append a live WebSocket bar onto backfilled history, producing one
 * seamless series rather than a disconnected second one.
 *
 * Mirrors barsStore.ts's own real `_appendBar` semantics exactly (same
 * dedupe-by-tUtc, update-in-place-for-the-in-progress-minute behavior) so
 * the browser's contract matches the server's already-proven logic instead
 * of inventing a second, potentially divergent one:
 *   - liveBar.tUtc > last history bar's tUtc  -> append (new bar).
 *   - liveBar.tUtc === last history bar's tUtc -> replace last bar in place
 *     (the current, still-forming minute getting updated ticks before close).
 *   - liveBar.tUtc < last history bar's tUtc  -> ignore. An out-of-order/
 *     stale live bar arriving behind the known history is a real anomaly
 *     (not an expected case — WS AM messages arrive in order), and silently
 *     inserting it out of order would corrupt a chart series that every
 *     consumer assumes is time-ascending. Dropped, not inserted.
 *
 * Returns a new array — does not mutate `history` — matching this module's
 * pure-function contract throughout.
 */
export function mergeLiveBar(history: readonly Bar[], liveBar: Bar): Bar[] {
  if (history.length === 0) return [liveBar];

  const last = history[history.length - 1];
  if (liveBar.tUtc > last.tUtc) {
    return [...history, liveBar];
  }
  if (liveBar.tUtc === last.tUtc) {
    return [...history.slice(0, -1), liveBar];
  }
  // Stale/out-of-order — ignore.
  return [...history];
}
