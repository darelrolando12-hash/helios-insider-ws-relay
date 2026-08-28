import { describe, it, expect } from 'vitest';
import { computePnlPct, classifyOutcome } from '../ledger/outcomeResolver.ts';

// SCRATCH_BAND_PCT is 2.0 in outcomeResolver.ts — not exported, so these
// tests hardcode the same real value to keep assertions self-contained.
const SCRATCH_BAND_PCT = 2.0;

describe('computePnlPct', () => {
  it('call direction does NOT flip sign — price up is a positive P&L', () => {
    // entry 100 -> exit 105 = +5% raw move, call keeps it positive
    expect(computePnlPct(100, 105, 'call')).toBeCloseTo(5, 5);
  });

  it('call direction does NOT flip sign — price down is a negative P&L', () => {
    expect(computePnlPct(100, 95, 'call')).toBeCloseTo(-5, 5);
  });

  it('put direction DOES flip sign — price up on the underlying is a LOSS for a put', () => {
    // entry 100 -> exit 105 = +5% raw move, put flips it to -5%
    expect(computePnlPct(100, 105, 'put')).toBeCloseTo(-5, 5);
  });

  it('put direction DOES flip sign — price down on the underlying is a WIN for a put', () => {
    expect(computePnlPct(100, 95, 'put')).toBeCloseTo(5, 5);
  });

  it('handles a scratch-band-adjacent value near zero, correctly signed for call', () => {
    // entry 100 -> exit 101.5 = +1.5% raw, inside the 2% scratch band, but
    // computePnlPct itself doesn't know about the band — it just reports sign.
    expect(computePnlPct(100, 101.5, 'call')).toBeCloseTo(1.5, 5);
  });

  it('handles a scratch-band-adjacent value near zero, correctly signed for put', () => {
    expect(computePnlPct(100, 101.5, 'put')).toBeCloseTo(-1.5, 5);
  });
});

describe('classifyOutcome', () => {
  it('classifies a value just INSIDE the scratch band as scratch (boundary is inclusive)', () => {
    expect(classifyOutcome(SCRATCH_BAND_PCT)).toBe('scratch');       // exactly 2.0 — inclusive
    expect(classifyOutcome(-SCRATCH_BAND_PCT)).toBe('scratch');      // exactly -2.0 — inclusive
    expect(classifyOutcome(1.99)).toBe('scratch');
    expect(classifyOutcome(-1.99)).toBe('scratch');
  });

  it('classifies a value just OUTSIDE the scratch band as win/loss', () => {
    expect(classifyOutcome(2.01)).toBe('win');
    expect(classifyOutcome(-2.01)).toBe('loss');
  });

  it('classifies exact zero as scratch', () => {
    expect(classifyOutcome(0)).toBe('scratch');
  });

  it('classifies a clearly positive value as a win', () => {
    expect(classifyOutcome(12.4)).toBe('win');
  });

  it('classifies a clearly negative value as a loss', () => {
    expect(classifyOutcome(-8.7)).toBe('loss');
  });
});
