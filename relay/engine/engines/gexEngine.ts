/**
 * Layer 2 — gexEngine
 *
 * Reads Option Chain Snapshot data fed from the ingestion layer.
 * Computes per-strike GEX, identifies structural levels, writes to marketStore.
 *
 * This is the ONLY caller of marketStore.writeContext().
 *
 * Computation runs on each chain snapshot arrival — not on a timer.
 * If a snapshot has fewer than MIN_STRIKES strikes, computation is skipped
 * and the previous marketStore context is preserved (not overwritten with garbage).
 *
 * GEX formula (per strike):
 *   callGex(strike) = callOI × callGamma × spotPrice² × 0.01
 *   putGex(strike)  = putOI  × putGamma  × spotPrice² × 0.01  (negative sign — dealers short)
 *   netGex          = Σ callGex - Σ putGex
 *
 * Regime:
 *   netGex > 0   → 'positive'  (dealers long gamma → mean-reversion)
 *   netGex < 0   → 'negative'  (dealers short gamma → trending)
 *   |netGex| < ε → 'neutral'
 */

import * as marketStore from '../stores/marketStore.ts';
import type { MarketContext }  from '../stores/marketStore.ts';
import type { GexRegime, ChainRow } from '../stores/types.ts';

// ── Constants ─────────────────────────────────────────────────────────────────

const MIN_STRIKES         = 10;
const NEUTRAL_GEX_EPSILON = 50_000_000; // $50M net GEX ≈ neutral band

// ── Public types ──────────────────────────────────────────────────────────────

export interface StrikeData {
  strike:    number;
  callOI:    number;
  putOI:     number;
  callGamma: number;
  putGamma:  number;

  /** YYYY-MM-DD expiration date from Massive details.expiration_date */
  expiry?: string;

  // Full chain fields — populated from the ingestion layer's options snapshot.
  // Optional so that callers that only provide OI/gamma (e.g. backtestEngine)
  // don't break; ChainCockpit renders these columns only when present.
  callBid?:    number;
  callAsk?:    number;
  callLast?:   number;
  callIV?:     number;
  callVolume?: number;
  callDelta?:  number;
  callTheta?:  number;
  callVega?:   number;

  putBid?:    number;
  putAsk?:    number;
  putLast?:   number;
  putIV?:     number;
  putVolume?: number;
  putDelta?:  number;
  putTheta?:  number;
  putVega?:   number;
}

export interface GexResult {
  ticker:     string;
  spotPrice:  number;
  netGex:     number;
  callGex:    number;   // total positive GEX from calls
  putGex:     number;   // total negative GEX from puts (stored as positive magnitude)
  flipLevel:  number;
  wallAbove:  number;
  wallBelow:  number;
  upTarget:   number;
  downTarget: number;
  pcRatio:    number;
  regime:     GexRegime;
  asOf:       number;
}

// ── Engine entry point ────────────────────────────────────────────────────────

/**
 * Process an incoming chain snapshot for `ticker`.
 * Call this whenever the ingestion layer receives a fresh option chain payload.
 *
 * @param ticker     Underlying ticker (e.g. 'SPY')
 * @param spotPrice  Current underlying price
 * @param strikes    Per-strike data array from the chain snapshot
 * @param asOf       UTC ms of the snapshot
 */
