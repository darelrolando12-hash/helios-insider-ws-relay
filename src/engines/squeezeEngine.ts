/**
 * Layer 2 — squeezeEngine
 *
 * Computes squeeze-risk score per ticker from fundamentals + price momentum.
 *
 * Inputs (all read from Layer 1 stores — no direct Massive calls):
 *   fundamentalsStore  — shortInterest%, daysToCover, shortVolumeRatio
 *   barsStore          — recent price momentum (rate of change)
 *
 * Output:
 *   SqueezeRisk — { level: 'low'|'medium'|'high', score: 0–100, factors }
 *   Written to _squeezeState (internal map), read via getResult(ticker).
 *
 * Update cadence: runs when fundamentalsStore emits an update (daily after
 * close for short interest; intraday for short volume). Not every tick.
 *
 * Scoring model (weights sum to 100):
 *   Short float %         35 pts  — > 20% float short is significant
 *   Days to cover         30 pts  — > 5 DTC is elevated; > 10 DTC is high
 *   Short volume ratio    20 pts  — > 40% of daily volume short = pressure
 *   Price momentum        15 pts  — rising price into high short = squeeze setup
 *
 * Level thresholds:
 *   score >= 65 → 'high'
 *   score >= 40 → 'medium'
 *   score <  40 → 'low'
 */

import * as fundamentalsStore from '../stores/fundamentalsStore';
import * as barsStore         from '../stores/barsStore';
import type { Result }        from '../stores/types';
import { ready, loading }     from '../stores/types';

// ── SqueezeRisk ───────────────────────────────────────────────────────────────

export type SqueezeLevel = 'low' | 'medium' | 'high';

export interface SqueezeRisk {
  ticker:            string;
  level:             SqueezeLevel;
  score:             number;   // 0–100
  shortFloatPct:     number | null;
  daysToCover:       number | null;
  shortVolumeRatio:  number | null;
  momentumScore:     number;   // 0–15
  asOf:              number;   // UTC ms of the fundamentals snapshot used
}

// ── Internal state ────────────────────────────────────────────────────────────

const _state     = new Map<string, SqueezeRisk>();
const _listeners = new Set<() => void>();
let   _initialised = false;

// ── Engine lifecycle ──────────────────────────────────────────────────────────

export function init() {
  if (_initialised) return;
  _initialised = true;
  fundamentalsStore.subscribe(_onFundamentalsUpdate);
  console.log('[squeezeEngine] Initialised.');
}

export function teardown() {
  _initialised = false;
  // Note: fundamentalsStore.subscribe returns an unsubscribe fn — store it
  // if teardown becomes a hard requirement. Omitted here for simplicity.
}

// ── Public read API ───────────────────────────────────────────────────────────

export function getResult(ticker: string): Result<SqueezeRisk> {
  const risk = _state.get(ticker);
  if (!risk) return loading();
  return ready(risk, risk.asOf);
}

export function subscribe(listener: () => void): () => void {
  _listeners.add(listener);
  return () => _listeners.delete(listener);
}

// ── Internal ──────────────────────────────────────────────────────────────────

function _onFundamentalsUpdate() {
  // Re-score every ticker that has fundamentals data
  // (squeezeEngine has no ticker watch list — it processes whatever fundamentalsStore has)
  for (const ticker of _getTrackedTickers()) {
    _scoreTicker(ticker);
  }
}

function _getTrackedTickers(): string[] {
  // Derive from _state — any ticker we've scored before
  // plus any ticker in fundamentalsStore that has shortInterest data
  return Array.from(_state.keys());
}

/**
 * Force a score for `ticker` — called by cockpit initialiser when
 * a new ticker is added to the watch list.
 */
export function scoreTicker(ticker: string) {
  _scoreTicker(ticker);
}

