/**
 * zeroGamma — the gamma flip level, computed by re-pricing total dealer GEX
 * across a grid of hypothetical spot prices.
 *
 * ── What it replaced, and why (measured 2026-09-10/11) ─────────────────────
 * The old computeFlipLevel took the FIRST sign change of cumulative per-
 * strike GEX walking up from the lowest strike, and returned the spot price
 * when it found none. On the real chains that gave META $5.00 at a $641
 * price (a physically impossible negative call gamma at the $5 strike —
 * 7.6e-7 of the chain's GEX — started the sum below zero), TSLA $18.67,
 * AAPL $70, SPY $580, and QQQ exactly its own price (the fallback). Ten of
 * thirteen tickers had no usable flip, and the no-crossing fallback made
 * "within 0.5% of flip" permanently true wherever it fired.
 *
 * ── Method ────────────────────────────────────────────────────────────────
 * For each hypothetical spot S on a ±15% grid (0.1% steps), recompute every
 * contract's Black-Scholes gamma at S from its own implied volatility and
 * time to expiry, and sum  sign × OI × Γ(S) × S² × 0.01 × 100  (calls +,
 * puts −: the codebase's existing dealer convention, unchanged). The flip is
 * where that total crosses zero, linearly interpolated; with several
 * crossings, the one nearest the current spot. Massive's own per-contract
 * gamma is not used at all — it is only valid at today's spot, and it is
 * where the negative-gamma artifact came from.
 *
 * Assumptions, stated: r = q = 0 (measured sensitivity on SPY with r = 4%,
 * q = 1.2%: 768.80 → 768.09, 0.09%); calendar-day year; every contract
 * expires at the NYSE regular close, 4:00 PM ET = 3:00 PM CT (same source
 * CLAUDE.md cites for DEFAULT_FORCED_CLOSE, verified 2026-08-31) — AM-
 * settled index monthlies actually stop at the open, a known approximation.
 *
 * ── Validation against external references (2026-09-11) ─────────────────
 * Full chains, Massive snapshot as of the 2026-09-10 close:
 *   SPY  757.83 spot   this method 768.80   published 771.02   −0.29%
 *   QQQ  706.90 spot   this method 718.94   published 722.22   −0.45%
 * Same side of spot and same regime as the references in both. GEXBoard
 * documents the same method (OI, calls + / puts −, Black-Scholes re-pricing
 * across hypothetical prices, all expirations). No same-day single-name
 * reference was found; the method, not the ticker, is what was validated.
 *
 * ── Absent, never a stand-in ─────────────────────────────────────────────
 * No crossing inside the grid, or too little of the chain's open interest
 * carrying a usable IV and expiry, returns level = null with a reason. A
 * fallback that silently equals the current price is exactly the silent-
 * zero class this codebase keeps finding.
 *
 * Browser copy of relay/engine/lib/zeroGamma.ts — the authoritative version. Must stay identical apart from import extensions.
 */

import { toCentralTime } from './time';

export interface GammaContract {
  strike: number;
  /** YYYY-MM-DD */
  expiry: string;
  /** Implied volatility as a decimal (0.18 = 18%). */
  iv:     number;
  openInterest: number;
  type:   'call' | 'put';
}

export interface ZeroGammaResult {
  /** The flip level, or null when absent. */
  level:     number | null;
  dataQuality: 'real' | 'absent';
  /** Why it is absent (null when real). */
  reason:    string | null;
  /** Every crossing found inside the grid, ascending. */
  crossings: number[];
  /** Share of total open interest that could be re-priced (0–1). */
  oiCoverage: number;
  /** Total GEX at the current spot under this model ($ per 1% move). */
  gexAtSpot: number;
}

export const GRID_HALF_WIDTH = 0.15;   // ±15% of spot
export const GRID_STEP       = 0.001;  // 0.1% steps → 301 points
/** Below this share of re-priceable OI the curve is not the chain's. */
export const MIN_OI_COVERAGE = 0.8;

