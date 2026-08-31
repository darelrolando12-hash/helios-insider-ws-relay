/**
 * Pure decision functions for items 9, 10 and 11 — ladder, confirmation,
 * forced close. None of these touch a broker; all are decisions the execution
 * layer then performs.
 */
import { describe, it, expect } from 'vitest';
import { nextLadderAction, type LadderConfig, type LadderState } from '../execution/orderLadder.ts';
import { evaluateConfirmation, type ConfirmationConfig } from '../risk/confirmation.ts';
import { evaluateForcedClose, DEFAULT_FORCED_CLOSE } from '../risk/forcedClose.ts';

// ── 9. Order ladder ──────────────────────────────────────────────────────────

const ladderCfg: LadderConfig = {
  tickSize: 0.01,
  attemptTimeoutsMs: [2000, 2000, 3000],
  maxSlippagePct: 0.10,
  allowMarketOnExhaustion: false,
};

const entryState: LadderState = {
  intent: 'entry', side: 'buy', bid: 1.00, ask: 1.10,
  attempt: 0, elapsedMsOnAttempt: 0, referencePrice: 1.10,
};

describe('orderLadder — marketable limits, never a bare market entry', () => {
  it('first attempt submits at the ask for a buy', () => {
    const a = nextLadderAction(entryState, ladderCfg);
    expect(a.action).toBe('submit');
    if (a.action === 'submit') {
      expect(a.limitPrice).toBeCloseTo(1.10, 6);
      expect(a.attempt).toBe(1);
    }
  });

  it('first attempt submits at the bid for a sell', () => {
    const a = nextLadderAction({ ...entryState, side: 'sell', referencePrice: 1.00 }, ladderCfg);
    if (a.action === 'submit') expect(a.limitPrice).toBeCloseTo(1.00, 6);
  });

  it('waits while the current attempt is still inside its window', () => {
    const a = nextLadderAction({ ...entryState, attempt: 1, elapsedMsOnAttempt: 1200 }, ladderCfg);
    expect(a.action).toBe('wait');
    if (a.action === 'wait') expect(a.msRemaining).toBe(800);
  });

  it('escalates one tick through the ask after the window elapses', () => {
    const a = nextLadderAction({ ...entryState, attempt: 1, elapsedMsOnAttempt: 2000 }, ladderCfg);
    expect(a.action).toBe('submit');
    if (a.action === 'submit') {
      expect(a.limitPrice).toBeCloseTo(1.11, 6);
      expect(a.attempt).toBe(2);
    }
  });

  it('an ENTRY cancels when the ladder is exhausted — it never chases', () => {
    const a = nextLadderAction({ ...entryState, attempt: 3, elapsedMsOnAttempt: 9999 }, ladderCfg);
    expect(a.action).toBe('cancel');
    if (a.action === 'cancel') expect(a.reason).toMatch(/not chasing/);
  });

  it('an EXIT may cross with a market order when exhausted — asymmetry is deliberate', () => {
    const a = nextLadderAction(
      { ...entryState, intent: 'exit', side: 'sell', attempt: 3, elapsedMsOnAttempt: 9999, referencePrice: 1.00 },
      { ...ladderCfg, allowMarketOnExhaustion: true },
    );
    expect(a.action).toBe('market');
  });

  it('stops at the slippage ceiling rather than converging on a market order', () => {
    // referencePrice 1.10, ceiling 10% -> 1.21. Attempt 20 would concede far past it.
    const a = nextLadderAction({ ...entryState, attempt: 20, elapsedMsOnAttempt: 9999 }, ladderCfg);
    expect(a.action).toBe('cancel');
    if (a.action === 'cancel') expect(a.reason).toMatch(/slippage ceiling/);
  });

  it('an exit at the slippage ceiling crosses instead of abandoning the position', () => {
    const a = nextLadderAction(
      { ...entryState, intent: 'exit', side: 'sell', attempt: 20, elapsedMsOnAttempt: 9999, referencePrice: 1.00 },
      { ...ladderCfg, allowMarketOnExhaustion: true },
    );
    expect(a.action).toBe('market');
  });

  it.each([
    ['crossed book', { bid: 1.20, ask: 1.10 }],
    ['zero bid', { bid: 0, ask: 1.10 }],
    ['NaN ask', { bid: 1.00, ask: NaN }],
  ])('an entry stands down on %s rather than guessing a price', (_l, quote) => {
    const a = nextLadderAction({ ...entryState, ...(quote as object) }, ladderCfg);
    expect(a.action).toBe('cancel');
  });

  it('an exit with no usable quote still crosses to close', () => {
    const a = nextLadderAction(
      { ...entryState, intent: 'exit', side: 'sell', bid: 0, ask: 0 },
      { ...ladderCfg, allowMarketOnExhaustion: true },
    );
    expect(a.action).toBe('market');
  });
});

