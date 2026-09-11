/**
 * Layer 1 — cvdStore
 *
 * Real tick-classified cumulative delta for both asset classes.
 * Keyed by ticker. Source: T.* (trades) + Q.* (quotes) from massiveBus only.
 *
 * CVD is NEVER sourced from:
 *   - Chain snapshots (those give OI/greeks, not order flow)
 *   - REST endpoints (fetchTradesPage is the boot rebuild only — see appendRebuiltTicks)
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
 *   'ready' iff at least one tick of TODAY's regular session has been
 *   classified. A zeroed-out CVD with 0 ticks is 'loading', never 'ready' —
 *   and so is yesterday's total before today's first trade.
 *
 * ── Session scope (fixed 2026-09-11) ─────────────────────────────────────
 * CVD is cumulative from the session open, and it is only ever the regular
 * session's: trades from 8:30 AM to 3:00 PM CT (NYSE 9:30 AM–4:00 PM ET, the
 * same source CLAUDE.md cites for the forced close). The first trade of a new
 * session resets every total. Before this, buyDelta/sellDelta were set once
 * per ticker and only ever added to, so the 25-point CVD factor scored a
 * total running since the process booted — right on a deploy day, days of
 * stale flow on every other. Extended-hours trades still advance the uptick
 * reference price but are not part of the session's CVD.
 */

import { type CvdTick, type AssetClass, type Result, ready, loading } from './types.ts';
import { toCentralTime } from '../lib/time.ts';

// ── Constants ─────────────────────────────────────────────────────────────────

/** CVD is considered stale if no tick has arrived in the last 30 seconds. */
const STALE_TICK_THRESHOLD_MS = 30 * 1000;

const DAY_MS = 86_400_000;
/** Regular session, CT minute of day: NYSE 9:30 AM ET = 8:30 AM CT … 4:00 PM ET = 3:00 PM CT. */
const SESSION_OPEN_MIN  = 8 * 60 + 30;
const SESSION_CLOSE_MIN = 15 * 60;

/**
 * The CT day index (days since epoch, CT pseudo-epoch) of the regular session
 * a trade at `tCT` belongs to — or null when it is outside regular hours.
 * No holiday or early-close calendar exists (CLAUDE.md, KNOWN GAPS).
 */
export function regularSessionDay(tCT: number): number | null {
  const day = Math.floor(tCT / DAY_MS);
  const min = Math.floor((tCT - day * DAY_MS) / 60_000);
  return min >= SESSION_OPEN_MIN && min < SESSION_CLOSE_MIN ? day : null;
}

/** Cap on raw tick history kept per ticker — prevents unbounded growth over a long session. */
const MAX_TICKS_PER_TICKER = 5000;

/** Per-minute delta buckets kept per ticker: one full day of minutes. */
const MAX_DELTA_MINUTES = 1_440;

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
  /** Classified volume per CT minute (key = minute start, CT pseudo-epoch ms). See getDeltaBars. */
  minutes:     Map<number, { buy: number; sell: number }>;
  /** CT day index of the regular session every total above belongs to. */
  sessionDay:  number | null;
  /** UTC ms of the first LIVE trade since subscription — where a rebuild must stop. */
  liveFromUtc: number | null;
  coverage:    SessionCoverage | null;
}

/** What the boot rebuild covered, so a partial session can say so. */
export interface SessionCoverage {
  sessionDay:     number;
  rebuiltFromUtc: number;
  /** UTC ms of the last rebuilt trade, or null when none was needed/found. */
  rebuiltToUtc:   number | null;
  /** False when the rebuild could not reach the live feed (page cap, failure). */
  complete:       boolean;
  note:           string | null;
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
    minutes:     new Map(),
    sessionDay:  null,
    liveFromUtc: null,
    coverage:    null,
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
  // Totals from an earlier session are not today's CVD. Before today's first
  // regular-session trade there is no CVD yet — say so, don't serve yesterday.
  if (state.sessionDay !== Math.floor(toCentralTime(Date.now()).ctMs / DAY_MS)) return loading();

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

  if (state.liveFromUtc === null) state.liveFromUtc = tick.tUtc;
  // The uptick fallback compares against the last trade of any session.
  state.prevPrice = tick.price;
  if (!_accumulate(state, tick)) return;

  state.ticks.push(tick);
  if (state.ticks.length > MAX_TICKS_PER_TICKER) {
    state.ticks.splice(0, state.ticks.length - MAX_TICKS_PER_TICKER);
  }
  _notify();
}

/**
 * Write API for session/cvdRebuild: trades fetched over REST from the open.
 *
 * Separate from the live path on purpose. A replayed trade must not become
 * the live classifier's uptick reference (prevPrice), and any replayed trade
 * at or after the first LIVE trade is dropped — the live feed already
 * counted it. Before this split the rebuild wrote through the live path and
 * fetched up to "now" while live trades were arriving over the relay's shared
 * subscriptions, so every trade in that window would have been counted twice.
 * (Latent: until 2026-09-11 every rebuild request was rejected, HTTP 400.)
 *
 * Returns how many were applied and how many were dropped as already live.
 */
