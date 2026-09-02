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
      ticker: 'ZZZQ5', shortFloat: 0.05, shortInterest: 1000000,
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
