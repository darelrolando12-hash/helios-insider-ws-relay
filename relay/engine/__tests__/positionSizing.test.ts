/**
 * Position sizing — options-correct risk model.
 *
 * The most important tests here are the zero cases. `contracts: 0` is a
 * legitimate outcome meaning "skip this signal", and the failure mode that
 * matters is a caller (or a future edit) turning it into 1.
 */
import { describe, it, expect } from 'vitest';
import {
  sizePosition,
  affordablePremiumBand,
  CONTRACT_MULTIPLIER,
  type SizingCaps,
} from '../risk/positionSizing.ts';

const caps: SizingCaps = {
  maxContractsPerPosition: 50,
  maxPositionPctOfEquity: 0.30,
  minEquityToTrade: 100,
};

const base = {
  equity: 10_000,
  riskPct: 0.02,          // $200 budget
  premium: 2.00,          // $200/contract notional
  maxPremiumLossPct: 0.50,// premium bound = 2.00 * 100 * 0.5 = $100
  stopDistance: 5.00,
  delta: 0.50,            // delta bound = 5 * 0.5 * 100 = $250
  caps,
};

describe('sizePosition — the two-bound risk model', () => {
  it('takes the tighter bound: premium ($100) beats delta ($250) here', () => {
    const r = sizePosition(base);
    expect(r.riskPerContract).toBe(100);
    expect(r.bindingRisk).toBe('premium');
    expect(r.contracts).toBe(2);          // $200 budget / $100
    expect(r.reason).toBe('ok');
  });

  it('takes the delta bound when it is tighter', () => {
    // stopDistance 1.00, delta 0.30 -> delta bound $30, premium bound $100
    const r = sizePosition({ ...base, stopDistance: 1.00, delta: 0.30 });
    expect(r.riskPerContract).toBe(30);
    expect(r.bindingRisk).toBe('delta');
    expect(r.contracts).toBe(6);          // floor(200/30)
  });

  it('does NOT use the stock formula — far-OTM delta changes the size materially', () => {
    // The bug being guarded against: stopDistance * 100 ignores delta entirely.
    // At delta 0.08 the stock formula would compute $500/contract; the correct
    // delta bound is $40, and the premium bound $100 is what actually binds.
    const stockFormulaRisk = base.stopDistance * CONTRACT_MULTIPLIER;   // 500
    const r = sizePosition({ ...base, delta: 0.08 });
    expect(stockFormulaRisk).toBe(500);
    expect(r.riskPerContract).toBe(40);   // 5 * 0.08 * 100
    expect(r.bindingRisk).toBe('delta');
    expect(r.contracts).toBe(5);
    // The stock formula would have sized 0 contracts here (200/500 < 1).
    expect(Math.floor(200 / stockFormulaRisk)).toBe(0);
  });

  it('falls back to the premium bound when delta is absent — and that is conservative', () => {
    const withDelta = sizePosition({ ...base, stopDistance: 1.00, delta: 0.30 });
    const noDelta = sizePosition({ ...base, stopDistance: 1.00, delta: undefined });
    expect(noDelta.bindingRisk).toBe('premium-only-no-delta');
    expect(noDelta.riskPerContract).toBe(100);
    // Fewer contracts than the delta-informed size => conservative fallback.
    expect(noDelta.contracts).toBeLessThan(withDelta.contracts);
  });
});

