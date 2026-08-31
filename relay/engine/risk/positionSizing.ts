/**
 * Position sizing — percentage-of-equity risk, options-correct.
 *
 * Pure. No broker import, no clock, no store reads. Equity is passed in and
 * never fetched here, so this is testable in isolation and cannot silently
 * size against a stale balance.
 *
 * ── Why not stopDistance × 100 ────────────────────────────────────────────
 *
 * That is the STOCK formula. A share moves 1:1 with the underlying; an option
 * moves by its delta. A 0.08-delta far-OTM contract loses roughly 8 cents per
 * dollar of adverse move, not a dollar — so the stock formula overstates
 * risk-per-contract by up to ~12x on exactly the far-OTM contracts DUMP/RIP
 * and 0DTE trade, and therefore under-sizes by the same factor.
 *
 * ── The two bounds ────────────────────────────────────────────────────────
 *
 *   premiumRisk = premium × 100 × maxPremiumLossPct
 *       A long option cannot lose more than the premium paid. This bound is
 *       always enforceable — you can always exit at -50% — and on 0DTE the
 *       premium can decay to zero before the underlying ever reaches a
 *       delta-implied stop.
 *
 *   deltaRisk   = stopDistance × |delta| × 100
 *       The thesis-implied risk: what the contract loses if the underlying
 *       travels to the stop.
 *
 *   riskPerContract = min(premiumRisk, deltaRisk)
 *
 * min() is correct because the position exits at whichever trigger fires
 * first. IMPORTANT: that is only true if BOTH exits are actually enforced.
 * Taking the min while enforcing only the delta stop would understate real
 * risk — if premium collapses 80% before the underlying reaches the stop, the
 * loss is the premium, not the delta estimate. The execution layer owes this
 * function a premium-based exit; see maxPremiumLossPct.
 */

export type SizingReason =
  | 'ok'
  | 'below-min-equity'
  | 'equity-below-options-viable'
  | 'budget-below-one-contract'
  | 'capped-by-max-contracts'
  | 'capped-by-pct-of-equity'
  | 'capped-by-liquidity'
  | 'invalid-inputs'
  | 'equity-unavailable';

/** US equity options: 100 shares per contract. */
export const CONTRACT_MULTIPLIER = 100;

export interface SizingCaps {
  /** Absolute ceiling on contracts, regardless of what the formula says. */
  maxContractsPerPosition: number;
  /** Max fraction of equity a single position's premium may consume (0-1). */
  maxPositionPctOfEquity: number;
  /** Below this equity, do not trade at all. */
  minEquityToTrade: number;
  /**
   * Optional liquidity ceiling — e.g. a fraction of the contract's open
   * interest or day volume. Omit when unknown; never defaulted to a guess.
   */
  maxContractsByLiquidity?: number;
}

export interface SizingInput {
  /** Account equity in dollars. MUST come from the broker, freshly read. */
  equity: number;
  /** Fraction of equity to risk on this trade (e.g. 0.02 for 2%). */
  riskPct: number;
  /** Option premium per share (not per contract). */
  premium: number;
  /** Fraction of premium accepted as a loss before exiting (e.g. 0.5). */
  maxPremiumLossPct: number;
  /** Underlying distance from entry to stop, in dollars per share. */
  stopDistance: number;
  /**
   * Contract delta. Sign is ignored — magnitude is what scales the move.
   * Optional: when absent, sizing falls back to the premium bound alone,
   * which yields FEWER contracts (a larger risk-per-contract), so the
   * fallback is conservative rather than permissive.
   */
  delta?: number;
  caps: SizingCaps;
}

export interface SizingResult {
  contracts: number;
  reason: SizingReason;
  /** Which cap bound the result, when a cap was the binding constraint. */
  appliedCap: 'none' | 'max-contracts' | 'pct-of-equity' | 'liquidity';
  /** Dollars of equity this trade is permitted to risk. */
  riskBudget: number;
  /** Modelled dollar loss per contract if stopped out. */
  riskPerContract: number;
  /** Which bound was tighter — useful for understanding a surprising size. */
  bindingRisk: 'premium' | 'delta' | 'premium-only-no-delta' | 'none';
}

