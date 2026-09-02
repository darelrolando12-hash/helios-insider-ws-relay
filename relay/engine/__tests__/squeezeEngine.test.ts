/**
 * squeezeEngine — real, quantified fix (W8 audit, 2026-09-02).
 *
 * scoreShortFloat is 35 of squeezeEngine's 100 points, the single largest
 * component. Confirmed live: Massive's real short-interest response never
 * carries short_pct_float (0/483 real reports across all FEED_TICKERS, a
 * full year) — it was a permanent, silent zero. Fixed via a real, separate
 * free-float endpoint combined with short_interest
 * (fundamentalsStore.computeShortPctOfFloat). These tests cover the scoring
 * functions plus the new shortVolumeDataQuality distinction.
 */
import { describe, it, expect } from 'vitest';
import {
  computeSqueezeRisk,
  scoreShortFloat,
  scoreDaysToCover,
  scoreShortVolumeRatio,
  scoreMomentum,
  classifySqueezeLevel,
} from '../engines/squeezeEngine.ts';
import type { Bar } from '../stores/types.ts';

function makeBars(closes: number[]): Bar[] {
  return closes.map((c) => ({
    ticker: 'TEST', open: c, high: c, low: c, close: c, volume: 1000, tCT: Date.now(), tUtc: Date.now(),
  }));
}

describe('scoreShortFloat — now reachable, previously a permanent zero', () => {
  it('returns 0 for null (unknown, not a real zero)', () => {
    expect(scoreShortFloat(null)).toBe(0);
  });

  it('35 pts at >= 40%', () => {
    expect(scoreShortFloat(40)).toBe(35);
    expect(scoreShortFloat(55)).toBe(35);
  });

  it('22 pts at >= 20%, < 40%', () => {
    expect(scoreShortFloat(20)).toBe(22);
    expect(scoreShortFloat(39.9)).toBe(22);
  });

  it('12 pts at >= 10%, < 20%', () => {
    expect(scoreShortFloat(10)).toBe(12);
  });

  it('0 pts below 10%', () => {
    expect(scoreShortFloat(9.9)).toBe(0);
    expect(scoreShortFloat(0)).toBe(0);
  });

  it('a real, plausible TSLA-shaped value (2.17%) scores 0 — genuinely low, not an error', () => {
    expect(scoreShortFloat(2.17)).toBe(0);
  });
});

describe('computeSqueezeRisk — real ceiling is 100 again, not 65', () => {
  it('can reach the full 100 now that short float contributes — was capped at 65 before the fix', () => {
    const bars = makeBars([100, 100, 100, 100, 100, 104]); // +4% momentum -> 15 pts
    const risk = computeSqueezeRisk('TEST', 45, 12, 65, 'real', bars, Date.now());
    // 35 (float >=40) + 30 (dtc >=10) + 20 (svr >=60) + 15 (momentum >=3%) = 100
    expect(risk.score).toBe(100);
    expect(risk.level).toBe('high');
  });

  it('with shortFloatPct null (float not yet fetched for this ticker), ceiling is still 65 — real, honest, not fake', () => {
    const bars = makeBars([100, 100, 100, 100, 100, 104]);
    const risk = computeSqueezeRisk('TEST', null, 12, 65, 'real', bars, Date.now());
    expect(risk.score).toBe(65); // 30+20+15, float contributes 0 because it's genuinely unknown
  });

  it('shortVolumeDataQuality passes through unchanged on the result — absent vs real', () => {
    const bars = makeBars([100, 100, 100, 100, 100, 100]);
    const absentRisk = computeSqueezeRisk('TEST', 15, 3, null, 'absent', bars, Date.now());
    const realRisk    = computeSqueezeRisk('TEST', 15, 3, null, 'real',   bars, Date.now());
    expect(absentRisk.shortVolumeDataQuality).toBe('absent');
    expect(realRisk.shortVolumeDataQuality).toBe('real');
    // Both score identically on the number (scoreShortVolumeRatio can't
    // distinguish null-because-absent from null-because-real-zero on its
    // own) — the dataQuality field is what a caller must check instead.
    expect(absentRisk.score).toBe(realRisk.score);
  });
});

describe('scoreDaysToCover / scoreShortVolumeRatio / scoreMomentum — unaffected by this fix, sanity-checked', () => {
  it('days to cover thresholds', () => {
    expect(scoreDaysToCover(null)).toBe(0);
    expect(scoreDaysToCover(10)).toBe(30);
    expect(scoreDaysToCover(5)).toBe(18);
    expect(scoreDaysToCover(2)).toBe(8);
    expect(scoreDaysToCover(1.9)).toBe(0);
  });

  it('short volume ratio thresholds', () => {
    expect(scoreShortVolumeRatio(null)).toBe(0);
    expect(scoreShortVolumeRatio(60)).toBe(20);
    expect(scoreShortVolumeRatio(40)).toBe(12);
    expect(scoreShortVolumeRatio(25)).toBe(6);
    expect(scoreShortVolumeRatio(24.9)).toBe(0);
  });

  it('momentum requires at least 6 bars, else 0', () => {
    expect(scoreMomentum(null)).toBe(0);
    expect(scoreMomentum(makeBars([100, 100, 100]))).toBe(0);
  });

  it('classifySqueezeLevel thresholds', () => {
    expect(classifySqueezeLevel(65)).toBe('high');
    expect(classifySqueezeLevel(64)).toBe('medium');
    expect(classifySqueezeLevel(40)).toBe('medium');
    expect(classifySqueezeLevel(39)).toBe('low');
  });
});
