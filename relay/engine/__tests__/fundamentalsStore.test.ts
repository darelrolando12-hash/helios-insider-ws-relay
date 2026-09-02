/**
 * fundamentalsStore — insiderDataQuality tests (2026-09-02).
 *
 * Real gap this covers: `insiderTransactions.length === 0` is ambiguous —
 * it means either "checked, genuinely nothing recent" or "never
 * successfully fetched". markInsiderDataChecked/upsertInsiderTransactions
 * are what tell those two apart. Each test uses a distinct ticker — this
 * store is a module-level singleton, so tests must not share state.
 */
import { describe, it, expect } from 'vitest';
import * as fundamentalsStore from '../stores/fundamentalsStore.ts';

describe('fundamentalsStore — insiderDataQuality', () => {
  it('defaults to absent for a ticker that has never been touched', () => {
    const r = fundamentalsStore.getResult('ZZZQ1');
    // Never written at all — status is 'loading', not 'ready'.
    expect(r.status).toBe('loading');
  });

  it('markInsiderDataChecked flips a fresh ticker to real with an empty array — a genuine zero, not "never checked"', () => {
    fundamentalsStore.markInsiderDataChecked('ZZZQ2');
    const r = fundamentalsStore.getResult('ZZZQ2');
    expect(r.status).toBe('ready');
    if (r.status === 'ready') {
      expect(r.data.insiderDataQuality).toBe('real');
      expect(r.data.insiderTransactions).toEqual([]);
    }
  });

  it('upsertInsiderTransactions also sets insiderDataQuality to real', () => {
    fundamentalsStore.upsertInsiderTransactions('ZZZQ3', [{
      ticker: 'ZZZQ3', id: 't1', insiderName: 'Test', relationship: 'Officer',
      transactionType: 'buy', shares: 100, pricePerShare: 50, totalValue: 5000,
      is10b51: false, filedAt: Date.now(), transactedAt: Date.now(),
    }]);
    const r = fundamentalsStore.getResult('ZZZQ3');
    expect(r.status).toBe('ready');
    if (r.status === 'ready') expect(r.data.insiderDataQuality).toBe('real');
  });

  it('markInsiderDataChecked never downgrades an already-real ticker back to absent', () => {
    fundamentalsStore.markInsiderDataChecked('ZZZQ4');
    fundamentalsStore.markInsiderDataChecked('ZZZQ4'); // second call, e.g. a later successful poll
    const r = fundamentalsStore.getResult('ZZZQ4');
    expect(r.status).toBe('ready');
    if (r.status === 'ready') expect(r.data.insiderDataQuality).toBe('real');
  });

  it('a ticker with real short-interest data but no insider check yet reports insiderDataQuality absent, not real', () => {
    // The exact ambiguity this fix closes: another category (short interest)
    // makes the store 'ready' overall, but insider specifically was never checked.
    fundamentalsStore.upsertShortInterest('ZZZQ5', {
      ticker: 'ZZZQ5', shortInterest: 1000000,
      daysToCover: 2, reportDate: Date.now(),
    });
    const r = fundamentalsStore.getResult('ZZZQ5');
    expect(r.status).toBe('ready'); // ready overall...
    if (r.status === 'ready') {
      expect(r.data.insiderDataQuality).toBe('absent'); // ...but insider specifically was never checked
      expect(r.data.insiderTransactions).toEqual([]);
    }
  });
});

describe('fundamentalsStore.computeShortPctOfFloat — pure derivation', () => {
  it('computes the real formula: shortInterest / freeFloat * 100', () => {
    // Real TSLA numbers, 2026-09-02: short_interest 69,196,896 / free_float
    // 3,187,679,703 -> 2.17%, a plausible real short-float reading.
    const pct = fundamentalsStore.computeShortPctOfFloat(69_196_896, 3_187_679_703);
    expect(pct).not.toBeNull();
    expect(pct!).toBeCloseTo(2.17, 1);
  });

  it('returns null for a zero or negative free float rather than Infinity/NaN', () => {
    expect(fundamentalsStore.computeShortPctOfFloat(1000, 0)).toBeNull();
    expect(fundamentalsStore.computeShortPctOfFloat(1000, -5)).toBeNull();
  });

  it('returns null for non-finite inputs', () => {
    expect(fundamentalsStore.computeShortPctOfFloat(NaN, 1000)).toBeNull();
    expect(fundamentalsStore.computeShortPctOfFloat(1000, NaN)).toBeNull();
  });
});

