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

function makeFund(disclosures: EightKDisclosure[]): FundamentalsData {
  return {
    ticker:              'MSTR',
    shortInterest:       null,
    shortVolume:         null,
    shortVolumeRatio:    null,
    insiderTransactions: [],
    recentDisclosures:   disclosures,
    ratios:              null,
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
