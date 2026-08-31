/**
 * Marketable-limit escalation ladder — pure decision function.
 *
 * Given the current quote, which attempt we are on, and how long it has been
 * working, decide the next action. Contains NO broker call: the execution
 * layer takes this decision and performs it, which keeps the policy testable
 * without a network and unable to place an order by itself.
 *
 * ── Why never a bare market order on entry ────────────────────────────────
 *
 * A market order has no price bound. On the thin option books this system
 * trades, that is how a fill lands far through the spread. The contract
 * quality gate already refuses the worst markets; the ladder makes sure the
 * ones we do trade are entered at a price we chose.
 *
 * ── Entry and exit are deliberately asymmetric ────────────────────────────
 *
 * An unfilled ENTRY is a non-event: cancel, move on, the setup either
 * re-triggers or it does not. Nothing is at risk.
 *
 * An unfilled EXIT is an open position with unbounded downside. It must
 * escalate harder and may legitimately end in a market order. Treating the
 * two symmetrically necessarily gets one of them wrong — a market entry is
 * reckless, and a cancelled exit is worse.
 */

export type LadderAction =
  | { action: 'submit'; limitPrice: number; attempt: number; reason: string }
  | { action: 'wait'; msRemaining: number; reason: string }
  | { action: 'cancel'; reason: string }
  | { action: 'market'; reason: string };

export type OrderSide = 'buy' | 'sell';
export type OrderIntent = 'entry' | 'exit';

export interface LadderConfig {
  /** Tick size for the instrument, e.g. 0.01 or 0.05. */
  tickSize: number;
  /** Milliseconds to let each attempt work before escalating. */
  attemptTimeoutsMs: readonly number[];
  /**
   * Hardest bound: total price concession as a fraction of the starting
   * marketable price. Escalation stops here even if attempts remain — if
   * filling costs more than the trade was worth, not filling is correct.
   */
  maxSlippagePct: number;
  /** Exits only: after the ladder is exhausted, may we cross with a market order? */
  allowMarketOnExhaustion: boolean;
}

export interface LadderState {
  intent: OrderIntent;
  side: OrderSide;
  bid: number;
  ask: number;
  /** 0-based. 0 means nothing submitted yet. */
  attempt: number;
  /** Milliseconds the current attempt has been working. */
  elapsedMsOnAttempt: number;
  /** The marketable price when the ladder started — the slippage baseline. */
  referencePrice: number;
}

/**
 * The price that crosses the spread for this side.
 * Buys lift the ask; sells hit the bid.
 */
function marketablePrice(side: OrderSide, bid: number, ask: number): number {
  return side === 'buy' ? ask : bid;
}

/** Escalation moves the limit further through the spread, never back. */
function concede(side: OrderSide, price: number, ticks: number, tickSize: number): number {
  const delta = ticks * tickSize;
  return side === 'buy' ? price + delta : price - delta;
}

export function nextLadderAction(state: LadderState, config: LadderConfig): LadderAction {
  const { intent, side, bid, ask, attempt, elapsedMsOnAttempt, referencePrice } = state;

  // No usable quote: never guess a price. For an exit this is where a market
  // order is legitimate (the position is real and must be closed); for an
  // entry, simply stand down.
  if (!Number.isFinite(bid) || !Number.isFinite(ask) || bid <= 0 || ask <= 0 || bid >= ask) {
    return intent === 'exit' && config.allowMarketOnExhaustion
      ? { action: 'market', reason: 'no usable quote on an exit — crossing to close' }
      : { action: 'cancel', reason: 'no usable quote — standing down rather than guessing a price' };
  }

  const base = marketablePrice(side, bid, ask);

  // First submission: at the touch, no concession yet.
  if (attempt === 0) {
    return {
      action: 'submit',
      limitPrice: base,
      attempt: 1,
      reason: `attempt 1 — marketable limit at the ${side === 'buy' ? 'ask' : 'bid'}`,
    };
  }

  // Still inside this attempt's working window.
  const timeout = config.attemptTimeoutsMs[Math.min(attempt - 1, config.attemptTimeoutsMs.length - 1)];
  if (elapsedMsOnAttempt < timeout) {
    return {
      action: 'wait',
      msRemaining: timeout - elapsedMsOnAttempt,
      reason: `attempt ${attempt} still working (${elapsedMsOnAttempt}ms of ${timeout}ms)`,
    };
  }

  // Escalate: one additional tick of concession per completed attempt.
  const nextAttempt = attempt + 1;
  const candidate = concede(side, base, attempt, config.tickSize);

  // Slippage ceiling, measured against where the ladder started. Without this
  // the ladder quietly converges on a market order one tick at a time.
  const conceded = Math.abs(candidate - referencePrice) / referencePrice;
  if (conceded > config.maxSlippagePct) {
    if (intent === 'exit' && config.allowMarketOnExhaustion) {
      return {
        action: 'market',
        reason: `slippage ceiling reached on an exit (${(conceded * 100).toFixed(1)}% > ` +
                `${(config.maxSlippagePct * 100).toFixed(1)}%) — crossing to close the position`,
      };
    }
    return {
      action: 'cancel',
      reason: `slippage ceiling reached (${(conceded * 100).toFixed(1)}% > ` +
              `${(config.maxSlippagePct * 100).toFixed(1)}%) — the fill would cost more than the edge`,
    };
  }

  // Ladder exhausted.
  if (nextAttempt > config.attemptTimeoutsMs.length) {
    if (intent === 'exit' && config.allowMarketOnExhaustion) {
      return { action: 'market', reason: 'ladder exhausted on an exit — crossing to close' };
    }
    return { action: 'cancel', reason: 'ladder exhausted on an entry — not chasing' };
  }

  return {
    action: 'submit',
    limitPrice: candidate,
    attempt: nextAttempt,
    reason: `attempt ${nextAttempt} — conceding ${attempt} tick(s) through the ${side === 'buy' ? 'ask' : 'bid'}`,
  };
}
