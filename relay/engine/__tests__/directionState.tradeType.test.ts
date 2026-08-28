import { describe, it, expect } from 'vitest';
import { computeTradeType } from '../state/directionState.ts';

// CONTINUATION_GAP_MS is 90 * 60 * 1000 in directionState.ts — not exported,
// hardcoded here with the same real value to keep assertions self-contained.
const CONTINUATION_GAP_MS = 90 * 60 * 1000;

describe('computeTradeType', () => {
  it('returns with_session when call direction matches bullish bias', () => {
    expect(computeTradeType('call', 'bullish', null, null)).toBe('with_session');
  });

  it('returns with_session when put direction matches bearish bias', () => {
    expect(computeTradeType('put', 'bearish', null, null)).toBe('with_session');
  });

  it('returns counter_session when call direction is against bearish bias', () => {
    expect(computeTradeType('call', 'bearish', null, null)).toBe('counter_session');
  });

  it('returns counter_session when put direction is against bullish bias', () => {
    expect(computeTradeType('put', 'bullish', null, null)).toBe('counter_session');
  });

  it('returns with_session for a call when bias is neutral', () => {
    expect(computeTradeType('call', 'neutral', null, null)).toBe('with_session');
  });

  it('returns with_session for a put when bias is neutral', () => {
    expect(computeTradeType('put', 'neutral', null, null)).toBe('with_session');
  });

  it('returns continuation when priorDirection matches direction within the 90-minute window', () => {
    const priorResolvedAt = Date.now() - (30 * 60 * 1000); // 30 min ago, inside window
    // Even with a mismatched bias, continuation is checked first and wins.
    expect(computeTradeType('call', 'bearish', 'call', priorResolvedAt)).toBe('continuation');
  });

  it('returns continuation for puts too, matching direction within the window', () => {
    const priorResolvedAt = Date.now() - (10 * 60 * 1000);
    expect(computeTradeType('put', 'bullish', 'put', priorResolvedAt)).toBe('continuation');
  });

  it('does NOT return continuation when priorDirection differs from direction, even within the window', () => {
    const priorResolvedAt = Date.now() - (10 * 60 * 1000);
    expect(computeTradeType('call', 'bullish', 'put', priorResolvedAt)).toBe('with_session');
  });

  it('does NOT return continuation when priorResolvedAt is outside the 90-minute window', () => {
    const priorResolvedAt = Date.now() - CONTINUATION_GAP_MS - 1000; // just past the window
    expect(computeTradeType('call', 'bullish', 'call', priorResolvedAt)).toBe('with_session');
  });

  it('does NOT return continuation exactly at the 90-minute boundary (strict <)', () => {
    const priorResolvedAt = Date.now() - CONTINUATION_GAP_MS; // exactly at the edge
    // Date.now() - priorResolvedAt === CONTINUATION_GAP_MS, and the check is strict "<"
    expect(computeTradeType('call', 'bullish', 'call', priorResolvedAt)).toBe('with_session');
  });

  it('does NOT return continuation when priorDirection is null, regardless of priorResolvedAt', () => {
    const priorResolvedAt = Date.now() - (5 * 60 * 1000);
    expect(computeTradeType('call', 'bullish', null, priorResolvedAt)).toBe('with_session');
  });

  it('does NOT return continuation when priorResolvedAt is null, regardless of priorDirection', () => {
    expect(computeTradeType('call', 'bullish', 'call', null)).toBe('with_session');
  });
});
