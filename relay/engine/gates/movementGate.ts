/**
 * Gate 2 — movement.
 *
 * "Is the underlying moving enough for an option to pay?" It kills ENTER on
 * a consolidating chart (helios-trading-machine-architecture.md, Part 1). It
 * is pure — no stores, no clock, no network — so the code that runs live is
 * exactly the code the five-year backtest ran (relay/backtests/movementGate.ts).
 *
 * ── The test ─────────────────────────────────────────────────────────────
 * Relative range: the last WINDOW minutes' high−low, as a fraction of price,
 * divided by the MEDIAN of that same measure at the same minute of the day
 * over the previous BASELINE_SESSIONS sessions. Time of day matters — the
 * first hour is always wide and lunch always narrow, so an absolute ATR rule
 * would call every open "moving" and every midday "asleep". Below RANGE_MIN
 * the ticker is ASLEEP: the coil / consolidation state, and a hard no.
 *
 * ── What the five-year backtest showed (2021-09-10 → 2026-09-10) ─────────
 * SPY QQQ IWM AAPL TSLA NVDA META AMD, a decision every 5 min 09:00–14:30 CT,
 * 660,000 decisions. Yardstick: would an ATM 0DTE option bought at that
 * moment have cleared its own spread + 30 minutes of decay (Black-Scholes,
 * vol = 20-day realised × 1.3; results hold at 1.0 and 1.6 too)?
 *
 * MAGNITUDE — WORKS. The share of windows whose next 30 minutes cleared the
 * breakeven rises steadily with relative range, and holds out of sample:
 *
 *   relative range      <0.6   0.6–0.8  0.8–1  1–1.25  1.25–1.5  1.5–2   ≥2
 *   in-sample  (touch)  47.3%  54.2%    57.9%  60.8%   63.5%     67.1%   72.8%
 *   out-of-sample       43.4%  50.9%    55.3%  58.4%   61.8%     65.4%   72.7%
 *
 * DIRECTION — DOES NOT. The first version of this gate also required
 * efficiency ≥ 0.35 (Kaufman) and ≥ 80% of closes on the move's side of
 * VWAP, taken from the architecture document's "directional persistence".
 * The backtest disproved it: windows that passed paid in the window's
 * direction 64.5% of the time and in the OPPOSITE direction 65.1%; "chop"
 * paid 64.0% — the same as "moving". Across efficiency buckets the rate was
 * flat (65.7% → 66.3% in sample, 64.1% → 64.5% out of sample). The last 30
 * minutes' direction says nothing about the next 30, so a gate that blocked
 * on it would only discard good-magnitude windows. Direction is Gate 4's
 * (named setups) and Gate 5's (flow) to earn, each proven the same way.
 * Efficiency and VWAP side are still measured and reported, never gated on.
 *
 * NOT SUFFICIENT. Even the widest windows paid at a plain 30-minute time
 * exit only ~36% of the time (touch rates assume a perfect exit). This gate
 * removes the worst trades; it does not make a trade.
 *
 * ── What this gate does NOT do ───────────────────────────────────────────
 * It does not price an option — Gate 6 does, against the real contract.
 *
 * ── Absent blocks ────────────────────────────────────────────────────────
 * Too few bars in the window, or too few prior sessions to form this
 * minute's baseline, returns 'absent' — never 'moving', never a guess.
 *
 * RANGE_MIN = 1.0 was fixed before the backtest ran ("at least as wide as
 * usual for this time of day") and was not tuned on it. Changing it is a
 * backtest re-run, not a tweak.
 */

import { sessionVwapSeries, type VwapBar } from '../lib/sessionVwap.ts';

export const WINDOW            = 30;   // one-minute bars
export const RANGE_MIN         = 1.0;  // × the median range for this minute of day
export const BASELINE_SESSIONS = 20;
/** A minute-of-day baseline needs at least this many prior observations. */
export const BASELINE_MIN_OBS  = 10;

export type MovementState = 'moving' | 'asleep' | 'absent';

export interface MovementBar extends VwapBar {
  open: number;
}

export interface MovementResult {
  state:          MovementState;
  /** Sign of the window's net move — INFORMATIONAL, not predictive (see header). */
  direction:      'up' | 'down' | null;
  /** Window range ÷ median range at this minute of day. Null when absent. */
  relativeRange:  number | null;
  /** Kaufman efficiency of the window — informational only. */
  efficiency:     number | null;
  /** Share of window closes on the move's side of session VWAP — informational only. */
  vwapSideShare:  number | null;
  reasons:        string[];
}

/** Window high−low as a fraction of the window's last close. */
export function windowRangePct(bars: readonly MovementBar[], end: number, window = WINDOW): number | null {
  const start = end - window + 1;
  if (start < 0) return null;
  let hi = -Infinity;
  let lo = Infinity;
  for (let i = start; i <= end; i++) {
    if (bars[i].high > hi) hi = bars[i].high;
    if (bars[i].low  < lo) lo = bars[i].low;
  }
  const last = bars[end].close;
  return last > 0 ? (hi - lo) / last : null;
}

