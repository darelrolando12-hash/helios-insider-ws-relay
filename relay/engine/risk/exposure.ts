/**
 * Total exposure cap — the portfolio-level check the per-trade sizer cannot make.
 *
 * sizePosition() answers "how much may THIS trade risk". It has no visibility
 * into what is already open, so a 2%-per-trade rule with twenty concurrent
 * positions is a 40% portfolio risk that every individual check approves.
 *
 * "60-80% of the account" is a TOTAL DEPLOYMENT ceiling, not a per-trade risk
 * budget. Risking 70% of equity on one options trade is a coin flip with the
 * balance — a long option routinely goes to zero, and on 0DTE that is the
 * ordinary outcome, not the tail. Deploying up to 70% of capital across all
 * open positions while risking ~2% per trade is an entirely different and
 * survivable statement.
 *
 * Compounding needs no separate rule: percentage-of-equity sizing already
 * delivers it. A win raises equity, so the same riskPct is automatically a
 * larger dollar amount on the next trade.
 *
 * Pure, but requires live position state, so the execution layer calls this
 * BEFORE sizePosition rather than the sizer calling it.
 */

export type ExposureReason =
  | 'ok'
  | 'at-capital-cap'
  | 'at-risk-cap'
  | 'at-position-count-cap'
  | 'invalid-inputs'
  | 'equity-unavailable';

export interface OpenPosition {
  /** Premium paid per share for this position. */
  premium: number;
  contracts: number;
  /** Modelled dollar loss if stopped out — from sizePosition at entry time. */
  riskDollars: number;
}

export interface ExposureLimits {
  /** Max fraction of equity deployed as premium across ALL positions (0-1). */
  maxTotalDeployedPct: number;
  /** Max fraction of equity at risk across ALL positions (0-1). */
  maxTotalRiskPct: number;
  /** Max simultaneous open positions. */
  maxConcurrentPositions: number;
}

export interface ExposureResult {
  allowed: boolean;
  reason: ExposureReason;
  /** Dollars of premium currently deployed. */
  deployedDollars: number;
  /** Dollars currently at risk across open positions. */
  riskDollars: number;
  openCount: number;
  /** Premium headroom, in dollars, for the next position. */
  remainingCapital: number;
  /** Risk headroom, in dollars, for the next position. */
  remainingRisk: number;
}

const CONTRACT_MULTIPLIER = 100;

export function checkExposure(args: {
  equity: number;
  openPositions: readonly OpenPosition[];
  limits: ExposureLimits;
}): ExposureResult {
  const { equity, openPositions, limits } = args;

  const empty = (reason: ExposureReason): ExposureResult => ({
    allowed: false, reason,
    deployedDollars: 0, riskDollars: 0, openCount: 0,
    remainingCapital: 0, remainingRisk: 0,
  });

  if (!Number.isFinite(equity) || equity <= 0) return empty('equity-unavailable');
  if (!Array.isArray(openPositions)) return empty('invalid-inputs');
  if (!Number.isFinite(limits.maxTotalDeployedPct) || limits.maxTotalDeployedPct <= 0 || limits.maxTotalDeployedPct > 1) return empty('invalid-inputs');
  if (!Number.isFinite(limits.maxTotalRiskPct) || limits.maxTotalRiskPct <= 0 || limits.maxTotalRiskPct > 1) return empty('invalid-inputs');
  if (!Number.isFinite(limits.maxConcurrentPositions) || limits.maxConcurrentPositions < 0) return empty('invalid-inputs');

  let deployedDollars = 0;
  let riskDollars = 0;
  for (const p of openPositions) {
    // A malformed position must not silently count as zero exposure — that
    // would let the cap be bypassed by bad data rather than by a real limit.
    if (!Number.isFinite(p.premium) || !Number.isFinite(p.contracts) || !Number.isFinite(p.riskDollars)) {
      return empty('invalid-inputs');
    }
    deployedDollars += p.premium * p.contracts * CONTRACT_MULTIPLIER;
    riskDollars += p.riskDollars;
  }

  const openCount = openPositions.length;
  const capitalCap = equity * limits.maxTotalDeployedPct;
  const riskCap = equity * limits.maxTotalRiskPct;

  const remainingCapital = Math.max(0, capitalCap - deployedDollars);
  const remainingRisk = Math.max(0, riskCap - riskDollars);

  const base = { deployedDollars, riskDollars, openCount, remainingCapital, remainingRisk };

  if (openCount >= limits.maxConcurrentPositions) {
    return { allowed: false, reason: 'at-position-count-cap', ...base };
  }
  if (remainingCapital <= 0) {
    return { allowed: false, reason: 'at-capital-cap', ...base };
  }
  if (remainingRisk <= 0) {
    return { allowed: false, reason: 'at-risk-cap', ...base };
  }

  return { allowed: true, reason: 'ok', ...base };
}
