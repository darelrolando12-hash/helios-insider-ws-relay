/**
 * contractDiscovery — preferStrike/preferExpiry real reordering (2026-09-03).
 *
 * Focused on the new soft-preference addition only — the existing
 * fetch/filter/quality-gate/sort pipeline and the Webull walk itself are
 * unchanged and already proven live (see this file's header). These tests
 * mock deps.massive/deps.webull to prove the new reordering +
 * matchedPreference logic in isolation, since real live calls need a real
 * Massive key + Webull sandbox session this test file shouldn't depend on.
 */
import { describe, it, expect } from 'vitest';
import { discoverContract } from '../execution/contractDiscovery.ts';

const SYMBOL = 'SPY';

function makeContract(strike: number, expiration: string, volume: number) {
  return {
    details: { ticker: `O:${SYMBOL}${expiration}C${strike}`, strike_price: strike, expiration_date: expiration, contract_type: 'call' },
    last_quote: { bid: 2.40, ask: 2.50 },
    day: { volume },
    open_interest: 1000,
    greeks: { delta: 0.5 },
    underlying_asset: { price: 450 },
  };
}

function makeMassiveStub(contracts: ReturnType<typeof makeContract>[]) {
  return { fetchOptionsSnapshot: async () => contracts } as any;
}

function makeWebullStub(listedStrikes: number[], expiration: string) {
  return {
    instrumentOptionContracts: async () => ({
      status: 200,
      body: listedStrikes.map((strike) => ({
        symbol: `${SYMBOL}${expiration}C${strike}`,
        root_symbol: SYMBOL,
        strike_price: String(strike),
        expiration_date: expiration,
        instrument_id: `id_${strike}`,
      })),
    }),
  } as any;
}

const REAL_INPUT_BASE = {
  symbol: SYMBOL, right: 'CALL' as const,
  equity: 10_000, riskPct: 0.02, maxPremiumLossPct: 0.5,
  caps: { maxContractsPerPosition: 10, maxPositionPctOfEquity: 0.1, minEquityToTrade: 500 },
  minDaysOut: 0,
};

describe('discoverContract — preferStrike/preferExpiry, real reordering behavior', () => {
  it('with no preference, keeps the existing volume-sorted order (regression guard)', async () => {
    const expiration = '2026-09-05';
    const contracts = [
      makeContract(445, expiration, 100),
      makeContract(450, expiration, 500), // highest real volume -> should win today's default sort
      makeContract(455, expiration, 200),
    ];
    const result = await discoverContract(
      REAL_INPUT_BASE,
      { massive: makeMassiveStub(contracts), webull: makeWebullStub([445, 450, 455], expiration) },
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.candidate.strike).toBe(450);
      expect(result.matchedPreference).toBe(false); // no preference was given
    }
  });

  it('a real preference in the accepted pool is tried first and matchedPreference is true', async () => {
    const expiration = '2026-09-05';
    const contracts = [
      makeContract(445, expiration, 100),
      makeContract(450, expiration, 500), // would win by volume alone
      makeContract(455, expiration, 200), // the real preferred strike, lower volume
    ];
    const result = await discoverContract(
      { ...REAL_INPUT_BASE, preferStrike: 455, preferExpiry: expiration },
      { massive: makeMassiveStub(contracts), webull: makeWebullStub([445, 450, 455], expiration) },
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.candidate.strike).toBe(455); // preference won despite lower volume
      expect(result.rank).toBe(1); // tried first, matched first
      expect(result.matchedPreference).toBe(true);
    }
  });

  it('a preference NOT in the accepted pool falls back to the real unconstrained walk, unaffected', async () => {
    const expiration = '2026-09-05';
    const contracts = [
      makeContract(445, expiration, 100),
      makeContract(450, expiration, 500),
    ];
    // Preferred strike 999 does not exist in this chain at all.
    const result = await discoverContract(
      { ...REAL_INPUT_BASE, preferStrike: 999, preferExpiry: expiration },
      { massive: makeMassiveStub(contracts), webull: makeWebullStub([445, 450], expiration) },
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.candidate.strike).toBe(450); // real fallback to the volume-sorted default
      expect(result.matchedPreference).toBe(false); // honestly reports the fallback, doesn't lie
    }
  });

  it('a preference that exists but is not on Webull falls through to the next real ranked candidate', async () => {
    const expiration = '2026-09-05';
    const contracts = [
      makeContract(445, expiration, 100),
      makeContract(450, expiration, 500),
      makeContract(455, expiration, 200), // the preference — real in the chain, but NOT listed on Webull below
    ];
    const result = await discoverContract(
      { ...REAL_INPUT_BASE, preferStrike: 455, preferExpiry: expiration },
      { massive: makeMassiveStub(contracts), webull: makeWebullStub([445, 450], expiration) }, // 455 absent from Webull's list
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.candidate.strike).toBe(450); // real second-ranked candidate after the preference failed Webull-matching
      expect(result.rank).toBe(2); // preference was attempt #1 (failed), this is #2
      expect(result.matchedPreference).toBe(false);
    }
  });
});
