/**
 * Layer 1 — barsStore
 *
 * The single candle table for the entire app. Every engine and every chart
 * reads from here. Nothing else writes bars.
 *
 * Data sources (in priority order):
 *   1. Cold-start: REST backfill via api.ts on first subscribe.
 *   2. Live: AM (per-minute agg) WebSocket messages from massiveBus.
 *   3. Reconnect gap-fill: REST backfill triggered when massiveBus emits
 *      'reconnected' and the last known bar for a ticker is > 2 min old.
 *
 * isDataReady(ticker) — folded into Result status:
 *   'ready' iff bars.length >= 2 AND last bar tUtc is < 2 min ago (UTC).
 *   A ticker that just connected but has only one bar stays 'loading'.
 */

import { massiveBus, type WSMessageWithCT } from '../bus.ts';
import { MassiveRestClient }                from '../lib/massive/api.ts';
import { type Bar, type Result, ready, loading, error } from './types.ts';

// ── Constants ─────────────────────────────────────────────────────────────────

/** Maximum age of the most recent bar before the ticker is considered stale. */
const STALE_THRESHOLD_MS = 2 * 60 * 1000; // 2 minutes

/** Maximum bars retained per ticker in memory (one full session + buffer). */
const MAX_BARS_PER_TICKER = 500;

/**
 * Tolerance window for signal-outcome bar lookup.
 * Engineering Lesson #7: exact timestamp match silently misses; use ±5 min.
 */
const SIGNAL_RESOLUTION_TOLERANCE_MS = 5 * 60 * 1000;

// ── Internal state ────────────────────────────────────────────────────────────

/**
 * Internal mutable store — not exposed directly. Consumers call getResult().
 * Map<ticker, { bars: Bar[]; status: internal tracking fields }>
 */
interface TickerState {
  bars:          Bar[];
  backfilling:   boolean;  // REST backfill in-flight
  subscribed:    boolean;  // AM channel subscribed on massiveBus
}

const _state   = new Map<string, TickerState>();
const _listeners = new Set<() => void>();

// ── REST client reference ─────────────────────────────────────────────────────

/**
 * Injected at init time by the Railway relay / server-side caller.
 * The store itself never constructs MassiveRestClient — it receives one.
 * Default is null; calling backfill methods before init throws a clear error.
 */
let _restClient: MassiveRestClient | null = null;

export function initBarsStore(client: MassiveRestClient) {
  _restClient = client;
  _registerReconnectHandler();
}

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Subscribe to bars for `ticker`. Triggers:
 *   1. AM WebSocket subscription on massiveBus.
 *   2. Cold-start REST backfill (async, does not block).
 *
 * Safe to call multiple times for the same ticker — idempotent.
 */
export function subscribeTicker(ticker: string) {
  if (_state.has(ticker)) return; // already subscribed

  _state.set(ticker, { bars: [], backfilling: false, subscribed: false });

  // Subscribe to per-minute aggregates on the WS bus
  massiveBus.subscribeStock('AM', ticker);
  _getOrCreate(ticker).subscribed = true;

  // Register the AM message handler
  massiveBus.on('AM', _handleAM);

  // Cold-start backfill — async, status stays 'loading' until it resolves
  _backfill(ticker, 'cold-start');
}

/**
 * Unsubscribe from bars for `ticker`. Clears in-memory bars.
 */
export function unsubscribeTicker(ticker: string) {
  massiveBus.unsubscribeStock('AM', ticker);
  _state.delete(ticker);
  _notify();
}

/**
 * Get the current Result<Bar[]> for `ticker`.
 *
 * status: 'loading' — backfill in flight or insufficient data.
 * status: 'ready'   — >= 2 bars, most recent bar < 2 min old.
 * status: 'error'   — backfill failed and no bars on hand.
 */
export function getResult(ticker: string): Result<Bar[]> {
  const state = _state.get(ticker);
  if (!state) return loading();
  if (state.backfilling && state.bars.length === 0) return loading();
  return _toResult(ticker, state);
}

/**
 * isDataReady — convenience wrapper over getResult.
 * True iff status === 'ready'.
 */
export function isDataReady(ticker: string): boolean {
  return getResult(ticker).status === 'ready';
}

/**
 * hasHistoricalData — returns true if the ticker has any bars at all,
 * regardless of staleness. Used by scoring engines that can work on
 * day-old data (e.g. Swing score, after-hours EMA trend check).
 * Does NOT imply the data is fresh or the feed is active.
 */
export function hasHistoricalData(ticker: string): boolean {
  const state = _state.get(ticker);
  return !!(state && state.bars.length >= 2);
}

/**
 * getBarsRaw — returns the raw bar array for a ticker regardless of staleness.
 * Returns [] if no bars are loaded.
 * Use this for scoring/analysis that is valid on stale data (e.g. Swing EMA).
 * Use getResult() when you need to know if data is fresh.
 */
export function getBarsRaw(ticker: string): import('./types.ts').Bar[] {
  const state = _state.get(ticker);
  return state ? [...state.bars] : [];
}

/**
 * Find the bar whose tUtc is closest to `targetUtcMs` within ±5 minutes.
 *
 * Used by the signal-outcome ledger. Returns null if no bar falls within
 * the tolerance window — the ledger records the outcome as 'pending' and
 * retries on the next bar arrival.
 *
 * Engineering Lesson #7: never use exact-timestamp match here.
 */
