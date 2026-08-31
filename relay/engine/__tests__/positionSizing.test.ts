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
    expect(['budget-below-one-contract', 'equity-below-options-viable']).toContain(r.reason);
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
