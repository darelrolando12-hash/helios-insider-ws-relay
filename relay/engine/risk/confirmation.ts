/**
 * Confirmation-gated signal invalidation — the pullback / reversal distinction.
 *
 * ── Why this does not duplicate confluenceEngine ──────────────────────────
 *
 * The open question was how to define confirmation windows without a second
 * scorer. The answer is that this module does not score anything. It consumes
 * confluenceEngine's EXISTING band output and adds two conditions the engine
 * does not currently express, both of which are temporal predicates over state
 * that already exists:
 *
 *   1. Bar closure — the adverse reading must hold at the close of a completed
 *      bar, not intrabar. barsStore already knows which bar is provisional.
 *   2. Sustained CVD flip — flow must stay flipped across N consecutive
 *      classified ticks, not a single one. cvdStore already accumulates them.
 *
 * Neither recomputes a score, so confluenceEngine is untouched. That is the
 * whole point: a pullback shows one adverse tick and recovers inside the bar;
 * a reversal closes the bar adversely with flow confirming.
 *
 * ── The precedence rule that matters ──────────────────────────────────────
 *
 * Confirmation gates SIGNAL-based exits only. It must NEVER gate a risk-based
 * exit: a trailing-stop or forced-close decision fires immediately, with no
 * confirmation. Requiring a closed 1-minute bar can mean up to 60 seconds of
 * adverse movement, which on 0DTE can be most of the premium — acceptable when
 * deciding whether a thesis broke, unacceptable when a stop has been hit.
 * Letting thesis-invalidation outrank a stop-loss inverts the precedence.
 */

export type ConfirmationState =
  | 'confirmed'   // structural — act on it
  | 'pending'     // adverse but unconfirmed — keep watching
  | 'rejected'    // recovered — it was a pullback
  | 'unknown';    // inputs insufficient to judge

export interface ConfirmationConfig {
  /** Consecutive classified ticks the CVD flip must persist for. */
  minSustainedTicks: number;
  /** Require the adverse reading at a CLOSED bar, not intrabar. */
  requireBarClose: boolean;
}

export interface ConfirmationInput {
  /** Band from confluenceEngine at signal time. */
  entryBand: string;
  /** Band from confluenceEngine now. */
  currentBand: string;
  /** Direction the position is in. */
  positionDirection: 'call' | 'put';
  /**
   * Recent CVD classifications, oldest first. 'buy' | 'sell' per tick — read
   * from cvdStore, not recomputed.
   */
  recentCvdSides: readonly ('buy' | 'sell')[];
  /** True when the most recent bar has CLOSED (is no longer provisional). */
  barClosed: boolean;
}

export interface ConfirmationResult {
  state: ConfirmationState;
  reason: string;
  /** How many trailing ticks currently oppose the position. */
  sustainedAgainst: number;
  /** True when the band itself has deteriorated from entry. */
  bandDeteriorated: boolean;
}

/** Band ordering, weakest to strongest, matching the documented thresholds. */
const BAND_RANK: Record<string, number> = {
  none: 0,
  EXIT: 1,
  REVERSAL: 2,
  ENTER_BREAKOUT: 3,
};

export function evaluateConfirmation(
  input: ConfirmationInput,
  config: ConfirmationConfig,
): ConfirmationResult {
  const { entryBand, currentBand, positionDirection, recentCvdSides, barClosed } = input;

  if (!Array.isArray(recentCvdSides)) {
    return { state: 'unknown', reason: 'no CVD history supplied', sustainedAgainst: 0, bandDeteriorated: false };
  }

  const entryRank = BAND_RANK[entryBand];
  const currentRank = BAND_RANK[currentBand];
  if (entryRank === undefined || currentRank === undefined) {
    // An unrecognised band is data we cannot judge — never guess that a
    // position should be exited on it.
    return {
      state: 'unknown',
      reason: `unrecognised band (entry="${entryBand}", current="${currentBand}") — cannot judge`,
      sustainedAgainst: 0,
      bandDeteriorated: false,
    };
  }

  const bandDeteriorated = currentRank < entryRank;

  // A long call is opposed by sell flow; a long put by buy flow.
  const opposing: 'buy' | 'sell' = positionDirection === 'call' ? 'sell' : 'buy';

  // Count the trailing run of opposing ticks. A run that was broken and
  // resumed is not "sustained" — that is chop, not a flip.
  let sustainedAgainst = 0;
  for (let i = recentCvdSides.length - 1; i >= 0; i--) {
    if (recentCvdSides[i] === opposing) sustainedAgainst++;
    else break;
  }

  const flowConfirms = sustainedAgainst >= config.minSustainedTicks;

  if (!bandDeteriorated && !flowConfirms) {
    return {
      state: 'rejected',
      reason: 'band intact and flow not sustained against the position — pullback, not reversal',
      sustainedAgainst,
      bandDeteriorated,
    };
  }

  if (config.requireBarClose && !barClosed) {
    return {
      state: 'pending',
      reason: 'adverse reading is intrabar — waiting for the bar to close before treating it as structural',
      sustainedAgainst,
      bandDeteriorated,
    };
  }

  if (!flowConfirms) {
    return {
      state: 'pending',
      reason: `band deteriorated but flow not sustained (${sustainedAgainst}/${config.minSustainedTicks} ticks against)`,
      sustainedAgainst,
      bandDeteriorated,
    };
  }

  if (!bandDeteriorated) {
    return {
      state: 'pending',
      reason: `flow sustained against (${sustainedAgainst} ticks) but band has not deteriorated`,
      sustainedAgainst,
      bandDeteriorated,
    };
  }

  return {
    state: 'confirmed',
    reason: `structural reversal — band ${entryBand} -> ${currentBand} on a closed bar with ` +
            `${sustainedAgainst} consecutive opposing ticks`,
    sustainedAgainst,
    bandDeteriorated,
  };
}
