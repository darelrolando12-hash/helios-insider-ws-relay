/**
 * Deterministic exits for an open long-option position.
 *
 * Pure: evaluates one position against one completed one-minute bar and the
 * option's current mark. No stores, no clock, no network — the same function
 * runs live and in the five-year replay (relay/backtests/exitRules.ts).
 *
 * The rules (helios-trading-machine-architecture.md, Part 7), checked in
 * this order — the first that fires wins, and its reason is recorded:
 *
 *   session-cutoff  CT time ≥ 14:30 = 3:30 PM ET. The doc's "hard exit by
 *                   ~3:30 PM ET" before the close-of-session gamma and
 *                   liquidity vacuum. NYSE closes 4:00 PM ET = 3:00 PM CT
 *                   (same source as DEFAULT_FORCED_CLOSE, verified
 *                   2026-08-31); this is 30 minutes before it. Early closes
 *                   are not modelled — CLAUDE.md known gap.
 *   max-loss        mark ≤ entry × (1 − maxLossPct). Risk known at entry.
 *   lost-thesis     the bar CLOSED on the wrong side of the level the entry
 *                   depended on ("broke out above the flip" → closed back
 *                   below it). The machine knows why it entered; when that
 *                   stops being true it leaves, regardless of P&L.
 *   target          the underlying reached the position's target level
 *                   (e.g. prior-day high for a call) intrabar.
 *   time-stop       held ≥ timeStopMin and not in profit — "positions that
 *                   lose money after 30 minutes should be exited".
 *   max-hold        held ≥ maxHoldMin, whatever the P&L (a plain time exit).
 *
 * Every rule is optional (null disables it) so each can be measured alone.
 */

export type ExitReason = 'session-cutoff' | 'max-loss' | 'lost-thesis' | 'target' | 'time-stop' | 'max-hold';

/** The level the trade's reason for existing depends on. */
export interface Thesis {
  /** 'above': the thesis holds while price closes above `level`; 'below' the reverse. */
  holds: 'above' | 'below';
  level: number;
  label: string;
}

export interface OpenPosition {
  direction:    'call' | 'put';
  /** CT minute of day the position was entered. */
  entryMinute:  number;
  /** Premium actually paid (the ask), per share. */
  entryPremium: number;
  thesis:       Thesis | null;
  /** Underlying price target, or null for none. */
  target:       number | null;
}

export interface ExitBar {
  /** CT minute of day of this completed bar. */
  minute: number;
  high:   number;
  low:    number;
  close:  number;
}

export interface ExitParams {
  /** CT minute of day at/after which everything closes. null = off. */
  sessionCutoffMin: number | null;
  /** Exit when the mark has lost this fraction of the entry premium. null = off. */
  maxLossPct:       number | null;
  /** Enforce the position's thesis (if it has one). */
  useThesis:        boolean;
  /** Enforce the position's target (if it has one). */
  useTarget:        boolean;
  /** Minutes after which a position that is not in profit is closed. null = off. */
  timeStopMin:      number | null;
  /** Minutes after which the position is closed regardless. null = off. */
  maxHoldMin:       number | null;
}

/** 3:30 PM ET = 2:30 PM CT — see header. */
export const SESSION_CUTOFF_CT_MIN = 14 * 60 + 30;

export const DEFAULT_EXIT_PARAMS: ExitParams = {
  sessionCutoffMin: SESSION_CUTOFF_CT_MIN,
  maxLossPct:       0.5,
  useThesis:        true,
  useTarget:        true,
  timeStopMin:      30,
  maxHoldMin:       null,
};

/**
 * Should `pos` be closed at the end of `bar`, given the option's mark
 * (per share, at the bid you could actually sell at)? Returns the first rule
 * that fires, or null to hold.
 */
export function evaluateExit(
  pos:    OpenPosition,
  bar:    ExitBar,
  mark:   number,
  params: ExitParams = DEFAULT_EXIT_PARAMS,
): ExitReason | null {
  const held = bar.minute - pos.entryMinute;

  if (params.sessionCutoffMin !== null && bar.minute >= params.sessionCutoffMin) return 'session-cutoff';

  if (params.maxLossPct !== null && mark <= pos.entryPremium * (1 - params.maxLossPct)) return 'max-loss';

  if (params.useThesis && pos.thesis) {
    const t = pos.thesis;
    if ((t.holds === 'above' && bar.close < t.level) || (t.holds === 'below' && bar.close > t.level)) return 'lost-thesis';
  }

  if (params.useTarget && pos.target !== null) {
    if ((pos.direction === 'call' && bar.high >= pos.target) || (pos.direction === 'put' && bar.low <= pos.target)) return 'target';
  }

  if (params.timeStopMin !== null && held >= params.timeStopMin && mark <= pos.entryPremium) return 'time-stop';

  if (params.maxHoldMin !== null && held >= params.maxHoldMin) return 'max-hold';

  return null;
}
