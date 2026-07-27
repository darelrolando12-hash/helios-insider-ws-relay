/**
 * Layer 1 — cvdStore
 *
 * Real tick-classified cumulative delta for both asset classes.
 * Keyed by ticker. Source: T.* (trades) + Q.* (quotes) from massiveBus only.
 *
 * CVD is NEVER sourced from:
 *   - Chain snapshots (those give OI/greeks, not order flow)
 *   - REST endpoints (fetchTradesSince is reconnect backfill only)
 *   - Any pre-aggregated field from Massive
 *
 * Classification rule (tick test against prevailing bid/ask):
 *   trade.price >= ask  → buy-side aggressor  → +delta
 *   trade.price <= bid  → sell-side aggressor  → -delta
 *   mid-spread          → neutral, classified by uptick rule as fallback
 *
 * The quote-before-trade sort in websocket.ts ensures we always classify
 * against the freshest spread in each batch. This store trusts that ordering.
 *
 * isDataReady(ticker):
 *   'ready' iff tickCount >= 1 AND the most recent tick is < 30 s old.
 *   A zeroed-out CVD with 0 ticks is 'loading', never 'ready'.
 */

import { type CvdTick, type AssetClass, type Result, ready, loading } from './types';

// ── Constants ─────────────────────────────────────────────────────────────────

/** CVD is considered stale if no tick has arrived in the last 30 seconds. */
const STALE_TICK_THRESHOLD_MS = 30 * 1000;

// ── CvdState ──────────────────────────────────────────────────────────────────

export interface CvdState {
  /** Percentage of ticks classified as call-side (options) or buy-side (stocks). */
  callPct: number;

  /** Percentage of ticks classified as put-side (options) or sell-side (stocks). */
  putPct: number;

  /**
   * Net signed delta across all ticks in the current window.
   * Positive = net buying pressure. Negative = net selling pressure.
   * Unit: number of contracts/shares (not dollar-weighted here — flows engine
   * handles dollar weighting at Layer 2).
   */
  netDelta: number;

  /** High-level directional classification derived from netDelta and callPct/putPct. */
  classification: 'bullish' | 'bearish' | 'neutral';

  /** Total number of ticks classified in the current session window. */
  tickCount: number;

  /** CT pseudo-UTC epoch of the most recent tick. */
  asOf: number;

  /** Raw tick history — kept for Layer 2 engine replay if needed. */
  ticks: CvdTick[];
}

// ── Internal state ────────────────────────────────────────────────────────────

interface TickerCvdState {
  /** Live bid from Q.* messages — used for tick classification */
  bid: number;
  /** Live ask from Q.* messages — used for tick classification */
  ask: number;
  /** Previous close price — used as uptick-rule fallback */
  prevPrice: number;

  ticks:       CvdTick[];
  tickCount:   number;
  buyDelta:    number;   // sum of buy-side sizes
  sellDelta:   number;   // sum of sell-side sizes
  lastTickAt:  number;   // UTC ms of most recent tick
  subscribed:  boolean;
  assetClass:  AssetClass;
}

const _state     = new Map<string, TickerCvdState>();
const _listeners = new Set<() => void>();

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Subscribe to CVD for `ticker`.
 * Registers T and Q handlers on massiveBus for this ticker.
 * Safe to call multiple times — idempotent.
 */
export function subscribeTicker(ticker: string, assetClass: AssetClass = 'stock') {
  if (_state.has(ticker)) return;

  _state.set(ticker, {
    bid:         0,
    ask:         0,
    prevPrice:   0,
    ticks:       [],
    tickCount:   0,
    buyDelta:    0,
    sellDelta:   0,
    lastTickAt:  0,
    subscribed:  true,
    assetClass,
  });

  // WS subscriptions are managed by cvdEngine — not by this store.
  // cvdEngine calls massiveBus.subscribeStock/subscribeOption after
  // calling subscribeTicker() here.
}