export function processChainSnapshot(
  ticker:    string,
  spotPrice: number,
  strikes:   StrikeData[],
  asOf:      number,
) {
  if (strikes.length < MIN_STRIKES) {
    console.warn(
      `[gexEngine] ${ticker}: only ${strikes.length} strikes — skipping (min ${MIN_STRIKES}). ` +
      `Previous context preserved.`
    );
    return;
  }

  const result = computeGex(ticker, spotPrice, strikes, asOf);
  if (!result) return;

  // ── Max pain ─────────────────────────────────────────────────────────────────
  const maxPain = computeMaxPain(strikes);

  // ── Per-strike chain rows ─────────────────────────────────────────────────────
  const chain: ChainRow[] = strikes
    .slice()
    .sort((a, b) => a.strike - b.strike)
    .map((s) => {
      const cGex = perStrikeCallGex(s, spotPrice);
      const pGex = perStrikePutGex(s, spotPrice);
      return {
        strike:     s.strike,
        expiry:     s.expiry ?? '',
        callBid:    s.callBid    ?? 0,
        callAsk:    s.callAsk    ?? 0,
        callLast:   s.callLast   ?? 0,
        callIV:     s.callIV     ?? 0,
        callVolume: s.callVolume ?? 0,
        callOI:     s.callOI,
        callDelta:  s.callDelta  ?? 0,
        callGamma:  s.callGamma,
        callTheta:  s.callTheta  ?? 0,
        callVega:   s.callVega   ?? 0,
        putBid:     s.putBid     ?? 0,
        putAsk:     s.putAsk     ?? 0,
        putLast:    s.putLast    ?? 0,
        putIV:      s.putIV      ?? 0,
        putVolume:  s.putVolume  ?? 0,
        putOI:      s.putOI,
        putDelta:   s.putDelta   ?? 0,
        putGamma:   s.putGamma,
        putTheta:   s.putTheta   ?? 0,
        putVega:    s.putVega    ?? 0,
        callGex:    cGex,
        putGex:     pGex,
        netGex:     cGex - pGex,
        isMaxPain:  s.strike === maxPain,
      };
    });

  const ctx: MarketContext = {
    ticker,
    gexRegime:   result.regime,
    walls: {
      callWall: result.wallAbove,
      putWall:  result.wallBelow,
    },
    flipLevel:   result.flipLevel,
    vannaLevel:  undefined,
    charmLevel:  undefined,
    upTarget:    result.upTarget,
    downTarget:  result.downTarget,
    netGex:      result.netGex,
    pcRatio:     result.pcRatio,
    maxPain,
    chain,
    asOf,
  };

  marketStore.writeContext(ticker, ctx);
  console.log(
    `[gexEngine] ${ticker} — regime: ${result.regime}, flip: ${result.flipLevel}, ` +
    `wallAbove: ${result.wallAbove}, wallBelow: ${result.wallBelow}, netGex: ${result.netGex.toExponential(2)}`
  );
}

// ── Pure computation — exported for unit tests ────────────────────────────────

/**
 * Core GEX computation. Pure function — no side effects, no store reads/writes.
 * Returns null if computation cannot proceed (zero spot price, no valid strikes).
 */
export function computeGex(
  ticker:    string,
  spotPrice: number,
  strikes:   StrikeData[],
  asOf:      number,
): GexResult | null {
  if (spotPrice <= 0 || strikes.length === 0) return null;

  // Per-strike GEX: $ gamma exposure per 1% move
  const strikeGex = strikes.map((s) => ({
    strike:   s.strike,
    callGex:  perStrikeCallGex(s, spotPrice),
    putGex:   perStrikePutGex(s, spotPrice),
    totalOI:  s.callOI + s.putOI,
    callOI:   s.callOI,
    putOI:    s.putOI,
  }));

  const totalCallGex = strikeGex.reduce((sum, s) => sum + s.callGex, 0);
  const totalPutGex  = strikeGex.reduce((sum, s) => sum + s.putGex, 0);
  const netGex       = totalCallGex - totalPutGex;

  // Flip level: strike where cumulative net GEX crosses zero (linear interpolation)
  const flipLevel = computeFlipLevel(strikeGex, spotPrice);

  // Walls: top N strikes by absolute GEX magnitude, split above/below spot
  const aboveSpot = strikeGex.filter((s) => s.strike > spotPrice)
    .sort((a, b) => Math.abs(b.callGex) - Math.abs(a.callGex));
  const belowSpot = strikeGex.filter((s) => s.strike < spotPrice)
    .sort((a, b) => Math.abs(b.putGex) - Math.abs(a.putGex));

  const wallAbove = aboveSpot[0]?.strike ?? spotPrice;
  const wallBelow = belowSpot[0]?.strike ?? spotPrice;

  // Targets: second significant wall cluster (beyond the primary wall)
  const upTarget   = aboveSpot[1]?.strike ?? wallAbove;
  const downTarget = belowSpot[1]?.strike ?? wallBelow;

  // P/C ratio by OI
  const totalCallOI = strikes.reduce((sum, s) => sum + s.callOI, 0);
  const totalPutOI  = strikes.reduce((sum, s) => sum + s.putOI, 0);
  const pcRatio     = totalCallOI > 0 ? totalPutOI / totalCallOI : 1;

  const regime = classifyRegime(netGex);

  return {
    ticker,
    spotPrice,
    netGex,
    callGex:    totalCallGex,
    putGex:     totalPutGex,
    flipLevel,
    wallAbove,
    wallBelow,
    upTarget,
    downTarget,
    pcRatio,
    regime,
    asOf,
  };
}