/** Kaufman efficiency ratio of closes over the window ending at `end`. */
export function efficiencyRatio(bars: readonly MovementBar[], end: number, window = WINDOW): number | null {
  const start = end - window;
  if (start < 0) return null;
  let path = 0;
  for (let i = start + 1; i <= end; i++) path += Math.abs(bars[i].close - bars[i - 1].close);
  if (path === 0) return 0;
  return Math.abs(bars[end].close - bars[start].close) / path;
}

/** Median of an array of numbers (copy-sorted). Null for an empty array. */
export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export interface MovementParams {
  rangeMin: number;
}

export const DEFAULT_PARAMS: MovementParams = { rangeMin: RANGE_MIN };

/** The measurements the decision is made from — kept separate so a
 *  backtest can re-classify the same measurements under other thresholds
 *  through the SAME classifier, rather than a re-implementation of it. */
export interface MovementFeatures {
  direction:     'up' | 'down' | null;
  relativeRange: number;
  efficiency:    number;
  vwapSideShare: number;
  lastOnSide:    boolean;
}

/**
 * Measure the window ending at bar index `end`, or explain why it can't be.
 *
 * @param sessionBars  The session's one-minute bars in time order, from its
 *                     first bar (pre-market included — VWAP is anchored at
 *                     the session start) through at least `end`.
 * @param end          Index of the decision bar.
 * @param baselineRangePcts  This minute of day's window-range % from prior
 *                     sessions (most recent last). The caller keeps the
 *                     history; only the last BASELINE_SESSIONS are used.
 * @param vwapSeries   Optional precomputed session VWAP values (same length
 *                     as sessionBars) — the backtest passes one to avoid
 *                     recomputing it per decision. Computed if omitted.
 */
export function measureMovement(
  sessionBars:       readonly MovementBar[],
  end:               number,
  baselineRangePcts: readonly number[],
  vwapSeries?:       readonly number[],
): MovementFeatures | { absent: string } {
  if (end < WINDOW) return { absent: `fewer than ${WINDOW + 1} bars in the session` };
  const recent = baselineRangePcts.slice(-BASELINE_SESSIONS);
  if (recent.length < BASELINE_MIN_OBS) {
    return { absent: `only ${recent.length} prior sessions for this minute (need ${BASELINE_MIN_OBS})` };
  }
  const base = median(recent);
  const rangePct = windowRangePct(sessionBars, end);
  const eff = efficiencyRatio(sessionBars, end);
  if (base === null || !(base > 0) || rangePct === null || eff === null) return { absent: 'range not computable' };

  const vwap = vwapSeries ?? sessionVwapSeries(sessionBars.slice(0, end + 1)).map((p) => p.value);
  const net = sessionBars[end].close - sessionBars[end - WINDOW].close;
  const direction = net > 0 ? 'up' : net < 0 ? 'down' : null;

  let onSide = 0;
  for (let i = end - WINDOW + 1; i <= end; i++) {
    const c = sessionBars[i].close;
    if ((direction === 'up' && c > vwap[i]) || (direction === 'down' && c < vwap[i])) onSide++;
  }
  const lastOnSide = direction === 'up' ? sessionBars[end].close > vwap[end]
    : direction === 'down' ? sessionBars[end].close < vwap[end]
    : false;

  return { direction, relativeRange: rangePct / base, efficiency: eff, vwapSideShare: onSide / WINDOW, lastOnSide };
}

/** The decision itself: magnitude only. Pure function of the features. */
export function classifyMovement(f: MovementFeatures, p: MovementParams = DEFAULT_PARAMS): MovementResult {
  const base = { direction: f.direction, relativeRange: f.relativeRange, efficiency: f.efficiency, vwapSideShare: f.vwapSideShare };
  if (f.relativeRange < p.rangeMin) {
    return { ...base, state: 'asleep', reasons: [`range ${f.relativeRange.toFixed(2)}× the usual for this time of day (< ${p.rangeMin}) — consolidating`] };
  }
  return { ...base, state: 'moving', reasons: [`range ${f.relativeRange.toFixed(2)}× the usual for this time of day`] };
}

/** Measure + classify: the gate as the engine calls it. */
export function evaluateMovement(
  sessionBars:       readonly MovementBar[],
  end:               number,
  baselineRangePcts: readonly number[],
  vwapSeries?:       readonly number[],
  params:            MovementParams = DEFAULT_PARAMS,
): MovementResult {
  const f = measureMovement(sessionBars, end, baselineRangePcts, vwapSeries);
  if ('absent' in f) {
    return { state: 'absent', direction: null, relativeRange: null, efficiency: null, vwapSideShare: null, reasons: [f.absent] };
  }
  return classifyMovement(f, params);
}
