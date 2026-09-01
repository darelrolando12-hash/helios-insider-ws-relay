/**
 * EXECUTION_MODE must default to 'paper' on every unset or unrecognised
 * input — 'live' is only reachable by an explicit, exact "live" value. Same
 * "safe direction is always do less" rule ENGINE_MODE follows for 'shadow'.
 */
import { describe, it, expect } from 'vitest';
import { parseExecutionMode, orderTypeForMode } from '../execution/executionMode.ts';

describe('parseExecutionMode', () => {
  it('resolves "live" to live', () => {
    expect(parseExecutionMode('live')).toBe('live');
    expect(parseExecutionMode('LIVE')).toBe('live');
    expect(parseExecutionMode(' live ')).toBe('live');
  });

  it.each(['', 'paper', 'PAPER', 'off', 'shadow', 'production', 'typo'])(
    'resolves %j to paper — never falls to live by accident',
    (raw) => {
      expect(parseExecutionMode(raw)).toBe('paper');
    },
  );
});

describe('orderTypeForMode', () => {
  it('paper -> MARKET (proven to fill this sandbox, proven to match real NBBO)', () => {
    expect(orderTypeForMode('paper')).toBe('MARKET');
  });

  it('live -> LIMIT (orderLadder.ts owns the escalation from there)', () => {
    expect(orderTypeForMode('live')).toBe('LIMIT');
  });
});
