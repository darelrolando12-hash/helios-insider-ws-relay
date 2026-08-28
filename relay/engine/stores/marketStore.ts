/**
 * Layer 1 — marketStore
 *
 * Read-only store for GEX regime, walls, flip level, vanna/charm context.
 * Written exclusively by the GEX engine (Layer 2). Cockpits read from here.
 *
 * This store does NOT compute GEX. It holds the output of the GEX engine
 * and makes it available to consumers as Result<MarketContext>.
 *
 * isDataReady(ticker):
 *   'ready' iff a MarketContext snapshot exists and asOf is < 5 min old.
 *   The GEX engine writes on each chain snapshot cycle; a 5-min staleness
 *   window matches the typical chain-refresh cadence.
 */

import { type MarketContextSnapshot, type ChainRow, type Result, ready, loading, error } from './types.ts';

// ── Constants ─────────────────────────────────────────────────────────────────

/** MarketContext is considered stale if the GEX engine hasn't written in 5 min. */
const STALE_THRESHOLD_MS = 5 * 60 * 1000;

// ── MarketContext ─────────────────────────────────────────────────────────────

/**
 * Full market context snapshot as exposed to cockpits.
 * Extends MarketContextSnapshot (from types.ts) with derived output fields
 * that the GEX engine computes and writes here.
 */
export interface MarketContext extends MarketContextSnapshot {
  /**
   * Price target above current price implied by GEX structure.
   * Typically the next significant call-wall cluster above the flip level.
   */
  upTarget: number;

  /**
   * Price target below current price implied by GEX structure.
   * Typically the next significant put-wall cluster below the flip level.
   */
  downTarget: number;

  /**
   * Net GEX in dollar-gamma terms (positive = dealers long gamma).
   * Sign determines regime; magnitude determines expected move range.
   */
  netGex: number;

  /**
   * Put/Call open interest ratio for the underlying.
   * > 1.0 = more put OI than call OI (typically bearish sentiment hedge).
   */
  pcRatio: number;

  /**
   * Max-pain strike — the strike at which aggregate option losses are minimised
   * for option sellers. Written by gexEngine from the chain snapshot.
   */
  maxPain: number;

  /**
   * Per-strike chain snapshot. Written by gexEngine on each chain refresh.
   * Consumed exclusively by ChainCockpit. Sorted ascending by strike.
   */
  chain: ChainRow[];
}

// ── Internal state ────────────────────────────────────────────────────────────

const _state     = new Map<string, MarketContext>();
const _listeners = new Set<() => void>();

// ── Public read API ───────────────────────────────────────────────────────────

/**
 * Get the current Result<MarketContext> for `ticker`.
 *
 * status: 'loading' — GEX engine hasn't written a snapshot yet.
 * status: 'ready'   — snapshot exists and is < 5 min old.
 * status: 'error'   — snapshot exists but is stale (GEX engine may be down).
 */
export function getResult(ticker: string): Result<MarketContext> {
  const ctx = _state.get(ticker);
  if (!ctx) return loading();

  const ageMs   = Date.now() - ctx.asOf;
  const isStale = ageMs > STALE_THRESHOLD_MS;

  if (isStale) {
    return error(
      `${ticker} market context is stale (last update ${Math.round(ageMs / 1000)}s ago)`
    );
  }

  return ready(ctx, ctx.asOf);
}

export function isDataReady(ticker: string): boolean {
  return getResult(ticker).status === 'ready';
}

export function subscribe(listener: () => void): () => void {
  _listeners.add(listener);
  return () => _listeners.delete(listener);
}

// ── Write API — called exclusively by the GEX engine (Layer 2) ───────────────

/**
 * Write or update the MarketContext for `ticker`.
 *
 * Only the GEX engine calls this. No cockpit, no other store, no UI component
 * calls writeContext() directly.
 */
export function writeContext(ticker: string, ctx: MarketContext) {
  _state.set(ticker, ctx);
  _notify();
}

// ── Internal ──────────────────────────────────────────────────────────────────

function _notify() {
  for (const fn of _listeners) fn();
}
