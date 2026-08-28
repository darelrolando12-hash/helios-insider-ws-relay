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
 *       EXIT             → inferred from live CVD classification
 *       DUMP             → put   (bearish-only signal type)
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
import { getDirectionState, computeTradeType } from '../state/directionState';
import type { TradeType }              from '../state/directionState';
import { vixBucket }                   from '../ledger/brainStore';
import type { VixBucket }              from '../ledger/brainStore';
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
  /**
   * Whether catalyst's input data was actually available at scoring time
   * ('real') or missing entirely ('absent') — carried over from the
   * originating Signal's `catalystDataQuality` (set by confluenceEngine at
   * the exact moment of scoring). Distinguishes a genuine "no catalyst
   * today" zero from "fundamentals hadn't loaded yet, so it couldn't even
   * be checked" — both previously looked identical as `catalystTags: null`.
   * Optional/undefined for signals that bypass scoreConfluence entirely
   * (DUMP/RIP), which never set this field on the Signal.
   */
  catalystDataQuality?: 'real' | 'absent';
  luld: {
    isHalted:   boolean;
    upperBand:  number | null;
    lowerBand:  number | null;
  };
  /** VIX bucket at signal-fire time, from the real I:VIX feed. */
  vixBucket:    VixBucket | null;
  /**
   * Trade type relative to session bias at signal-fire time.
   * NOTE: computed with priorDirection/priorResolvedAt = null/null — see
   * the TODO on computeTradeType() in directionState.ts. 'continuation' is
   * not reachable yet because prior-signal tracking isn't wired anywhere.
   */
  tradeType:    TradeType | null;
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

  // Carry over the data-quality flag confluenceEngine computed at the exact
  // scoring moment — more reliable than recomputing here, since a tiny gap
  // could exist between when the engine scored and when the ledger captures.
  factors.catalystDataQuality = signal.catalystDataQuality;

  // tradeType depends on direction, which is only known after _inferDirection
  // runs — compute it here and fold it into the factors blob before writing.
  // priorDirection/priorResolvedAt are null/null: prior-signal tracking is not
  // wired anywhere yet (see TODO on computeTradeType in directionState.ts).
  const sessionBias = getDirectionState(signal.ticker)?.sessionBias ?? 'neutral';
  factors.tradeType = computeTradeType(direction, sessionBias, null, null);

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
    .upsert(row, { onConflict: 'id', ignoreDuplicates: true });

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
  // Store a definitive boolean at write time — null (no halt data yet) is a
  // store-layer "unknown" state, but a persisted signal record should commit
  // to a real answer: no confirmed halt event means "not halted".
  const isHalted   = luldStore.isHalted(ticker) === true;
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

  // ── VIX Bucket ────────────────────────────────────────────────────────────
  const vixResult = barsStore.getResult('I:VIX');
  const vixClose = vixResult.status === 'ready' && vixResult.data.length > 0
    ? vixResult.data[vixResult.data.length - 1].close
    : null;
  const vixBucketVal = vixClose !== null ? vixBucket(vixClose) : null;

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
    vixBucket: vixBucketVal,
    // tradeType is filled in by _onSignal after direction is inferred.
    tradeType: null,
  };
}

// ── Direction inference ────────────────────────────────────────────────────────

/**
 * Infer the dominant direction (call / put) from signal type and live CVD.
 *
 * ENTER / BREAKOUT → call  (engine only fires these in bullish context)
 * EXIT              → inferred from live CVD classification (weakening
 *                      confluence on an existing position, not inherently
 *                      bearish — see REVERSAL below for the same pattern)
 * DUMP              → put   (genuinely bearish-only signal type)
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
      return factors.cvdClass === 'bearish' ? 'put' : 'call';

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
