import { describe, it, expect } from 'vitest';
import {
  scoreCvd,
  scoreGex,
  scoreEmaTrend,
  scoreCatalyst,
  scoreConfluence,
  resolveSignalType,
  computeEma,
} from '../engines/confluenceEngine.ts';
import type { CvdState } from '../stores/cvdStore.ts';
import type { MarketContext } from '../stores/marketStore.ts';
import type { CatalystTags } from '../engines/catalystGate.ts';
import type { Bar } from '../stores/types.ts';

// ── Test fixtures ──────────────────────────────────────────────────────────────

function makeCvd(overrides: Partial<CvdState> = {}): CvdState {
  return {
    callPct: 50,
    putPct: 50,
    netDelta: 0,
    classification: 'neutral',
    tickCount: 0,
    asOf: Date.now(),
    ticks: [],
    ...overrides,
  };
}

function makeCtx(overrides: Partial<MarketContext> = {}): MarketContext {
  return {
    ticker: 'TEST',
    gexRegime: 'neutral',
    walls: { callWall: 110, putWall: 90 },
    flipLevel: 100,
    asOf: Date.now(),
    upTarget: 110,
    downTarget: 90,
    ...overrides,
  } as MarketContext;
}

function makeCatalyst(overrides: Partial<CatalystTags> = {}): CatalystTags {
  return {
    earningsPending: false,
    materialEvent: false,
    insiderBuy: false,
    insiderSell: false,
    leadDisclosure: null,
    computedAt: Date.now(),
    ...overrides,
  };
}

function makeBar(close: number): Bar {
  return {
    ticker: 'TEST',
    open: close,
    high: close,
    low: close,
    close,
    volume: 1000,
    tCT: Date.now(),
    tUtc: Date.now(),
  };
}

// ── scoreCvd ────────────────────────────────────────────────────────────────────

describe('scoreCvd', () => {
  it('returns 25 pts for strong call-side conviction (>70%)', () => {
    expect(scoreCvd(makeCvd({ callPct: 71, putPct: 29 })).points).toBe(25);
  });

  it('returns 25 pts for strong put-side conviction (>70%)', () => {
    expect(scoreCvd(makeCvd({ callPct: 29, putPct: 71 })).points).toBe(25);
  });

  it('returns 12 pts for moderate call-side conviction (>55%, <=70%)', () => {
    expect(scoreCvd(makeCvd({ callPct: 56, putPct: 44 })).points).toBe(12);
  });

  it('returns 12 pts for moderate put-side conviction (>55%, <=70%)', () => {
    expect(scoreCvd(makeCvd({ callPct: 44, putPct: 56 })).points).toBe(12);
  });

  it('returns 0 pts for neutral flow (both sides <=55%)', () => {
    expect(scoreCvd(makeCvd({ callPct: 50, putPct: 50 })).points).toBe(0);
  });

  it('exact boundary 55 is NOT moderate (strict >)', () => {
    expect(scoreCvd(makeCvd({ callPct: 55, putPct: 45 })).points).toBe(0);
  });

  it('exact boundary 70 is NOT strong (strict >)', () => {
    expect(scoreCvd(makeCvd({ callPct: 70, putPct: 30 })).points).toBe(12);
  });
});

// ── scoreGex ────────────────────────────────────────────────────────────────────

describe('scoreGex', () => {
  it('returns 20 pts when price is at the flip level (within 0.5%)', () => {
    const ctx = makeCtx({ flipLevel: 100, gexRegime: 'neutral' });
    expect(scoreGex(ctx, 100.4).points).toBe(20); // 0.4% from flip
  });

  it('returns 15 pts for negative regime, outside flip proximity', () => {
    const ctx = makeCtx({ flipLevel: 100, gexRegime: 'negative' });
    expect(scoreGex(ctx, 110).points).toBe(15);
  });

  it('returns 10 pts for positive regime, outside flip proximity', () => {
    const ctx = makeCtx({ flipLevel: 100, gexRegime: 'positive' });
    expect(scoreGex(ctx, 110).points).toBe(10);
  });

  it('returns 5 pts for neutral regime, outside flip proximity', () => {
    const ctx = makeCtx({ flipLevel: 100, gexRegime: 'neutral' });
    expect(scoreGex(ctx, 110).points).toBe(5);
  });

  it('flip proximity check takes priority over regime, even in positive regime', () => {
    const ctx = makeCtx({ flipLevel: 100, gexRegime: 'positive' });
    expect(scoreGex(ctx, 100.2).points).toBe(20);
  });

  it('just outside the 0.5% flip band falls through to regime scoring', () => {
    const ctx = makeCtx({ flipLevel: 100, gexRegime: 'negative' });
    // 0.6% away — outside band
    expect(scoreGex(ctx, 100.6).points).toBe(15);
  });
});

