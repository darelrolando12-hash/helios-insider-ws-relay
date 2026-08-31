/**
 * Forced-close detection — pure, state-based, restart-survivable.
 *
 * ── Why this is not optional ──────────────────────────────────────────────
 *
 * OCC auto-exercises any option that finishes $0.01 in the money. Verified
 * against OCC's 2008 rule change filing, SEC documentation, and multiple CBOE
 * regulatory circulars, 2026-08-31 — real, multiply-sourced. A forgotten
 * $1.00 SPY call closing ITM becomes an obligation to buy 100 shares — roughly
 * $65,000 — on an account that may hold $1,000. The risk being managed here is
 * NOT "giving back a winner". It is an assignment the account cannot fund.
 *
 * ASSUMPTION, not independently confirmed: $0.01 is OCC's baseline
 * "ex-by-exception" threshold, but several sources note a member firm may set
 * a different threshold for its own customers. Webull's specific threshold has
 * not been confirmed. Building the deadline around the OCC baseline is the
 * right default — it is the more conservative (lower) of the two plausible
 * values — but this should be verified against Webull's actual exercise
 * policy before this module governs a real account.
 *
 * That is why this outranks conviction, the trailing stop, partial-profit
 * state and the daily limits. The case where you least want to close is
 * exactly the case that creates the assignment.
 *
 * ── Why detection is a pure function of state, not a timer ────────────────
 *
 * A setTimeout scheduled at position open dies with the process, and Railway
 * restarts on every deploy — the same lesson the CVD rebuild taught. So the
 * deadline lives on the POSITION and is re-evaluated on every tick against the
 * current time. A restart at 14:25 CT still closes at 14:30 CT.
 *
 * Central Time is supplied by the caller via lib/time.ts, never computed here:
 * Railway runs UTC, the market runs Central, and this is a DST-sensitive
 * wall-clock deadline that `new Date().getHours()` would get wrong for half
 * the year.
 *
 * ── Cash-settled index options are exempt, and this is a fact, not a policy call ──
 *
 * The entire rationale above is share assignment: OCC auto-exercises an ITM
 * option and PHYSICALLY-settled names (every single-stock option, and SPY/QQQ/
 * IWM, which are ETF shares) hand out or demand real shares. SPX and NDX are
 * CASH-settled index options — exercise credits or debits a dollar amount,
 * never shares. There is no assignment to prevent on them, so applying this
 * rule there would not be "more cautious" — it would exit a position for a
 * risk that is structurally absent from the product, on the same un-overridable
 * footing as a real assignment threat.
 *
 * `settlementType` is therefore a required INPUT, not something this module
 * looks up — importing engine/state/directionState.ts's CASH_SETTLED_TICKERS
 * here would pull in the store layer (barsStore, marketStore, cvdStore,
 * confluenceEngine) transitively, destroying the zero-dependency purity that
 * makes this function trivially testable. The caller decides, the same way
 * sizePosition takes `delta` as an input rather than fetching it. Prefer the
 * broker's own instrument data when available — Webull's sandbox
 * /openapi/instrument/option/contracts response carries a real
 * `settlement_method: "PHYSICAL"` field per contract, confirmed live
 * 2026-08-31 — and fall back to CASH_SETTLED_TICKERS only when that field is
 * absent.
 */

export type ForcedCloseUrgency =
  | 'none'        // not yet due
  | 'due'         // close now, marketable limit is fine
  | 'urgent'      // escalate the ladder
  | 'immediate';  // cross the spread; an unfunded assignment is worse

export interface ForcedCloseSchedule {
  /** Minutes-of-day CT at which a same-day-expiry position must close. */
  closeAtMinuteCT: number;
  /** Minutes past the deadline before escalating the ladder. */
  urgentAfterMin: number;
  /** Minutes past the deadline before crossing the spread outright. */
  immediateAfterMin: number;
}

export type SettlementType = 'physical' | 'cash';

export interface PositionExpiry {
  /** Contract expiry date, YYYY-MM-DD. */
  expiryDate: string;
  /** Whether the position is currently open. */
  isOpen: boolean;
  /**
   * 'physical' (every single-stock option, SPY/QQQ/IWM) carries real
   * assignment risk and is what this whole module exists to protect against.
   * 'cash' (SPX, NDX) settles in dollars — there are no shares to be
   * assigned, so the deadline below does not apply to it at all. Required,
   * not optional: an unset settlement type must not silently default to the
   * side that skips protection.
   */
  settlementType: SettlementType;
}

export interface ForcedCloseResult {
  urgency: ForcedCloseUrgency;
  /** True when the caller must close regardless of any other signal. */
  mustClose: boolean;
  reason: string;
  /** Minutes until (negative) or past (positive) the deadline. */
  minutesPastDeadline: number;
  /** True when this contract expires today and is therefore in scope. */
  expiresToday: boolean;
}

/**
 * Decide whether an open position must be force-closed.
 *
 * @param todayCT       Today's date in CT, YYYY-MM-DD — from lib/time.ts.
 * @param minuteOfDayCT Current minute-of-day in CT — from lib/time.ts.
 */
