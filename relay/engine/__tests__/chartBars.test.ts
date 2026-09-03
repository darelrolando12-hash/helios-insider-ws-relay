/**
 * chartBars — real edge-case coverage (2026-09-03).
 *
 * The real gap this whole module exists to fix: opening the app with the
 * market closed showed zero bars — the live-feed-only chart had no REST/DB
 * backfill path at all. These tests cover the pure transform logic that
 * makes a real backfill possible: OHLCV rollup, gap tolerance, the trading-
 * day-to-calendar-day window math, and the live-feed handoff.
 */
import { describe, it, expect } from 'vitest';
import {
  aggregateBars,
  groupByTimeBucket,
  computeChartBackfillWindow,
  mergeLiveBar,
  INTERVAL_MINUTES,
} from '../lib/chartBars.ts';
import type { Bar } from '../stores/types.ts';

// Real session anchor: 2026-09-02 was a real Wednesday. 9:30 AM CT open.
const SESSION_OPEN_CT = Date.UTC(2026, 8, 2, 9, 30, 0, 0); // month is 0-indexed: 8 = September

function makeBar(minuteOffset: number, overrides: Partial<Bar> = {}): Bar {
  const tCT = SESSION_OPEN_CT + minuteOffset * 60_000;
  return {
    ticker: 'TEST',
    open: 100 + minuteOffset,
    high: 100 + minuteOffset + 0.5,
    low: 100 + minuteOffset - 0.5,
    close: 100 + minuteOffset + 0.25,
    volume: 1000,
    vwap: 100 + minuteOffset,
    transactions: 10,
    tCT,
    tUtc: tCT + 5 * 60 * 60 * 1000, // arbitrary real-looking UTC offset, not used by aggregateBars' bucketing
    ...overrides,
  };
}

describe('aggregateBars — 1m passthrough', () => {
  it('returns bars unchanged for interval 1m (identity, not a special-cased no-op)', () => {
    const bars = [makeBar(0), makeBar(1), makeBar(2)];
    const result = aggregateBars(bars, '1m');
    expect(result).toEqual(bars);
  });

  it('empty input returns empty output for every interval', () => {
    expect(aggregateBars([], '1m')).toEqual([]);
    expect(aggregateBars([], '5m')).toEqual([]);
  });
});

describe('aggregateBars — 5m real OHLCV rollup, clean data', () => {
  it('groups exactly 5 one-minute bars into 1 five-minute candle with correct OHLCV', () => {
    const bars = [0, 1, 2, 3, 4].map((i) => makeBar(i));
    const result = aggregateBars(bars, '5m');

    expect(result).toHaveLength(1);
    const candle = result[0];
    expect(candle.open).toBe(bars[0].open);       // first bar's open
    expect(candle.close).toBe(bars[4].close);     // last bar's close
    expect(candle.high).toBe(Math.max(...bars.map((b) => b.high)));
    expect(candle.low).toBe(Math.min(...bars.map((b) => b.low)));
    expect(candle.volume).toBe(5000);             // sum of 5 x 1000
    expect(candle.tCT).toBe(SESSION_OPEN_CT);      // bucket start, not first bar's own tCT necessarily (here they're equal)
  });

  it('two full 5-minute groups from 10 one-minute bars', () => {
    const bars = Array.from({ length: 10 }, (_, i) => makeBar(i));
    const result = aggregateBars(bars, '5m');
    expect(result).toHaveLength(2);
    expect(result[0].tCT).toBe(SESSION_OPEN_CT);
    expect(result[1].tCT).toBe(SESSION_OPEN_CT + 5 * 60_000);
  });

  it('real volume-weighted vwap recombination when every source bar has one', () => {
    const bars = [
      makeBar(0, { vwap: 100, volume: 100 }),
      makeBar(1, { vwap: 200, volume: 300 }),
    ];
    const result = aggregateBars(bars, '5m');
    // (100*100 + 200*300) / (100+300) = 70000/400 = 175
    expect(result[0].vwap).toBeCloseTo(175, 5);
  });

  it('transactions sum when every source bar has a value', () => {
    const bars = [makeBar(0, { transactions: 5 }), makeBar(1, { transactions: 7 })];
    const result = aggregateBars(bars, '5m');
    expect(result[0].transactions).toBe(12);
  });
});