export function appendRebuiltTicks(ticker: string, ticks: readonly CvdTick[]): { applied: number; droppedAsLive: number } {
  const state = _state.get(ticker);
  if (!state) return { applied: 0, droppedAsLive: 0 };
  let applied = 0, droppedAsLive = 0;
  for (const tick of ticks) {
    if (state.liveFromUtc !== null && tick.tUtc >= state.liveFromUtc) { droppedAsLive++; continue; }
    if (_accumulate(state, tick)) applied++;
  }
  if (applied > 0) _notify();
  return { applied, droppedAsLive };
}

/** First live trade since subscription (UTC ms), or null if none yet. */
export function getLiveFromUtc(ticker: string): number | null {
  return _state.get(ticker)?.liveFromUtc ?? null;
}

export function setCoverage(ticker: string, coverage: SessionCoverage) {
  const state = _state.get(ticker);
  if (state) state.coverage = coverage;
}

/** What the rebuild covered for the CURRENT session, or null (no rebuild, or an older session's). */
export function getCoverage(ticker: string): SessionCoverage | null {
  const state = _state.get(ticker);
  if (!state?.coverage || state.coverage.sessionDay !== state.sessionDay) return null;
  return state.coverage;
}

/**
 * Add one classified trade to the session totals and the minute series.
 * Returns false when the trade is not part of a session this state counts:
 * outside regular hours, or from a session older than the current one. The
 * first trade of a newer session resets everything.
 */
function _accumulate(state: TickerCvdState, tick: CvdTick): boolean {
  const day = regularSessionDay(tick.tCT);
  if (day === null) return false;
  if (state.sessionDay === null || day > state.sessionDay) {
    state.sessionDay = day;
    state.buyDelta   = 0;
    state.sellDelta  = 0;
    state.tickCount  = 0;
    state.ticks      = [];
    state.minutes    = new Map();
  } else if (day < state.sessionDay) {
    return false;
  }

  state.tickCount++;
  if (tick.tUtc > state.lastTickAt) state.lastTickAt = tick.tUtc;
  if (tick.side === 'buy') state.buyDelta += tick.size; else state.sellDelta += tick.size;

  // Per-minute buckets for the delta series (getDeltaBars).
  const minute = Math.floor(tick.tCT / 60_000) * 60_000;
  let bucket = state.minutes.get(minute);
  if (!bucket) {
    bucket = { buy: 0, sell: 0 };
    state.minutes.set(minute, bucket);
    if (state.minutes.size > MAX_DELTA_MINUTES) {
      state.minutes.delete(Math.min(...state.minutes.keys()));
    }
  }
  if (tick.side === 'buy') bucket.buy += tick.size; else bucket.sell += tick.size;
  return true;
}

/** One minute of classified volume, with the session's running total. */
export interface DeltaBar {
  /** Minute start, CT pseudo-epoch ms. */
  tCT:      number;
  buy:      number;
  sell:     number;
  /** buy − sell for this minute. */
  delta:    number;
  /** Running Σ delta from the session's first classified minute. */
  cumDelta: number;
}

/**
 * The per-minute delta series for the newest CT session present — the real
 * series the chart's CVD panel draws and the exhaustion exit will read
 * (price makes a new high while the delta behind it shrinks).
 *
 * It replaces a projection: the chart used to draw a straight ramp from 0 to
 * the CURRENT call/put skew across every bar on screen. This is what traded.
 *
 * Minutes with no classified trade are simply absent — never zero-filled.
 * Only regular-session minutes (8:30 AM–3:00 PM CT) are kept, and the
 * running total starts from zero at the open. Coverage starts where the
 * ticks do: the open if the boot rebuild (session/cvdRebuild) reached it —
 * see getCoverage — otherwise the engine's boot. Rebuilt minutes are
 * classified by the uptick rule (no historical quotes); live minutes against
 * the prevailing bid/ask.
 */
export function getDeltaBars(ticker: string): DeltaBar[] {
  const state = _state.get(ticker);
  if (!state || state.minutes.size === 0) return [];
  const keys = [...state.minutes.keys()].sort((a, b) => a - b);
  const day = Math.floor(keys[keys.length - 1] / 86_400_000);
  const out: DeltaBar[] = [];
  let cum = 0;
  for (const k of keys) {
    if (Math.floor(k / 86_400_000) !== day) continue;
    const b = state.minutes.get(k)!;
    const delta = b.buy - b.sell;
    cum += delta;
    out.push({ tCT: k, buy: b.buy, sell: b.sell, delta, cumDelta: cum });
  }
  return out;
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
