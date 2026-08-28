import { describe, it, expect } from 'vitest';
import {
  computeGex,
  perStrikeCallGex,
  perStrikePutGex,
  classifyRegime,
  computeFlipLevel,
  computeMaxPain,
  type StrikeData,
} from '../engines/gexEngine';

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

describe('computeFlipLevel', () => {
  it('interpolates a sane flip level between two strikes when cumulative GEX crosses zero', () => {
    // Hand-computed: strikes at 100 (net -40), 110 (net +20), 120 (net +75)
    // cumulative: -40 -> -20 -> +55, sign flips between strike 110 and 120
    // t = 20 / (20 + 55) = 4/15, flip = 110 + (4/15)*10 = 112.6666...
    const strikeGex = [
      { strike: 100, callGex: 10, putGex: 50 },
      { strike: 110, callGex: 30, putGex: 10 },
      { strike: 120, callGex: 80, putGex: 5 },
    ];
    expect(computeFlipLevel(strikeGex, 110)).toBeCloseTo(112.6667, 3);
  });

  it('returns spot price when no sign change exists in the chain', () => {
    const strikeGex = [
      { strike: 100, callGex: 10, putGex: 1 },
      { strike: 110, callGex: 20, putGex: 1 },
      { strike: 120, callGex: 30, putGex: 1 },
    ];
    expect(computeFlipLevel(strikeGex, 505)).toBe(505);
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

  it('computes put/call OI ratio correctly', () => {
    const result = computeGex('TEST', spot, strikes, 123456);
    // totalCallOI = 1000, totalPutOI = 900 -> pcRatio = 0.9
    expect(result!.pcRatio).toBeCloseTo(0.9, 5);
  });

  it('falls back flipLevel to spot when cumulative GEX never crosses zero', () => {
    const result = computeGex('TEST', spot, strikes, 123456);
    // cumulative stays negative across all 3 strikes in this dataset -> no crossing
    expect(result!.flipLevel).toBe(spot);
  });
});
