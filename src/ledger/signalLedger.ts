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

// ── Per-bar duplicate suppression ──────────────────────────────────────────────
//
// Real, measured defect (2026-09-10). 50.2% of the last real session's
// signal rows were byte-identical duplicates: same ticker, same bar, same
// direction, same type, same price. 42.9% of (ticker, bar) buckets carried
// more than one row; the worst historical case was 398 identical call/EXIT
// rows at one price inside 7 seconds. Verified directly against the live
// table, not inferred.
//
// The mechanism is NOT a missing gate — confluenceEngine already refuses to
// re-emit while the score stays inside the same band:
//
//     if (_lastBand.get(ticker) === band) return;
//
// What that gate lacks is HYSTERESIS. It is a bare equality check, so a
// score oscillating by a point either side of a threshold re-triggers on
// every crossing, and _onStoreUpdate() re-scores every watched ticker on
// every store notification — with WS frames arriving at ~313/sec (measured
// during the Track B work). A score hovering at 55 therefore flips
// none↔EXIT repeatedly and emits each time, which is exactly why EXIT
// (the 55–64 band, and so the most-hovered boundary) accounted for 426 of
// 548 rows against just 3 ENTERs.
//
// Fixing the oscillation properly means adding hysteresis to the scoring
// gate, which changes real signal-generation behaviour and Brain's training
// input — that is a deliberate product decision, not a cleanup. This guard
// is the structural backstop underneath it: whatever the scorer does, the
// ledger records a given (ticker, bar, direction, type) at most once.
//
// Price is deliberately NOT part of the key. entry_price is the bar's close
// and is therefore constant within a bar — confirmed against the live table:
// across the last session, zero keys showed any price drift, so a
// byte-identical key and this key suppress exactly the same 275 rows.
// Leaving price out costs nothing today and stays correct if the scorer ever
// starts sampling an intra-bar price.
const _seenThisBar = new Set<string>();
/** Bounded so a long session cannot grow this without limit. Comfortably
 *  larger than (watched tickers × directions × types) for one bar. */
const _SEEN_CAP = 2_000;

function _rememberThisBar(key: string) {
  if (_seenThisBar.size >= _SEEN_CAP) {
    // Oldest-first eviction — Set preserves insertion order, and keys from
    // older bars are always the oldest entries.
    const oldest = _seenThisBar.values().next().value;
    if (oldest !== undefined) _seenThisBar.delete(oldest);
  }
  _seenThisBar.add(key);
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

  // One signal per (ticker, bar, direction, type). See _seenThisBar.
  const dedupeKey = `${signal.ticker}|${signal.firedAtCT}|${direction}|${signal.type}`;
  if (_seenThisBar.has(dedupeKey)) {
    console.log(
      `[signalLedger] Suppressed duplicate ${signal.ticker} ${signal.type} (${direction}) ` +
      `for bar ${signal.firedAtCT} — already recorded this bar.`
    );
    return;
  }
  _rememberThisBar(dedupeKey);

  // Conflict on the NATURAL key, not on `id`.
  //
  // `id` is `sig_<per-session counter>_<ticker>_<Date.now()>`, so two writers
  // can never produce the same id for the same signal — onConflict:'id' could
  // only ever catch a literal retry of one row. Measured 2026-09-10 after
  // Wegic's cleanup: 14 separate page sessions wrote signals within two hours
  // (every open tab, every device, every reload, Wegic's production build and
  // local dev all share this table), and 5 of 8 duplicated buckets came from
  // DIFFERENT sessions — exactly the case the in-memory guard above cannot
  // see. The unique index on (ticker, entry_tct, direction, signal_type)
  // makes a second copy impossible from any writer, including the relay
  // engine once it leaves shadow mode alongside the browser.
  //
  // CLAUDE.md's ignoreDuplicates warning (the 91%-unrepairable disclosures
  // bug) does not apply here, and deliberately so: that table needed later
  // rows to UPDATE earlier ones. A signal row is insert-once by design (see
  // this file's header — "never updated after insert"; outcomes live in
  // signal_outcomes), and the first write IS the genuine first emission.
  // DO NOTHING on the natural key is exactly the right semantics.
  //
  // REQUIRES the unique index from backups/signals-unique-constraint.sql to
  // exist first. Without it PostgREST rejects every write ("no unique or
  // exclusion constraint matching the ON CONFLICT specification") — that
  // failure is logged below, never thrown, so it would look like a quiet day.
  const { error: dbError } = await supabase
    .from('signals')
    .upsert(row, { onConflict: 'ticker,entry_tct,direction,signal_type', ignoreDuplicates: true });

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
