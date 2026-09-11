/**
 * barsStore.placeBar — the live buffer must stay in time order when Massive's
 * AM for minute M arrives after the 'A' channel has opened minute M+1.
 * Sequence and values from the live TSLA console log, 2026-09-11.
 */
import { describe, it, expect } from 'vitest';
import { placeBar } from '../stores/barsStore';
import type { Bar } from '../stores/types';

const M39 = 1789133940000; // 2026-09-11 13:39Z = 08:39 CT
const M40 = M39 + 60_000;
const bar = (tUtc: number, close: number, volume: number, vwap?: number): Bar =>
  ({ ticker: 'TSLA', open: close, high: close, low: close, close, volume, vwap, tCT: tUtc - 5 * 3_600_000, tUtc });

describe('placeBar', () => {
  it('a late AM for the previous minute replaces that minute, not appended after the forming bar', () => {
    const bars = [bar(M39, 366.5, 190_000), bar(M40, 366.74, 105_935)]; // provisional 08:39, forming 08:40
    expect(placeBar(bars, bar(M39, 366.77, 213_075, 366.4689))).toBe('replaced');
    expect(bars.map((b) => b.tUtc)).toEqual([M39, M40]);
    expect(bars[0].vwap).toBe(366.4689);
  });

  it('a late AM for a minute the buffer never held is inserted in order', () => {
    const bars = [bar(M40, 366.74, 105_935)];
    expect(placeBar(bars, bar(M39, 366.77, 213_075, 366.4689))).toBe('inserted');
    expect(bars.map((b) => b.tUtc)).toEqual([M39, M40]);
  });

  it('the forming minute updates in place and a new minute appends', () => {
    const bars = [bar(M39, 366.77, 213_075)];
    expect(placeBar(bars, bar(M39, 366.8, 213_100))).toBe('replaced');
    expect(placeBar(bars, bar(M40, 366.69, 2_508))).toBe('appended');
    expect(bars.map((b) => b.tUtc)).toEqual([M39, M40]);
  });
});
