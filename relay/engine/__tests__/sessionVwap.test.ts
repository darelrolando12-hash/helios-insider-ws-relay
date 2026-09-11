import { describe, it, expect } from 'vitest';
import { sessionVwapSeries, latestSessionVwap, type VwapBar } from '../lib/sessionVwap.ts';
import { toCentralTime } from '../lib/time.ts';

// One minute bar at a given UTC instant. tCT is derived the same way
// massiveAggToBar does it, so session boundaries are the real CT ones.
function bar(utc: number, high: number, low: number, close: number, volume: number): VwapBar {
  return { high, low, close, volume, tUtc: utc, tCT: toCentralTime(utc).ctMs };
}

// 2026-09-10 is CDT (UTC−5): 14:00Z = 09:00 CT.
const D1 = Date.UTC(2026, 8, 10, 14, 0);
// 2026-09-11 08:05Z = 03:05 CT — the next CT day's pre-market.
const D2 = Date.UTC(2026, 8, 11, 8, 5);

describe('sessionVwapSeries', () => {
  it('weights the typical price (h+l+c)/3 by volume', () => {
    const bars = [
      bar(D1,          103, 97, 100, 100),  // typical 100
      bar(D1 + 60_000, 112, 106, 109, 300), // typical 109
    ];
    const s = sessionVwapSeries(bars);
    expect(s[0].value).toBeCloseTo(100, 10);
    // (100·100 + 109·300) / 400 = 106.75
    expect(s[1].value).toBeCloseTo(106.75, 10);
  });

  it('resets at the CT calendar-day boundary, not at UTC midnight', () => {
    const late = Date.UTC(2026, 8, 11, 0, 30); // 19:30 CT on the 10th — same CT day, next UTC day
    const bars = [
      bar(D1,   101, 99, 100, 100),
      bar(late, 201, 199, 200, 100), // still the 10th in CT: accumulates
      bar(D2,   301, 299, 300, 100), // the 11th in CT: resets
    ];
    const s = sessionVwapSeries(bars);
    expect(s[1].value).toBeCloseTo(150, 10);
    expect(s[2].value).toBeCloseTo(300, 10);
  });

  it('never emits NaN for a zero-volume first bar', () => {
    const s = sessionVwapSeries([bar(D1, 101, 99, 100, 0)]);
    expect(s[0].value).toBeCloseTo(100, 10);
  });
});

describe('latestSessionVwap', () => {
  it('uses only the newest session present', () => {
    const bars = [
      bar(D1, 1001, 999, 1000, 1_000_000), // yesterday, huge volume — must not leak in
      bar(D2, 101, 99, 100, 10),
      bar(D2 + 60_000, 111, 109, 110, 30),
    ];
    // (100·10 + 110·30) / 40 = 107.5
    expect(latestSessionVwap(bars)).toBeCloseTo(107.5, 10);
  });

  it('is null — absent, not a price — with no bars or no volume', () => {
    expect(latestSessionVwap([])).toBeNull();
    expect(latestSessionVwap([bar(D2, 101, 99, 100, 0)])).toBeNull();
  });
});
