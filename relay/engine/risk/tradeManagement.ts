/**
 * Open-position management — tiered trailing stop and partial profit-taking.
 *
 * Both are pure: current state in, decision out. No clock, no store, no
 * broker. The caller owns peak tracking and tells us the peak; deriving it
 * here would require hidden mutable state and make the function untestable.
 *
 * ── Why the trail is peak-based, not entry-based ──────────────────────────
 *
 * An entry-based stop can only ever protect the entry. Once a position is
 * +200%, a stop measured from entry is enormously far away — it would hand
 * back the entire move before triggering. Measuring the trail from the PEAK
 * lets the same rule protect accumulated gains and still leave a runner room,
 * which an entry-based rule fundamentally cannot do at the same time.
 *
 * The tiers widen as gains grow (25% at +80%, 20% at +150%) so a large winner
 * is given proportionally more room, not less — tightening a trail on a
 * runner is how runners get cut short.
 */

export type TradeAction = 'hold' | 'exit';

export interface TrailingStopTiers {
  /** Gain fraction at which the stop moves to breakeven (e.g. 0.30). */
  breakevenAt: number;
  /** Gain fraction at which trailing begins (e.g. 0.80). */
  trailTier1At: number;
  /** Give-back fraction from peak in tier 1 (e.g. 0.25). */
  trailTier1Pct: number;
  /** Gain fraction for the wider tier (e.g. 1.50). */
  trailTier2At: number;
  /** Give-back fraction from peak in tier 2 (e.g. 0.20). */
  trailTier2Pct: number;
  /** Initial stop as a fraction of premium lost (e.g. 0.50), from sizing. */
  initialStopLossPct: number;
}

export type StopTier =
  | 'initial'
  | 'breakeven'
  | 'trail-tier-1'
  | 'trail-tier-2';

export interface TrailingStopResult {
  action: TradeAction;
  reason: string;
  /** Which tier is currently governing. */
  tier: StopTier;
  /** The price at or below which the position exits. */
  stopPrice: number;
  /** Gain from entry, as a fraction (0.8 = +80%). */
  gainPct: number;
  /** Peak gain reached, as a fraction — what selects the tier. */
  peakGainPct: number;
}

/**
 * Decide whether an open long option position should be held or exited.
 *
 * Tier selection uses the PEAK gain, not the current gain. Using current gain
 * would let a position that reached +200% and fell back to +50% drop out of
 * its trailing tier and revert to the initial stop, discarding the protection
 * exactly when it is needed. Once earned, a tier is never given back.
 */
export function evaluateTrailingStop(args: {
  entryPrice: number;
  currentPrice: number;
  peakPrice: number;
  tiers: TrailingStopTiers;
}): TrailingStopResult {
  const { entryPrice, currentPrice, tiers } = args;
  // Peak can never be below entry: a position that only ever fell has a peak
  // of its entry, and clamping here keeps every downstream tier calculation
  // honest without the caller having to pre-normalise.
  const peakPrice = Math.max(args.peakPrice, entryPrice);

  if (!Number.isFinite(entryPrice) || entryPrice <= 0
      || !Number.isFinite(currentPrice) || currentPrice < 0
      || !Number.isFinite(args.peakPrice)) {
    return {
      action: 'hold',
      reason: 'invalid inputs — holding rather than acting on unusable data',
      tier: 'initial',
      stopPrice: 0,
      gainPct: 0,
      peakGainPct: 0,
    };
  }

  const gainPct = (currentPrice - entryPrice) / entryPrice;
  const peakGainPct = (peakPrice - entryPrice) / entryPrice;

  let tier: StopTier;
  let stopPrice: number;

  if (peakGainPct >= tiers.trailTier2At) {
    tier = 'trail-tier-2';
    stopPrice = peakPrice * (1 - tiers.trailTier2Pct);
  } else if (peakGainPct >= tiers.trailTier1At) {
    tier = 'trail-tier-1';
    stopPrice = peakPrice * (1 - tiers.trailTier1Pct);
  } else if (peakGainPct >= tiers.breakevenAt) {
    tier = 'breakeven';
    stopPrice = entryPrice;
  } else {
    tier = 'initial';
    stopPrice = entryPrice * (1 - tiers.initialStopLossPct);
  }

  // Once breakeven is earned, the stop must never sit below entry again, even
  // if a wide trail tier would compute lower. Protection is monotonic.
  if (tier !== 'initial') stopPrice = Math.max(stopPrice, entryPrice);

  if (currentPrice <= stopPrice) {
    return {
      action: 'exit',
      reason: `${tier} stop hit — price ${currentPrice.toFixed(2)} <= stop ${stopPrice.toFixed(2)} ` +
              `(peak +${(peakGainPct * 100).toFixed(1)}%, now ${(gainPct * 100).toFixed(1)}%)`,
      tier, stopPrice, gainPct, peakGainPct,
    };
  }

  return {
    action: 'hold',
    reason: `${tier} — stop ${stopPrice.toFixed(2)}, price ${currentPrice.toFixed(2)}`,
    tier, stopPrice, gainPct, peakGainPct,
  };
}

