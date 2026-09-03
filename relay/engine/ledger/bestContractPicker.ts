/**
 * Layer 3 — bestContractPicker
 *
 * Server-side port of BestContractsCockpit.tsx's real per-ticker contract
 * selection: the ATM-with-narrow-fallback strike choice, the 8-criterion
 * quality check, and the composite rankScore — the same real logic, same
 * real thresholds, ported so signalLedger can capture it at signal-fire
 * time instead of it only ever existing at browser render time.
 *
 * ── What this is NOT — a real distinction, checked before building ────────
 * BestContractsCockpit's "top 5" is a CROSS-TICKER ranking: one candidate
 * per currently-firing ticker, sorted against every other ticker's current
 * candidate to decide which opportunity to surface first in the UI. It is
 * NOT a ranked list of multiple strikes for one ticker — for a single
 * ticker, the real chain-row selection (_pickChainRow below) considers at
 * most 3 real candidates (ATM + its 2 nearest neighbors) and returns
 * exactly ONE, falling back to a neighbor only when ATM itself fails the
 * spread/IV quality check. This module ports that ONE-candidate-per-ticker
 * logic — not a fabricated "ranked list" that doesn't correspond to how
 * Best Contracts actually works. The real ranked-attempt-fallback pattern
 * that walks MULTIPLE candidates for execution already exists unchanged in
 * contractDiscovery.ts's own internal walk; this module feeds it one real
 * preferred strike, not a competing list.
 *
 * Pure function — no store reads inside. The caller (signalLedger.ts)
 * passes in already-read store snapshots, same contract as every other
 * pure scoring function in this codebase (catalystGate.computeTags,
 * confluenceEngine.scoreEmaTrend).
 */

import type { Bar, ChainRow } from '../stores/types.ts';
import type { MarketContext } from '../stores/marketStore.ts';
import type { CvdState } from '../stores/cvdStore.ts';
import type { FundamentalsData } from '../stores/fundamentalsStore.ts';
import type { BaseRate } from './brainStore.ts';

// ── Constants — real thresholds, copied verbatim from BestContractsCockpit.tsx ──

const BRAIN_WIN_FLOOR    = 0.60;
const BRAIN_N_FLOOR      = 30;
const SPREAD_MAX_PCT     = 0.08;
const IV_RANK_WARN       = 0.75;
const EARNINGS_WARN_DAYS = 2;

// ── Public shape ──────────────────────────────────────────────────────────────

export interface BestContractCriteria {
  c1BrainValid:  boolean;
  c2NoBlocker:   boolean;
  c3CvdDual:     boolean;
  c4SignalState: boolean;
  c5Spread:      boolean;
  c6BreakEven:   boolean;
  c7IvRank:      boolean;
  c8NoEarnings:  boolean;
}

/**
 * The real, single contract Best Contracts' own logic would recommend for
 * this ticker + direction at this exact moment — captured once, at
 * signal-fire time, immutable afterward (same rule as the rest of
 * SignalFactors).
 */
export interface BestContractPick {
  strike:             number;
  expiry:             string;
  premium:            number;  // mid = (bid+ask)/2 — same real formula everywhere else in this codebase
  delta:              number | null;
  gamma:              number | null; // NOT read by BestContractsCockpit's own readSide() — added here since ZeroDteCockpit's real Greek-capture shape includes it and the field already exists on ChainRow
  theta:              number | null;
  spreadPctOfMid:      number;
  usedFallbackStrike:  boolean; // true if ATM failed quality and a neighbor strike was used instead
  criteria:            BestContractCriteria;
  rankScore:           number;  // real computeRankScore output — a quality score, NOT a cross-ticker rank position
}

export interface PickBestContractInput {
  ticker:      string;
  direction:   'call' | 'put';
  signalType:  string;
  confidence:  number;
  ctx:         MarketContext | null;
  cvd:         CvdState | null;
  leaderCvd:   CvdState | null;
  bars:        Bar[] | null;
  fund:        FundamentalsData | null;
  baseRate:    BaseRate | null;
  nowMs:       number;
}

// ── Real helpers — ported verbatim from BestContractsCockpit.tsx ────────────────

/**
 * Real IV -> percentile mapping (no historical IV series available, so this
 * is a rough shape-based estimate, not a true percentile rank) — same
 * function, same real breakpoints as the browser's estimateIvRank.
 */