const YEAR_MS = 365 * 86_400_000;
const INV_SQRT_2PI = 1 / Math.sqrt(2 * Math.PI);

/** Black-Scholes gamma (r = q = 0). Identical for calls and puts. */
export function bsGamma(S: number, K: number, T: number, iv: number): number {
  const sd = iv * Math.sqrt(T);
  const d1 = (Math.log(S / K) + 0.5 * iv * iv * T) / sd;
  return (Math.exp(-0.5 * d1 * d1) * INV_SQRT_2PI) / (S * sd);
}

/** UTC ms of 3:00 PM CT (the NYSE close) on a YYYY-MM-DD date, DST-correct. */
export function expiryCloseUtc(ymd: string): number {
  const [y, m, d] = ymd.split('-').map(Number);
  // Noon UTC on that date is the same CT calendar day in both CDT and CST,
  // so its DST flag is the date's.
  const offsetHours = toCentralTime(Date.UTC(y, m - 1, d, 12)).isDST ? 5 : 6;
  return Date.UTC(y, m - 1, d, 15 + offsetHours);
}

export function computeZeroGamma(
  contracts: readonly GammaContract[],
  spot:      number,
  nowMs:     number,
): ZeroGammaResult {
  const absent = (reason: string, oiCoverage = 0): ZeroGammaResult =>
    ({ level: null, dataQuality: 'absent', reason, crossings: [], oiCoverage, gexAtSpot: 0 });

  if (!(spot > 0)) return absent('no spot price');

  let oiAll = 0;
  let oiUsed = 0;
  const rows: { K: number; T: number; iv: number; w: number }[] = [];
  for (const c of contracts) {
    if (!(c.openInterest > 0)) continue;
    const T = (expiryCloseUtc(c.expiry) - nowMs) / YEAR_MS;
    if (!(T > 0)) continue; // expired — carries no gamma, not counted either way
    oiAll += c.openInterest;
    if (!(c.iv > 0) || !(c.strike > 0)) continue;
    oiUsed += c.openInterest;
    rows.push({ K: c.strike, T, iv: c.iv, w: (c.type === 'call' ? 1 : -1) * c.openInterest });
  }
  if (oiAll === 0) return absent('no open interest on unexpired contracts');
  const oiCoverage = oiUsed / oiAll;
  if (oiCoverage < MIN_OI_COVERAGE) {
    return absent(`only ${(oiCoverage * 100).toFixed(1)}% of open interest has a usable IV`, oiCoverage);
  }

  const gexAt = (S: number) => {
    let g = 0;
    for (const r of rows) g += r.w * bsGamma(S, r.K, r.T, r.iv);
    return g * S * S * 0.01 * 100;
  };

  const steps = Math.round(GRID_HALF_WIDTH / GRID_STEP);
  const crossings: number[] = [];
  let prevS = spot * (1 - GRID_HALF_WIDTH);
  let prevG = gexAt(prevS);
  for (let i = -steps + 1; i <= steps; i++) {
    const S = spot * (1 + i * GRID_STEP);
    const G = gexAt(S);
    if (prevG === 0) crossings.push(prevS);
    else if (Math.sign(prevG) !== Math.sign(G) && G !== 0) {
      crossings.push(prevS + (S - prevS) * Math.abs(prevG) / (Math.abs(prevG) + Math.abs(G)));
    }
    prevS = S;
    prevG = G;
  }

  const gexAtSpot = gexAt(spot);
  if (crossings.length === 0) {
    return { ...absent(`no zero crossing within ±${GRID_HALF_WIDTH * 100}% of spot`, oiCoverage), gexAtSpot };
  }
  const nearest = crossings.reduce((a, b) => (Math.abs(b - spot) < Math.abs(a - spot) ? b : a));
  return { level: nearest, dataQuality: 'real', reason: null, crossings, oiCoverage, gexAtSpot };
}