// ── scoreEmaTrend ───────────────────────────────────────────────────────────────
// Hand-verified via a standalone EMA computation run against these exact series.

describe('scoreEmaTrend', () => {
  it('returns 0 pts when fewer than 55 bars are available', () => {
    const bars = Array.from({ length: 54 }, (_, i) => makeBar(100 + i));
    expect(scoreEmaTrend(bars).points).toBe(0);
  });

  it('returns 20 pts for a full bull stack (flat-then-strictly-increasing closes)', () => {
    const bars = Array.from({ length: 60 }, (_, i) => makeBar(100 + i));
    expect(scoreEmaTrend(bars).points).toBe(20);
  });

  it('returns 20 pts for a full bear stack (strictly decreasing closes)', () => {
    const bars = Array.from({ length: 60 }, (_, i) => makeBar(200 - i));
    expect(scoreEmaTrend(bars).points).toBe(20);
  });

  it('returns 0 pts for perfectly flat closes (no alignment at all)', () => {
    const bars = Array.from({ length: 60 }, () => makeBar(100));
    expect(scoreEmaTrend(bars).points).toBe(0);
  });

  it('returns 10 pts for partial alignment (long uptrend broken by a sharp recent drop)', () => {
    // 50 bars rising 100->149, then 5 bars dropping sharply: 140,130,120,110,100
    // Verified real EMAs: ema8=123.76, ema21=131.08, ema55=124.09
    // ema8 < ema21 (fails bull-full), ema21 < ema55 is false (131.08 > 124.09) so not bear-full,
    // but ema21 > ema55 is true -> partial branch
    const rising = Array.from({ length: 50 }, (_, i) => makeBar(100 + i));
    const drop = [140, 130, 120, 110, 100].map(makeBar);
    expect(scoreEmaTrend(rising.concat(drop)).points).toBe(10);
  });

  it('returns 10 pts for partial alignment (long downtrend broken by a sharp recent rise)', () => {
    // 50 bars falling 200->151, then 5 bars rising sharply: 160,170,180,190,200
    // Verified real EMAs: ema8=176.24, ema21=168.92, ema55=175.91
    // ema8 > ema21 is true -> partial branch (first condition already satisfies partial's OR)
    const falling = Array.from({ length: 50 }, (_, i) => makeBar(200 - i));
    const rise = [160, 170, 180, 190, 200].map(makeBar);
    expect(scoreEmaTrend(falling.concat(rise)).points).toBe(10);
  });
});

// ── scoreCatalyst ───────────────────────────────────────────────────────────────

describe('scoreCatalyst', () => {
  it('returns 0 pts when all tags are false', () => {
    expect(scoreCatalyst(makeCatalyst()).points).toBe(0);
  });

  it('returns 12 pts for insiderBuy alone', () => {
    expect(scoreCatalyst(makeCatalyst({ insiderBuy: true })).points).toBe(12);
  });

  it('returns 8 pts for materialEvent alone', () => {
    expect(scoreCatalyst(makeCatalyst({ materialEvent: true })).points).toBe(8);
  });

  it('returns 5 pts for earningsPending alone', () => {
    expect(scoreCatalyst(makeCatalyst({ earningsPending: true })).points).toBe(5);
  });

  it('sums insiderBuy + materialEvent + earningsPending (12+8+5=25) but caps at 20', () => {
    const tags = makeCatalyst({ insiderBuy: true, materialEvent: true, earningsPending: true });
    expect(scoreCatalyst(tags).points).toBe(20);
  });

  it('sums two non-maxing tags without capping (12+8=20, exactly at cap)', () => {
    const tags = makeCatalyst({ insiderBuy: true, materialEvent: true });
    expect(scoreCatalyst(tags).points).toBe(20);
  });

  it('insiderSell alone contributes 0 pts (negative modifier, not a positive add here)', () => {
    expect(scoreCatalyst(makeCatalyst({ insiderSell: true })).points).toBe(0);
  });
});

