/**
 * insiderIngestion.resolveTransactionType() — real, quantified fix (2026-09-02).
 *
 * Previously derived from transaction_acquired_disposed alone ('A' -> buy,
 * 'D' -> sell). Real audit found 97.5% of what that produced was noise:
 * company compensation grants (code A) and derivative exercises (code M),
 * neither a genuine open-market transaction. Confirmed against a real SEC
 * Form 5 filing's own instructions and four independent sources: only P
 * (buy) and S (sell) are "General Transaction Codes" — a real, voluntary,
 * open-market event. Every other code is a structurally different kind of
 * event and must resolve to 'other', regardless of A/D direction.
 */
import { describe, it, expect } from 'vitest';
import { resolveTransactionType, form4RowId } from '../ingestion/insiderIngestion.ts';
import type { MassiveForm4Result } from '../lib/massive/api.ts';

function makeForm4(overrides: Partial<MassiveForm4Result> = {}): MassiveForm4Result {
  return {
    tickers: ['TEST'],
    issuer_cik: '0000000000',
    owner_cik: '0000000001',
    accession_number: '0000000000-26-000001',
    form_type: '4',
    filing_date: '2026-08-01',
    period_of_report: '2026-08-01',
    issuer_name: 'Test Corp',
    owner_name: 'Test Insider',
    is_director: false,
    is_officer: true,
    is_ten_percent_owner: false,
    is_other: false,
    security_type: 'non_derivative',
    record_type: 'transaction',
    security_title: 'Common Stock',
    aff_10b5_one: false,
    transaction_date: '2026-08-01',
    transaction_code: 'P',
    transaction_acquired_disposed: 'A',
    transaction_shares: 100,
    transaction_price_per_share: 50,
    transaction_value: 5000,
    direct_or_indirect: 'D',
    filing_url: 'https://example.com',
    ...overrides,
  };
}

describe('resolveTransactionType — real SEC transaction codes, not A/D direction', () => {
  it('code P (open-market purchase) resolves to buy', () => {
    expect(resolveTransactionType(makeForm4({ transaction_code: 'P', transaction_acquired_disposed: 'A' }))).toBe('buy');
  });

  it('code S (open-market sale) resolves to sell', () => {
    expect(resolveTransactionType(makeForm4({ transaction_code: 'S', transaction_acquired_disposed: 'D' }))).toBe('sell');
  });

  it('code A (company grant/award) is "other", NOT buy, even though A/D says acquired', () => {
    expect(resolveTransactionType(makeForm4({ transaction_code: 'A', transaction_acquired_disposed: 'A' }))).toBe('other');
  });

  it('code M (derivative/option exercise) is "other", NOT buy — the largest real-world noise source (62.5% of "A" rows in the live audit)', () => {
    expect(resolveTransactionType(makeForm4({ transaction_code: 'M', transaction_acquired_disposed: 'A' }))).toBe('other');
  });

  it.each(['A', 'D', 'F', 'G', 'C', 'J', 'I', 'K', 'V', 'W', 'X', 'Z'])(
    'code %s is "other" regardless of A/D direction',
    (code) => {
      expect(resolveTransactionType(makeForm4({ transaction_code: code, transaction_acquired_disposed: 'A' }))).toBe('other');
      expect(resolveTransactionType(makeForm4({ transaction_code: code, transaction_acquired_disposed: 'D' }))).toBe('other');
    },
  );

  it('a real gift given away (code G, acquired_disposed D) is NOT a sell', () => {
    expect(resolveTransactionType(makeForm4({ transaction_code: 'G', transaction_acquired_disposed: 'D' }))).toBe('other');
  });

  it('missing/undefined transaction_code (e.g. a holding row) is "other", not a crash', () => {
    expect(resolveTransactionType(makeForm4({ transaction_code: undefined }))).toBe('other');
  });
});