// ── Partial profit-taking ────────────────────────────────────────────────────

export interface PartialProfitResult {
  /** Contracts to close now. 0 = take nothing. */
  contractsToClose: number;
  contractsRemaining: number;
  reason: string;
  /** True once the scale-out has been taken and must not repeat. */
  alreadyTaken: boolean;
}

/**
 * Close half the position at a gain threshold; the remainder rides the trail.
 *
 * `alreadyScaledOut` is required rather than inferred: without it this
 * function would re-trigger on every tick above the threshold and liquidate
 * the position in halves. The caller owns that flag as position state.
 *
 * Rounding is deliberate: with an odd contract count, MORE than half is left
 * running (floor on the close side). Taking the smaller half locks in less
 * but leaves the larger remainder exposed to the tiered trail, which is where
 * the asymmetric upside lives. With a single contract there is nothing to
 * halve, so nothing is taken — partial exits are not possible and pretending
 * otherwise would close the whole position.
 */
export function evaluatePartialProfit(args: {
  entryPrice: number;
  currentPrice: number;
  openContracts: number;
  takeProfitAt: number;      // e.g. 0.50 for +50%
  alreadyScaledOut: boolean;
}): PartialProfitResult {
  const { entryPrice, currentPrice, openContracts, takeProfitAt, alreadyScaledOut } = args;

  const none = (reason: string, taken = alreadyScaledOut): PartialProfitResult => ({
    contractsToClose: 0,
    contractsRemaining: Number.isFinite(openContracts) ? openContracts : 0,
    reason,
    alreadyTaken: taken,
  });

  if (!Number.isFinite(entryPrice) || entryPrice <= 0
      || !Number.isFinite(currentPrice) || currentPrice < 0
      || !Number.isFinite(openContracts) || openContracts <= 0) {
    return none('invalid inputs — taking nothing');
  }
  if (alreadyScaledOut) return none('already scaled out — will not repeat');

  const gainPct = (currentPrice - entryPrice) / entryPrice;
  if (gainPct < takeProfitAt) {
    return none(`below take-profit threshold (+${(gainPct * 100).toFixed(1)}% < +${(takeProfitAt * 100).toFixed(1)}%)`);
  }

  if (openContracts < 2) {
    return none('single contract — cannot take a partial without closing the whole position');
  }

  const contractsToClose = Math.floor(openContracts / 2);
  return {
    contractsToClose,
    contractsRemaining: openContracts - contractsToClose,
    reason: `+${(gainPct * 100).toFixed(1)}% — closing ${contractsToClose} of ${openContracts}, remainder rides the trail`,
    alreadyTaken: true,
  };
}