// ── scoreCatalyst — news sentiment integration (2026-09-02) ─────────────────────

describe('scoreCatalyst — news sentiment integration', () => {
  const NOW = Date.now();
  function bullishArticle() {
    return {
      id: 'n1', title: 't', description: '', publishedUtc: NOW, source: 's',
      articleUrl: 'https://x', tickers: ['TEST'], impact: 'HIGH' as const,
      sentiment: 'bullish' as const, sentimentScore: 0.6,
    };
  }
  function bearishArticle() {
    return { ...bullishArticle(), id: 'n2', sentiment: 'bearish' as const, sentimentScore: -0.6 };
  }

  it('bullish news alone (no fundamentals tags) contributes real points, dataQuality real', () => {
    const r = scoreCatalyst(null, [bullishArticle()], true, NOW);
    expect(r.points).toBeCloseTo(5, 5);
    expect(r.dataQuality).toBe('real');
  });

  it('dataQuality is absent only when BOTH fundamentals tags AND news are unavailable', () => {
    const r = scoreCatalyst(null, [], false, NOW);
    expect(r.dataQuality).toBe('absent');
  });

  it('dataQuality is real when tags are null but news feed is fresh (even with zero articles)', () => {
    const r = scoreCatalyst(null, [], true, NOW);
    expect(r.dataQuality).toBe('real');
    expect(r.points).toBe(0);
  });

  it('dataQuality is real when news is absent but fundamentals tags are present', () => {
    const r = scoreCatalyst(makeCatalyst({ insiderBuy: true }), [], false, NOW);
    expect(r.dataQuality).toBe('real');
    expect(r.points).toBe(12);
  });

  it('bullish news is crowded out once insiderBuy+materialEvent already saturate the 20 cap', () => {
    const tags = makeCatalyst({ insiderBuy: true, materialEvent: true }); // already 20
    const r = scoreCatalyst(tags, [bullishArticle()], true, NOW);
    expect(r.points).toBe(20); // news added nothing more room for
  });

  it('bearish news pulls the subtotal DOWN even when insiderBuy+materialEvent already maxed it — real-time bad news is not crowded out', () => {
    const tags = makeCatalyst({ insiderBuy: true, materialEvent: true }); // 20
    const r = scoreCatalyst(tags, [bearishArticle()], true, NOW);
    expect(r.points).toBeCloseTo(15, 5); // 20 - 5
  });

  it('the combined catalyst subtotal is floored at 0, never negative, even with only bearish news', () => {
    const r = scoreCatalyst(null, [bearishArticle(), { ...bearishArticle(), id: 'n3' }], true, NOW);
    expect(r.points).toBe(0);
  });
});

// ── scoreConfluence — aggregator ────────────────────────────────────────────────