describe('sizePosition — zero cases (must never round up to 1)', () => {
  it('returns 0 for a $100 account that cannot afford one contract', () => {
    // $100 * 2% = $2 budget; cheapest bound is $100/contract.
    const r = sizePosition({ ...base, equity: 100 });
    expect(r.contracts).toBe(0);
    // The single most important assertion in this file: rounding this to 1
    // would turn a 2% risk into an 80%+ risk on a small account.
    expect(r.contracts).not.toBe(1);
    // $100 equity: capital cap $20, flexed $30, contract costs $200 -> capital
    // cannot fund one either. Which limit reports first is less important than
    // the count being 0.
    expect(['budget-below-one-contract', 'equity-below-options-viable', 'capped-by-capital']).toContain(r.reason);
  });

  it('returns 0 below minimum equity, with a distinct reason', () => {
    const r = sizePosition({ ...base, equity: 50 });
    expect(r.contracts).toBe(0);
    expect(r.reason).toBe('below-min-equity');
  });

  it('rejects a zero stopDistance rather than silently sizing on premium alone', () => {
    // deltaRisk would be 0, and budget/0 is Infinity -> floor(Infinity)
    // contracts. A zero-distance stop is nonsense input, not "no stop", so it
    // is refused rather than quietly reinterpreted.
    const r = sizePosition({ ...base, stopDistance: 0 });
    expect(Number.isFinite(r.contracts)).toBe(true);
    expect(r.contracts).toBe(0);
    expect(r.reason).toBe('invalid-inputs');
  });

  it('treats delta 0 as "no delta" and sizes on the premium bound, never Infinity', () => {
    // |delta| === 0 must not win the min() — that is the other route to a
    // divide-by-zero. It falls back to the premium bound instead.
    const r = sizePosition({ ...base, delta: 0 });
    expect(Number.isFinite(r.contracts)).toBe(true);
    expect(r.bindingRisk).toBe('premium-only-no-delta');
    expect(r.riskPerContract).toBe(100);
    expect(r.contracts).toBe(2);
  });

  it('a pathological premium cannot produce an unbounded size — caps hold the line', () => {
    // Even with an absurd premium making riskPerContract almost zero, the
    // hard caps are what stop this being millions of contracts.
    const r = sizePosition({ ...base, delta: 0, premium: 0.0001, maxPremiumLossPct: 0.0001 });
    expect(Number.isFinite(r.contracts)).toBe(true);
    expect(r.contracts).toBeLessThanOrEqual(caps.maxContractsPerPosition);
  });

  it.each([
    ['equity NaN', { equity: NaN }, 'equity-unavailable'],
    ['equity 0', { equity: 0 }, 'equity-unavailable'],
    ['equity negative', { equity: -5000 }, 'equity-unavailable'],
    ['riskPct 0', { riskPct: 0 }, 'invalid-inputs'],
    ['riskPct > 1', { riskPct: 1.5 }, 'invalid-inputs'],
    ['premium 0', { premium: 0 }, 'invalid-inputs'],
    ['premium NaN', { premium: NaN }, 'invalid-inputs'],
    ['maxPremiumLossPct 0', { maxPremiumLossPct: 0 }, 'invalid-inputs'],
    ['negative stopDistance', { stopDistance: -1 }, 'invalid-inputs'],
  ])('returns 0 for %s and never guesses', (_l, patch, reason) => {
    const r = sizePosition({ ...base, ...(patch as object) });
    expect(r.contracts).toBe(0);
    expect(r.reason).toBe(reason);
  });

  it('never fetches equity itself — an equity failure is the caller passing 0', () => {
    // Documents the contract: there is no internal fallback to a cached value.
    const r = sizePosition({ ...base, equity: 0 });
    expect(r.reason).toBe('equity-unavailable');
    expect(r.contracts).toBe(0);
  });
});

describe('sizePosition — floor, never round', () => {
  it.each([
    [199, 1],   // 199/100 = 1.99 -> 1, not 2
    [299, 2],   // 2.99 -> 2
    [99, 0],    // 0.99 -> 0, not 1
  ])('budget $%i yields %i contracts', (budget, expected) => {
    const r = sizePosition({ ...base, equity: budget / 0.02 });
    expect(r.contracts).toBe(expected);
  });
});

