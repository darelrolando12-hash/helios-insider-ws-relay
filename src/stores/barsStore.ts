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

import { massiveBus, type WSMessageWithCT } from '../lib/massive/websocket';
import { MassiveRestClient }                from '../lib/massive/api';
import { type Bar, type Result, ready, loading, error } from './types';
import { formatError } from '../lib/errors';

// ── Constants ─────────────────────────────────────────────────────────────────

/** Maximum age of the most recent bar before the ticker is considered stale. */
const STALE_THRESHOLD_MS = 2 * 60 * 1000; // 2 minutes

/**
 * Maximum bars retained per ticker — one FULL extended session. The feed
 * runs ~03:00–19:00 CT = 960 one-minute bars; 1,000 holds all of it.
 *
 * It was 500, commented "one full session + buffer" — true only for the
 * 390-minute regular session. Session VWAP (lib/sessionVwap) needs every bar
 * since the session start, and 500 bars stopped reaching it by ~11:20 CT:
 * measured −9¢ on QQQ at 14:59 CT and −22¢ on SPY at 18:59 CT, 2026-09-09/10.
 */
const MAX_BARS_PER_TICKER = 1_000;

/**
 * Max number of tickers allowed to have a reconnect gap-fill REST call in
 * flight at once.
 *
 * Real root cause found 2026-09-04: _registerReconnectHandler's onReconnect
 * loop below called _backfill(ticker, 'reconnect') for every stale ticker
 * without awaiting each call — with 4 upstream WS connections dropping
 * together (observed repeatedly, ~every 3 min, in a real 30-min session),
 * every one of ~23 FEED_TICKERS crosses the 2-min STALE_THRESHOLD_MS and
 * fires its own fetchBarRange() in the same synchronous tick. That burst
 * lands on relay.helios-insiders.com/rest/* at the exact moment
 * chainAggregator's own concurrent chain-snapshot polls are already
 * in flight, on one single-threaded, single-Railway-replica relay process
 * with no server-side concurrency governor on its own outbound fetch() —
 * the real mechanism behind SOFI's 24x fetch-time spread (1.5s idle vs
 * 36.1s mid-burst) and the mass "_poll hard-timeout" clusters that
 * consistently appeared within seconds of a WS reconnect.
 *
 * Mirrors chainAggregator.ts's own _acquireSlot/_releaseSlot semaphore
 * pattern exactly, kept local rather than extracted to a shared utility —
 * two independent, unrelated call sites don't yet justify a shared
 * abstraction. Capped at 5, matching that module's original conservative
 * default: this handler's job is to stop a reconnect from ever adding a
 * burst larger than what the rest of the system already tolerates, not to
 * make gap-fill maximally fast at the cost of re-creating the exact
 * thundering-herd this fix exists to remove.
 */
const MAX_CONCURRENT_RECONNECT_BACKFILLS = 5;

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

// ── Reconnect-backfill concurrency semaphore ────────────────────────────────
// See MAX_CONCURRENT_RECONNECT_BACKFILLS's comment for why this exists.

let _activeReconnectBackfills = 0;
const _reconnectBackfillQueue: Array<() => void> = [];

async function _acquireReconnectBackfillSlot(): Promise<void> {
  if (_activeReconnectBackfills < MAX_CONCURRENT_RECONNECT_BACKFILLS) {
    _activeReconnectBackfills++;
    return;
  }
  return new Promise((resolve) => {
    _reconnectBackfillQueue.push(() => {
      _activeReconnectBackfills++;
      resolve();
    });
  });
}

function _releaseReconnectBackfillSlot(): void {
  _activeReconnectBackfills--;
  const next = _reconnectBackfillQueue.shift();
  if (next) next();
}

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

  // Subscribe to per-minute aggregates on the WS bus, plus per-second
  // aggregates so the currently-forming bar stays live between minutes.
  massiveBus.subscribeStock('AM', ticker);
  massiveBus.subscribeStock('A', ticker);
  _getOrCreate(ticker).subscribed = true;

  // Register the message handlers
  massiveBus.on('AM', _handleAM);
  massiveBus.on('A', _handleA);

  // Cold-start backfill — async, status stays 'loading' until it resolves
  _backfill(ticker, 'cold-start');
}

/**
 * Unsubscribe from bars for `ticker`. Clears in-memory bars.
 */
