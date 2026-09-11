import { describe, it, expect } from 'vitest';
import {
  computeGex,
  perStrikeCallGex,
  perStrikePutGex,
  classifyRegime,
  computeMaxPain,
  type StrikeData,
} from '../engines/gexEngine';
import {
  bsGamma,
  computeZeroGamma,
  expiryCloseUtc,
  type GammaContract,
} from '../lib/zeroGamma';

// NEUTRAL_GEX_EPSILON is 50_000_000 in gexEngine.ts — not exported, hardcoded
// here with the same real value so assertions stay self-contained.
const NEUTRAL_GEX_EPSILON = 50_000_000;

describe('perStrikeCallGex / perStrikePutGex', () => {
  // Formula: OI x gamma x spot^2 x 0.01 x 100  ==  OI x gamma x spot^2
  const spot = 500;
  const strike: StrikeData = { strike: 500, callOI: 1000, putOI: 800, callGamma: 0.05, putGamma: 0.04 };

  it('computes call GEX per the documented formula', () => {
    // 1000 * 0.05 * 500^2 * 0.01 * 100 = 12,500,000
    expect(perStrikeCallGex(strike, spot)).toBeCloseTo(12_500_000, 2);
  });

  it('computes put GEX per the documented formula (positive magnitude, sign handled by caller)', () => {
    // 800 * 0.04 * 500^2 * 0.01 * 100 = 8,000,000
    expect(perStrikePutGex(strike, spot)).toBeCloseTo(8_000_000, 2);
  });

  it('scales quadratically with spot price', () => {
    const low  = perStrikeCallGex(strike, 100);
    const high = perStrikeCallGex(strike, 200);
    // doubling spot should 4x the GEX (spot^2 term)
    expect(high).toBeCloseTo(low * 4, 2);
  });
});

describe('classifyRegime', () => {
  it('classifies a clearly positive net GEX as positive', () => {
    expect(classifyRegime(100_000_000)).toBe('positive');
  });

  it('classifies a clearly negative net GEX as negative', () => {
    expect(classifyRegime(-100_000_000)).toBe('negative');
  });

  it('classifies a value just inside the neutral epsilon as neutral', () => {
    expect(classifyRegime(NEUTRAL_GEX_EPSILON - 1)).toBe('neutral');
    expect(classifyRegime(-(NEUTRAL_GEX_EPSILON - 1))).toBe('neutral');
  });

  it('classifies a value exactly at the epsilon boundary as NOT neutral (strict <)', () => {
    expect(classifyRegime(NEUTRAL_GEX_EPSILON)).toBe('positive');
    expect(classifyRegime(-NEUTRAL_GEX_EPSILON)).toBe('negative');
  });
});

// ── Zero gamma (the rebuilt flip level) ─────────────────────────────────────
//
// The old computeFlipLevel walked cumulative per-strike GEX up from the
// lowest strike and returned SPOT when it found no crossing; its own test
// asserted that fallback ("returns spot price when no sign change exists").
// On real chains it produced META $5.00 at a $641 price. See lib/zeroGamma.ts.

describe('bsGamma', () => {
  it('matches the closed form at the money', () => {
    // S = K = 100, T = 1, σ = 0.2, r = q = 0:
    // d1 = σ²T/2 / (σ√T) = 0.1,  φ(0.1) = 0.396953,  Γ = φ(d1) / (S σ √T)
    expect(bsGamma(100, 100, 1, 0.2)).toBeCloseTo(0.396953 / 20, 6);
  });
});

describe('expiryCloseUtc', () => {
  it('is 3:00 PM CT — 20:00Z under CDT, 21:00Z under CST', () => {
    expect(new Date(expiryCloseUtc('2026-09-18')).toISOString()).toBe('2026-09-18T20:00:00.000Z');
    expect(new Date(expiryCloseUtc('2026-12-18')).toISOString()).toBe('2026-12-18T21:00:00.000Z');
  });
});

