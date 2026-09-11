import { describe, it, expect } from 'vitest';
import {
  windowRangePct, efficiencyRatio, median, measureMovement, classifyMovement, evaluateMovement,
  WINDOW, BASELINE_MIN_OBS, type MovementBar,
} from '../gates/movementGate.ts';

const T0 = Date.UTC(2026, 8, 10, 13, 30); // 08:30 CT, CDT

/** One-minute bars from a list of closes; each bar spans ±halfRange around its close. */
function barsFrom(closes: number[], halfRange = 0.05, volume = 1_000): MovementBar[] {
  return closes.map((c, i) => ({
    tUtc: T0 + i * 60_000, tCT: T0 - 5 * 3_600_000 + i * 60_000,
    open: c, high: c + halfRange, low: c - halfRange, close: c, volume,
  }));
}

describe('windowRangePct / efficiencyRatio / median', () => {
  it('range is window high−low over the last close', () => {
    const b = barsFrom(Array.from({ length: 31 }, (_, i) => 100 + i * 0.1), 0);
    // closes 100.0 .. 103.0 → last 30 bars span 100.1 .. 103.0
    expect(windowRangePct(b, 30)!).toBeCloseTo((103.0 - 100.1) / 103.0, 10);
  });

  it('efficiency is 1 for a straight line and ~0 for a round trip', () => {
    const straight = barsFrom(Array.from({ length: 31 }, (_, i) => 100 + i));
    expect(efficiencyRatio(straight, 30)).toBeCloseTo(1, 10);
    const roundTrip = barsFrom([...Array.from({ length: 16 }, (_, i) => 100 + i), ...Array.from({ length: 15 }, (_, i) => 114 - i)]);
    expect(efficiencyRatio(roundTrip, 30)!).toBeLessThan(0.05);
  });

  it('median handles odd, even and empty inputs', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(median([])).toBeNull();
  });
});

describe('measureMovement — absent blocks', () => {
  const bars = barsFrom(Array.from({ length: 40 }, (_, i) => 100 + i * 0.01));

  it('is absent before the window is full', () => {
    expect('absent' in measureMovement(bars, WINDOW - 1, Array(20).fill(0.01))).toBe(true);
  });

  it(`is absent with fewer than ${BASELINE_MIN_OBS} prior sessions for this minute`, () => {
    const r = measureMovement(bars, 35, Array(BASELINE_MIN_OBS - 1).fill(0.01));
    expect(r).toEqual({ absent: expect.stringMatching(/prior sessions/) });
  });

  it('evaluateMovement reports absent as its own state — never moving', () => {
    expect(evaluateMovement(bars, 35, []).state).toBe('absent');
  });
});

describe('classifyMovement — magnitude only', () => {
  const f = (relativeRange: number, efficiency = 0.1) =>
    ({ direction: 'up' as const, relativeRange, efficiency, vwapSideShare: 0.2, lastOnSide: false });

  it('asleep below the usual range for this time of day', () => {
    expect(classifyMovement(f(0.99)).state).toBe('asleep');
  });

  it('moving at or above it', () => {
    expect(classifyMovement(f(1.0)).state).toBe('moving');
  });

  it('does NOT block a wide window for low efficiency or VWAP oscillation', () => {
    // v1 called this "chop" and blocked it. Five years of data: chop paid
    // 64.0% vs "moving" 64.5%, and direction was a coin flip either way.
    expect(classifyMovement(f(1.8, 0.05)).state).toBe('moving');
  });
});

describe('evaluateMovement — end to end on real-shaped bars', () => {
  it('a session twice as wide as its baseline is moving', () => {
    const bars = barsFrom(Array.from({ length: 40 }, (_, i) => 100 + i * 0.05));
    const rp = windowRangePct(bars, 39)!;
    const r = evaluateMovement(bars, 39, Array(20).fill(rp / 2));
    expect(r.state).toBe('moving');
    expect(r.relativeRange!).toBeCloseTo(2, 6);
  });

  it('a session half as wide as its baseline is asleep', () => {
    const bars = barsFrom(Array.from({ length: 40 }, (_, i) => 100 + i * 0.05));
    const rp = windowRangePct(bars, 39)!;
    expect(evaluateMovement(bars, 39, Array(20).fill(rp * 2)).state).toBe('asleep');
  });
});