describe('scoreConfluence', () => {
  it('sums all four components correctly with no catalyst (max real non-catalyst = 65)', () => {
    // CVD 25 (strong) + GEX 20 (at flip) + EMA 20 (bull stack) + catalyst null = 65
    const bars = Array.from({ length: 60 }, (_, i) => makeBar(100 + i));
    const cvd = makeCvd({ callPct: 75, putPct: 25 });
    const ctx = makeCtx({ flipLevel: bars[bars.length - 1].close, gexRegime: 'negative' });
    const result = scoreConfluence(bars, cvd, ctx, null, bars[bars.length - 1].close);
    expect(result.score).toBe(65);
    expect(result.sources).toEqual(['cvd', 'gex', 'ema']);
  });

  it('reaches the ENTER threshold (75) when catalyst tags push the max non-catalyst score up', () => {
    const bars = Array.from({ length: 60 }, (_, i) => makeBar(100 + i));
    const cvd = makeCvd({ callPct: 75, putPct: 25 });
    const ctx = makeCtx({ flipLevel: bars[bars.length - 1].close, gexRegime: 'negative' });
    const catalyst = makeCatalyst({ insiderBuy: true }); // +12 -> 65+12=77, capped at 100 (no cap needed here)
    const result = scoreConfluence(bars, cvd, ctx, catalyst, bars[bars.length - 1].close);
    expect(result.score).toBe(77);
    expect(result.sources).toEqual(['cvd', 'gex', 'ema', 'catalyst']);
  });

  it('lands exactly at the REVERSAL threshold (65) using CVD+GEX+EMA only, no catalyst', () => {
    const bars = Array.from({ length: 60 }, (_, i) => makeBar(200 - i)); // bear stack, 20 pts
    const cvd = makeCvd({ callPct: 25, putPct: 75 }); // 25 pts
    const ctx = makeCtx({ flipLevel: bars[bars.length - 1].close, gexRegime: 'negative' }); // at flip -> 20 pts
    const result = scoreConfluence(bars, cvd, ctx, null, bars[bars.length - 1].close);
    expect(result.score).toBe(65);
  });

  it('lands exactly at the EXIT threshold (55) with a real component combination', () => {
    // Combination hand-verified to sum to exactly 55:
    // CVD strong (25) + GEX neutral-far-from-flip (5) + EMA bull-full (20) + catalyst earningsPending (5) = 55
    const bars60 = Array.from({ length: 60 }, (_, i) => makeBar(100 + i));
    const cvdStrong = makeCvd({ callPct: 75, putPct: 25 }); // 25
    const ctxFar = makeCtx({ flipLevel: 999, gexRegime: 'neutral' }); // far from flip, neutral -> 5
    const catalystEarnings = makeCatalyst({ earningsPending: true }); // 5
    const result = scoreConfluence(bars60, cvdStrong, ctxFar, catalystEarnings, bars60[bars60.length - 1].close);
    expect(result.score).toBe(55);
  });

  it('caps total score at 100 even if components would sum higher', () => {
    const bars = Array.from({ length: 60 }, (_, i) => makeBar(100 + i)); // bull-full 20
    const cvd = makeCvd({ callPct: 90, putPct: 10 }); // 25
    const ctx = makeCtx({ flipLevel: bars[bars.length - 1].close, gexRegime: 'negative' }); // at flip 20
    const catalyst = makeCatalyst({ insiderBuy: true, materialEvent: true, earningsPending: true }); // capped 20
    // 20+25+20+20 = 85, still under 100 — but confirms the Math.min(100, ...) path doesn't corrupt a normal sum
    const result = scoreConfluence(bars, cvd, ctx, catalyst, bars[bars.length - 1].close);
    expect(result.score).toBe(85);
    expect(result.score).toBeLessThanOrEqual(100);
  });
});

// ── resolveSignalType ───────────────────────────────────────────────────────────

