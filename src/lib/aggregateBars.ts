/**
 * aggregateBars — browser copy of relay/engine/lib/chartBars.ts's real
 * rollup/bucketing logic.
 *
 * A tracked, deliberate duplicate — same pattern as chartWindow.ts (which
 * already ports computeChartBackfillWindow from the same real source file).
 * Kept in its own file rather than added to chartWindow.ts because that
 * file's own header explicitly scopes itself to one function; this one
 * covers the interval-rollup half of the same real source instead.
 *
 * Real source of truth: relay/engine/lib/chartBars.ts. If aggregateBars'
 * or groupByTimeBucket's real formula ever changes there, this copy must
 * change with it.
 */

import type { Bar } from '../stores/types';

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
 * `getTimeMs` to read each item's timestamp. Generic over `T` — used here
 * for both Bar rollup (aggregateBars) and signal-marker clustering
 * (markerClustering.ts), matching the server-side original's own stated
 * purpose of staying reusable beyond just bars.
 *
 * Buckets by real elapsed wall-clock time (floor(t / bucketMs) * bucketMs),
 * NOT by counting every N raw items — a real gap in the source data (e.g. a
 * halted ticker missing a minute) produces one under-filled bucket rather
 * than silently drifting every later bucket's alignment off the true
 * wall-clock boundary.
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
 * Roll 1-minute bars up into `interval`-wide candles. Bucketed by tCT
 * (Central-time pseudo-epoch) — interval boundaries are a wall-clock/
 * session concept, not a UTC one.
 *
 * `interval: '1m'` is a real, tested identity passthrough.
 *
 * Per-bucket OHLCV: open = first bar's open, close = last bar's close,
 * high/low = max/min of the group, volume = sum. vwap/transactions only
 * recombine when every source bar in the group has one — partial data
 * producing a confidently-wrong number is worse than an honest undefined.
 *
 * A trailing partial group (end of available data, or an early close) is
 * included as-is — bucketing by real wall-clock time means this needs no
 * special-case detection.
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
    tUtc: first.tUtc,
  };
}