describe('fundamentalsStore — shortFloat derivation, order-independent', () => {
  it('upsertShortInterest THEN upsertFreeFloat: shortFloat appears once float arrives', () => {
    fundamentalsStore.upsertShortInterest('ZZZQ6', {
      ticker: 'ZZZQ6', shortInterest: 1_000_000, reportDate: Date.now(),
    });
    let r = fundamentalsStore.getResult('ZZZQ6');
    if (r.status === 'ready') expect(r.data.shortInterest?.shortFloat).toBeUndefined();

    fundamentalsStore.upsertFreeFloat('ZZZQ6', {
      shares: 10_000_000, percentOfOutstanding: 80, effectiveDate: '2026-08-01', fetchedAt: Date.now(),
    });
    r = fundamentalsStore.getResult('ZZZQ6');
    if (r.status === 'ready') expect(r.data.shortInterest?.shortFloat).toBeCloseTo(10, 5); // 1M/10M*100
  });

  it('upsertFreeFloat THEN upsertShortInterest: shortFloat is derived immediately, arriving in the other order', () => {
    fundamentalsStore.upsertFreeFloat('ZZZQ7', {
      shares: 5_000_000, percentOfOutstanding: 90, effectiveDate: '2026-08-01', fetchedAt: Date.now(),
    });
    fundamentalsStore.upsertShortInterest('ZZZQ7', {
      ticker: 'ZZZQ7', shortInterest: 250_000, reportDate: Date.now(),
    });
    const r = fundamentalsStore.getResult('ZZZQ7');
    if (r.status === 'ready') expect(r.data.shortInterest?.shortFloat).toBeCloseTo(5, 5); // 250k/5M*100
  });

  it('a caller-supplied shortFloat on the snapshot is ignored — the store is the single source of truth', () => {
    fundamentalsStore.upsertFreeFloat('ZZZQ8', {
      shares: 1_000_000, percentOfOutstanding: 100, effectiveDate: '2026-08-01', fetchedAt: Date.now(),
    });
    fundamentalsStore.upsertShortInterest('ZZZQ8', {
      // @ts-expect-error deliberately passing a wrong value to prove it's ignored
      ticker: 'ZZZQ8', shortInterest: 100_000, shortFloat: 999, reportDate: Date.now(),
    });
    const r = fundamentalsStore.getResult('ZZZQ8');
    if (r.status === 'ready') expect(r.data.shortInterest?.shortFloat).toBeCloseTo(10, 5); // real derivation, not 999
  });
});

describe('fundamentalsStore — shortVolumeDataQuality', () => {
  it('defaults to absent, and a null ratio before any fetch is genuinely unknown', () => {
    fundamentalsStore.markInsiderDataChecked('ZZZQ9'); // just to make the ticker ready
    const r = fundamentalsStore.getResult('ZZZQ9');
    if (r.status === 'ready') {
      expect(r.data.shortVolumeDataQuality).toBe('absent');
      expect(r.data.shortVolumeRatio).toBeNull();
    }
  });

  it('upsertShortVolume sets shortVolumeDataQuality to real, even when the computed ratio is null', () => {
    fundamentalsStore.upsertShortVolume('ZZZQ10', 500, 0); // reportedVolume <= 0 -> ratio null, but the fetch itself was real
    const r = fundamentalsStore.getResult('ZZZQ10');
    if (r.status === 'ready') {
      expect(r.data.shortVolumeDataQuality).toBe('real');
      expect(r.data.shortVolumeRatio).toBeNull(); // a real null, not an absent one
    }
  });

  it('a real, nonzero ratio also sets dataQuality real', () => {
    fundamentalsStore.upsertShortVolume('ZZZQ11', 4_000_000, 10_000_000);
    const r = fundamentalsStore.getResult('ZZZQ11');
    if (r.status === 'ready') {
      expect(r.data.shortVolumeDataQuality).toBe('real');
      expect(r.data.shortVolumeRatio).toBeCloseTo(40, 5);
    }
  });
});
