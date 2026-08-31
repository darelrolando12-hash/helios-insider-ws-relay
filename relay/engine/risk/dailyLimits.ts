/**
 * Daily circuit breakers — loss AND win side.
 *
 * The loss breaker is obvious: stop before a bad day compounds into a
 * catastrophic one.
 *
 * The win breaker is the one people leave out, and it protects against a real
 * and specific failure: after a strong day, the temptation is to keep trading
 * on a smaller edge, and giving back a +5% day is both financially and
 * behaviourally worse than stopping at +5%. It is deliberately the mirror
 * image of the loss rule rather than an afterthought.
 *
 * The win side has two stages because "stop entirely" is too blunt at the
 * first threshold — a genuinely excellent setup after a good morning is still
 * worth taking. Raising the conviction bar keeps that possible while
 * filtering everything marginal.
 *
 * Pure: takes starting equity and realised day P&L, returns what is allowed.
 * No clock read — the caller supplies the day boundary, so this is
 * deterministic and timezone-correct via lib/time.ts upstream rather than
 * doing its own (Railway runs UTC, the market runs Central).
 */

export type TradingAllowed =
  | 'normal'              // trade as usual
  | 'elevated-bar'        // only higher-conviction entries
  | 'halted-daily-loss'   // no new entries — loss limit hit
  | 'halted-daily-win'    // no new entries — win target hit
  | 'unknown';            // inputs unusable; treat as halted

export interface DailyLimitConfig {
  /** Realised loss, as a fraction of starting equity, that halts (e.g. 0.06). */
  maxDailyLossPct: number;
  /** Gain fraction at which the conviction bar rises (e.g. 0.05). */
  winSoftTargetPct: number;
  /** Gain fraction at which new entries stop entirely (e.g. 0.10). */
  winHardTargetPct: number;
  /** Conviction score required while in 'elevated-bar'. */
  elevatedConvictionMin: number;
}

export interface DailyLimitResult {
  status: TradingAllowed;
  /** True only when a new entry may be opened at all. */
  canOpenNewPosition: boolean;
  /** Minimum conviction for a new entry; null when none may open. */
  requiredConviction: number | null;
  dayPnlPct: number;
  reason: string;
}

/**
 * Existing positions are NEVER force-closed by this function. A daily limit
 * governs whether new risk may be TAKEN; exiting an open position is the
 * trailing stop's and the forced-close scheduler's job. Conflating the two
 * would liquidate a winning runner because the day's target was reached.
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
    requiredConviction: null,
    dayPnlPct: 0,
    reason,
  });

  if (!Number.isFinite(startingEquity) || startingEquity <= 0) {
    return unusable('starting equity unavailable — cannot evaluate daily limits, refusing new entries');
  }
  if (!Number.isFinite(currentDayPnl)) {
    return unusable('day P&L unavailable — refusing new entries rather than assuming zero');
  }
  if (!Number.isFinite(config.maxDailyLossPct) || config.maxDailyLossPct <= 0) return unusable('invalid maxDailyLossPct');
  if (!Number.isFinite(config.winSoftTargetPct) || config.winSoftTargetPct <= 0) return unusable('invalid winSoftTargetPct');
  if (!Number.isFinite(config.winHardTargetPct) || config.winHardTargetPct <= 0) return unusable('invalid winHardTargetPct');

  const dayPnlPct = currentDayPnl / startingEquity;

  // Loss side first: it outranks every other state.
  if (dayPnlPct <= -Math.abs(config.maxDailyLossPct)) {
    return {
      status: 'halted-daily-loss',
      canOpenNewPosition: false,
      requiredConviction: null,
      dayPnlPct,
      reason: `daily loss limit reached (${(dayPnlPct * 100).toFixed(2)}% <= -${(config.maxDailyLossPct * 100).toFixed(2)}%)`,
    };
  }

  if (dayPnlPct >= config.winHardTargetPct) {
    return {
      status: 'halted-daily-win',
      canOpenNewPosition: false,
      requiredConviction: null,
      dayPnlPct,
      reason: `daily win target reached (${(dayPnlPct * 100).toFixed(2)}% >= ${(config.winHardTargetPct * 100).toFixed(2)}%) — protecting the day`,
    };
  }

  if (dayPnlPct >= config.winSoftTargetPct) {
    return {
      status: 'elevated-bar',
      canOpenNewPosition: true,
      requiredConviction: config.elevatedConvictionMin,
      dayPnlPct,
      reason: `up ${(dayPnlPct * 100).toFixed(2)}% — only conviction >= ${config.elevatedConvictionMin} accepted`,
    };
  }

  return {
    status: 'normal',
    canOpenNewPosition: true,
    requiredConviction: null,
    dayPnlPct,
    reason: 'within daily limits',
  };
}
