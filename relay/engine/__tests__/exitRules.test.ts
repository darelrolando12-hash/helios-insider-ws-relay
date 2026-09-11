import { describe, it, expect } from 'vitest';
import { evaluateExit, DEFAULT_EXIT_PARAMS, SESSION_CUTOFF_CT_MIN, type OpenPosition, type ExitParams } from '../exits/exitRules.ts';

const call: OpenPosition = {
  direction: 'call', entryMinute: 600, entryPremium: 2.0,
  thesis: { holds: 'above', level: 100, label: 'above VWAP' }, target: 105,
};
const bar = (minute: number, close: number, high = close, low = close) => ({ minute, high, low, close });
const only = (p: Partial<ExitParams>): ExitParams => ({
  sessionCutoffMin: null, maxLossPct: null, useThesis: false, useTarget: false, timeStopMin: null, maxHoldMin: null, ...p,
});

describe('evaluateExit', () => {
  it('holds when nothing fires', () => {
    expect(evaluateExit(call, bar(610, 101), 2.2)).toBeNull();
  });

  it('session cutoff at 14:30 CT (3:30 PM ET) beats everything', () => {
    expect(SESSION_CUTOFF_CT_MIN).toBe(870);
    expect(evaluateExit(call, bar(870, 104.9), 3.5)).toBe('session-cutoff');
  });

  it('max loss when the mark has lost half the premium', () => {
    expect(evaluateExit(call, bar(612, 101), 1.0)).toBe('max-loss');
    expect(evaluateExit(call, bar(612, 101), 1.01)).toBeNull();
  });

  it('lost thesis on a CLOSE back through the level, not an intrabar poke', () => {
    expect(evaluateExit(call, bar(615, 100.5, 101, 99.5), 1.9)).toBeNull();
    expect(evaluateExit(call, bar(615, 99.9), 1.9)).toBe('lost-thesis');
  });

  it('target on an intrabar touch, in the position\'s direction', () => {
    expect(evaluateExit(call, bar(615, 104, 105), 3.0)).toBe('target');
    const put: OpenPosition = { ...call, direction: 'put', thesis: null, target: 95 };
    expect(evaluateExit(put, bar(615, 96, 97, 95), 3.0)).toBe('target');
  });

  it('time stop after 30 minutes only when not in profit', () => {
    expect(evaluateExit(call, bar(630, 101), 2.0)).toBe('time-stop');
    expect(evaluateExit(call, bar(630, 101), 2.01)).toBeNull();
    expect(evaluateExit(call, bar(629, 101), 1.5)).toBeNull();
  });

  it('max hold closes regardless of P&L', () => {
    expect(evaluateExit(call, bar(630, 101), 9.0, only({ maxHoldMin: 30 }))).toBe('max-hold');
  });

  it('every rule can be switched off on its own', () => {
    const none = only({});
    expect(evaluateExit(call, bar(900, 50, 200, 10), 0.01, none)).toBeNull();
  });

  it('default params are the four deterministic exits with a 50% max loss', () => {
    expect(DEFAULT_EXIT_PARAMS).toMatchObject({ sessionCutoffMin: 870, maxLossPct: 0.5, useThesis: true, useTarget: true, timeStopMin: 30 });
  });
});