describe('resolveSignalType', () => {
  const bars = Array.from({ length: 60 }, (_, i) => makeBar(100 + i));
  const currentPrice = bars[bars.length - 1].close;

  it('returns null when score is below EXIT_THRESHOLD (55)', () => {
    const cvd = makeCvd({ classification: 'bullish' });
    const ctx = makeCtx({ flipLevel: 999, walls: { callWall: 999, putWall: 1 } });
    expect(resolveSignalType(54, cvd, ctx, currentPrice)).toBeNull();
  });

  it('returns EXIT for a score in the EXIT band (55-64) with no wall proximity', () => {
    const cvd = makeCvd({ classification: 'bullish' });
    const ctx = makeCtx({ flipLevel: currentPrice, walls: { callWall: 999, putWall: 1 } });
    // score 60 is in EXIT band regardless of bullish/bearish per the function's own branch order
    expect(resolveSignalType(60, cvd, ctx, currentPrice)).toBe('EXIT');
  });

  it('returns REVERSAL for a score in the REVERSAL band (65-74)', () => {
    const cvd = makeCvd({ classification: 'bullish' });
    const ctx = makeCtx({ flipLevel: currentPrice, walls: { callWall: 999, putWall: 1 } });
    expect(resolveSignalType(70, cvd, ctx, currentPrice)).toBe('REVERSAL');
  });

  it('returns ENTER for a score >= 75, bullish CVD + negative GEX, no wall proximity', () => {
    const cvd = makeCvd({ classification: 'bullish' });
    const ctx = makeCtx({ gexRegime: 'negative', flipLevel: 1, walls: { callWall: 999, putWall: 1 } });
    expect(resolveSignalType(80, cvd, ctx, currentPrice)).toBe('ENTER');
  });

  it('returns EXIT for a score >= 75 when isBullish is false (not bullish CVD, not favorable GEX/price)', () => {
    const cvd = makeCvd({ classification: 'bearish' });
    const ctx = makeCtx({ gexRegime: 'positive', flipLevel: currentPrice + 1000, walls: { callWall: 999, putWall: 1 } });
    expect(resolveSignalType(80, cvd, ctx, currentPrice)).toBe('EXIT');
  });

  it('returns BREAKOUT when score >= 75 and price is within 0.3% of the call wall', () => {
    const cvd = makeCvd({ classification: 'bullish' });
    const nearCallWall = currentPrice * 1.001; // 0.1% away
    const ctx = makeCtx({ gexRegime: 'negative', flipLevel: 1, walls: { callWall: nearCallWall, putWall: 1 } });
    expect(resolveSignalType(80, cvd, ctx, currentPrice)).toBe('BREAKOUT');
  });

  it('returns BREAKOUT when score >= 75 and price is within 0.3% of the put wall', () => {
    const cvd = makeCvd({ classification: 'bullish' });
    const nearPutWall = currentPrice * 0.999; // 0.1% away
    const ctx = makeCtx({ gexRegime: 'negative', flipLevel: 1, walls: { callWall: 99999, putWall: nearPutWall } });
    expect(resolveSignalType(80, cvd, ctx, currentPrice)).toBe('BREAKOUT');
  });

  it('does NOT return BREAKOUT when just outside the 0.3% wall band (falls to ENTER/EXIT)', () => {
    const cvd = makeCvd({ classification: 'bullish' });
    const farCallWall = currentPrice * 1.005; // 0.5% away, outside 0.3% band
    const ctx = makeCtx({ gexRegime: 'negative', flipLevel: 1, walls: { callWall: farCallWall, putWall: 1 } });
    expect(resolveSignalType(80, cvd, ctx, currentPrice)).toBe('ENTER');
  });
});

// ── computeEma ──────────────────────────────────────────────────────────────────

describe('computeEma', () => {
  it('returns the last value when data length is less than the period', () => {
    expect(computeEma([10, 20, 30], 5)).toBe(30);
  });

  it('returns 0 for an empty array with a period larger than 0', () => {
    expect(computeEma([], 5)).toBe(0);
  });

  it('matches hand-computed EMA for a small series (period=3)', () => {
    // data = [10, 20, 30, 40], period 3
    // seed = avg(10,20,30) = 20
    // k = 2/(3+1) = 0.5
    // i=3: ema = 40*0.5 + 20*0.5 = 20 + 10 = 30
    expect(computeEma([10, 20, 30, 40], 3)).toBeCloseTo(30, 5);
  });

  it('matches hand-computed EMA for a longer small series (period=2)', () => {
    // data = [1, 2, 3, 4, 5], period 2
    // seed = avg(1,2) = 1.5
    // k = 2/3 = 0.6667
    // i=2 (val 3): ema = 3*0.6667 + 1.5*0.3333 = 2 + 0.5 = 2.5
    // i=3 (val 4): ema = 4*0.6667 + 2.5*0.3333 = 2.6667 + 0.8333 = 3.5
    // i=4 (val 5): ema = 5*0.6667 + 3.5*0.3333 = 3.3333 + 1.1667 = 4.5
    expect(computeEma([1, 2, 3, 4, 5], 2)).toBeCloseTo(4.5, 4);
  });

  it('returns exactly the constant value for a flat series (any period)', () => {
    expect(computeEma(new Array(20).fill(50), 8)).toBeCloseTo(50, 10);
  });
});
