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
  | 'capped-by-capital'
  | 'capped-by-risk'
  | 'capital-flexed-for-quality-floor'
  | 'capital-governed-risk-exceeded'
  | 'invalid-inputs'
  | 'equity-unavailable';

/** US equity options: 100 shares per contract. */
export const CONTRACT_MULTIPLIER = 100;

// ── Capital cap (small accounts) ─────────────────────────────────────────────
//
// riskBudget bounds the acceptable LOSS. A contract costs the full PREMIUM.
// Those are different numbers, and on a small account the gap decides whether
// anything is tradeable at all: at $300 equity and 2% risk the budget is $6,
// while the cheapest quality-passing contract costs $35. Risk-based sizing
// alone returns 0 forever — not because the trade is bad, but because the
// wrong question is being asked.
//
// So capital and risk are separated. Capital answers "how many can I buy",
// risk answers "how many should I hold", and the result is the min().
//
// ── Why 20%, and why it must not drift upward ──────────────────────────────
//
// A long option going to zero is a routine 0DTE outcome, not a tail event.
// Account remaining after N consecutive total losses, by capital cap:
//
//   cap/trade │ 1 loss │ 2 losses │ 3 losses │ 4 losses
//   ──────────┼────────┼──────────┼──────────┼──────────
//      50%    │  50%   │   25%    │   12%    │    6%
//      30%    │  70%   │   49%    │   34%    │   24%
//      20%    │  80%   │   64%    │   51%    │   41%
//      15%    │  85%   │   72%    │   61%    │   52%
//
// Two losses in a row is ordinary variance. At 50% that leaves a quarter of
// the account; at 20% it leaves 64% — painful and fully recoverable. 20% is
// the point where the "can't afford anything" problem is solved without
// taking on ruin risk. Anyone raising this toward 50% should have to read
// this table first.
export const BASE_CAPITAL_CAP_PCT = 0.20;

/**
 * The cap may stretch to here, and ONLY to afford a single contract that has
 * already passed the quality gate. It never buys a second contract.
 */
export const MAX_FLEXED_CAPITAL_CAP_PCT = 0.30;

/**
 * Equity above which the capital cap stops applying entirely.
 *
 * The cap is an accommodation for accounts too small for risk-based sizing to
 * clear the contract-price floor. Above roughly this level, 2% risk already
 * affords quality contracts on its own, and continuing to allow 20% of equity
 * into one position would be indefensible — 20% of $10,000 is $2,000 in a
 * single 0DTE trade. Named rather than implicit so the crossover is visible.
 */
export const CAPITAL_CAP_EQUITY_THRESHOLD = 2_000;

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
  appliedCap: 'none' | 'max-contracts' | 'pct-of-equity' | 'liquidity' | 'capital';
  /** Dollars of equity this trade is permitted to risk. */
  riskBudget: number;
  /** Modelled dollar loss per contract if stopped out. */
  riskPerContract: number;
  /** Which bound was tighter — useful for understanding a surprising size. */
  bindingRisk: 'premium' | 'delta' | 'premium-only-no-delta' | 'none';
  /** Dollars of capital this position may consume. 0 when the cap is inactive. */
  capitalCap: number;
  /** Contracts affordable from capital alone. Infinity when the cap is inactive. */
  contractsFromCapital: number;
  /** Contracts permitted by the risk formula alone. */
  contractsFromRisk: number;
  /** True when the cap stretched past BASE to afford one quality contract. */
  capitalFlexed: boolean;
  /** False above CAPITAL_CAP_EQUITY_THRESHOLD — pure risk sizing applies. */
  capitalCapActive: boolean;
}

