/**
 * Layer 2 — dumpRipDetector
 *
 * Detects DUMP and RIP conditions from LULD halt events.
 * Reads luldStore exclusively — does NOT subscribe to the LULD WS channel.
 * luldStore is the only consumer of that channel; this engine reads the store.
 *
 * Signal conditions:
 *   DUMP: isActive === true AND last trade price <= event.lowerBand
 *   RIP:  isActive === true AND last trade price >= event.upperBand
 *
 * Emits typed events to registered listeners. Does not write to any store.
 * The confluenceEngine subscribes to these events as signal inputs.
 *
 * Price feed:
 *   This engine requires a price callback for the current trade price of each
 *   ticker. The caller (typically the cockpit initialiser or confluenceEngine)
 *   registers a price provider via setPriceProvider(). If no provider is
 *   registered, band-crossing checks default to the midpoint of the bands
 *   (conservative — fires only when price is clearly outside the bands).
 */

import * as luldStore from '../stores/luldStore';
import type { StoredLuldEvent } from '../stores/luldStore';
import type { SignalType }      from '../stores/types';
import { formatError }          from '../lib/errors';

// ── Event types ───────────────────────────────────────────────────────────────

export interface DumpRipEvent {
  ticker:     string;
  signalType: Extract<SignalType, 'DUMP' | 'RIP'>;
  triggerPrice: number;
  band: {
    upper: number;
    lower: number;
  };
  luldEvent:  StoredLuldEvent;
  detectedAt: number;  // UTC ms
}

export type DumpRipListener = (event: DumpRipEvent) => void;

// ── Internal state ────────────────────────────────────────────────────────────

const _listeners           = new Set<DumpRipListener>();
const _watchedTickers      = new Set<string>();
let   _priceProvider: ((ticker: string) => number | null) | null = null;

// Track which LULD events have already fired a signal (by tUtc) to prevent
// re-firing the same halt multiple times on store re-notification.
const _firedEventTimestamps = new Map<string, Set<number>>();

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Register a price provider callback.
 * The engine calls this to get the current trade price for band-crossing checks.
 * If not set, the engine uses band midpoint as a conservative estimate.
 */
export function setPriceProvider(fn: (ticker: string) => number | null) {
  _priceProvider = fn;
}

/**
 * Add `ticker` to the watch list.
 * On each luldStore notification, this ticker's halt events are checked.
 */
export function watchTicker(ticker: string) {
  if (_watchedTickers.has(ticker)) return;
  _watchedTickers.add(ticker);

  if (!_firedEventTimestamps.has(ticker)) {
    _firedEventTimestamps.set(ticker, new Set());
  }

  // Subscribe to luldStore notifications if this is the first ticker
  if (_watchedTickers.size === 1) {
    luldStore.subscribe(_onStoreUpdate);
  }
}

export function unwatchTicker(ticker: string) {
  _watchedTickers.delete(ticker);
  _firedEventTimestamps.delete(ticker);
}

export function onDumpRip(listener: DumpRipListener): () => void {
  _listeners.add(listener);
  return () => _listeners.delete(listener);
}

// ── Internal ──────────────────────────────────────────────────────────────────

function _onStoreUpdate() {
  for (const ticker of _watchedTickers) {
    _checkTicker(ticker);
  }
}

function _checkTicker(ticker: string) {
  const result = luldStore.getResult(ticker);
  if (result.status !== 'ready') return;

  const fired = _firedEventTimestamps.get(ticker)!;
  const price = _priceProvider ? (_priceProvider(ticker) ?? null) : null;

  for (const event of result.data.events) {
    if (!event.isActive) continue;
    if (fired.has(event.tUtc)) continue; // already fired for this halt

    const upper = event.upperBand ?? 0;
    const lower = event.lowerBand ?? 0;

    // Use provided price; fall back to band midpoint if unavailable
    const checkPrice = price ?? (upper > 0 && lower > 0 ? (upper + lower) / 2 : 0);
    if (checkPrice === 0) continue;

    const signal = detectSignal(checkPrice, upper, lower);
    if (!signal) continue;

    fired.add(event.tUtc);

    const dumpRipEvent: DumpRipEvent = {
      ticker,
      signalType:   signal,
      triggerPrice: checkPrice,
      band: { upper, lower },
      luldEvent:    event,
      detectedAt:   Date.now(),
    };

    _emit(dumpRipEvent);
  }
}

function _emit(event: DumpRipEvent) {
  console.log(`[dumpRipDetector] ${event.ticker} ${event.signalType} @ ${event.triggerPrice}`);
  for (const fn of _listeners) {
    try { fn(event); }
    catch (e) { console.error(`[dumpRipDetector] Listener error: ${formatError(e)}`); }
  }
}

// ── Pure detection — exported for unit tests ──────────────────────────────────

/**
 * Determine whether a price crossing constitutes a DUMP or RIP signal.
 *
 * DUMP: price is at or below the lower LULD band (price fell through the floor)
 * RIP:  price is at or above the upper LULD band (price broke through the ceiling)
 * null: price is within the bands — no signal
 *
 * Both bands must be positive (>0) for a signal to fire.
 * A zero band value means the data is incomplete — do not fire.
 */
export function detectSignal(
  price:      number,
  upperBand:  number,
  lowerBand:  number,
): Extract<SignalType, 'DUMP' | 'RIP'> | null {
  if (upperBand <= 0 || lowerBand <= 0) return null;
  if (price <= lowerBand) return 'DUMP';
  if (price >= upperBand) return 'RIP';
  return null;
}