export function estimateIvRank(iv: number): number {
  if (iv <= 0.15) return 0;
  if (iv >= 0.80) return 1;
  if (iv <= 0.30) return (iv - 0.15) / (0.30 - 0.15) * 0.50;
  if (iv <= 0.50) return 0.50 + (iv - 0.30) / (0.50 - 0.30) * 0.25;
  return 0.75 + (iv - 0.50) / (0.80 - 0.50) * 0.25;
}

/**
 * Real earnings-within-window check, same real 1hr-lookback-to-`days`-ahead
 * window as the browser's earningsWithinDays. Returns the real formatted
 * date string or null — the caller only needs the boolean (c8NoEarnings)
 * but the date is kept for parity with the real source function.
 */
function earningsWithinDays(
  disclosures: FundamentalsData['recentDisclosures'],
  days: number,
  nowMs: number,
): boolean {
  const cutoff = nowMs + days * 24 * 60 * 60 * 1000;
  return disclosures.some(
    (d) => d.category === 'earnings' && d.filedAt <= cutoff && d.filedAt >= nowMs - 3600_000,
  );
}

interface ChainSide {
  bid: number;
  ask: number;
  iv: number;
  delta: number;
  gamma: number;
  theta: number;
}

function _readSide(row: ChainRow, direction: 'call' | 'put'): ChainSide {
  return direction === 'call'
    ? { bid: row.callBid, ask: row.callAsk, iv: row.callIV, delta: row.callDelta, gamma: row.callGamma, theta: row.callTheta }
    : { bid: row.putBid,  ask: row.putAsk,  iv: row.putIV,  delta: row.putDelta,  gamma: row.putGamma,  theta: row.putTheta };
}

function _passesQuality(side: ChainSide): boolean {
  const mid  = (side.bid + side.ask) / 2;
  const sPct = mid > 0 ? (side.ask - side.bid) / mid : 1;
  const rank = estimateIvRank(side.iv);
  return (sPct < SPREAD_MAX_PCT || mid === 0) && rank < IV_RANK_WARN;
}

/**
 * Real ATM-with-narrow-fallback strike selection — ported verbatim from
 * BestContractsCockpit.tsx (lines 641-690 at last read): nearest-to-price
 * strike by default; if ATM fails the real spread/IV quality gate, check
 * the 2 strikes immediately adjacent (by strike distance, not price
 * distance) and use the first one that clears quality. Falls back to ATM
 * itself if no neighbor clears it either — this never returns "no pick",
 * only ever "ATM" or "a clean neighbor instead of ATM".
 */
function _pickChainRow(
  chain: ChainRow[],
  price: number,
  direction: 'call' | 'put',
): { row: ChainRow; side: ChainSide; usedFallback: boolean } | null {
  if (chain.length === 0) return null;

  const sortedByDistance = [...chain].sort((a, b) => Math.abs(a.strike - price) - Math.abs(b.strike - price));
  const atmRow  = sortedByDistance[0];
  const atmSide = _readSide(atmRow, direction);

  if (_passesQuality(atmSide) || sortedByDistance.length <= 1) {
    return { row: atmRow, side: atmSide, usedFallback: false };
  }

  const neighbors = chain
    .filter((r) => r.strike !== atmRow.strike)
    .sort((a, b) => Math.abs(a.strike - atmRow.strike) - Math.abs(b.strike - atmRow.strike))
    .slice(0, 2);

  for (const candidate of neighbors) {
    const side = _readSide(candidate, direction);
    if (_passesQuality(side)) {
      return { row: candidate, side, usedFallback: true };
    }
  }

  return { row: atmRow, side: atmSide, usedFallback: false };
}

/** Real composite score — copied verbatim from BestContractsCockpit's computeRankScore. */
export function computeRankScore(criteria: BestContractCriteria, confidence: number): number {
  let score = 0;
  if (criteria.c1BrainValid)  score += 128;
  if (criteria.c2NoBlocker)   score += 64;
  if (criteria.c3CvdDual)     score += 32;
  if (criteria.c4SignalState) score += 16;
  if (criteria.c5Spread)      score += 8;
  if (criteria.c6BreakEven)   score += 4;
  if (criteria.c7IvRank)      score += 2;
  if (criteria.c8NoEarnings)  score += 1;
  score += confidence * 0.001;
  return score;
}

