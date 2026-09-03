/**
 * bestContractPicker — real port verification (2026-09-03).
 *
 * Ports BestContractsCockpit.tsx's real ATM-with-fallback strike selection,
 * 8-criterion quality check, and computeRankScore server-side, so
 * signalLedger.ts can capture the real, single contract Best Contracts
 * would recommend at signal-fire time. These tests check the ported logic
 * against the same real thresholds/behavior as the browser source —
 * anything that diverges here is a real porting bug, not a design choice.
 */
import { describe, it, expect } from 'vitest';
import {
  pickBestContract,
  estimateIvRank,
  computeRankScore,
  type PickBestContractInput,
  type BestContractCriteria,
} from '../ledger/bestContractPicker.ts';
import type { ChainRow } from '../stores/types.ts';
import type { Bar } from '../stores/types.ts';

const NOW = Date.now();

function makeChainRow(overrides: Partial<ChainRow> = {}): ChainRow {
  return {
    strike: 450,
    expiry: '2026-09-05',
    callBid: 2.40, callAsk: 2.50, callLast: 2.45, callIV: 0.28,
    callVolume: 1000, callOI: 5000, callDelta: 0.5, callGamma: 0.02, callTheta: -0.15, callVega: 0.3,
    putBid: 2.30, putAsk: 2.40, putLast: 2.35, putIV: 0.30,
    putVolume: 800, putOI: 4000, putDelta: -0.5, putGamma: 0.02, putTheta: -0.14, putVega: 0.3,
    callGex: 0, putGex: 0, netGex: 0, isMaxPain: false,
    ...overrides,
  };
}

function makeBar(close: number): Bar {
  return { ticker: 'TEST', open: close, high: close, low: close, close, volume: 1000, tCT: NOW, tUtc: NOW };
}

function baseInput(overrides: Partial<PickBestContractInput> = {}): PickBestContractInput {
  return {
    ticker: 'SPY',
    direction: 'call',
    signalType: 'ENTER',
    confidence: 80,
    ctx: {
      ticker: 'SPY', gexRegime: 'positive',
      walls: { callWall: 460, putWall: 440 },
      flipLevel: 450, upTarget: 465, downTarget: 435, maxPain: 450,
      chain: [makeChainRow()], asOf: NOW,
    } as any,
    cvd: { callPct: 60, putPct: 40, netDelta: 1000, classification: 'bullish', tickCount: 50 } as any,
    leaderCvd: { callPct: 58, putPct: 42, netDelta: 900, classification: 'bullish', tickCount: 50 } as any,
    bars: [makeBar(450)],
    fund: { recentDisclosures: [] } as any,
    baseRate: { fingerprint: {} as any, n: 40, winRate: 0.65, avgPnl: 0.02, isStatisticallyValid: true },
    nowMs: NOW,
    ...overrides,
  };
}

describe('estimateIvRank — real breakpoints, ported verbatim', () => {
  it('floors at 0 for IV <= 0.15', () => {
    expect(estimateIvRank(0.10)).toBe(0);
    expect(estimateIvRank(0.15)).toBe(0);
  });
  it('caps at 1 for IV >= 0.80', () => {
    expect(estimateIvRank(0.80)).toBe(1);
    expect(estimateIvRank(1.2)).toBe(1);
  });
  it('real midpoint: 0.30 -> 50%', () => {
    expect(estimateIvRank(0.30)).toBeCloseTo(0.50, 5);
  });
});

describe('pickBestContract — real ATM-with-fallback strike selection', () => {
  it('returns null when chain or bars are not ready — genuine absence, not a fabricated pick', () => {
    expect(pickBestContract(baseInput({ ctx: null }))).toBeNull();
    expect(pickBestContract(baseInput({ bars: null }))).toBeNull();
    expect(pickBestContract(baseInput({ ctx: { ...baseInput().ctx, chain: [] } as any }))).toBeNull();
  });

  it('picks the real ATM row when it passes quality — usedFallbackStrike false', () => {
    const pick = pickBestContract(baseInput());
    expect(pick).not.toBeNull();
    expect(pick!.strike).toBe(450);
    expect(pick!.usedFallbackStrike).toBe(false);
    expect(pick!.premium).toBeCloseTo(2.45, 5); // (2.40+2.50)/2
    expect(pick!.delta).toBe(0.5);
    expect(pick!.gamma).toBe(0.02); // real addition beyond BestContractsCockpit's own readSide()
    expect(pick!.theta).toBe(-0.15);
  });

  it('falls back to a clean neighbor when ATM fails the real spread quality gate', () => {
    const wideAtm = makeChainRow({ strike: 450, callBid: 2.00, callAsk: 3.00 }); // spreadPct = 1/2.5 = 40% > 8%
    const cleanNeighbor = makeChainRow({ strike: 455, callBid: 2.40, callAsk: 2.50 });
    const input = baseInput({
      ctx: { ...baseInput().ctx, chain: [wideAtm, cleanNeighbor] } as any,
    });
    const pick = pickBestContract(input);
    expect(pick).not.toBeNull();
    expect(pick!.strike).toBe(455);
    expect(pick!.usedFallbackStrike).toBe(true);
  });

  it('falls back to ATM itself when no neighbor clears quality either — never returns null just because quality is bad', () => {
    const wideAtm = makeChainRow({ strike: 450, callBid: 2.00, callAsk: 3.00 });
    const alsoWideNeighbor = makeChainRow({ strike: 455, callBid: 1.50, callAsk: 2.50 });
    const input = baseInput({
      ctx: { ...baseInput().ctx, chain: [wideAtm, alsoWideNeighbor] } as any,
    });
    const pick = pickBestContract(input);
    expect(pick).not.toBeNull();
    expect(pick!.strike).toBe(450);
    expect(pick!.usedFallbackStrike).toBe(false);
    expect(pick!.criteria.c5Spread).toBe(false); // honestly reports the fail, doesn't hide it
  });
});

