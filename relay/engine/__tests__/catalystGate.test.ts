/**
 * catalystGate.computeTags() — gate-level unit tests.
 *
 * disclosureIngestion.categorize.test.ts covers category mapping in
 * isolation. This file covers the actual gate the confluenceEngine reads:
 * whether a disclosure's category + age combine to flip materialEvent,
 * independent of live market timing (materialEvent has never been observed
 * true against real data yet, since the current dataset has no material
 * filing inside the 3-day window right now).
 */

import { describe, it, expect } from 'vitest';
import { computeTags } from '../engines/catalystGate.ts';
import type { FundamentalsData, EightKDisclosure } from '../stores/fundamentalsStore.ts';

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-08-27T00:00:00Z').getTime();

function makeDisclosure(overrides: Partial<EightKDisclosure> = {}): EightKDisclosure {
  return {
    ticker:      'MSTR',
    category:    'buyback',
    summary:     'Test disclosure',
    filedAt:     NOW - DAY_MS,
    accessionNo: '0000000000-00-000000',
    ...overrides,
  };
}

function makeFund(
  disclosures: EightKDisclosure[],
  upcomingEarnings: FundamentalsData['upcomingEarnings'] = null,
): FundamentalsData {
  return {
    ticker:              'MSTR',
    shortInterest:       null,
    shortVolume:         null,
    shortVolumeRatio:    null,
    insiderTransactions: [],
    insiderDataQuality:  'real',
    recentDisclosures:   disclosures,
    ratios:              null,
    upcomingEarnings,
    lastUpdatedAt:        NOW,
  };
}

describe('catalystGate.computeTags — materialEvent gate', () => {
  it('is true for a material category filed 1 day ago (inside the 3-day window)', () => {
    const fund = makeFund([
      makeDisclosure({ category: 'buyback', filedAt: NOW - 1 * DAY_MS }),
    ]);
    expect(computeTags('MSTR', fund, NOW).materialEvent).toBe(true);
  });

  it('is false for the same material category filed 5 days ago (outside the window)', () => {
    const fund = makeFund([
      makeDisclosure({ category: 'buyback', filedAt: NOW - 5 * DAY_MS }),
    ]);
    expect(computeTags('MSTR', fund, NOW).materialEvent).toBe(false);
  });

  it('is false for a non-material category filed 1 day ago', () => {
    const fund = makeFund([
      makeDisclosure({ category: 'other', filedAt: NOW - 1 * DAY_MS }),
    ]);
    expect(computeTags('MSTR', fund, NOW).materialEvent).toBe(false);
  });
});

describe('catalystGate.computeTags — earningsPending, forward-looking (earningsCalendarIngestion)', () => {
  function dateStr(ms: number): string {
    return new Date(ms).toISOString().slice(0, 10);
  }

  it('is true for a real calendar date 3 days out, with NO 8-K present at all', () => {
    const fund = makeFund([], {
      reportDate: dateStr(NOW + 3 * DAY_MS),
      timing: 'amc',
      epsForecast: 1.23,
      numEstimates: 8,
      fetchedAt: NOW,
    });
    expect(computeTags('MSTR', fund, NOW).earningsPending).toBe(true);
  });

  it('is false for a calendar date 10 days out — outside the 7-day lookahead', () => {
    const fund = makeFund([], {
      reportDate: dateStr(NOW + 10 * DAY_MS),
      timing: 'bmo',
      epsForecast: null,
      numEstimates: null,
      fetchedAt: NOW,
    });
    expect(computeTags('MSTR', fund, NOW).earningsPending).toBe(false);
  });

  it('is false for a calendar date that has already passed — no store mutation needed for this', () => {
    const fund = makeFund([], {
      reportDate: dateStr(NOW - 1 * DAY_MS),
      timing: 'amc',
      epsForecast: null,
      numEstimates: null,
      fetchedAt: NOW,
    });
    expect(computeTags('MSTR', fund, NOW).earningsPending).toBe(false);
  });

  it('is true on the exact report date itself (boundary is inclusive)', () => {
    const fund = makeFund([], {
      reportDate: dateStr(NOW),
      timing: 'unknown',
      epsForecast: null,
      numEstimates: null,
      fetchedAt: NOW,
    });
    expect(computeTags('MSTR', fund, NOW).earningsPending).toBe(true);
  });

  it('still fires on a backward-looking 8-K when no calendar data exists at all — old behaviour preserved', () => {
    const fund = makeFund([
      makeDisclosure({ category: 'earnings', filedAt: NOW - 1 * DAY_MS }),
    ], null);
    expect(computeTags('MSTR', fund, NOW).earningsPending).toBe(true);
  });

  it('is false when neither a forward calendar date nor a recent 8-K exists', () => {
    const fund = makeFund([], null);
    expect(computeTags('MSTR', fund, NOW).earningsPending).toBe(false);
  });

  it('fires true from EITHER signal independently — forward date stale/absent, 8-K present', () => {
    const fund = makeFund(
      [makeDisclosure({ category: 'earnings', filedAt: NOW - 1 * DAY_MS })],
      { reportDate: dateStr(NOW - 30 * DAY_MS), timing: 'amc', epsForecast: null, numEstimates: null, fetchedAt: NOW },
    );
    const tags = computeTags('MSTR', fund, NOW);
    expect(tags.earningsPending).toBe(true); // via the 8-K, not the stale calendar date
  });
});
