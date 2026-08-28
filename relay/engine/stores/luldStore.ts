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
  const ticker = msg.sym;
  const state  = _state.get(ticker);
  if (!state) return;

  // Massive LULD fields:
  //   T = event type string (not to be confused with trades 'T' channel)
  //   h = high band price
  //   l = low band price
  //   i = indicator code
  const rawType    = (msg.T as string) ?? '';
  const eventType  = _normaliseEventType(rawType);
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

function _normaliseEventType(rawType: string): LuldEventType {
  // Massive LULD indicator codes — normalise to app union
  switch (rawType.toUpperCase()) {
    case 'H':
    case 'HALT':
    case 'T1':  // regulatory halt
    case 'T2':  // non-regulatory halt
    case 'T6':  // extraordinary market activity
    case 'T12': // additional regulatory halt
      return 'halt';

    case 'R':
    case 'RESUME':
    case 'T3':  // resume after T1
    case 'T7':  // resume after T6
      return 'resume';

    case 'P':
    case 'LULD_PAUSE':
    case 'LUDP':
      return 'luld_pause';

    case 'B':
    case 'LULD_BAND':
    case 'LUDB':
    default:
      return 'luld_band';
  }
}

function _notify() {
  for (const fn of _listeners) fn();
}