describe('pickBestContract — real 8-criterion checks', () => {
  it('c1BrainValid requires n>=30 and winRate>=0.60 and isStatisticallyValid', () => {
    expect(pickBestContract(baseInput())!.criteria.c1BrainValid).toBe(true);
    expect(pickBestContract(baseInput({ baseRate: null }))!.criteria.c1BrainValid).toBe(false);
    expect(pickBestContract(baseInput({ baseRate: { fingerprint: {} as any, n: 10, winRate: 0.9, avgPnl: 0, isStatisticallyValid: true } }))!.criteria.c1BrainValid).toBe(false);
  });

  it('c3CvdDual requires BOTH leader and own-ticker CVD to confirm direction', () => {
    expect(pickBestContract(baseInput())!.criteria.c3CvdDual).toBe(true);
    const bearishLeader = { callPct: 30, putPct: 70, netDelta: -500, classification: 'bearish', tickCount: 50 } as any;
    expect(pickBestContract(baseInput({ leaderCvd: bearishLeader }))!.criteria.c3CvdDual).toBe(false);
  });

  it('c4SignalState requires an actionable signal type AND confidence >= 65', () => {
    expect(pickBestContract(baseInput({ signalType: 'ENTER', confidence: 80 }))!.criteria.c4SignalState).toBe(true);
    expect(pickBestContract(baseInput({ signalType: 'EXIT', confidence: 80 }))!.criteria.c4SignalState).toBe(false);
    expect(pickBestContract(baseInput({ signalType: 'ENTER', confidence: 50 }))!.criteria.c4SignalState).toBe(false);
  });

  it('c6BreakEven checks the real premium against distance to the nearest wall', () => {
    // Premium 2.45, wall at 460, price 450 -> distance 10 -> 2.45 < 10 -> passes
    expect(pickBestContract(baseInput())!.criteria.c6BreakEven).toBe(true);
    const closeWall = { ...baseInput().ctx, walls: { callWall: 452, putWall: 440 } } as any;
    // distance to wall = 2, premium 2.45 -> 2.45 < 2 is false
    expect(pickBestContract(baseInput({ ctx: closeWall }))!.criteria.c6BreakEven).toBe(false);
  });

  it('c8NoEarnings fails when a real earnings disclosure falls within the real 2-day window', () => {
    expect(pickBestContract(baseInput())!.criteria.c8NoEarnings).toBe(true);
    const withEarnings = { recentDisclosures: [{ category: 'earnings', filedAt: NOW + 24 * 3600_000 }] } as any;
    expect(pickBestContract(baseInput({ fund: withEarnings }))!.criteria.c8NoEarnings).toBe(false);
  });
});

describe('computeRankScore — real weighted composite, ported verbatim', () => {
  const allTrue: BestContractCriteria = {
    c1BrainValid: true, c2NoBlocker: true, c3CvdDual: true, c4SignalState: true,
    c5Spread: true, c6BreakEven: true, c7IvRank: true, c8NoEarnings: true,
  };
  const allFalse: BestContractCriteria = {
    c1BrainValid: false, c2NoBlocker: false, c3CvdDual: false, c4SignalState: false,
    c5Spread: false, c6BreakEven: false, c7IvRank: false, c8NoEarnings: false,
  };

  it('sums the real 128/64/32/16/8/4/2/1 weights plus a confidence tiebreak', () => {
    expect(computeRankScore(allTrue, 0)).toBe(255);
    expect(computeRankScore(allFalse, 0)).toBe(0);
    expect(computeRankScore(allFalse, 80)).toBeCloseTo(0.08, 5); // 80 * 0.001
  });

  it('c1 alone outweighs every lower criterion combined (128 > 64+32+16+8+4+2+1=127)', () => {
    const onlyC1 = { ...allFalse, c1BrainValid: true };
    const everythingElse = { ...allTrue, c1BrainValid: false };
    expect(computeRankScore(onlyC1, 0)).toBeGreaterThan(computeRankScore(everythingElse, 0));
  });
});