/**
 * Per-strike call GEX (positive — dealers are long calls, short delta).
 *
 *   callGex = callOI × callGamma × spotPrice² × 0.01
 *
 * The 0.01 factor converts from "per 1 point" gamma to "per 1% move" GEX.
 * 100 multiplier (standard contract size) is embedded in the OI figures
 * from Massive chain snapshots (OI is in contracts, not shares).
 */
export function perStrikeCallGex(s: StrikeData, spotPrice: number): number {
  return s.callOI * s.callGamma * spotPrice * spotPrice * 0.01 * 100;
}

/**
 * Per-strike put GEX (positive magnitude — dealers are short puts, long delta).
 * Stored as positive; subtracted from callGex for netGex.
 *
 *   putGex = putOI × putGamma × spotPrice² × 0.01
 */
export function perStrikePutGex(s: StrikeData, spotPrice: number): number {
  return s.putOI * s.putGamma * spotPrice * spotPrice * 0.01 * 100;
}

/**
 * Classify GEX regime from net GEX value.
 */
export function classifyRegime(netGex: number): GexRegime {
  if (Math.abs(netGex) < NEUTRAL_GEX_EPSILON) return 'neutral';
  return netGex > 0 ? 'positive' : 'negative';
}

/**
 * Compute the flip level: the strike price at which net cumulative GEX
 * transitions from positive to negative (or vice versa).
 *
 * Method: accumulate net GEX from lowest strike upward. The flip is at the
 * strike where the running sum changes sign. Linear interpolation between
 * the two surrounding strikes provides a sub-strike estimate.
 *
 * Returns the current spot price if no sign change is found (no flip in chain).
 */
export function computeFlipLevel(
  strikeGex: Array<{ strike: number; callGex: number; putGex: number }>,
  spotPrice: number,
): number {
  const sorted = [...strikeGex].sort((a, b) => a.strike - b.strike);

  let cumulative = 0;
  let prev = sorted[0];

  for (const curr of sorted) {
    const net = curr.callGex - curr.putGex;
    const prevCumulative = cumulative;
    cumulative += net;

    if (prevCumulative !== 0 && Math.sign(prevCumulative) !== Math.sign(cumulative)) {
      // Linear interpolation between prev.strike and curr.strike
      const t = Math.abs(prevCumulative) / (Math.abs(prevCumulative) + Math.abs(cumulative));
      return prev.strike + t * (curr.strike - prev.strike);
    }

    prev = curr;
  }

  return spotPrice; // no flip found in chain
}

/**
 * Compute max-pain strike: the strike at which aggregate P&L loss is
 * minimised for option holders (i.e. maximised for option sellers).
 *
 * Method: for each candidate strike, sum (strike - K) × OI for all OTM
 * calls above it and (K - strike) × OI for all OTM puts below it.
 * The candidate with minimum total loss is max pain.
 */
export function computeMaxPain(strikes: StrikeData[]): number {
  if (strikes.length === 0) return 0;

  const sorted = [...strikes].sort((a, b) => a.strike - b.strike);
  let minLoss = Infinity;
  let maxPainStrike = sorted[0].strike;

  for (const candidate of sorted) {
    let totalLoss = 0;

    for (const s of sorted) {
      // Call loss: calls expire ITM when strike < candidate → loss = (candidate - s.strike) × callOI
      if (s.strike < candidate.strike) {
        totalLoss += (candidate.strike - s.strike) * s.callOI;
      }
      // Put loss: puts expire ITM when strike > candidate → loss = (s.strike - candidate) × putOI
      if (s.strike > candidate.strike) {
        totalLoss += (s.strike - candidate.strike) * s.putOI;
      }
    }

    if (totalLoss < minLoss) {
      minLoss = totalLoss;
      maxPainStrike = candidate.strike;
    }
  }

  return maxPainStrike;
}