function _fail(reason: SizingReason): SizingResult {
  return {
    contracts: 0,
    reason,
    appliedCap: 'none',
    riskBudget: 0,
    riskPerContract: 0,
    bindingRisk: 'none',
  };
}

/**
 * Size a position.
 *
 * Returns `contracts: 0` as a legitimate outcome, never as an error. The
 * caller MUST treat 0 as "skip this signal" and must never round it up to 1 —
 * on a $100 account at 2% risk the budget is $2, and rounding up to a single
 * $80 contract turns a 2% risk into an 80% one. That is the most common way
 * proportional sizing gets quietly broken for small accounts.
 */
export function sizePosition(input: SizingInput): SizingResult {
  const { equity, riskPct, premium, maxPremiumLossPct, stopDistance, delta, caps } = input;

  // ── Input validity. Every one of these would otherwise produce a
  // confidently wrong number rather than an obvious failure.
  if (!Number.isFinite(equity) || equity <= 0) return _fail('equity-unavailable');
  if (!Number.isFinite(riskPct) || riskPct <= 0 || riskPct > 1) return _fail('invalid-inputs');
  if (!Number.isFinite(premium) || premium <= 0) return _fail('invalid-inputs');
  if (!Number.isFinite(maxPremiumLossPct) || maxPremiumLossPct <= 0 || maxPremiumLossPct > 1) return _fail('invalid-inputs');
  // stopDistance must be strictly positive. A zero-distance stop sits AT the
  // entry price and would trigger immediately — it is not "no stop", it is a
  // nonsense stop. Accepting it and quietly falling back to premium-only
  // sizing would hide a caller bug behind a plausible-looking contract count.
  if (!Number.isFinite(stopDistance) || stopDistance <= 0) return _fail('invalid-inputs');
  if (!Number.isFinite(caps.maxContractsPerPosition) || caps.maxContractsPerPosition <= 0) return _fail('invalid-inputs');
  if (!Number.isFinite(caps.maxPositionPctOfEquity) || caps.maxPositionPctOfEquity <= 0 || caps.maxPositionPctOfEquity > 1) return _fail('invalid-inputs');

  if (equity < caps.minEquityToTrade) return _fail('below-min-equity');

  const riskBudget = equity * riskPct;

  // ── Risk per contract: the tighter of the two bounds.
  const premiumRisk = premium * CONTRACT_MULTIPLIER * maxPremiumLossPct;

  const haveDelta = Number.isFinite(delta) && Math.abs(delta as number) > 0;
  const deltaRisk = haveDelta
    ? stopDistance * Math.abs(delta as number) * CONTRACT_MULTIPLIER
    : Number.POSITIVE_INFINITY;   // absent delta must never win the min()

  let riskPerContract: number;
  let bindingRisk: SizingResult['bindingRisk'];

  if (!haveDelta) {
    riskPerContract = premiumRisk;
    bindingRisk = 'premium-only-no-delta';
  } else if (deltaRisk > 0 && deltaRisk < premiumRisk) {
    riskPerContract = deltaRisk;
    bindingRisk = 'delta';
  } else {
    riskPerContract = premiumRisk;
    bindingRisk = 'premium';
  }

  // A zero or non-finite risk-per-contract would make the division below
  // produce Infinity contracts. This is the divide-by-zero that a
  // stopDistance of 0, or a delta of 0, walks straight into.
  if (!Number.isFinite(riskPerContract) || riskPerContract <= 0) return _fail('invalid-inputs');

  // ── Raw size. floor, never round — rounding up over-risks by construction.
  const rawContracts = Math.floor(riskBudget / riskPerContract);

  if (rawContracts < 1) {
    // Distinguish "this account cannot trade options at all at this risk
    // level" from "this particular contract is too expensive for the budget".
    // Both yield 0, but they mean different things and need different fixes.
    const cheapestViableRisk = premium * CONTRACT_MULTIPLIER * maxPremiumLossPct;
    return {
      ..._fail(riskBudget < cheapestViableRisk && equity < caps.minEquityToTrade * 2
        ? 'equity-below-options-viable'
        : 'budget-below-one-contract'),
      riskBudget,
      riskPerContract,
      bindingRisk,
    };
  }

  // ── Hard caps, applied AFTER the formula and independently of it. These are
  // the circuit breaker for the case where the formula itself is wrong.
  let contracts = rawContracts;
  let appliedCap: SizingResult['appliedCap'] = 'none';
  let reason: SizingReason = 'ok';

  // Notional cap: a wide stop can pass the risk check while consuming most of
  // the account in premium. Risk and capital-at-stake are different questions.
  const maxByNotional = Math.floor(
    (equity * caps.maxPositionPctOfEquity) / (premium * CONTRACT_MULTIPLIER),
  );
  if (maxByNotional < contracts) {
    contracts = maxByNotional;
    appliedCap = 'pct-of-equity';
    reason = 'capped-by-pct-of-equity';
  }

  if (caps.maxContractsPerPosition < contracts) {
    contracts = caps.maxContractsPerPosition;
    appliedCap = 'max-contracts';
    reason = 'capped-by-max-contracts';
  }

  if (Number.isFinite(caps.maxContractsByLiquidity as number)
      && (caps.maxContractsByLiquidity as number) < contracts) {
    contracts = Math.floor(caps.maxContractsByLiquidity as number);
    appliedCap = 'liquidity';
    reason = 'capped-by-liquidity';
  }

  if (contracts < 1) {
    return { ..._fail('budget-below-one-contract'), riskBudget, riskPerContract, bindingRisk };
  }

  return { contracts, reason, appliedCap, riskBudget, riskPerContract, bindingRisk };
}