describe('aggregateBars — real edge cases the user explicitly flagged', () => {
  it('partial group at the end of available data is included as-is, not dropped or padded', () => {
    // 7 bars: one full 5-min group + a trailing partial group of 2.
    const bars = Array.from({ length: 7 }, (_, i) => makeBar(i));
    const result = aggregateBars(bars, '5m');
    expect(result).toHaveLength(2);
    expect(result[1].tCT).toBe(SESSION_OPEN_CT + 5 * 60_000);
    // Partial candle's close is the last of the 2 real bars it actually has.
    expect(result[1].close).toBe(bars[6].close);
    expect(result[1].volume).toBe(2000); // only 2 bars' worth, not padded to 5
  });

  it('a gap in the bars (halted ticker missing a minute) does not shift later bucket alignment', () => {
    // Minutes 0-4 present, minute 5 MISSING, minutes 6-9 present.
    // Naive "chunk every 5 raw bars" would misalign bucket 2 to start at
    // real minute 6 instead of minute 5 — time-bucketing must not do that.
    const bars = [0, 1, 2, 3, 4, 6, 7, 8, 9].map((i) => makeBar(i));
    const result = aggregateBars(bars, '5m');

    expect(result).toHaveLength(2);
    // First bucket: minutes 0-4, full and correct.
    expect(result[0].tCT).toBe(SESSION_OPEN_CT);
    expect(result[0].volume).toBe(5000);
    // Second bucket: real wall-clock slot for minutes 5-9, but minute 5 is
    // missing — it must still start at the TRUE minute-5 boundary, with only
    // 4 real bars' worth of volume, not drift to start at minute 6.
    expect(result[1].tCT).toBe(SESSION_OPEN_CT + 5 * 60_000);
    expect(result[1].volume).toBe(4000); // 4 real bars, not 5 — the gap is honest, not padded
    expect(result[1].open).toBe(bars.find((b) => b.tCT === SESSION_OPEN_CT + 6 * 60_000)!.open); // first REAL bar in that slot (minute 6)
  });

  it('a session that closed early produces a real, shorter trailing candle — same mechanism as a trailing partial group', () => {
    // Early close: only the first 3 minutes of what would be a 15-minute
    // candle exist. No special-case "early close" logic is needed — the
    // time-bucketing handles it identically to "data hasn't arrived yet".
    const bars = [0, 1, 2].map((i) => makeBar(i));
    const result = aggregateBars(bars, '15m');
    expect(result).toHaveLength(1);
    expect(result[0].open).toBe(bars[0].open);
    expect(result[0].close).toBe(bars[2].close);
    expect(result[0].volume).toBe(3000);
  });

  it('vwap is undefined (not silently wrong) when any source bar in the group is missing it', () => {
    const bars = [makeBar(0, { vwap: 100 }), makeBar(1, { vwap: undefined })];
    const result = aggregateBars(bars, '5m');
    expect(result[0].vwap).toBeUndefined();
  });

  it('transactions is undefined when any source bar in the group is missing it', () => {
    const bars = [makeBar(0, { transactions: 5 }), makeBar(1, { transactions: undefined })];
    const result = aggregateBars(bars, '5m');
    expect(result[0].transactions).toBeUndefined();
  });
});

describe('aggregateBars — 1h real rollup', () => {
  it('60 one-minute bars starting mid-hour (real 9:30 open) split into 2 real wall-clock-aligned candles, not 1', () => {
    // Bucketing is by absolute wall-clock hour (9:00-10:00, 10:00-11:00),
    // not "60 bars = 1 bucket regardless of alignment" — a real trading
    // session opens at 9:30, so the first hourly candle is genuinely a
    // partial one (9:30-10:00, 30 real bars) and the second one starts
    // exactly on the hour (10:00-11:00). This is the same gap/partial-group
    // tolerance as the 5-minute tests above, just at a coarser interval.
    const bars = Array.from({ length: 60 }, (_, i) => makeBar(i));
    const result = aggregateBars(bars, '1h');
    expect(result).toHaveLength(2);
    expect(result[0].open).toBe(bars[0].open);
    expect(result[0].volume).toBe(30_000); // 9:30-9:59, 30 real bars
    expect(result[1].close).toBe(bars[59].close);
    expect(result[1].volume).toBe(30_000); // 10:00-10:29, 30 real bars
  });

  it('60 one-minute bars starting exactly on the hour roll into exactly 1 hourly candle', () => {
    const hourStart = Date.UTC(2026, 8, 2, 10, 0, 0, 0);
    const bars = Array.from({ length: 60 }, (_, i) =>
      makeBar(i, { tCT: hourStart + i * 60_000 })); // vary open/close by i, override only tCT
    const result = aggregateBars(bars, '1h');
    expect(result).toHaveLength(1);
    expect(result[0].open).toBe(bars[0].open);
    expect(result[0].close).toBe(bars[59].close);
    expect(result[0].volume).toBe(60_000);
  });
});