export function findBarNear(ticker: string, targetUtcMs: number): Bar | null {
  const state = _state.get(ticker);
  if (!state || state.bars.length === 0) return null;

  let best: Bar | null = null;
  let bestDelta = Infinity;

  for (const bar of state.bars) {
    const delta = Math.abs(bar.tUtc - targetUtcMs);
    if (delta <= SIGNAL_RESOLUTION_TOLERANCE_MS && delta < bestDelta) {
      bestDelta = delta;
      best = bar;
    }
  }

  return best;
}

/**
 * Subscribe to store change notifications.
 * Returns an unsubscribe function.
 */
export function subscribe(listener: () => void): () => void {
  _listeners.add(listener);
  return () => _listeners.delete(listener);
}

// ── Internal helpers ──────────────────────────────────────────────────────────

function _getOrCreate(ticker: string): TickerState {
  let s = _state.get(ticker);
  if (!s) {
    s = { bars: [], backfilling: false, subscribed: false };
    _state.set(ticker, s);
  }
  return s;
}

function _handleAM(msg: WSMessageWithCT) {
  const ticker = msg.sym;
  const state  = _state.get(ticker);
  if (!state) return; // not subscribed — ignore

  // Massive AM fields: o, h, l, c, v, vw, n, s (start time UTC ms)
  const bar: Bar = {
    ticker,
    open:         (msg.o  as number) ?? 0,
    high:         (msg.h  as number) ?? 0,
    low:          (msg.l  as number) ?? 0,
    close:        (msg.c  as number) ?? 0,
    volume:       (msg.v  as number) ?? 0,
    vwap:         (msg.vw as number) ?? undefined,
    transactions: (msg.n  as number) ?? undefined,
    tCT:          msg._ct.ctMs,
    tUtc:         (msg.s  as number) ?? msg._ct.utcMs,
  };

  _appendBar(ticker, state, bar);
  _notify();
}

function _appendBar(ticker: string, state: TickerState, bar: Bar) {
  // Deduplicate by tUtc — a reconnect can replay the current-minute bar
  const last = state.bars[state.bars.length - 1];
  if (last && last.tUtc === bar.tUtc) {
    // Update in place: live bar gets updated ticks before the minute closes
    state.bars[state.bars.length - 1] = bar;
    return;
  }

  state.bars.push(bar);

  // Trim to MAX_BARS_PER_TICKER — drop oldest
  if (state.bars.length > MAX_BARS_PER_TICKER) {
    state.bars.splice(0, state.bars.length - MAX_BARS_PER_TICKER);
  }

  console.log(`[barsStore] ${ticker} — ${state.bars.length} bars, last close ${bar.close}`);
}

function _toResult(ticker: string, state: TickerState): Result<Bar[]> {
  if (state.bars.length < 2) return loading();

  const last     = state.bars[state.bars.length - 1];
  const ageMs    = Date.now() - last.tUtc;
  const isStale  = ageMs > STALE_THRESHOLD_MS;

  // Stale but have data — surface as error so consumers know explicitly
  if (isStale && !state.backfilling) {
    return error(`${ticker} bars are stale (last bar ${Math.round(ageMs / 1000)}s ago)`);
  }

  // Backfilling after stale detection — stay loading, don't show old data as ready
  if (isStale && state.backfilling) return loading();

  return ready([...state.bars], last.tUtc);
}

async function _backfill(ticker: string, reason: 'cold-start' | 'reconnect') {
  if (!_restClient) {
    console.error('[barsStore] REST client not initialised — call initBarsStore() first.');
    return;
  }

  const state = _getOrCreate(ticker);
  if (state.backfilling) return; // already in flight

  state.backfilling = true;
  _notify();

  console.log(`[barsStore] Backfilling ${ticker} (${reason})…`);

  try {
    let bars: Bar[];

    if (reason === 'reconnect' && state.bars.length > 0) {
      // Gap-fill only: fetch bars from last known bar to now
      const lastUtc = state.bars[state.bars.length - 1].tUtc;
      bars = await _restClient.fetchBarRange(ticker, lastUtc, Date.now());
    } else {
      // Cold-start: fetch a full session's worth of bars
      bars = await _restClient.fetchRecentBars(ticker);
    }

    // Merge fetched bars, deduplicating by tUtc
    const existing = new Set(state.bars.map(b => b.tUtc));
    const newBars  = bars.filter(b => !existing.has(b.tUtc));
    state.bars     = [...state.bars, ...newBars].sort((a, b) => a.tUtc - b.tUtc);

    // Trim to limit
    if (state.bars.length > MAX_BARS_PER_TICKER) {
      state.bars.splice(0, state.bars.length - MAX_BARS_PER_TICKER);
    }

    console.log(`[barsStore] ${ticker} backfill complete — ${state.bars.length} bars total.`);
  } catch (e) {
    console.error(`[barsStore] Backfill failed for ${ticker}:`, e);
  } finally {
    state.backfilling = false;
    _notify();
  }
}

/**
 * On reconnect, check all subscribed tickers. Any ticker whose last bar is
 * older than STALE_THRESHOLD_MS gets a gap-fill backfill.
 * Engineering Lesson #9.
 */
function _registerReconnectHandler() {
  massiveBus.onReconnect(() => {
    const nowMs = Date.now();
    for (const [ticker, state] of _state) {
      if (state.bars.length === 0) {
        _backfill(ticker, 'cold-start');
        continue;
      }
      const last  = state.bars[state.bars.length - 1];
      const ageMs = nowMs - last.tUtc;
      if (ageMs > STALE_THRESHOLD_MS) {
        console.log(`[barsStore] ${ticker} stale after reconnect (${Math.round(ageMs / 1000)}s) — gap-filling.`);
        _backfill(ticker, 'reconnect');
      }
    }
  });
}

function _notify() {
  for (const fn of _listeners) fn();
}
