/**
 * Gate 1 pre-market fingerprint — AAPL 2026-09-11 from real Massive minute
 * bars (the day this work started), plus the absent cases.
 */
import { describe, it, expect } from 'vitest';
import { premarketFingerprint, isCleanOpen, type PremarketBar } from '../gates/premarket.ts';

const flat = (price: number, n: number, volume = 1_000): PremarketBar[] =>
  Array.from({ length: n }, () => ({ open: price, high: price + 0.05, low: price - 0.05, close: price, volume }));

describe('premarketFingerprint', () => {
  it('is absent — not a quiet reading — without enough pre-market bars or ATR history', () => {
    const prior = flat(100, 390);
    expect(premarketFingerprint({ priorSession: prior, afterHours: [], premarket: flat(100, 5), atr: 2, premarketVolumeAvg20: 1 }))
      .toMatchObject({ dataQuality: 'absent' });
    expect(premarketFingerprint({ priorSession: prior, afterHours: [], premarket: flat(100, 60), atr: null, premarketVolumeAvg20: 1 }))
      .toMatchObject({ dataQuality: 'absent', reason: 'no ATR history' });
  });

  it('in play is the volume test; the fade side is opposite the gap', () => {
    const fp = premarketFingerprint({
      priorSession: flat(100, 390), afterHours: [], premarket: [...flat(101, 30, 5_000), ...flat(102, 30, 5_000)],
      atr: 2, premarketVolumeAvg20: 150_000,
    });
    expect(fp).toMatchObject({ dataQuality: 'real', inPlay: true, fadeDirection: 'short', premarketDirection: 1 });
    if (fp.dataQuality === 'real') {
      expect(fp.gapAtr).toBeCloseTo(1, 6);
      expect(fp.premarketVolumeRatio).toBeCloseTo(2, 6);
    }
  });
});

describe('isCleanOpen', () => {
  it("labels AAPL's 2026-09-11 open clean and long (first 30 minutes from the real bars)", () => {
    // 08:30–08:59 CT, rounded to the cent from Massive minute bars.
    const r = [
      [327.45, 328.25, 326.30, 327.64], [327.58, 329.37, 327.48, 328.52], [328.56, 329.48, 328.36, 328.87], [328.90, 330.89, 328.79, 330.77],
      [330.74, 332.28, 330.43, 331.98], [331.96, 332.73, 331.41, 332.54], [332.52, 333.72, 332.52, 333.24], [333.25, 333.75, 332.94, 333.18],
      [333.10, 333.39, 332.24, 332.90], [332.89, 334.27, 332.89, 334.12], [334.12, 334.16, 333.05, 333.19], [333.20, 333.59, 332.70, 333.02],
      [333.07, 333.91, 333.05, 333.86], [333.86, 334.01, 333.32, 333.55], [333.58, 333.74, 332.93, 333.35], [333.39, 333.76, 332.68, 332.94],
      [332.90, 333.02, 332.38, 332.43], [332.44, 332.51, 331.82, 332.01], [331.99, 332.13, 331.01, 331.21], [331.24, 331.94, 331.19, 331.71],
      [331.66, 332.43, 331.31, 332.35], [332.37, 332.78, 332.35, 332.58], [332.64, 332.74, 331.40, 331.44], [331.46, 331.96, 331.35, 331.95],
      [331.94, 332.22, 331.61, 331.81], [331.82, 332.00, 331.45, 331.83], [331.84, 332.47, 331.84, 332.24], [332.27, 332.95, 332.27, 332.75],
      [332.73, 332.96, 332.61, 332.70], [332.71, 332.72, 332.18, 332.47],
    ].map(([open, high, low, close]) => ({ open, high, low, close, volume: 1 }));
    // Its usual 30-minute opening range: 7.97 ÷ 2.207 (the measured ratio).
    expect(isCleanOpen(r, 7.97 / 2.207)).toEqual({ clean: true, direction: 1 });
    // …and the same open is not clean against a usual range as wide as itself.
    expect(isCleanOpen(r, 7.97).clean).toBe(false);
  });
});