function _scoreTicker(ticker: string) {
  const fundResult = fundamentalsStore.getResult(ticker);
  if (fundResult.status !== 'ready') return;

  const fund = fundResult.data;
  if (!fund.shortInterest) return; // no data to score yet

  const barsResult = barsStore.getResult(ticker);
  const bars = barsResult.status === 'ready' ? barsResult.data : null;

  const risk = computeSqueezeRisk(ticker, fund.shortInterest.shortFloat ?? null,
    fund.shortInterest.daysToCover ?? null,
    fund.shortVolumeRatio,
    bars,
    fundResult.asOf,
  );

  _state.set(ticker, risk);
  _notify();
}

function _notify() {
  for (const fn of _listeners) fn();
}

// ── Pure computation — exported for unit tests ────────────────────────────────

/**
 * Compute squeeze risk from raw inputs.
 * Pure function — no store access.
 */
export function computeSqueezeRisk(
  ticker:           string,
  shortFloatPct:    number | null,
  daysToCover:      number | null,
  shortVolumeRatio: number | null,
  bars:             import('../stores/types').Bar[] | null,
  asOf:             number,
): SqueezeRisk {
  const floatScore     = scoreShortFloat(shortFloatPct);
  const dtcScore       = scoreDaysToCover(daysToCover);
  const svrScore       = scoreShortVolumeRatio(shortVolumeRatio);
  const momentumScore  = scoreMomentum(bars);

  const score = Math.min(100, floatScore + dtcScore + svrScore + momentumScore);
  const level = classifySqueezeLevel(score);

  return {
    ticker,
    level,
    score,
    shortFloatPct,
    daysToCover,
    shortVolumeRatio,
    momentumScore,
    asOf,
  };
}

/**
 * Short float % scoring (35 pts max).
 *   >= 40%  → 35 pts (extreme squeeze potential)
 *   >= 20%  → 22 pts (elevated)
 *   >= 10%  → 12 pts (notable)
 *   <  10%  →  0 pts
 */
export function scoreShortFloat(shortFloatPct: number | null): number {
  if (shortFloatPct === null) return 0;
  if (shortFloatPct >= 40)   return 35;
  if (shortFloatPct >= 20)   return 22;
  if (shortFloatPct >= 10)   return 12;
  return 0;
}

/**
 * Days-to-cover scoring (30 pts max).
 *   >= 10 DTC → 30 pts
 *   >= 5  DTC → 18 pts
 *   >= 2  DTC →  8 pts
 *   <  2  DTC →  0 pts
 */
export function scoreDaysToCover(dtc: number | null): number {
  if (dtc === null) return 0;
  if (dtc >= 10) return 30;
  if (dtc >= 5)  return 18;
  if (dtc >= 2)  return 8;
  return 0;
}

/**
 * Short volume ratio scoring (20 pts max).
 *   >= 60% → 20 pts
 *   >= 40% → 12 pts
 *   >= 25% →  6 pts
 *   <  25% →  0 pts
 */
export function scoreShortVolumeRatio(ratio: number | null): number {
  if (ratio === null) return 0;
  if (ratio >= 60)   return 20;
  if (ratio >= 40)   return 12;
  if (ratio >= 25)   return 6;
  return 0;
}

/**
 * Price momentum scoring (15 pts max).
 * Uses 5-bar rate of change: (close[last] - close[last-5]) / close[last-5].
 * Rising price into high short interest amplifies squeeze risk.
 *   >= +3%  → 15 pts
 *   >= +1%  →  8 pts
 *   >= 0%   →  3 pts (flat is mild positive)
 *   negative →  0 pts
 */
export function scoreMomentum(bars: import('../stores/types').Bar[] | null): number {
  if (!bars || bars.length < 6) return 0;
  const last = bars[bars.length - 1].close;
  const prev = bars[bars.length - 6].close;
  if (prev === 0) return 0;

  const roc = (last - prev) / prev * 100;
  if (roc >= 3) return 15;
  if (roc >= 1) return 8;
  if (roc >= 0) return 3;
  return 0;
}

export function classifySqueezeLevel(score: number): SqueezeLevel {
  if (score >= 65) return 'high';
  if (score >= 40) return 'medium';
  return 'low';
}
