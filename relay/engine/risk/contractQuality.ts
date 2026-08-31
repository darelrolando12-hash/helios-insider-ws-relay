/**
 * Contract quality gate — bid/ask spread, independent of account size.
 *
 * A $0.05 / $0.10 market is a 67%-of-mid spread. Crossing it costs a third of
 * the position's value on entry and again on exit. That is a property of the
 * INSTRUMENT, not of the account: a $1,000,000 account should refuse that
 * contract for exactly the same reason a $500 account should. Size does not
 * make a bad market good.
 *
 * This runs before sizing. A contract that fails here is never sized, because
 * "how many should I buy" is the wrong question about an untradeable market.
 */

export type QualityReason =
  | 'ok'
  | 'spread-too-wide'
  | 'no-quote'
  | 'crossed-or-locked'
  | 'below-min-premium'
  | 'no-liquidity';

export interface ContractQuote {
  bid: number;
  ask: number;
  /** Open interest, when known. */
  openInterest?: number;
  /** Session volume, when known. */
  volume?: number;
}

export interface QualityThresholds {
  /** Max acceptable (ask-bid)/mid, e.g. 0.15 for 15%. */
  maxSpreadPctOfMid: number;
  /** Contracts below this premium are refused regardless of spread. */
  minPremium: number;
  /**
   * Minimum open interest. Optional — when the field is absent from the quote
   * the check is SKIPPED rather than assumed to pass, and the result says so.
   */
  minOpenInterest?: number;
}

export interface QualityResult {
  acceptable: boolean;
  reason: QualityReason;
  mid: number;
  spread: number;
  spreadPctOfMid: number;
  /**
   * True when a configured liquidity threshold could not be evaluated because
   * the quote did not carry the field. The contract is not failed for it —
   * but the caller must not read `acceptable: true` as "liquidity verified".
   * Same distinction as dataQuality 'absent' versus a real zero.
   */
  liquidityUnverified: boolean;
}

export function assessContractQuality(
  quote: ContractQuote,
  thresholds: QualityThresholds,
): QualityResult {
  const bad = (reason: QualityReason, mid = 0, spread = 0, pct = 0): QualityResult =>
    ({ acceptable: false, reason, mid, spread, spreadPctOfMid: pct, liquidityUnverified: false });

  const { bid, ask } = quote;

  // No quote at all. Distinct from a wide quote — this is data absence, and a
  // missing quote must never be treated as a passable one.
  if (!Number.isFinite(bid) || !Number.isFinite(ask) || bid <= 0 || ask <= 0) {
    return bad('no-quote');
  }

  // Crossed (bid > ask) or locked (bid === ask) markets are not tradeable
  // states; a mid computed from them is meaningless.
  if (bid >= ask) return bad('crossed-or-locked');

  const mid = (bid + ask) / 2;
  const spread = ask - bid;
  const spreadPctOfMid = spread / mid;

  if (mid < thresholds.minPremium) {
    return bad('below-min-premium', mid, spread, spreadPctOfMid);
  }

  if (spreadPctOfMid > thresholds.maxSpreadPctOfMid) {
    return bad('spread-too-wide', mid, spread, spreadPctOfMid);
  }

  // Liquidity: only evaluated when both a threshold and a value exist.
  let liquidityUnverified = false;
  if (Number.isFinite(thresholds.minOpenInterest as number)) {
    if (!Number.isFinite(quote.openInterest as number)) {
      liquidityUnverified = true;
    } else if ((quote.openInterest as number) < (thresholds.minOpenInterest as number)) {
      return bad('no-liquidity', mid, spread, spreadPctOfMid);
    }
  }

  return { acceptable: true, reason: 'ok', mid, spread, spreadPctOfMid, liquidityUnverified };
}