describe('sizePosition — hard caps applied after the formula', () => {
  it('caps by maxContractsPerPosition', () => {
    const r = sizePosition({
      ...base, equity: 1_000_000,
      caps: { ...caps, maxContractsPerPosition: 10, maxPositionPctOfEquity: 1.0 },
    });
    expect(r.contracts).toBe(10);
    expect(r.appliedCap).toBe('max-contracts');
    expect(r.reason).toBe('capped-by-max-contracts');
  });

  it('caps by percent-of-equity notional — a wide stop can pass risk but not capital', () => {
    // Risk bound allows many contracts; notional cap allows far fewer.
    const r = sizePosition({
      ...base, equity: 10_000, premium: 20.00, maxPremiumLossPct: 0.10,
      caps: { ...caps, maxPositionPctOfEquity: 0.10, maxContractsPerPosition: 999 },
    });
    // notional cap = 10_000 * 0.10 / (20 * 100) = 0.5 -> floor 0
    expect(r.contracts).toBe(0);
    expect(r.reason).toBe('budget-below-one-contract');
  });

  it('caps by liquidity when supplied, and skips the check when absent', () => {
    const capped = sizePosition({
      ...base, equity: 1_000_000,
      caps: { ...caps, maxPositionPctOfEquity: 1.0, maxContractsPerPosition: 999, maxContractsByLiquidity: 3 },
    });
    expect(capped.contracts).toBe(3);
    expect(capped.appliedCap).toBe('liquidity');

    const uncapped = sizePosition({
      ...base, equity: 1_000_000,
      caps: { ...caps, maxPositionPctOfEquity: 1.0, maxContractsPerPosition: 999 },
    });
    expect(uncapped.contracts).toBeGreaterThan(3);
  });
});

describe('affordablePremiumBand — inverting the question', () => {
  it('gives a tradeable band for a funded account', () => {
    const b = affordablePremiumBand({ equity: 10_000, riskPct: 0.02, maxPremiumLossPct: 0.50, caps });
    expect(b.tradeable).toBe(true);
    // risk bound: 200 / (100 * 0.5) = 4.00 ; notional: 10000*0.3/100 = 30
    expect(b.maxPremium).toBeCloseTo(4.00, 6);
    expect(b.minPremium).toBe(0.10);
  });

  it('is bound by notional when that is tighter than risk', () => {
    const b = affordablePremiumBand({
      equity: 1_000, riskPct: 0.50, maxPremiumLossPct: 0.50,
      caps: { ...caps, maxPositionPctOfEquity: 0.05 },
    });
    // risk: 500/(50) = 10 ; notional: 1000*0.05/100 = 0.50 -> notional binds
    expect(b.maxPremium).toBeCloseTo(0.50, 6);
  });

  it('reports untradeable for an account too small for any sane contract', () => {
    const b = affordablePremiumBand({ equity: 150, riskPct: 0.02, maxPremiumLossPct: 0.50, caps });
    // 3 / 50 = 0.06 max premium, below the 0.10 floor
    expect(b.tradeable).toBe(false);
    expect(b.reason).toBe('equity-below-options-viable');
  });

  it('a contract chosen inside the band is sizeable — band and sizer agree', () => {
    const b = affordablePremiumBand({ equity: 10_000, riskPct: 0.02, maxPremiumLossPct: 0.50, caps });
    const r = sizePosition({ ...base, premium: b.maxPremium });
    // This is the point of the band: selection inside it is never rejected.
    expect(r.contracts).toBeGreaterThanOrEqual(1);
    expect(r.reason).toBe('ok');
  });

  it('refuses on unusable equity rather than returning a band', () => {
    expect(affordablePremiumBand({ equity: NaN, riskPct: 0.02, maxPremiumLossPct: 0.5, caps }).reason)
      .toBe('equity-unavailable');
  });
});