describe('computeZeroGamma', () => {
  const EXPIRY = '2026-10-16';
  const IV = 0.2;
  const T_DAYS = 30;
  const NOW = expiryCloseUtc(EXPIRY) - T_DAYS * 86_400_000;
  // Calls at 110 and puts at 90, equal OI and IV. Total GEX ∝ Γ(S,110) −
  // Γ(S,90), zero where |d1| is equal for both strikes:
  //   S* = √(110·90) · exp(−σ²T/2) = 99.4987 · 0.998357 = 99.3353
  const symmetric: GammaContract[] = [
    { strike: 110, expiry: EXPIRY, iv: IV, openInterest: 1_000, type: 'call' },
    { strike: 90,  expiry: EXPIRY, iv: IV, openInterest: 1_000, type: 'put'  },
  ];

  it('finds the analytic crossing of a symmetric book', () => {
    const r = computeZeroGamma(symmetric, 100, NOW);
    expect(r.dataQuality).toBe('real');
    expect(r.level!).toBeCloseTo(99.3353, 1);
    expect(r.crossings).toHaveLength(1);
  });

  it('is not moved by a far-from-money artifact row (the META $5 failure)', () => {
    // A deep-ITM $5 call carried a negative Massive gamma and set the old
    // walk's cumulative sum negative. Re-pricing from IV gives it ~0 gamma
    // near spot, so the level stays where the book says it is.
    const withArtifact: GammaContract[] = [
      ...symmetric,
      { strike: 5, expiry: EXPIRY, iv: 1.5, openInterest: 10, type: 'call' },
    ];
    const r = computeZeroGamma(withArtifact, 100, NOW);
    expect(r.level!).toBeCloseTo(99.3353, 1);
  });

  it('returns ABSENT — never spot — when the total never crosses zero', () => {
    const callsOnly = symmetric.filter((c) => c.type === 'call');
    const r = computeZeroGamma(callsOnly, 100, NOW);
    expect(r.level).toBeNull();
    expect(r.dataQuality).toBe('absent');
    expect(r.reason).toMatch(/no zero crossing/);
  });

  it('returns ABSENT when too little open interest carries a usable IV', () => {
    const mostlyNoIv: GammaContract[] = [
      ...symmetric,
      { strike: 100, expiry: EXPIRY, iv: 0, openInterest: 50_000, type: 'call' },
    ];
    const r = computeZeroGamma(mostlyNoIv, 100, NOW);
    expect(r.level).toBeNull();
    expect(r.reason).toMatch(/open interest has a usable IV/);
  });

  it('ignores contracts that have already expired', () => {
    const withExpired: GammaContract[] = [
      ...symmetric,
      { strike: 100, expiry: '2026-09-01', iv: IV, openInterest: 1_000_000, type: 'call' },
    ];
    const r = computeZeroGamma(withExpired, 100, NOW);
    expect(r.level!).toBeCloseTo(99.3353, 1);
    expect(r.oiCoverage).toBe(1);
  });
});

describe('computeMaxPain', () => {
  it('identifies the strike that minimizes aggregate option-holder loss', () => {
    // 90: putOI=100 ; 100: callOI=50, putOI=50 ; 110: callOI=100
    // loss@90  = (100-90)*50(put) + (110-90)*0(put) = 500
    // loss@100 = (100-90)*0(call) + (110-100)*0(put) = 0
    // loss@110 = (110-90)*0(call) + (110-100)*50(call) = 500
    // minimum loss is at strike 100
    const strikes: StrikeData[] = [
      { strike: 90,  callOI: 0,   putOI: 100, callGamma: 0.01, putGamma: 0.01 },
      { strike: 100, callOI: 50,  putOI: 50,  callGamma: 0.01, putGamma: 0.01 },
      { strike: 110, callOI: 100, putOI: 0,   callGamma: 0.01, putGamma: 0.01 },
    ];
    expect(computeMaxPain(strikes)).toBe(100);
  });

  it('returns 0 for an empty strike list', () => {
    expect(computeMaxPain([])).toBe(0);
  });
});

