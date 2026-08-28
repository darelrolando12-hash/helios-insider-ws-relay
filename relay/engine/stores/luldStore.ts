/**
 * Layer 1 — luldStore
 *
 * Real-time LULD halt and circuit-breaker events from the LULD.* WebSocket
 * channel. Keyed by ticker. The DUMP/RIP detector (Layer 2) reads from here;
 * it does NOT subscribe to the LULD channel independently.
 *
 * This store is the only consumer of LULD WebSocket messages in the app.
 *
 * isDataReady(ticker):
 *   'ready' iff at least one event has been received for the ticker.
 *   An empty event list means LULD channel is subscribed but no events
 *   have fired today — status is 'loading', not 'ready'.
 *
 * Active halt detection:
 *   isActive is derived from the event sequence: a 'halt' event without a
 *   subsequent 'resume' event means the ticker is currently halted.
 *   The DUMP/RIP detector reads isActive directly from LuldEvent — it never
 *   re-derives halt state from raw event lists.
 *
 * HALT COVERAGE — a real structural limit, not a bug:
 *   Massive states verbatim that "Halt and resumption messages (indicators 17
 *   and 18) are only available for NASDAQ listed securities."
 *   (https://massive.com/docs/websocket/stocks/luld)
 *
 *   So for a NYSE- or AMEX-listed ticker (tape z = 1 or 2), a halt can NEVER
 *   arrive on this channel. isHalted() will answer `false` for those names no
 *   matter what actually happens to them. That is a data-availability gap
 *   masquerading as "not halted", which is exactly the shape of bug this repo
 *   keeps hitting — so any consumer that treats `false` as "confirmed
 *   trading" must first check the tape. In a 2026-08-28 capture the split was
 *   210 Nasdaq (z=3) to 65 NYSE (z=1) messages, so this covers roughly a
 *   quarter of observed traffic.
 *
 *   Every one of those 275 captured messages was a band publication
 *   (indicators 15/16/22, both bands present); no halt appeared. The 17/18
 *   mapping below therefore comes from Massive's published glossary rather
 *   than from observed halt traffic, and has not yet been exercised live.
 */

import { massiveBus, type WSMessageWithCT } from '../bus.ts';
import { type LuldEvent, type LuldEventType, type Result, ready, loading } from './types.ts';

// ── Extended LuldEvent for store consumers ────────────────────────────────────

export interface StoredLuldEvent extends LuldEvent {
  /**
   * True when this event represents an active halt (no subsequent resume).
   * Computed once on ingestion; DUMP/RIP detector reads this flag directly.
   * Not re-derived per-consumer.
   */
  isActive: boolean;
}

// ── LuldState ─────────────────────────────────────────────────────────────────

export interface LuldState {
  events:         StoredLuldEvent[];
  isCurrentlyHalted: boolean;
  lastEventAt:    number;  // UTC ms of the most recent event
}

// ── Internal state ────────────────────────────────────────────────────────────

const _state     = new Map<string, LuldState>();
const _listeners = new Set<() => void>();

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Subscribe to LULD events for `ticker`.
 * Registers the LULD channel on massiveBus.
 * Safe to call multiple times — idempotent.
 */
export function subscribeTicker(ticker: string) {
  if (_state.has(ticker)) return;

  _state.set(ticker, {
    events:            [],
    isCurrentlyHalted: false,
    lastEventAt:       0,
  });

  massiveBus.subscribeStock('LULD', ticker);
  massiveBus.on('LULD', _handleLuld);
}

export function unsubscribeTicker(ticker: string) {
  massiveBus.unsubscribeStock('LULD', ticker);
  _state.delete(ticker);
  _notify();
}

/**
 * Get the current Result<LuldState> for `ticker`.
 *
 * status: 'loading' — subscribed but no events have fired.
 * status: 'ready'   — at least one event received (even if no active halt).
 *
 * Note: 'ready' with isCurrentlyHalted === false is the normal trading state.
 * A consumer that sees 'loading' simply hasn't received any LULD data yet —
 * it should not assume the ticker is unhalted; it genuinely doesn't know yet.
 */
export function getResult(ticker: string): Result<LuldState> {
  const state = _state.get(ticker);
  if (!state || state.events.length === 0) return loading();
  return ready(state, state.lastEventAt);
}

export function isDataReady(ticker: string): boolean {
  return getResult(ticker).status === 'ready';
}

/**
 * Quick halt check without unpacking a Result.
 * Returns null if no data yet (not the same as false — caller must handle null).
 */
export function isHalted(ticker: string): boolean | null {
  const state = _state.get(ticker);
  if (!state || state.events.length === 0) return null;
  return state.isCurrentlyHalted;
}

export function subscribe(listener: () => void): () => void {
  _listeners.add(listener);
  return () => _listeners.delete(listener);
}

// ── Message handler ───────────────────────────────────────────────────────────