export function evaluateForcedClose(args: {
  position: PositionExpiry;
  todayCT: string;
  minuteOfDayCT: number;
  schedule: ForcedCloseSchedule;
}): ForcedCloseResult {
  const { position, todayCT, minuteOfDayCT, schedule } = args;

  const none = (reason: string, expiresToday = false): ForcedCloseResult =>
    ({ urgency: 'none', mustClose: false, reason, minutesPastDeadline: 0, expiresToday });

  if (!position || position.isOpen !== true) {
    return none('position is not open');
  }
  // Cash-settled index options (SPX, NDX) have no assignment to prevent —
  // exercise settles in dollars, never shares. Anything other than the
  // literal string 'cash' is treated as physically-settled, deliberately:
  // a missing, malformed, or unrecognised settlementType must fail toward
  // the protective behaviour, never toward silently skipping the check.
  if (position.settlementType === 'cash') {
    return none('cash-settled index option — no share assignment risk, forced-close rule does not apply');
  }
  if (typeof position.expiryDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(position.expiryDate)) {
    // An unparseable expiry cannot be cleared as safe. Treat it as due: the
    // cost of closing a position unnecessarily is a spread; the cost of
    // missing an assignment is the account.
    return {
      urgency: 'due',
      mustClose: true,
      reason: `expiry "${position.expiryDate}" is unparseable — closing rather than assuming it is not today`,
      minutesPastDeadline: 0,
      expiresToday: true,
    };
  }
  if (typeof todayCT !== 'string' || !Number.isFinite(minuteOfDayCT)) {
    return {
      urgency: 'due',
      mustClose: true,
      reason: 'current CT time unavailable — closing rather than assuming the deadline has not passed',
      minutesPastDeadline: 0,
      expiresToday: true,
    };
  }

  const expiresToday = position.expiryDate === todayCT;

  // Only same-day expiry carries assignment risk today. A later expiry is
  // governed by the trailing stop like any other position.
  if (!expiresToday) {
    return none(`expires ${position.expiryDate}, not today (${todayCT}) — no assignment risk today`, false);
  }

  const minutesPastDeadline = minuteOfDayCT - schedule.closeAtMinuteCT;

  if (minutesPastDeadline < 0) {
    return {
      urgency: 'none',
      mustClose: false,
      reason: `expires today; ${-minutesPastDeadline} min until the forced-close deadline`,
      minutesPastDeadline,
      expiresToday: true,
    };
  }

  let urgency: ForcedCloseUrgency = 'due';
  if (minutesPastDeadline >= schedule.immediateAfterMin) urgency = 'immediate';
  else if (minutesPastDeadline >= schedule.urgentAfterMin) urgency = 'urgent';

  return {
    urgency,
    mustClose: true,
    reason: urgency === 'immediate'
      ? `${minutesPastDeadline} min past the deadline — crossing the spread; an unfunded assignment is worse than slippage`
      : urgency === 'urgent'
        ? `${minutesPastDeadline} min past the deadline — escalating`
        : 'forced-close deadline reached for a same-day expiry',
    minutesPastDeadline,
    expiresToday: true,
  };
}

/**
 * SOURCE, VERIFIED — do not change this without re-verifying against the
 * exchange, not against memory or a prior version of this comment.
 *
 *   NYSE/Nasdaq regular session close: 4:00 PM ET = 3:00 PM CT (15:00 CT).
 *   Eastern and Central observe the same DST transitions, so the ET->CT
 *   offset is a constant 1 hour year-round — this is not a DST edge case.
 *   Verified 2026-08-31.
 *
 * The deadline below is 14:30 CT — 30 minutes BEFORE that close, not after
 * it. An earlier version of this constant was 15:45 CT: 45 minutes AFTER
 * the market had already shut, at which point there is no exchange left to
 * submit an order to. That number was never checked against the real close
 * time by anyone across four rounds of design, code, tests, and a
 * simulation harness — all of which correctly verified the system did
 * exactly what was specified. The specification was wrong at the source.
 * See CLAUDE.md, "A wall-clock deadline is only as correct as its source."
 *
 * The 30-minute margin is deliberate, not arbitrary: it gives the
 * escalating order ladder genuine room to work before the bell, and it
 * keeps the urgency tiers below inside the session too — due at 14:30,
 * urgent at 14:37, immediate at 14:40, all at least 20 minutes before the
 * 15:00 close even in the worst case.
 *
 * NOT handled here: early closes (e.g. the day after Thanksgiving, 1:00 PM
 * ET). This default is the regular-session schedule; a caller trading on a
 * known early-close day must supply its own ForcedCloseSchedule rather than
 * rely on this constant.
 */
export const DEFAULT_FORCED_CLOSE: ForcedCloseSchedule = {
  closeAtMinuteCT: 14 * 60 + 30,
  urgentAfterMin: 7,
  immediateAfterMin: 10,
};
