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
import { computeZeroGamma, type GammaContract } from '../lib/zeroGamma.ts';

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

/** A flip level computed somewhere else — null level means absent, with a reason. */
export interface ExternalFlip {
  level:  number | null;
  reason: string | null;
}

export interface GexResult {
  ticker:     string;
  spotPrice:  number;
  netGex:     number;
  callGex:    number;   // total positive GEX from calls
  putGex:     number;   // total negative GEX from puts (stored as positive magnitude)
  /** Gamma flip, or null when absent — see lib/zeroGamma.ts. Never spot. */
  flipLevel:  number | null;
  /** Why the flip is absent; null when it is real. */
  flipAbsentReason: string | null;
  wallAbove:  number | null;   // null = absent, never spot
  wallBelow:  number | null;
  upTarget:   number | null;
  downTarget: number | null;
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
 * @param flipSource Where the flip level comes from:
 *                     StrikeData[]  — rows to compute it from: the whole chain
 *                                     (the relay's full-chain cache). Default: `strikes`.
 *                     ExternalFlip  — a flip computed elsewhere (browsers read the
 *                                     relay's, via lib/serverGex, rather than each
 *                                     fetching whole chains).
 *                     null          — the caller knows it has no usable source.
 *                   Walls, max pain and the chain rows always come from `strikes`.
 */
export function processChainSnapshot(
  ticker:    string,
  spotPrice: number,
  strikes:   StrikeData[],
  asOf:      number,
  flipSource: StrikeData[] | ExternalFlip | null = strikes,
) {
  if (strikes.length < MIN_STRIKES) {
    console.warn(
      `[gexEngine] ${ticker}: only ${strikes.length} strikes — skipping (min ${MIN_STRIKES}). ` +
      `Previous context preserved.`
    );
    return;
  }

  const result = computeGex(ticker, spotPrice, strikes, asOf, flipSource);
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
    spotPrice,
    gexRegime:   result.regime,
    walls: {
      callWall: result.wallAbove,
      putWall:  result.wallBelow,
    },
    flipLevel:   result.flipLevel,
    flipAbsentReason: result.flipAbsentReason,
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
    `[gexEngine] ${ticker} — regime: ${result.regime}, flip: ${result.flipLevel ?? `ABSENT (${result.flipAbsentReason})`}, ` +
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
  flipSource: StrikeData[] | ExternalFlip | null = strikes,
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

  // Flip level: total GEX re-priced across hypothetical spots — see
  // lib/zeroGamma.ts for the method, its validation, and why the old
  // cumulative-by-strike walk was replaced. Null (absent) is a real answer.
  // A caller passes null when it knows its rows do not cover the whole
  // chain (chainAggregator before its full-chain fetch lands): a flip from a
  // truncated chain is a different number — SPY 761.38 from the first 2,000
  // contracts vs 768.80 from all 12,966 — so it is absent, not approximated.
  const flip: ExternalFlip = flipSource === null
    ? { level: null, reason: 'full option chain not loaded yet' }
    : Array.isArray(flipSource)
      ? computeZeroGamma(toGammaContracts(flipSource), spotPrice, asOf)
      : flipSource;

  // Walls: the largest call GEX above spot, the largest put GEX below.
  //
  // ABSENT (null) when there is none — the same fix the flip got, for the
  // same reason. This used to fall back to `spotPrice`: a chain with no
  // strike above spot (or none carrying gamma) reported a "wall" exactly at
  // the current price, which reads as maximal resistance right here and
  // puts price "within 0.3% of a wall" — the BREAKOUT condition. Rows with
  // zero or negative gamma exposure are not walls either: sorting by |GEX|
  // used to let a zero-gamma strike win when nothing else was there.
  const aboveSpot = strikeGex.filter((s) => s.strike > spotPrice && s.callGex > 0)
    .sort((a, b) => b.callGex - a.callGex);
  const belowSpot = strikeGex.filter((s) => s.strike < spotPrice && s.putGex > 0)
    .sort((a, b) => b.putGex - a.putGex);

  const wallAbove = aboveSpot[0]?.strike ?? null;
  const wallBelow = belowSpot[0]?.strike ?? null;

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
    flipLevel:  flip.level,
    flipAbsentReason: flip.reason,
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
 * One GammaContract per side that has open interest. A row without an
 * expiry (backtestEngine builds OI/gamma-only rows) contributes nothing, so
 * a chain made only of such rows yields an absent flip — never a guess.
 */
export function toGammaContracts(strikes: readonly StrikeData[]): GammaContract[] {
  const out: GammaContract[] = [];
  for (const s of strikes) {
    if (!s.expiry) continue;
    if (s.callOI > 0) out.push({ strike: s.strike, expiry: s.expiry, iv: s.callIV ?? 0, openInterest: s.callOI, type: 'call' });
    if (s.putOI  > 0) out.push({ strike: s.strike, expiry: s.expiry, iv: s.putIV  ?? 0, openInterest: s.putOI,  type: 'put'  });
  }
  return out;
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
