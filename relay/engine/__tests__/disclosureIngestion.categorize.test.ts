import { describe, it, expect } from 'vitest';
import { categorize } from '../ingestion/disclosureIngestion.ts';

// Real tier-combination strings, taken from disclosureIngestion.ts's own
// locked-decisions comment block (confirmed against live 8-K data,
// 24 tickers / 73 real combinations, 2026-08-14).
describe('categorize — locked 8-K category mapping', () => {
  it('maps financial_results / earnings_and_performance -> earnings', () => {
    expect(categorize('financial_results', 'earnings_and_performance', '')).toBe('earnings');
  });

  it('maps financial_results / guidance_and_outlook -> guidance', () => {
    expect(categorize('financial_results', 'guidance_and_outlook', '')).toBe('guidance');
  });

  it('maps strategic_transactions / acquisition_agreement -> acquisition', () => {
    expect(categorize('strategic_transactions', 'deal_agreements', 'acquisition_agreement')).toBe('acquisition');
  });

  it('maps strategic_transactions / acquisition_completion -> acquisition', () => {
    expect(categorize('strategic_transactions', 'deal_completions', 'acquisition_completion')).toBe('acquisition');
  });

  it('folds merger_agreement into acquisition', () => {
    expect(categorize('strategic_transactions', 'deal_agreements', 'merger_agreement')).toBe('acquisition');
  });

  it('folds merger_completion into acquisition', () => {
    expect(categorize('strategic_transactions', 'deal_completions', 'merger_completion')).toBe('acquisition');
  });

  it('maps strategic_transactions / divestiture_agreement -> divestiture', () => {
    expect(categorize('strategic_transactions', 'deal_agreements', 'divestiture_agreement')).toBe('divestiture');
  });

  it('folds spinoff_completion into divestiture', () => {
    expect(categorize('strategic_transactions', 'deal_completions', 'spinoff_completion')).toBe('divestiture');
  });

  it('maps operations_and_strategy / restructuring -> restructuring', () => {
    expect(categorize('operations_and_strategy', 'restructuring', '')).toBe('restructuring');
  });

  it('maps any regulatory_and_compliance primary -> regulatory, regardless of secondary/tertiary', () => {
    expect(categorize('regulatory_and_compliance', 'anything_here', 'whatever')).toBe('regulatory');
  });

  it('maps leadership_and_governance / executive_leadership -> leadership', () => {
    expect(categorize('leadership_and_governance', 'executive_leadership', 'ceo_departure')).toBe('leadership');
  });

  it('maps leadership_and_governance / corporate_control -> leadership', () => {
    expect(categorize('leadership_and_governance', 'corporate_control', 'going_private_transaction')).toBe('leadership');
  });

  it('maps leadership_and_governance / board_of_directors -> other (routine, not material)', () => {
    expect(categorize('leadership_and_governance', 'board_of_directors', 'director_appointment')).toBe('other');
  });

  it('maps leadership_and_governance / governance_documents -> other (routine, not material)', () => {
    expect(categorize('leadership_and_governance', 'governance_documents', 'bylaw_amendment')).toBe('other');
  });

  it('maps capital_and_financing / shareholder_returns / dividend_declaration -> dividend', () => {
    expect(categorize('capital_and_financing', 'shareholder_returns', 'dividend_declaration')).toBe('dividend');
  });

  it('maps capital_and_financing / shareholder_returns / dividend_policy_change -> dividend', () => {
    expect(categorize('capital_and_financing', 'shareholder_returns', 'dividend_policy_change')).toBe('dividend');
  });

  it('maps capital_and_financing / shareholder_returns / share_repurchase_program -> buyback', () => {
    expect(categorize('capital_and_financing', 'shareholder_returns', 'share_repurchase_program')).toBe('buyback');
  });

  it('maps capital_and_financing / debt_activity -> debt', () => {
    expect(categorize('capital_and_financing', 'debt_activity', 'debt_issuance')).toBe('debt');
  });

  it('maps capital_and_financing / equity_activity -> equity', () => {
    expect(categorize('capital_and_financing', 'equity_activity', 'public_offering')).toBe('equity');
  });

  it('maps shareholder_activity / shareholder_activism -> activism', () => {
    expect(categorize('shareholder_activity', 'shareholder_activism', 'activist_investor_campaign')).toBe('activism');
  });

  it('maps tender_offer (ambiguous, real data does not disambiguate) -> other', () => {
    expect(categorize('tender_offer', '', '')).toBe('other');
  });

  it('maps an unmatched real-world combo (e.g. debt distress) -> other', () => {
    expect(categorize('capital_and_financing', 'debt_distress', '')).toBe('other');
  });

  it('maps a completely unrecognized combo -> other (safe default)', () => {
    expect(categorize('some_unknown_primary', 'some_unknown_secondary', 'some_unknown_tertiary')).toBe('other');
  });
});