// ── Affordable premium band ──────────────────────────────────────────────────

export interface PremiumBand {
  /** Cheapest premium worth trading. Below this, spread dominates the edge. */
  minPremium: number;
  /** Most expensive premium where one contract still fits every constraint. */
  maxPremium: number;
  /** False when no contract can satisfy the account's constraints at all. */
  tradeable: boolean;
  reason: SizingReason;
}

/**
 * Invert the sizing question: given equity, what premium range is tradeable?
 *
 * This is the architecturally important half. Computing the band BEFORE
 * contract selection lets Best Contracts choose a strike it can actually
 * afford, instead of selecting on thesis quality and then having sizing reject
 * it. Selection happens inside the band rather than in front of it — a small
 * account gets shown a tradeable strike rather than a rejected trade.
 *
 * `minPremiumAbsolute` is a market-structure floor, not an account-size one:
 * a $0.03 contract has a spread measured in tens of percent no matter how
 * large the account is.
 */
export function affordablePremiumBand(args: {
  equity: number;
  riskPct: number;
  maxPremiumLossPct: number;
  caps: SizingCaps;
  minPremiumAbsolute?: number;
}): PremiumBand {
  const { equity, riskPct, maxPremiumLossPct, caps } = args;
  const minPremiumAbsolute = args.minPremiumAbsolute ?? 0.10;

  const bad = (reason: SizingReason): PremiumBand =>
    ({ minPremium: 0, maxPremium: 0, tradeable: false, reason });

  if (!Number.isFinite(equity) || equity <= 0) return bad('equity-unavailable');
  if (!Number.isFinite(riskPct) || riskPct <= 0 || riskPct > 1) return bad('invalid-inputs');
  if (!Number.isFinite(maxPremiumLossPct) || maxPremiumLossPct <= 0 || maxPremiumLossPct > 1) return bad('invalid-inputs');
  if (equity < caps.minEquityToTrade) return bad('below-min-equity');

  const riskBudget = equity * riskPct;

  // Bound 1 — risk: one contract's premium-loss must fit the risk budget.
  const maxByRisk = riskBudget / (CONTRACT_MULTIPLIER * maxPremiumLossPct);

  // Bound 2 — notional: one contract's full premium must fit the position cap.
  const maxByNotional = (equity * caps.maxPositionPctOfEquity) / CONTRACT_MULTIPLIER;

  const maxPremium = Math.min(maxByRisk, maxByNotional);

  if (maxPremium < minPremiumAbsolute) {
    // The account cannot afford even the cheapest contract worth trading.
    // A real answer, not an error — and far more useful than silently
    // returning an empty contract list later.
    return { minPremium: minPremiumAbsolute, maxPremium, tradeable: false, reason: 'equity-below-options-viable' };
  }

  return { minPremium: minPremiumAbsolute, maxPremium, tradeable: true, reason: 'ok' };
}
