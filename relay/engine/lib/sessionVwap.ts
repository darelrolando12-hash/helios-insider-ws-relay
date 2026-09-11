/**
 * sessionVwap — THE one VWAP definition. Every consumer (chart, direction
 * state, cockpits) must call this; none may compute VWAP inline.
 *
 * Definition: Σ(typical price × volume) / Σ(volume) over the 1-minute bars
 * of the current session, typical price = (high + low + close) / 3, session
 * = one Central-time calendar day (extended hours included — the feed runs
 * ~03:00–19:00 CT). This is TradingView's default VWAP (source hlc3, anchor
 * Session), the reference a trader checks this app against.
 *
 * ── Why one definition, and why this one (measured 2026-09-10/11) ────────
 * Before this module there were FIVE computations in the codebase:
 *   chart            close × v, reset at CT midnight
 *   directionState   Massive's per-bar `vw` × v over the whole 500-bar
 *                    buffer, never reset (mornings blended in yesterday's
 *                    after-hours)
 *   Indexes, Swing   `vw` (fallback hlc3) × v over the buffer, never reset
 *   0DTE conviction  the CALL WALL, commented "approximation"
 *
 * The `vw`-based ones are the real problem. Massive's minute `vw` includes
 * prints that never update the bar's OHLC — SPY 09-10 14:59 CT: high 758.03,
 * vw 758.98 — so on SPY 09-10 the `vw` session VWAP was 758.90 against
 * 758.31 for hlc3: 59¢, enough to put price on opposite sides of "VWAP"
 * depending on which screen you read. hlc3 vs close weighting, by contrast,
 * never differed by more than 1.4¢ across SPY/QQQ/TSLA sessions — the choice
 * between those two is cosmetic, the choice to drop `vw` is not.
 *
 * Callers must pass the WHOLE session: a 500-bar buffer stops reaching the
 * session start by ~11:20 CT, which measured −9¢ on QQQ at 14:59 CT and
 * −22¢ on SPY after hours. barsStore holds 1,000 bars for this reason.
 *
 * Browser copy: src/lib/sessionVwap.ts — must stay identical.
 */

import { toCTMidnight } from './time.ts';

export interface VwapBar {
  high:   number;
  low:    number;
  close:  number;
  volume: number;
  /** Real UTC epoch ms — the session is derived from it. */
  tUtc:   number;
  /** CT pseudo-epoch ms — only used to timestamp series points. */
  tCT:    number;
}

export interface VwapPoint {
  /** CT pseudo-epoch ms of the bar this value is "as of" (its end). */
  tCT:   number;
  value: number;
}

const typical = (b: VwapBar) => (b.high + b.low + b.close) / 3;

/**
 * Cumulative session VWAP at every bar, resetting at each new CT calendar
 * day. Input must be ascending in time. A bar before any volume has traded
 * in its session yields that bar's typical price (never NaN, never 0).
 */
export function sessionVwapSeries(bars: readonly VwapBar[]): VwapPoint[] {
  const out: VwapPoint[] = [];
  let session: number | null = null;
  let pv = 0;
  let vol = 0;
  for (const b of bars) {
    const s = toCTMidnight(b.tUtc);
    if (s !== session) { session = s; pv = 0; vol = 0; }
    pv  += typical(b) * b.volume;
    vol += b.volume;
    out.push({ tCT: b.tCT, value: vol > 0 ? pv / vol : typical(b) });
  }
  return out;
}

/**
 * VWAP of the newest session present in `bars`, as of its newest bar — or
 * null when there are no bars or the session has traded no volume. Null is
 * "absent": callers must treat it as unknown, never as a price.
 */
export function latestSessionVwap(bars: readonly VwapBar[]): number | null {
  if (bars.length === 0) return null;
  const session = toCTMidnight(bars[bars.length - 1].tUtc);
  let pv = 0;
  let vol = 0;
  for (let i = bars.length - 1; i >= 0; i--) {
    const b = bars[i];
    if (toCTMidnight(b.tUtc) !== session) break;
    pv  += typical(b) * b.volume;
    vol += b.volume;
  }
  return vol > 0 ? pv / vol : null;
}