// ── Public entry point ───────────────────────────────────────────────────────

/**
 * Real, single contract pick for one ticker+direction at signal-fire time.
 * Returns null when there isn't enough real data to compute one (chain or
 * bars not ready) — a genuine absence, not a fabricated default pick.
 */
export function pickBestContract(input: PickBestContractInput): BestContractPick | null {
  const { ticker, direction, signalType, confidence, ctx, cvd, leaderCvd, bars, fund, baseRate, nowMs } = input;

  if (!ctx?.chain || ctx.chain.length === 0 || !bars || bars.length === 0) return null;

  const price = bars[bars.length - 1].close;
  const picked = _pickChainRow(ctx.chain, price, direction);
  if (!picked) return null;

  const { row, side, usedFallback } = picked;
  const midPremium = (side.bid + side.ask) / 2;
  const spreadPctOfMid = midPremium > 0 ? (side.ask - side.bid) / midPremium : 1;
  const ivRank = estimateIvRank(side.iv);

  // ── Criterion 1: Brain base rate >= 60%, n >= 30 ──────────────────────────
  const c1BrainValid = !!(baseRate && baseRate.isStatisticallyValid && baseRate.n >= BRAIN_N_FLOOR && baseRate.winRate >= BRAIN_WIN_FLOOR);

  // ── Criterion 2: no active timing blocker ─────────────────────────────────
  // Real blockers, same real conditions BestContractsCockpit checks, folded
  // straight into the boolean since this module doesn't need the display
  // labels — only the pass/fail the criterion represents.
  const hasEarningsBlocker = fund ? earningsWithinDays(fund.recentDisclosures, EARNINGS_WARN_DAYS, nowMs) : false;
  const hasIvBlocker       = ivRank > IV_RANK_WARN;
  const hasSpreadBlocker   = spreadPctOfMid > SPREAD_MAX_PCT && midPremium > 0;
  const hasConvictionBlocker = confidence < 55;
  const c2NoBlocker = !hasEarningsBlocker && !hasIvBlocker && !hasSpreadBlocker && !hasConvictionBlocker;

  // ── Criterion 3: CVD dual confirmation (leader + own ticker) ──────────────
  const leaderCvdOk = leaderCvd
    ? (direction === 'call' ? leaderCvd.classification === 'bullish' : leaderCvd.classification === 'bearish')
    : false;
  const tickerCvdOk = cvd
    ? (direction === 'call'
        ? cvd.classification === 'bullish' || cvd.classification === 'neutral'
        : cvd.classification === 'bearish' || cvd.classification === 'neutral')
    : false;
  const c3CvdDual = leaderCvdOk && tickerCvdOk;

  // ── Criterion 4: signal state is actionable ───────────────────────────────
  const actionableTypes = new Set(['ENTER', 'BREAKOUT', 'REVERSAL', 'RIP']);
  const c4SignalState = actionableTypes.has(signalType) && confidence >= 65;

  // ── Criterion 5: spread < 8% ───────────────────────────────────────────────
  const c5Spread = spreadPctOfMid < SPREAD_MAX_PCT || midPremium === 0;

  // ── Criterion 6: break-even reachable before the nearest GEX wall ────────
  let c6BreakEven = true;
  if (ctx) {
    const wall = direction === 'call' ? ctx.walls.callWall : ctx.walls.putWall;
    c6BreakEven = midPremium < Math.abs(wall - price);
  }

  // ── Criterion 7: IV rank < 75th percentile ────────────────────────────────
  const c7IvRank = ivRank < IV_RANK_WARN;

  // ── Criterion 8: no earnings within 2 days ────────────────────────────────
  const c8NoEarnings = !hasEarningsBlocker;

  const criteria: BestContractCriteria = {
    c1BrainValid, c2NoBlocker, c3CvdDual, c4SignalState, c5Spread, c6BreakEven, c7IvRank, c8NoEarnings,
  };

  return {
    strike:  row.strike,
    expiry:  row.expiry,
    premium: midPremium,
    delta:   side.delta ?? null,
    gamma:   side.gamma ?? null,
    theta:   side.theta ?? null,
    spreadPctOfMid,
    usedFallbackStrike: usedFallback,
    criteria,
    rankScore: computeRankScore(criteria, confidence),
  };
}