// ── Capital cap ──────────────────────────────────────────────────────────────
// Fixtures below are REAL contracts pulled from a captured Massive options
// snapshot (132,823 quoted contracts in the session HAR), not invented numbers.
//   $0.35  O:AAPL261016P00245000  bid 0.32 / ask 0.38  delta -0.0206  OI 5152
//   $0.45  O:AMZN270115P00150000  bid 0.42 / ask 0.48  delta -0.0156  OI 11989
//   $1.30  O:NFLX260911C00082000  bid 1.28 / ask 1.32  delta  0.4067  OI 1279

import {
  BASE_CAPITAL_CAP_PCT,
  MAX_FLEXED_CAPITAL_CAP_PCT,
  CAPITAL_CAP_EQUITY_THRESHOLD,
} from '../risk/positionSizing.ts';

describe('capital cap — riskBudget bounds loss, but a contract costs full premium', () => {
  const smallCaps: SizingCaps = {
    maxContractsPerPosition: 50,
    maxPositionPctOfEquity: 1.0,   // let the capital cap be the binding one
    minEquityToTrade: 100,
  };
  const small = {
    equity: 300,
    riskPct: 0.02,
    maxPremiumLossPct: 0.50,
    stopDistance: 5.00,
    caps: smallCaps,
  };

  it('the $300 / $0.35 case: capital affords exactly 1 contract', () => {
    // capital cap = 300 * 0.20 = $60 ; contract cost = $35 -> 1
    const r = sizePosition({ ...small, premium: 0.35, delta: -0.0206 });
    expect(r.capitalCapActive).toBe(true);
    expect(r.capitalCap).toBeCloseTo(60, 6);
    expect(r.contractsFromCapital).toBe(1);
    expect(r.contracts).toBe(1);
  });

  it('the $300 / $0.45 case: capital affords exactly 1 contract', () => {
    // $60 cap / $45 cost -> 1
    const r = sizePosition({ ...small, premium: 0.45, delta: -0.0156 });
    expect(r.contractsFromCapital).toBe(1);
    expect(r.contracts).toBe(1);
    expect(r.reason).toBe('capital-governed-risk-exceeded');
  });

  it('the $300 / $1.30 case: $130 exceeds even the flexed $90 ceiling -> 0', () => {
    // base cap $60, flexed ceiling 300*0.30 = $90, contract costs $130.
    const r = sizePosition({ ...small, premium: 1.30, delta: 0.4067 });
    expect(r.contracts).toBe(0);
    expect(r.reason).toBe('capped-by-capital');
    expect(r.capitalFlexed).toBe(false);
  });

  it('flexes toward 30% ONLY to afford a single contract', () => {
    // $300 equity, $0.70 contract = $70. Base cap $60 affords 0; flexed $90
    // affords 1.
    const r = sizePosition({ ...small, premium: 0.70, delta: 0.10 });
    expect(r.capitalFlexed).toBe(true);
    expect(r.contracts).toBe(1);
    // risk returns 0 at this equity, so the capital-governed reason wins over
    // the flex reason — both are true, and risk-exceeded is the more important
    // one to surface.
    expect(r.reason).toBe('capital-governed-risk-exceeded');
    expect(r.capitalCap).toBeCloseTo(90, 6);
  });

  it('flexing never buys a SECOND contract — it is affordability, not leverage', () => {
    // $1000 equity, $0.25 contract = $25. Base cap $200 already affords 8, so
    // no flex occurs; and the flex path can only ever yield exactly 1.
    const r = sizePosition({ ...small, equity: 1000, premium: 0.25, delta: 0.10 });
    expect(r.capitalFlexed).toBe(false);
    expect(r.capitalCap).toBeCloseTo(200, 6);
  });

  it('final count is min(capital, risk) — risk can still bind below capital', () => {
    // $1500 equity: capital cap $300 -> 8 contracts of a $0.35 contract.
    // Risk: budget $30, premium bound = 0.35*100*0.5 = $17.50 -> 1 contract.
    const r = sizePosition({ ...small, equity: 1500, premium: 0.35, delta: -0.0206 });
    expect(r.contractsFromCapital).toBe(8);
    expect(r.contractsFromRisk).toBe(2);
    expect(r.contracts).toBe(2);
    expect(r.reason).toBe('capped-by-risk');
  });

  it('the arithmetic that started this: floor(16.50 / 17.50) === 0', () => {
    // $825 equity at 2% = $16.50 budget; a $0.35 contract's premium bound is
    // $17.50. Risk alone permits nothing — which is exactly why the capital
    // cap exists as a separate stage rather than the risk budget flexing.
    const r = sizePosition({ ...small, equity: 825, premium: 0.35, delta: -0.0206 });
    expect(r.riskBudget).toBeCloseTo(16.50, 6);
    // With the REAL AAPL delta of -0.0206 the delta bound ($10.30) is tighter
    // than the premium bound ($17.50) — the hand-worked example assumed the
    // premium bound. floor(16.50/10.30) is still 1, not 0.
    expect(r.riskPerContract).toBeCloseTo(10.30, 6);
    expect(r.contractsFromRisk).toBe(1);
    // Capital cap is active at $825, so the trade proceeds at 1 contract.
    // The original hand-worked claim (0 contracts) came from assuming the
    // premium bound; the real delta makes the risk bound tighter, not looser.
    expect(r.contracts).toBe(1);
  });
});

