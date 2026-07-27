/**
 * Layer 3 — signalLedger
 *
 * The write side of the signal-outcome ledger. Subscribes to
 * confluenceEngine's signal stream and persists each signal once as an
 * immutable record in the `signals` table.
 *
 * Design rules:
 *   - One write per signal. The `signals` row is never updated after insert.
 *   - The contributing-factors blob is captured from live store state at the
 *     moment the signal arrives. confluenceEngine emits synchronously from
 *     _scoreTicker, so store state is still fresh at listener call time.
 *   - `outcomeResolver` is the only writer of `signal_outcomes` and the only
 *     thing that ever updates the parent signal's `status`.
 *   - Direction ('call'/'put') is inferred from SignalType:
 *       ENTER / BREAKOUT → call  (engine only fires these in bullish context)
 *       EXIT  / DUMP     → put   (bearish / exit-short signal)
 *       RIP              → call  (LULD bounce = bullish)
 *       REVERSAL         → inferred from live CVD classification
 */

import { supabase }                    from '../lib/supabase';
import * as confluenceEngine           from '../engines/confluenceEngine';
import * as barsStore                  from '../stores/barsStore';
import * as cvdStore                   from '../stores/cvdStore';
import * as marketStore                from '../stores/marketStore';
import * as luldStore                  from '../stores/luldStore';
import * as fundamentalsStore          from '../stores/fundamentalsStore';
import * as catalystGate               from '../engines/catalystGate';
import type { Signal, SignalType }     from '../stores/types';

// ── Exported types ─────────────────────────────────────────────────────────────

export type SignalDirection = 'call' | 'put';
export type SignalStatus    = 'pending' | 'resolved' | 'expired';

/**
 * The JSON blob persisted alongside each signal row.
 * Captures the contributing engine state at the exact moment of emission.
 * This record is immutable after write — it represents what the engine
 * believed at signal-fire time, not what the market looks like later.
 */
export interface SignalFactors {
  gexRegime:    string | null;
  flipLevel:    number | null;
  callWall:     number | null;
  putWall:      number | null;
  /** callPct − putPct: directional skew in [−100, +100]; positive = net buying */
  cvdPct:       number | null;
  /** 'bullish' | 'bearish' | 'neutral' */
  cvdClass:     string | null;
  /** 'bull' | 'bear' | 'mixed' — EMA8 / EMA21 / EMA55 alignment */
  emaStack:     string | null;
  catalystTags: CatalystTagsBlob | null;
  luld: {
    isHalted:   boolean | null;
    upperBand:  number | null;
    lowerBand:  number | null;
  };
}

interface CatalystTagsBlob {
  earningsPending: boolean;
  materialEvent:   boolean;
  insiderBuy:      boolean;
  insiderSell:     boolean;
}

/**
 * A signal row as stored in the `signals` table.
 * Shape is the ground truth for both outcomeResolver and brainStore reads.
 */
export interface SignalRecord {
  id:           string;
  ticker:       string;
  direction:    SignalDirection;
  signal_type:  SignalType;
  /** Confluence score 0–100 */
  conviction:   number;
  entry_price:  number;
  /** CT pseudo-UTC epoch (ctMs) — used for chart display */
  entry_tct:    number;
  /** Raw UTC ms — used for findBarNear gap-fill lookups */
  entry_utc:    number;
  status:       SignalStatus;
  /** Immutable JSON blob of contributing engine state */
  factors:      SignalFactors;
  created_at:   string;  // ISO 8601, server-assigned
}

// ── Internal state ─────────────────────────────────────────────────────────────

let _initialised = false;

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Attach the ledger to the confluenceEngine signal stream.
 * Call once at app startup, after confluenceEngine.init().
 * Returns the unsubscribe function.
 */
export function initLedger(): () => void {
  if (_initialised) {
    console.warn('[signalLedger] Already initialised — ignoring duplicate init.');
    return () => {};
  }
  _initialised = true;

  const unsub = confluenceEngine.onSignal(_onSignal);
  console.log('[signalLedger] Subscribed to confluenceEngine signal stream.');
  return unsub;
}

// ── Signal handler ─────────────────────────────────────────────────────────────