function _fail(reason: SizingReason): SizingResult {
  return {
    contracts: 0,
    reason,
    appliedCap: 'none',
    riskBudget: 0,
    riskPerContract: 0,
    bindingRisk: 'none',
    capitalCap: 0,
    contractsFromCapital: 0,
    contractsFromRisk: 0,
    capitalFlexed: false,
    capitalCapActive: false,
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

  // ── Stage 1: risk. How many SHOULD be held?
  // floor, never round — rounding up over-risks by construction.
  const contractsFromRisk = Math.floor(riskBudget / riskPerContract);

  // ── Stage 2: capital. How many can actually be BOUGHT?
  // Only applies while the account is small enough to need the accommodation.
  const contractCost = premium * CONTRACT_MULTIPLIER;
  const capitalCapActive = equity < CAPITAL_CAP_EQUITY_THRESHOLD;

  let capitalCap = 0;
  let contractsFromCapital = Number.POSITIVE_INFINITY;
  let capitalFlexed = false;

  if (capitalCapActive) {
    capitalCap = equity * BASE_CAPITAL_CAP_PCT;
    contractsFromCapital = Math.floor(capitalCap / contractCost);

    // Flex toward the ceiling ONLY to afford a single contract. Flexing to buy
    // a second would convert an affordability accommodation into leverage.
    //
    // Deliberately NOT conditional on contractsFromRisk >= 1: on a small
    // account the risk stage routinely returns 0 (see the reconciliation note
    // below), and gating the flex on it would make the flex unreachable in
    // exactly the situation it exists for.
    if (contractsFromCapital < 1) {
      const flexedCap = equity * MAX_FLEXED_CAPITAL_CAP_PCT;
      if (flexedCap >= contractCost) {
        capitalCap = flexedCap;
        contractsFromCapital = 1;
        capitalFlexed = true;
      }
    }
  }

  const partial = { riskBudget, riskPerContract, bindingRisk, capitalCap, contractsFromCapital, contractsFromRisk, capitalCapActive, capitalFlexed };

  if (contractsFromCapital < 1) {
    // Cannot fund one contract even at the flexed ceiling. When the capital
    // cap is inactive this is Infinity, so this only fires on small accounts.
    return { ..._fail('capped-by-capital'), ...partial };
  }

  // ── Reconciling the two stages.
  //
  // On a small account these disagree in a way that has to be decided, not
  // averaged. At $300 equity and 2% risk the budget is $6, while a real
  // $0.35 contract (AAPL 245P, delta -0.021, from a captured chain) has a
  // risk-per-contract of $10.30. Risk says 0. Capital says 1.
  //
  // Deferring to risk means never trading a small account — the problem the
  // capital cap exists to solve. So while the cap is active, the CAPITAL CAP
  // IS the risk control: max loss on a long option is the premium paid, which
  // is exactly the capital deployed, so a 20% capital cap is a 20% worst-case
  // loss cap. That is precisely what the survival table in the header prices,
  // and why the cap is bounded at 20% rather than 50%.
  //
  // The consequence is explicit and must not be hidden: per-trade risk on a
  // small account is governed by the capital cap (up to 20%), NOT by riskPct
  // (2%). It is reported as its own reason code so this never looks like
  // ordinary 2% sizing in a log.
  //
  // Above the threshold the cap is inactive, riskPct governs alone, and this
  // branch cannot be reached.
  let rawContracts: number;
  let riskExceeded = false;

  if (contractsFromRisk < 1) {
    if (!capitalCapActive) {
      // Large account: risk genuinely forbids it. No capital accommodation.
      return {
        ..._fail(equity < caps.minEquityToTrade * 2
          ? 'equity-below-options-viable'
          : 'budget-below-one-contract'),
        ...partial,
      };
    }
    // Small account: take the single contract capital can fund.
    rawContracts = 1;
    riskExceeded = true;
  } else {
    rawContracts = Math.min(contractsFromRisk, contractsFromCapital);
  }

  // ── Hard caps, applied AFTER the formula and independently of it. These are
  // the circuit breaker for the case where the formula itself is wrong.
  let contracts = rawContracts;
  let appliedCap: SizingResult['appliedCap'] = 'none';

  // Which stage bound the result.
  //
  // The capital-vs-risk distinction is only meaningful while the capital cap
  // is ACTIVE. Above the threshold contractsFromCapital is Infinity, so risk
  // is trivially the tighter bound — reporting 'capped-by-risk' there would
  // imply a constraint was hit when this is simply ordinary sizing.
  let reason: SizingReason = 'ok';
  if (capitalCapActive) {
    if (riskExceeded) reason = 'capital-governed-risk-exceeded';
    else if (capitalFlexed) reason = 'capital-flexed-for-quality-floor';
    else if (contractsFromCapital < contractsFromRisk) reason = 'capped-by-capital';
    else if (contractsFromRisk < contractsFromCapital) reason = 'capped-by-risk';
    if (contractsFromCapital <= contractsFromRisk) appliedCap = 'capital';
  }

  // Notional cap: a wide stop can pass the risk check while consuming most of
  // the account in premium. Risk and capital-at-stake are different questions.
  // While the capital cap is active it is the tighter of the two by design, so
  // this mainly binds on larger accounts.
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
    return { ..._fail('budget-below-one-contract'), ...partial };
  }

  return { contracts, reason, appliedCap, ...partial };
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