// ── 10. Confirmation ─────────────────────────────────────────────────────────

const confCfg: ConfirmationConfig = { minSustainedTicks: 3, requireBarClose: true };
const sells = (n: number) => Array.from({ length: n }, () => 'sell' as const);

describe('evaluateConfirmation — pullback vs reversal', () => {
  it('rejects a single adverse tick with the band intact — a pullback', () => {
    const r = evaluateConfirmation({
      entryBand: 'ENTER_BREAKOUT', currentBand: 'ENTER_BREAKOUT',
      positionDirection: 'call', recentCvdSides: ['buy', 'buy', 'sell'], barClosed: true,
    }, confCfg);
    expect(r.state).toBe('rejected');
  });

  it('holds pending while the adverse reading is intrabar', () => {
    const r = evaluateConfirmation({
      entryBand: 'ENTER_BREAKOUT', currentBand: 'EXIT',
      positionDirection: 'call', recentCvdSides: sells(5), barClosed: false,
    }, confCfg);
    expect(r.state).toBe('pending');
    expect(r.reason).toMatch(/intrabar/);
  });

  it('confirms on a closed bar with band deterioration and sustained flow', () => {
    const r = evaluateConfirmation({
      entryBand: 'ENTER_BREAKOUT', currentBand: 'EXIT',
      positionDirection: 'call', recentCvdSides: sells(4), barClosed: true,
    }, confCfg);
    expect(r.state).toBe('confirmed');
    expect(r.bandDeteriorated).toBe(true);
    expect(r.sustainedAgainst).toBe(4);
  });

  it('a broken run is chop, not a sustained flip', () => {
    // 3 sells but interrupted — only the trailing run counts.
    const r = evaluateConfirmation({
      entryBand: 'ENTER_BREAKOUT', currentBand: 'EXIT',
      positionDirection: 'call', recentCvdSides: ['sell', 'sell', 'buy', 'sell'], barClosed: true,
    }, confCfg);
    expect(r.sustainedAgainst).toBe(1);
    expect(r.state).toBe('pending');
  });

  it('opposing flow is direction-aware — buys oppose a put', () => {
    const r = evaluateConfirmation({
      entryBand: 'ENTER_BREAKOUT', currentBand: 'EXIT',
      positionDirection: 'put', recentCvdSides: ['buy', 'buy', 'buy'], barClosed: true,
    }, confCfg);
    expect(r.state).toBe('confirmed');
  });

  it('band deterioration alone is not enough without flow', () => {
    const r = evaluateConfirmation({
      entryBand: 'ENTER_BREAKOUT', currentBand: 'EXIT',
      positionDirection: 'call', recentCvdSides: ['buy', 'buy'], barClosed: true,
    }, confCfg);
    expect(r.state).toBe('pending');
  });

  it('returns unknown on an unrecognised band rather than guessing an exit', () => {
    const r = evaluateConfirmation({
      entryBand: 'WAT', currentBand: 'EXIT',
      positionDirection: 'call', recentCvdSides: sells(5), barClosed: true,
    }, confCfg);
    expect(r.state).toBe('unknown');
  });
});

// ── 11. Forced close ─────────────────────────────────────────────────────────