function _handleLuld(msg: WSMessageWithCT) {
  // Real Massive LULD payload, verbatim from a captured session:
  //   {"ev":"LULD","h":314.7,"l":284.72,"i":[22],"z":1,"T":"IWM",
  //    "t":1787924309993088500,"q":39563}
  //
  //   T = TICKER  (not an event type — see below)
  //   h = upper (limit-up) band price
  //   l = lower (limit-down) band price
  //   i = indicator code ARRAY
  //   z = tape (1 = NYSE, 3 = Nasdaq)
  //   q = sequence number
  //   t = timestamp in NANOSECONDS (normalised upstream in bus.ts)
  //
  // There is NO `sym` field: across 275 captured LULD messages, zero had one.
  // This handler previously read `msg.sym`, so `ticker` was always undefined,
  // `_state.get(undefined)` always missed, and the function returned before
  // storing anything. Every LULD event since the channel was routed has been
  // discarded here — a silent zero that reads as "no halts today".
  //
  // `sym` is kept as a fallback purely so a future payload that does carry it
  // still works; `T` is the observed reality.
  const ticker = (msg.T as string) ?? (msg.sym as string) ?? '';
  const state  = _state.get(ticker);
  if (!state) return;

  const indicators = Array.isArray(msg.i) ? (msg.i as unknown[]) : [];
  const eventType  = _normaliseEventType(indicators);
  const upperBand  = (msg.h as number) ?? undefined;
  const lowerBand  = (msg.l as number) ?? undefined;

  // Determine isActive before appending (halt without resume = active)
  const isHaltEvent   = eventType === 'halt' || eventType === 'luld_pause';
  const isResumeEvent = eventType === 'resume';

  // Update halt tracker
  if (isHaltEvent)   state.isCurrentlyHalted = true;
  if (isResumeEvent) state.isCurrentlyHalted = false;

  const event: StoredLuldEvent = {
    ticker,
    type:      eventType,
    upperBand,
    lowerBand,
    tCT:       msg._ct.ctMs,
    tUtc:      msg._ct.utcMs,
    isActive:  state.isCurrentlyHalted,
  };

  state.events.push(event);
  state.lastEventAt = msg._ct.utcMs;

  console.log(`[luldStore] ${ticker} LULD event: ${eventType} | halted: ${state.isCurrentlyHalted}`);
  _notify();
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Map Massive's LULD indicator array to the app's event union.
 *
 * The previous implementation took a STRING and switched on codes like 'H',
 * 'T1', 'R'. The wire format carries no such field — it sends `i` as an array
 * of numeric indicator codes. Because the old code was handed `msg.T` (the
 * ticker, e.g. "IWM"), every lookup fell through to `default` and returned
 * 'luld_band'. It produced a plausible answer for entirely the wrong reason.
 *
 * Observed codes across 275 captured messages: 16 (206x), 22 (65x), 15 (4x).
 * All 275 carried BOTH an upper and lower band, which is what a band
 * publication looks like — none were halts.
 *
 * DELIBERATELY CONSERVATIVE: the authoritative SIP indicator table is not
 * something this codebase has verified, so an unrecognised code returns
 * 'luld_band', never 'halt'. That direction matters. isHalted() feeds the
 * catalyst gate, and a false 'halt' silently suppresses every signal for that
 * ticker — the exact failure this repo has already been bitten by. A missed
 * halt is visible in the data; a fabricated one is not.
 *
 * Halt/resume codes stay unmapped until they can be confirmed against real
 * halt traffic. When that happens, add them here rather than guessing.
 */
/**
 * LULD indicator codes, from Massive's published glossary.
 *
 * Source: https://massive.com/glossary/us/stocks/conditions-indicators
 *         (LULD Indicators section), linked from
 *         https://massive.com/docs/websocket/stocks/luld
 *
 *   15  Intraday Update
 *   16  Restated Value
 *   17  Suspended Halt Pause
 *   18  Reopening Update
 *   19  Outside Price Band Rule Hours
 *   21  Price Band
 *   22  Republished LULD Price Band
 *
 * 17 and 18 are the halt and resumption messages. Massive states verbatim:
 * "Halt and resumption messages (indicators 17 and 18) are only available for
 * NASDAQ listed securities." — see HALT COVERAGE in the module header for why
 * that matters to isHalted().
 */
const INDICATOR_HALT   = 17;
const INDICATOR_RESUME = 18;

/** Every documented code that describes a band publication rather than a halt. */
const INDICATOR_BAND = new Set([15, 16, 19, 21, 22]);

function _normaliseEventType(indicators: unknown[]): LuldEventType {
  const codes = indicators
    .map((c) => (typeof c === 'number' ? c : Number(c)))
    .filter((c) => Number.isFinite(c));

  // Halt and resume take precedence over any band code sharing the array —
  // a message that reopens trading is a resume first and a band update second.
  if (codes.includes(INDICATOR_HALT))   return 'halt';
  if (codes.includes(INDICATOR_RESUME)) return 'resume';

  // Anything documented as a band, plus anything undocumented, is treated as a
  // band publication. Never as a halt: isHalted() feeds the catalyst gate, so
  // a fabricated halt silently suppresses every signal for that ticker. A
  // missed halt is visible in the data; an invented one is not.
  const unknown = codes.filter((c) => !INDICATOR_BAND.has(c));
  if (unknown.length > 0) {
    console.warn(
      `[luldStore] Undocumented LULD indicator code(s): ${unknown.join(', ')}. ` +
      `Treating as a band publication (never as a halt). Known codes are ` +
      `15/16/19/21/22 = band, 17 = halt, 18 = resume.`
    );
  }

  return 'luld_band';
}

function _notify() {
  for (const fn of _listeners) fn();
}