async function _onSignal(signal: Signal): Promise<void> {
  const factors   = _captureFactors(signal.ticker);
  const direction = _inferDirection(signal.type, factors);

  const row = {
    id:          signal.id,
    ticker:      signal.ticker,
    direction,
    signal_type: signal.type,
    conviction:  signal.confidence,
    entry_price: signal.triggerPrice,
    entry_tct:   signal.firedAtCT,
    entry_utc:   signal.firedAt,
    status:      'pending' as SignalStatus,
    factors,
  };

  const { error: dbError } = await supabase
    .from('signals')
    .insert(row);

  if (dbError) {
    // Log but never throw — a ledger write failure must never propagate back
    // to the engine or crash the signal stream.
    console.error(`[signalLedger] Failed to write signal ${signal.id}:`, dbError.message);
  } else {
    console.log(
      `[signalLedger] Recorded ${signal.ticker} ${signal.type} ` +
      `(${direction}) @ ${signal.triggerPrice} — id: ${signal.id}`
    );
  }
}

// ── Factor capture ─────────────────────────────────────────────────────────────

/**
 * Snapshot the current store state for a ticker into a SignalFactors blob.
 * Called synchronously from _onSignal, which is itself called synchronously
 * from confluenceEngine._emit — so all store state is still from this tick.
 */
function _captureFactors(ticker: string): SignalFactors {
  // ── CVD ────────────────────────────────────────────────────────────────────
  // cvdPct = callPct - putPct, producing a directional skew in [-100, +100].
  // Positive = net buy-side pressure; negative = net sell-side pressure.
  const cvdResult = cvdStore.getResult(ticker);
  let cvdPct:  number | null = null;
  let cvdClass: string | null = null;
  if (cvdResult.status === 'ready') {
    const { callPct, putPct, classification } = cvdResult.data;
    cvdPct   = callPct - putPct;
    cvdClass = classification;
  }

  // ── GEX / Market Context ──────────────────────────────────────────────────
  const marketResult = marketStore.getResult(ticker);
  let gexRegime: string | null = null;
  let flipLevel:  number | null = null;
  let callWall:   number | null = null;
  let putWall:    number | null = null;
  if (marketResult.status === 'ready') {
    gexRegime = marketResult.data.gexRegime;
    flipLevel = marketResult.data.flipLevel;
    callWall  = marketResult.data.walls.callWall;
    putWall   = marketResult.data.walls.putWall;
  }

  // ── EMA Stack ─────────────────────────────────────────────────────────────
  let emaStack: string | null = null;
  const barsResult = barsStore.getResult(ticker);
  if (barsResult.status === 'ready') {
    const closes = barsResult.data.map(b => b.close);
    const ema8   = confluenceEngine.computeEma(closes, 8);
    const ema21  = confluenceEngine.computeEma(closes, 21);
    const ema55  = confluenceEngine.computeEma(closes, 55);
    if      (ema8 > ema21 && ema21 > ema55) emaStack = 'bull';
    else if (ema8 < ema21 && ema21 < ema55) emaStack = 'bear';
    else                                     emaStack = 'mixed';
  }

  // ── LULD / Halt State ─────────────────────────────────────────────────────
  const isHalted   = luldStore.isHalted(ticker);
  const luldResult = luldStore.getResult(ticker);
  const lastLuld   = luldResult.status === 'ready'
    ? luldResult.data.events[luldResult.data.events.length - 1]
    : null;
  const upperBand = lastLuld?.upperBand ?? null;
  const lowerBand = lastLuld?.lowerBand ?? null;

  // ── Catalyst Tags ─────────────────────────────────────────────────────────
  let catalystTags: CatalystTagsBlob | null = null;
  const fundResult = fundamentalsStore.getResult(ticker);
  if (fundResult.status === 'ready') {
    const tags = catalystGate.computeTags(ticker, fundResult.data);
    catalystTags = {
      earningsPending: tags.earningsPending,
      materialEvent:   tags.materialEvent,
      insiderBuy:      tags.insiderBuy,
      insiderSell:     tags.insiderSell,
    };
  }

  return {
    gexRegime,
    flipLevel,
    callWall,
    putWall,
    cvdPct,
    cvdClass,
    emaStack,
    catalystTags,
    luld: { isHalted, upperBand, lowerBand },
  };
}

// ── Direction inference ────────────────────────────────────────────────────────

/**
 * Infer the dominant direction (call / put) from signal type and live CVD.
 *
 * ENTER / BREAKOUT → call  (engine only fires these in bullish context)
 * EXIT  / DUMP     → put   (exit long or short-side signal)
 * RIP              → call  (LULD bounce from halt-down = bullish)
 * REVERSAL         → use CVD classification as tiebreaker
 */
function _inferDirection(
  type:    SignalType,
  factors: SignalFactors,
): SignalDirection {
  switch (type) {
    case 'ENTER':
    case 'BREAKOUT':
      return 'call';

    case 'EXIT':
    case 'DUMP':
      return 'put';

    case 'RIP':
      return 'call';

    case 'REVERSAL':
      return factors.cvdClass === 'bearish' ? 'put' : 'call';

    default:
      return 'call';
  }
}