describe('form4RowId — real collisions found live, 2026-09-02', () => {
  it('a same-day sale split across a material price band gets distinct ids (real NVDA case)', () => {
    const base = makeForm4({
      accession_number: '0001199039-26-000005', owner_cik: '0001199039',
      security_type: 'non_derivative', security_title: 'Common Stock',
      transaction_code: 'S', transaction_date: '2026-06-04',
    });
    const tranche1 = { ...base, transaction_shares: 100000, transaction_price_per_share: 217.655, shares_owned_following_transaction: 6799771 };
    const tranche2 = { ...base, transaction_shares: 400000, transaction_price_per_share: 220.371, shares_owned_following_transaction: 6399771 };
    expect(form4RowId(tranche1)).not.toBe(form4RowId(tranche2));
  });

  it('two different indirect ownership vehicles with an identical running total get distinct ids (real NVDA/Huang case)', () => {
    const base = makeForm4({
      accession_number: '0001197649-26-000008', owner_cik: '0001197649',
      record_type: 'holding', security_type: 'non_derivative', security_title: 'Common Stock',
      direct_or_indirect: 'I', shares_owned_following_transaction: 6632667,
    });
    const llc1 = { ...base, nature_of_ownership: 'By Limited Liability Company 1' };
    const llc2 = { ...base, nature_of_ownership: 'By Limited Liability Company 2' };
    expect(form4RowId(llc1)).not.toBe(form4RowId(llc2));
  });

  it('two share classes held by the same trust with an identical running total get distinct ids (real GOOGL/Shriram case)', () => {
    const base = makeForm4({
      accession_number: '0001193125-26-274727', owner_cik: '0001295084',
      record_type: 'holding', security_type: 'non_derivative',
      direct_or_indirect: 'I', shares_owned_following_transaction: 199100,
      nature_of_ownership: 'Ram Shriram TR UA 09/10/2021 2021 RS Irrevocable Trust',
    });
    const classA = { ...base, security_title: 'Class A Common Stock' };
    const classC = { ...base, security_title: 'Class C Capital Stock' };
    expect(form4RowId(classA)).not.toBe(form4RowId(classC));
  });

  it('multiple option-lot exercises that all net to zero owned-after get distinct ids by shares/price (real NFLX case)', () => {
    const base = makeForm4({
      accession_number: '0001065280-26-000191', owner_cik: '0001193119',
      security_type: 'derivative', security_title: 'Non-Qualified Stock Option (right to buy)',
      transaction_code: 'M', transaction_date: '2026-06-17', shares_owned_following_transaction: 0,
    });
    const lot1 = { ...base, transaction_shares: 6420, transaction_price_per_share: 0 };
    const lot2 = { ...base, transaction_shares: 5070, transaction_price_per_share: 0 };
    expect(form4RowId(lot1)).not.toBe(form4RowId(lot2));
  });

  it('two DEU/GSU grant tranches with the identical 1-share/$0 shape get distinct ids by running total (real GOOGL/Ferguson case)', () => {
    const base = makeForm4({
      accession_number: '0001193125-26-274731', owner_cik: '0001487637',
      security_type: 'non_derivative', security_title: 'Class C Google Stock Units',
      transaction_code: 'A', transaction_date: '2026-06-15',
      transaction_shares: 1, transaction_price_per_share: 0,
    });
    const tranche1 = { ...base, shares_owned_following_transaction: 1558 };
    const tranche2 = { ...base, shares_owned_following_transaction: 1026 };
    expect(form4RowId(tranche1)).not.toBe(form4RowId(tranche2));
  });

  it('two real same-day sale tranches reported under one shared end-of-day total get distinct ids by shares/price (real PLTR case)', () => {
    const base = makeForm4({
      accession_number: '0001823951-26-000009', owner_cik: '0001823951',
      security_type: 'non_derivative', security_title: 'Class A Common Stock',
      transaction_code: 'S', transaction_date: '2026-08-20', shares_owned_following_transaction: 6432258,
    });
    const tranche1 = { ...base, transaction_shares: 1304, transaction_price_per_share: 176.3133 };
    const tranche2 = { ...base, transaction_shares: 500, transaction_price_per_share: 176.302 };
    expect(form4RowId(tranche1)).not.toBe(form4RowId(tranche2));
  });

  it('a genuinely identical row produces the same id (idempotent upsert target)', () => {
    const r = makeForm4({ accession_number: '0001-26-000001' });
    expect(form4RowId(r)).toBe(form4RowId({ ...r }));
  });
});