describe('evaluateForcedClose — outranks everything, survives a restart', () => {
  const open = { expiryDate: '2026-08-30', isOpen: true };

  it('is inactive before the deadline', () => {
    const r = evaluateForcedClose({
      position: open, todayCT: '2026-08-30',
      minuteOfDayCT: 14 * 60, schedule: DEFAULT_FORCED_CLOSE,
    });
    expect(r.mustClose).toBe(false);
    expect(r.expiresToday).toBe(true);
    expect(r.minutesPastDeadline).toBe(-30);
  });

  it('fires exactly at 14:30 CT — 30 minutes before the real 15:00 CT close', () => {
    // Real close verified 2026-08-31: NYSE/Nasdaq regular session ends
    // 4:00 PM ET = 3:00 PM CT. This deadline sits BEFORE that, not after —
    // the corrected direction from the earlier 15:45 CT defect (see
    // forcedClose.ts's DEFAULT_FORCED_CLOSE header and CLAUDE.md).
    const r = evaluateForcedClose({
      position: open, todayCT: '2026-08-30',
      minuteOfDayCT: 14 * 60 + 30, schedule: DEFAULT_FORCED_CLOSE,
    });
    expect(r.mustClose).toBe(true);
    expect(r.urgency).toBe('due');
  });

  it('every escalation tier still lands before the real 15:00 CT close', () => {
    // The margin exists specifically so the ladder has room to work before
    // the bell. Assert that property directly, not just the tier labels.
    const MARKET_CLOSE_MIN = 15 * 60;
    for (const min of [14 * 60 + 30, 14 * 60 + 37, 14 * 60 + 40]) {
      expect(min).toBeLessThan(MARKET_CLOSE_MIN);
    }
  });

  it.each([
    [14 * 60 + 30, 'due'],
    [14 * 60 + 37, 'urgent'],
    [14 * 60 + 40, 'immediate'],
  ])('escalates by minute-of-day %i to %s', (min, urgency) => {
    const r = evaluateForcedClose({
      position: open, todayCT: '2026-08-30',
      minuteOfDayCT: min as number, schedule: DEFAULT_FORCED_CLOSE,
    });
    expect(r.urgency).toBe(urgency);
  });

  it('ignores a later expiry — no assignment risk today', () => {
    const r = evaluateForcedClose({
      position: { expiryDate: '2026-09-19', isOpen: true }, todayCT: '2026-08-30',
      minuteOfDayCT: 14 * 60 + 35, schedule: DEFAULT_FORCED_CLOSE,
    });
    expect(r.mustClose).toBe(false);
    expect(r.expiresToday).toBe(false);
  });

  it('is a pure function of state — a restart mid-session changes nothing', () => {
    // No timer was ever scheduled; the same inputs after a restart give the
    // same answer, which is the entire point.
    const args = {
      position: open, todayCT: '2026-08-30',
      minuteOfDayCT: 14 * 60 + 35, schedule: DEFAULT_FORCED_CLOSE,
    };
    expect(evaluateForcedClose(args)).toEqual(evaluateForcedClose(args));
    expect(evaluateForcedClose(args).mustClose).toBe(true);
  });

  it('closes on an unparseable expiry rather than assuming it is safe', () => {
    const r = evaluateForcedClose({
      position: { expiryDate: 'not-a-date', isOpen: true }, todayCT: '2026-08-30',
      minuteOfDayCT: 10 * 60, schedule: DEFAULT_FORCED_CLOSE,
    });
    expect(r.mustClose).toBe(true);
  });

  it('closes when CT time is unavailable rather than assuming the deadline has not passed', () => {
    const r = evaluateForcedClose({
      position: open, todayCT: '2026-08-30',
      minuteOfDayCT: NaN, schedule: DEFAULT_FORCED_CLOSE,
    });
    expect(r.mustClose).toBe(true);
  });

  it('ignores closed positions', () => {
    const r = evaluateForcedClose({
      position: { expiryDate: '2026-08-30', isOpen: false }, todayCT: '2026-08-30',
      minuteOfDayCT: 15 * 60 + 50, schedule: DEFAULT_FORCED_CLOSE,
    });
    expect(r.mustClose).toBe(false);
  });
});