describe('computeGex — full integration against hand-computed values', () => {
  const spot = 500;
  const strikes: StrikeData[] = [
    { strike: 480, callOI: 100, putOI: 500, callGamma: 0.02, putGamma: 0.06 },
    { strike: 500, callOI: 300, putOI: 300, callGamma: 0.05, putGamma: 0.05 },
    { strike: 520, callOI: 600, putOI: 100, callGamma: 0.04, putGamma: 0.015 },
  ];
  // Per-strike (OI x gamma x spot^2, since 0.01*100 cancels to 1):
  //   480: callGex=500,000    putGex=7,500,000
  //   500: callGex=3,750,000  putGex=3,750,000
  //   520: callGex=6,000,000  putGex=375,000
  // totalCallGex=10,250,000  totalPutGex=11,625,000  netGex=-1,375,000

  it('returns null for invalid input (zero spot or empty strikes)', () => {
    expect(computeGex('TEST', 0, strikes, Date.now())).toBeNull();
    expect(computeGex('TEST', spot, [], Date.now())).toBeNull();
  });

  it('computes netGex and regime matching the hand-computed values', () => {
    const result = computeGex('TEST', spot, strikes, 123456);
    expect(result).not.toBeNull();
    expect(result!.callGex).toBeCloseTo(10_250_000, 2);
    expect(result!.putGex).toBeCloseTo(11_625_000, 2);
    expect(result!.netGex).toBeCloseTo(-1_375_000, 2);
    expect(result!.regime).toBe('neutral'); // |−1.375M| < 50M epsilon
  });

  it('picks walls correctly above/below spot', () => {
    const result = computeGex('TEST', spot, strikes, 123456);
    expect(result!.wallAbove).toBe(520); // only strike above spot
    expect(result!.wallBelow).toBe(480); // only strike below spot
    expect(result!.upTarget).toBe(520);  // no second strike above -> falls back to wall
    expect(result!.downTarget).toBe(480); // no second strike below -> falls back to wall
  });

  it('reports a missing wall as ABSENT — never the spot price', () => {
    // Nothing above spot: the old engine returned `spotPrice` as the call
    // wall, which put price "within 0.3% of a wall" — a guaranteed BREAKOUT.
    const belowOnly = strikes.filter((s) => s.strike < spot);
    const result = computeGex('TEST', spot, belowOnly, 123456);
    expect(result!.wallAbove).toBeNull();
    expect(result!.upTarget).toBeNull();
    expect(result!.wallBelow).toBe(480);
  });

  it('a strike with no gamma exposure is not a wall', () => {
    const noGamma: StrikeData[] = [{ strike: 520, callOI: 600, putOI: 0, callGamma: 0, putGamma: 0 }, ...strikes.filter((s) => s.strike < spot)];
    expect(computeGex('TEST', spot, noGamma, 123456)!.wallAbove).toBeNull();
  });

  it('computes put/call OI ratio correctly', () => {
    const result = computeGex('TEST', spot, strikes, 123456);
    // totalCallOI = 1000, totalPutOI = 900 -> pcRatio = 0.9
    expect(result!.pcRatio).toBeCloseTo(0.9, 5);
  });

  it('reports the flip as ABSENT — never spot — when rows carry no expiry or IV', () => {
    // These hand-built rows have OI and gamma only (the backtestEngine shape),
    // so nothing can be re-priced. The old engine returned `spot` here.
    const result = computeGex('TEST', spot, strikes, 123456);
    expect(result!.flipLevel).toBeNull();
    expect(result!.flipAbsentReason).toMatch(/no open interest/);
  });

  it('reports the flip as ABSENT when the caller says the whole chain is not loaded', () => {
    const result = computeGex('TEST', spot, strikes, 123456, null);
    expect(result!.flipLevel).toBeNull();
    expect(result!.flipAbsentReason).toBe('full option chain not loaded yet');
  });

  it('computes the flip from flipStrikes, not from the (possibly truncated) strikes', () => {
    const expiry = '2026-10-16';
    const now = expiryCloseUtc(expiry) - 30 * 86_400_000;
    const full: StrikeData[] = [
      { strike: 110, expiry, callOI: 1_000, putOI: 0, callGamma: 0, putGamma: 0, callIV: 0.2 },
      { strike: 90,  expiry, callOI: 0, putOI: 1_000, callGamma: 0, putGamma: 0, putIV: 0.2 },
    ];
    const result = computeGex('TEST', 100, strikes, now, full);
    expect(result!.flipLevel!).toBeCloseTo(99.3353, 1);
    // Walls still come from `strikes`, untouched.
    expect(result!.wallAbove).toBe(520);
  });
});
