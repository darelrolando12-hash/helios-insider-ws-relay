/**
 * Daily circuit breaker — loss side only, deliberately.
 *
 * ── Why a loss stop exists ────────────────────────────────────────────────
 *
 * Losses compound against an account faster than equal-sized wins compound
 * for it. Recovery required, by drawdown:
 *
 *     10% loss  ->  11% gain to recover
 *     20% loss  ->  25% gain
 *     30% loss  ->  43% gain
 *     50% loss  -> 100% gain
 *
 * That asymmetry is real and quantifiable, and it is what justifies halting a
 * day that has gone badly: each further loss makes the hole disproportionately
 * harder to climb out of.
 *
 * ── Why there is NO win-side cap ──────────────────────────────────────────
 *
 * There was one, and it was a design bug — removed deliberately, so it should
 * not be reintroduced without reading this.
 *
 * A daily win target is real advice for a human trader. It defends against the
 * house-money effect: sizing up after a win because the gains feel like the
 * market's money rather than your own. That is a PSYCHOLOGICAL failure mode.
 *
 * This system has no psychology. Position size is fixed by the capital cap and
 * the risk formula on every single trade, computed from current equity and the
 * contract in front of it — never from how the day has gone. It is structurally
 * incapable of getting overconfident and sizing up after a win. Importing a
 * human safeguard into code that cannot exhibit the behaviour it guards against
 * added no protection and actively defeated compounding: a win raises equity,
 * which raises the capital cap, which sizes the next trade larger. That IS the
 * compounding mechanism, and halting on it caps the thing the system exists to
 * do.
 *
 * There is no win-side equivalent of the recovery asymmetry above. A win simply
 * raises the base.
 *
 * ── What actually does the protective work ────────────────────────────────
 *
 * All of it is P&L-independent and applies identically whether the day is up
 * or down: the exposure caps (70% deployed / 10% aggregate risk / position
 * count), the contract-quality gate, the conviction threshold, and the
 * per-trade capital cap. Those are the real brakes. The win cap sat on top of
 * them and contributed nothing.
 *
 * Pure: takes starting equity and realised day P&L, returns what is allowed.
 * No clock read — the caller supplies the day boundary, so this is
 * deterministic and timezone-correct via lib/time.ts upstream rather than
 * doing its own (Railway runs UTC, the market runs Central).
 */

export type TradingAllowed =
  | 'normal'              // trade as usual
  | 'halted-daily-loss'   // no new entries — loss limit hit
  | 'unknown';            // inputs unusable; treat as halted

export interface DailyLimitConfig {
  /** Realised loss, as a fraction of starting equity, that halts (e.g. 0.06). */
  maxDailyLossPct: number;
}

export interface DailyLimitResult {
  status: TradingAllowed;
  /** True only when a new entry may be opened at all. */
  canOpenNewPosition: boolean;
  dayPnlPct: number;
  reason: string;
}

/**
 * Existing positions are NEVER force-closed by this function. A daily limit
 * governs whether new risk may be TAKEN; exiting an open position is the
 * trailing stop's and the forced-close scheduler's job. Conflating the two
 * would liquidate a winning runner because the day's loss limit was reached
 * on a different position.
 */
export function evaluateDailyLimits(args: {
  startingEquity: number;
  currentDayPnl: number;
  config: DailyLimitConfig;
}): DailyLimitResult {
  const { startingEquity, currentDayPnl, config } = args;

  const unusable = (reason: string): DailyLimitResult => ({
    status: 'unknown',
    canOpenNewPosition: false,     // fail closed
    dayPnlPct: 0,
    reason,
  });

  if (!Number.isFinite(startingEquity) || startingEquity <= 0) {
    return unusable('starting equity unavailable — cannot evaluate daily limits, refusing new entries');
  }
  if (!Number.isFinite(currentDayPnl)) {
    return unusable('day P&L unavailable — refusing new entries rather than assuming zero');
  }
  if (!Number.isFinite(config.maxDailyLossPct) || config.maxDailyLossPct <= 0) {
    return unusable('invalid maxDailyLossPct');
  }

  const dayPnlPct = currentDayPnl / startingEquity;

  if (dayPnlPct <= -Math.abs(config.maxDailyLossPct)) {
    return {
      status: 'halted-daily-loss',
      canOpenNewPosition: false,
      dayPnlPct,
      reason: `daily loss limit reached (${(dayPnlPct * 100).toFixed(2)}% <= -${(config.maxDailyLossPct * 100).toFixed(2)}%)`,
    };
  }

  // Everything else — including a very large winning day — is normal. A
  // qualifying signal is taken regardless of running P&L, gated only by the
  // P&L-independent controls listed in the module header.
  return {
    status: 'normal',
    canOpenNewPosition: true,
    dayPnlPct,
    reason: dayPnlPct > 0
      ? `up ${(dayPnlPct * 100).toFixed(2)}% — no win-side cap by design; compounding continues`
      : 'within daily limits',
  };
}