export function unsubscribeTicker(ticker: string) {
  massiveBus.unsubscribeStock('AM', ticker);
  massiveBus.unsubscribeStock('A', ticker);
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
export function getBarsRaw(ticker: string): import('./types').Bar[] {
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

/**
 * Per-second aggregate — keeps the CURRENTLY-FORMING minute bar live.
 *
 * Why this exists (2026-09-10): AM only arrives once a minute, at the
 * minute's close, so between ticks the newest candle was frozen — its high,
 * low and close could not move until the bar was already finished. This
 * folds Massive's 'A' (per-second aggregate) channel into that same bar so
 * it grows in real time, while AM continues to be the authority that
 * finalises it.
 *
 * 'A' rather than raw 'T' trades, deliberately. Both are real Massive
 * channels and 'T' is already subscribed (cvdEngine uses it for trade
 * classification), but trades arrive far faster than the ~313 WS
 * frames/sec measured during the Track B work, and feeding that rate into
 * the chart's setData path is precisely how the main thread was blocked
 * 77% of the time. 'A' delivers the same sub-minute behaviour at ~1/sec.
 *
 * The bar is only ever EXTENDED, never rewritten: open and tUtc stay as AM
 * established them, high/low only widen, close follows the newest second.
 * If no forming bar exists yet for this second's minute, nothing is
 * invented — AM opens bars, this only grows them.
 */
function _handleA(msg: WSMessageWithCT) {
  const ticker = msg.sym;
  const state  = _state.get(ticker);
  if (!state) return;

  const c = msg.c as number | undefined;
  const h = msg.h as number | undefined;
  const l = msg.l as number | undefined;
  const o = msg.o as number | undefined;
  const v = msg.v as number | undefined;
  const s = msg.s as number | undefined;
  if (typeof c !== 'number' || !Number.isFinite(c)) return;
  if (typeof s !== 'number' || !Number.isFinite(s)) return;

  // The minute this second belongs to, in both frames. AM labels a bar with
  // its own bucket start (msg.s), so flooring a second's start to the minute
  // produces exactly the key AM will use for the same minute — which is what
  // lets _appendBar replace this bar in place when AM finally lands.
  const minuteUtc = Math.floor(s / 60_000) * 60_000;
  const minuteCT  = Math.floor(msg._ct.ctMs / 60_000) * 60_000;

  const last = state.bars[state.bars.length - 1];

  // Plausibility, not just validity — CLAUDE.md's own rule from the
  // nanosecond-timestamp incident. A technically-valid but wrong print here
  // does not make a slightly-off candle; a zero low or a decimal-shifted
  // high owns the whole price scale and flattens every other candle into a
  // line. Reference the bar we already trust where we have one.
  const ref = last ? last.close : (typeof o === 'number' ? o : c);
  const plausible = (x: number) =>
    Number.isFinite(x) && x > 0 && ref > 0 && Math.abs(x - ref) / ref < 0.20;
  if (!plausible(c)) {
    console.warn(`[barsStore] ${ticker}: implausible 'A' close ${c} against ${ref} — ignored.`);
    return;
  }

  // Case 1 — a bar for this minute already exists (provisional, or a real AM
  // bar that landed early). Extend it: open never moves, high/low only widen.
  if (last && last.tUtc === minuteUtc) {
    let changed = false;
    if (typeof h === 'number' && plausible(h) && h > last.high) { last.high = h; changed = true; }
    if (typeof l === 'number' && plausible(l) && l < last.low)  { last.low  = l; changed = true; }
    if (c !== last.close) { last.close = c; changed = true; }
    if (typeof v === 'number' && Number.isFinite(v) && v > 0) { last.volume += v; changed = true; }
    if (changed) _notifyCoalesced();
    return;
  }

  // Case 2 — this second belongs to a minute NEWER than anything we hold, so
  // open the forming bar ourselves.
  //
  // This is the part the first version of this function got wrong. It assumed
  // AM opens a bar and 'A' extends it — but AM only arrives at a minute's
  // CLOSE, so during the forming minute there is no AM bar to extend. Live
  // instrumentation was unambiguous: 14 of 14 'A' messages were rejected for
  // belonging to a minute 1-7 minutes ahead of the newest AM bar, and the
  // forming candle never moved.
  //
  // vwap/transactions are deliberately left undefined rather than derived
  // from one second — same discipline as aggregateBars' own merge, where a
  // confidently-wrong number is worse than an honest absence. AM replaces
  // this bar wholesale (via _appendBar's tUtc match) and brings the real
  // vwap/transactions with it.
  if (!last || minuteUtc > last.tUtc) {
    _appendBar(ticker, state, {
      ticker,
      open:   typeof o === 'number' && plausible(o) ? o : c,
      high:   typeof h === 'number' && plausible(h) ? h : c,
      low:    typeof l === 'number' && plausible(l) ? l : c,
      close:  c,
      volume: typeof v === 'number' && Number.isFinite(v) ? v : 0,
      vwap:         undefined,
      transactions: undefined,
      tCT:  minuteCT,
      tUtc: minuteUtc,
    });
    _notifyCoalesced();
  }
  // Otherwise the second is older than our newest bar — a late or replayed
  // message. Ignore it rather than rewriting settled history.
}

// ── Coalesced notification ────────────────────────────────────────────────────
//
// Non-negotiable constraint carried over from the Track B fix: subscriber
// fan-out must not run more than once per animation frame. Every consumer of
// this store re-derives real work from a notification — the chart alone
// merges ~10k one-minute bars, rebuilds VWAP, runs three EMA passes and
// calls setData on five series. Notifying per incoming second would rebuild
// that ~60× a minute per ticker across ~23 tickers.
//
// AM keeps calling _notify() directly: one message per minute per ticker is
// already rare, and a completed bar should land immediately.
let _rafPending = 0;
function _notifyCoalesced() {
  if (_rafPending !== 0) return;
  if (typeof requestAnimationFrame !== 'function') { _notify(); return; }
  _rafPending = requestAnimationFrame(() => { _rafPending = 0; _notify(); });
}

/**
 * Put `bar` where its minute belongs: replace the bar with the same tUtc, or
 * insert in time order. Returns false when the bar was placed, not appended.
 *
 * Comparing against the last bar alone was wrong once `_handleA` began
 * opening the forming minute (2026-09-11): Massive's AM for minute M lands a
 * few seconds AFTER the first 'A' of minute M+1, so AM(M) was pushed behind
 * the provisional M+1 bar. Seen live on TSLA — buffer [08:40 provisional,
 * 08:39 AM, 08:40 again] — and the chart's order guard then dropped the
 * authoritative 08:39 bar and every later update to 08:40.
 */
export function placeBar(bars: Bar[], bar: Bar): 'appended' | 'replaced' | 'inserted' {
  let i = bars.length - 1;
  while (i >= 0 && bars[i].tUtc > bar.tUtc) i--;
  if (i >= 0 && bars[i].tUtc === bar.tUtc) { bars[i] = bar; return 'replaced'; }
  if (i === bars.length - 1) { bars.push(bar); return 'appended'; }
  bars.splice(i + 1, 0, bar);
  return 'inserted';
}

function _appendBar(ticker: string, state: TickerState, bar: Bar) {
  // A reconnect can replay the current-minute bar, and AM finalises a bar the
  // 'A' channel opened — both replace in place.
  if (placeBar(state.bars, bar) === 'replaced') return;

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
    console.error(`[barsStore] Backfill failed for ${ticker}: ${formatError(e)}`);
  } finally {
    state.backfilling = false;
    _notify();
  }
}

/**
 * Runs `_backfill` for one ticker only after acquiring a reconnect-backfill
 * slot — the real fix for the thundering-herd burst described on
 * MAX_CONCURRENT_RECONNECT_BACKFILLS. Callers fire-and-forget this per
 * ticker; the semaphore (not the caller) decides how many run at once.
 */
async function _gatedReconnectBackfill(ticker: string, reason: 'cold-start' | 'reconnect') {
  await _acquireReconnectBackfillSlot();
  try {
    await _backfill(ticker, reason);
  } finally {
    _releaseReconnectBackfillSlot();
  }
}

/**
 * On reconnect, check all subscribed tickers. Any ticker whose last bar is
 * older than STALE_THRESHOLD_MS gets a gap-fill backfill.
 * Engineering Lesson #9.
 *
 * Every stale ticker is queued through _gatedReconnectBackfill rather than
 * called directly — with 4 upstream connections reconnecting together,
 * this loop can mark most/all subscribed tickers stale in the same tick.
 * Un-gated, that fires every one of their REST calls simultaneously; see
 * MAX_CONCURRENT_RECONNECT_BACKFILLS for the real incident this caused.
 */
function _registerReconnectHandler() {
  massiveBus.onReconnect(() => {
    const nowMs = Date.now();
    for (const [ticker, state] of _state) {
      if (state.bars.length === 0) {
        void _gatedReconnectBackfill(ticker, 'cold-start');
        continue;
      }
      const last  = state.bars[state.bars.length - 1];
      const ageMs = nowMs - last.tUtc;
      if (ageMs > STALE_THRESHOLD_MS) {
        console.log(`[barsStore] ${ticker} stale after reconnect (${Math.round(ageMs / 1000)}s) — gap-filling.`);
        void _gatedReconnectBackfill(ticker, 'reconnect');
      }
    }
  });
}

function _notify() {
  for (const fn of _listeners) fn();
}