describe('groupByTimeBucket — the generic core (portable to a future tick aggregator)', () => {
  it('groups arbitrary timestamped items with no Bar-specific assumptions', () => {
    const events = [{ t: 0 }, { t: 100 }, { t: 250 }, { t: 900 }];
    const groups = groupByTimeBucket(events, 500, (e) => e.t);
    expect(groups).toHaveLength(2);
    expect(groups[0]).toHaveLength(3); // t=0,100,250 -> bucket [0,500)
    expect(groups[1]).toHaveLength(1); // t=900 -> bucket [500,1000)
  });

  it('unsorted input is bucketed correctly regardless of input order', () => {
    const events = [{ t: 900 }, { t: 0 }, { t: 100 }];
    const groups = groupByTimeBucket(events, 500, (e) => e.t);
    expect(groups).toHaveLength(2);
  });
});

describe('computeChartBackfillWindow — trading-day to calendar-day conversion', () => {
  it('7 trading days -> 13 real calendar days of range (ceil(7*7/5) + 3)', () => {
    const now = Date.UTC(2026, 8, 2, 20, 0, 0); // a real Wednesday
    const { fromMs, toMs } = computeChartBackfillWindow(now, 7);
    expect(toMs).toBe(now);
    const calendarDays = (toMs - fromMs) / (24 * 60 * 60 * 1000);
    expect(calendarDays).toBe(13); // ceil(7*7/5) + 3 = ceil(9.8) + 3 = 10 + 3 = 13
  });

  it('5 trading days (the low end of the recommended 5-10 range) -> 10 calendar days', () => {
    const now = Date.UTC(2026, 8, 2, 20, 0, 0);
    const { fromMs, toMs } = computeChartBackfillWindow(now, 5);
    const calendarDays = (toMs - fromMs) / (24 * 60 * 60 * 1000);
    expect(calendarDays).toBe(10); // ceil(5*7/5) + 3 = 7 + 3 = 10
  });

  it('10 trading days (the high end) -> 17 calendar days', () => {
    const now = Date.UTC(2026, 8, 2, 20, 0, 0);
    const { fromMs, toMs } = computeChartBackfillWindow(now, 10);
    const calendarDays = (toMs - fromMs) / (24 * 60 * 60 * 1000);
    expect(calendarDays).toBe(17); // ceil(10*7/5) + 3 = 14 + 3 = 17
  });

  it('defaults to 7 trading days when not specified', () => {
    const now = Date.UTC(2026, 8, 2, 20, 0, 0);
    const withDefault = computeChartBackfillWindow(now);
    const explicit = computeChartBackfillWindow(now, 7);
    expect(withDefault).toEqual(explicit);
  });

  it('toMs is always exactly nowMs — no attempt to find "last session close" as a boundary', () => {
    // Real reasoning documented in chartBars.ts: querying straight through to
    // now is correct whether the market is open or closed, since bars_1m
    // simply has no rows past the true last trade either way.
    const now = Date.UTC(2026, 8, 5, 3, 0, 0); // a real Saturday, market closed
    const { toMs } = computeChartBackfillWindow(now, 7);
    expect(toMs).toBe(now);
  });
});

describe('mergeLiveBar — the live-feed handoff, mirroring barsStore._appendBar', () => {
  it('appends a genuinely new bar (tUtc greater than the last history bar)', () => {
    const history = [makeBar(0), makeBar(1)];
    const live = makeBar(2);
    const result = mergeLiveBar(history, live);
    expect(result).toHaveLength(3);
    expect(result[2]).toEqual(live);
  });

  it('updates the last bar in place when tUtc matches (the in-progress minute getting new ticks)', () => {
    const history = [makeBar(0), makeBar(1)];
    const updatedLive = { ...history[1], close: 999.99 };
    const result = mergeLiveBar(history, updatedLive);
    expect(result).toHaveLength(2); // no growth
    expect(result[1].close).toBe(999.99);
  });

  it('ignores a stale/out-of-order bar older than the last known history bar', () => {
    const history = [makeBar(0), makeBar(5)];
    const staleLive = makeBar(2); // older than history's last (minute 5)
    const result = mergeLiveBar(history, staleLive);
    expect(result).toHaveLength(2);
    expect(result).toEqual(history); // unchanged
  });

  it('first live bar onto empty history seeds the series', () => {
    const result = mergeLiveBar([], makeBar(0));
    expect(result).toHaveLength(1);
  });

  it('does not mutate the input history array', () => {
    const history = [makeBar(0)];
    const historyCopy = [...history];
    mergeLiveBar(history, makeBar(1));
    expect(history).toEqual(historyCopy);
  });
});

describe('INTERVAL_MINUTES — sanity check against the real supported intervals', () => {
  it('matches the documented bucket widths', () => {
    expect(INTERVAL_MINUTES['1m']).toBe(1);
    expect(INTERVAL_MINUTES['5m']).toBe(5);
    expect(INTERVAL_MINUTES['15m']).toBe(15);
    expect(INTERVAL_MINUTES['1h']).toBe(60);
  });
});