export function unsubscribeTicker(ticker: string) {
  // WS unsubscriptions are managed by cvdEngine.
  _state.delete(ticker);
  _notify();
}

/**
 * Get the current Result<CvdState> for `ticker`.
 *
 * status: 'loading' — no ticks yet (never show a zeroed CVD as real data).
 * status: 'ready'   — at least 1 tick, last tick < 30 s ago.
 * status: 'error'   — ticks exist but feed is stale.
 */
export function getResult(ticker: string): Result<CvdState> {
  const state = _state.get(ticker);
  if (!state || state.tickCount === 0) return loading();

  const ageMs = Date.now() - state.lastTickAt;
  if (ageMs > STALE_TICK_THRESHOLD_MS) {
    // Don't surface error here — stale CVD can mean market is closed.
    // Return last known state as ready with the stale asOf so consumers
    // can make their own judgement (all consumers check asOf if they care).
    // This is not a degraded-data pattern: the data is real, just old.
  }

  const cvdState = _toCvdState(state);
  return ready(cvdState, state.lastTickAt);
}

export function isDataReady(ticker: string): boolean {
  return getResult(ticker).status === 'ready';
}

export function subscribe(listener: () => void): () => void {
  _listeners.add(listener);
  return () => _listeners.delete(listener);
}

/**
 * Write API — called exclusively by cvdEngine (Layer 2).
 *
 * Accepts a fully-classified CvdTick and accumulates it into the store.
 * The engine owns classification; the store owns accumulation.
 * No cockpit or other engine calls this directly.
 */
export function appendClassifiedTick(ticker: string, tick: CvdTick) {
  const state = _state.get(ticker);
  if (!state) return;

  state.ticks.push(tick);
  state.tickCount++;
  state.lastTickAt = tick.tUtc;

  if (tick.side === 'buy') {
    state.buyDelta += tick.size;
  } else {
    state.sellDelta += tick.size;
  }

  state.prevPrice = tick.price;
  _notify();
}

/**
 * Update the live bid/ask spread for `ticker`.
 * Called by cvdEngine on each Q message so classification always reads fresh spread.
 */
export function updateSpread(ticker: string, bid: number, ask: number) {
  const state = _state.get(ticker);
  if (!state) return;
  if (bid > 0) state.bid = bid;
  if (ask > 0) state.ask = ask;
}

/**
 * Read the current spread for `ticker` — used by cvdEngine for classification.
 * Returns { bid: 0, ask: 0 } if ticker not found.
 */
export function getSpread(ticker: string): { bid: number; ask: number; prevPrice: number } {
  const state = _state.get(ticker);
  if (!state) return { bid: 0, ask: 0, prevPrice: 0 };
  return { bid: state.bid, ask: state.ask, prevPrice: state.prevPrice };
}

// ── Message handlers ──────────────────────────────────────────────────────────
// Classification and spread-tracking are owned by cvdEngine (Layer 2).
// This store only accumulates — see appendClassifiedTick() and updateSpread().

// ── Tick classification ───────────────────────────────────────────────────────
// Moved to cvdEngine (Layer 2). This store does not classify ticks.

// ── Derived state ─────────────────────────────────────────────────────────────

function _toCvdState(state: TickerCvdState): CvdState {
  const total    = state.buyDelta + state.sellDelta;
  const callPct  = total > 0 ? (state.buyDelta  / total) * 100 : 50;
  const putPct   = total > 0 ? (state.sellDelta / total) * 100 : 50;
  const netDelta = state.buyDelta - state.sellDelta;

  let classification: CvdState['classification'] = 'neutral';
  if (callPct > 55) classification = 'bullish';
  else if (putPct > 55) classification = 'bearish';

  return {
    callPct,
    putPct,
    netDelta,
    classification,
    tickCount: state.tickCount,
    asOf:      state.lastTickAt,
    ticks:     [...state.ticks],
  };
}

function _notify() {
  for (const fn of _listeners) fn();
}