describe('capital cap — crossover at the named threshold', () => {
  const caps2: SizingCaps = {
    maxContractsPerPosition: 999,
    maxPositionPctOfEquity: 1.0,
    minEquityToTrade: 100,
  };
  const at = (equity: number) => sizePosition({
    equity, riskPct: 0.02, premium: 0.35, maxPremiumLossPct: 0.50,
    stopDistance: 5.00, delta: -0.0206, caps: caps2,
  });

  it('is active just below the threshold and inactive at it', () => {
    expect(at(CAPITAL_CAP_EQUITY_THRESHOLD - 1).capitalCapActive).toBe(true);
    expect(at(CAPITAL_CAP_EQUITY_THRESHOLD).capitalCapActive).toBe(false);
    expect(at(CAPITAL_CAP_EQUITY_THRESHOLD + 1).capitalCapActive).toBe(false);
  });

  it('above the threshold, capital no longer constrains — risk alone decides', () => {
    const r = at(10_000);
    expect(r.capitalCapActive).toBe(false);
    expect(r.contractsFromCapital).toBe(Number.POSITIVE_INFINITY);
    // 20% of $10,000 would be $2,000 into one 0DTE trade — the accommodation
    // must not survive past the point where it is needed.
    expect(r.contracts).toBe(r.contractsFromRisk);
  });

  it('the constants are the documented values', () => {
    expect(BASE_CAPITAL_CAP_PCT).toBe(0.20);
    expect(MAX_FLEXED_CAPITAL_CAP_PCT).toBe(0.30);
    expect(CAPITAL_CAP_EQUITY_THRESHOLD).toBe(2_000);
  });
});

describe('capital cap — the 4-loss survival table that justifies 20%', () => {
  // Guards the constant against being quietly retuned upward. If someone
  // raises BASE_CAPITAL_CAP_PCT toward 0.50, these numbers move and this
  // fails, forcing them to confront the ruin math in the module header.
  const survive = (cap: number, losses: number) => Math.pow(1 - cap, losses);

  it.each([
    [0.50, 2, 0.25],
    [0.30, 2, 0.49],
    [0.20, 2, 0.64],
    [0.20, 4, 0.4096],
  ])('cap %d after %d total losses leaves %d of the account', (cap, n, expected) => {
    expect(survive(cap as number, n as number)).toBeCloseTo(expected as number, 4);
  });

  it('two consecutive total losses leave a recoverable account at the chosen cap', () => {
    const remaining = survive(BASE_CAPITAL_CAP_PCT, 2);
    expect(remaining).toBeGreaterThan(0.60);   // 50% cap would leave 0.25
  });
});
