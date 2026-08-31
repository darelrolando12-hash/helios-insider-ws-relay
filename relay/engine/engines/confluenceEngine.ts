/**
 * Layer 2 — confluenceEngine
 *
 * Signal-scoring brain. Reads all Layer 1 stores and the dumpRipDetector
 * event stream. Scores each ticker 0–100 and emits typed Signal events.
 *
 * Input gates (all must pass before scoring runs):
 *   1. barsStore.isDataReady(ticker)  — need real price context
 *   2. luldStore.isHalted(ticker) === true  — block only on a confirmed active
 *      halt; null (no halt data yet) is treated as normal trading
 *   3. Market must be open (MarketStatus.market === 'open')
 *
 * Scoring components (weights sum to 100):
 *   CVD strength         25 pts  — netDelta direction and magnitude
 *   GEX regime alignment  20 pts  — price position relative to flip/walls
 *   EMA trend stack       20 pts  — EMA8 > EMA21 > EMA55 alignment
 *   Catalyst boost        20 pts  — insiderBuy + materialEvent modifiers
 *   DUMP/RIP urgency      15 pts  — dumpRipDetector event input
 *
 * Signal thresholds:
 *   score >= 75  → ENTER or BREAKOUT (direction-dependent)
 *   score >= 65  → REVERSAL
 *   score >= 55  → EXIT
 *   DUMP/RIP fire at any score when dumpRipDetector emits directly
 *
 * Emits Signal objects to registered listeners. Does not write to any store.
 * The signal-outcome ledger (Layer 3) subscribes to these events.
 */

import * as barsStore        from '../stores/barsStore.ts';
import * as marketStore      from '../stores/marketStore.ts';
import * as cvdStore         from '../stores/cvdStore.ts';
import * as luldStore        from '../stores/luldStore.ts';
import * as fundamentalsStore from '../stores/fundamentalsStore.ts';
import * as directionState   from '../state/directionState.ts';
import * as catalystGate     from './catalystGate.ts';
import * as dumpRipDetector  from './dumpRipDetector.ts';
import type { Signal, SignalType, Bar, MarketStatusValue } from '../stores/types.ts';
import type { CvdState }     from '../stores/cvdStore.ts';
import type { MarketContext } from '../stores/marketStore.ts';
import type { CatalystTags } from './catalystGate.ts';
import type { DumpRipEvent } from './dumpRipDetector.ts';

// ── Constants ─────────────────────────────────────────────────────────────────

const ENTER_THRESHOLD     = 75;
const REVERSAL_THRESHOLD  = 65;
const EXIT_THRESHOLD      = 55;

// EMA periods
const EMA_FAST   = 8;
const EMA_MED    = 21;
const EMA_SLOW   = 55;

// ── Internal state ────────────────────────────────────────────────────────────

const _listeners       = new Set<(signal: Signal) => void>();
const _watchedTickers  = new Set<string>();
let   _marketStatus: MarketStatusValue = 'closed';
let   _initialised = false;
let   _signalCounter = 0;

// Edge-triggered emission: only emit a new signal when a ticker genuinely
// transitions into a score band it wasn't already in. Prevents re-firing a
// fresh signal on every store update while a ticker sits near/inside the
// same band (e.g. wobbling at score 76-78 would otherwise spam ENTER on
// every tick). A ticker must fully exit a band (drop to 'none' or move to a
// different band) before it can re-fire that band again.
type ScoreBand = 'none' | 'EXIT' | 'REVERSAL' | 'ENTER_BREAKOUT';
const _lastBand = new Map<string, ScoreBand>();

// ── SCORE-DIAG throttling ────────────────────────────────────────────────────
// Off by default — unconditional per-tick logging saturated the main thread
// (~410 console.log calls/sec observed live) and was a real contributor to
// heartbeat-based browser disconnects. Toggle on ad-hoc from the browser
// console with `window.__HELIOS_DIAG = true` when a live capture is needed;
// no rebuild required. When on, only score changes are logged, throttled to
// once per ticker per 10s — except threshold crossings (55/65/75), which
// always log immediately since those are the events that actually matter.
const DIAG_THROTTLE_MS = 10_000;
const DIAG_THRESHOLDS  = [EXIT_THRESHOLD, REVERSAL_THRESHOLD, ENTER_THRESHOLD];

const _lastDiagScore = new Map<string, number>();
const _lastDiagLogAt = new Map<string, number>();

function _isDiagEnabled(): boolean {
  if (typeof window !== 'undefined' && (window as unknown as Record<string, unknown>).__HELIOS_DIAG === true) {
    return true;
  }
  // Server-side fallback (Layer 1 porting target) — `window` won't exist in
  // Node, so without this the diagnostic would be permanently off post-migration.
  if (typeof process !== 'undefined' && process.env?.HELIOS_DIAG === 'true') {
    return true;
  }
  return false;
}

function _crossedThreshold(prevScore: number, nextScore: number): boolean {
  return DIAG_THRESHOLDS.some(
    (t) => (prevScore < t && nextScore >= t) || (prevScore >= t && nextScore < t)
  );
}

export function scoreBand(score: number): ScoreBand {
  if (score >= ENTER_THRESHOLD)    return 'ENTER_BREAKOUT';
  if (score >= REVERSAL_THRESHOLD) return 'REVERSAL';
  if (score >= EXIT_THRESHOLD)     return 'EXIT';
  return 'none';
}

// ── Public API ────────────────────────────────────────────────────────────────

export function init() {
  if (_initialised) return;
  _initialised = true;

  // Listen for DUMP/RIP events — these bypass score thresholds
  dumpRipDetector.onDumpRip(_onDumpRip);

  // Re-score on any store update
  barsStore.subscribe(_onStoreUpdate);
  cvdStore.subscribe(_onStoreUpdate);
  marketStore.subscribe(_onStoreUpdate);

  console.log('[confluenceEngine] Initialised.');
}

export function setMarketStatus(status: MarketStatusValue) {
  if (status !== _marketStatus) {
    console.error(`[confluenceEngine] Market status flipped → ${status}.`);
  }
  _marketStatus = status;
}

export function watchTicker(ticker: string) {
  _watchedTickers.add(ticker);
  dumpRipDetector.watchTicker(ticker);
}

export function unwatchTicker(ticker: string) {
  _watchedTickers.delete(ticker);
  _lastBand.delete(ticker);
  dumpRipDetector.unwatchTicker(ticker);
}

export function onSignal(listener: (signal: Signal) => void): () => void {
  _listeners.add(listener);
  return () => _listeners.delete(listener);
}

// ── Score + emit ──────────────────────────────────────────────────────────────

function _onStoreUpdate() {
  if (_marketStatus !== 'open') return;
  for (const ticker of _watchedTickers) {
    _scoreTicker(ticker);
    // Recompute session bias + play direction at the end of every scoring
    // pass, per the directionState contract (see state/directionState.ts).
    directionState.updateDirectionState(ticker);
  }
}

function _scoreTicker(ticker: string) {
  // Gate 1: bars ready — must have price data to score
  if (!barsStore.isDataReady(ticker)) return;

  // Gate 2: not halted. null = no halt/resume event ever received for this
  // ticker, which is the normal state on a quiet trading day (per
  // luldStore's own contract: isCurrentlyHalted === false is normal).
  // Only a confirmed active halt (=== true) should block scoring.
  const halted = luldStore.isHalted(ticker);
  if (halted === true) return;

  const barsResult   = barsStore.getResult(ticker);
  const cvdResult    = cvdStore.getResult(ticker);
  const marketResult = marketStore.getResult(ticker);
  const fundResult   = fundamentalsStore.getResult(ticker);

  if (barsResult.status   !== 'ready') return;
  // CVD is required — it is the aggressor-classified order-flow read.
  // A signal without order-flow confirmation is a fundamentally different claim.
  if (cvdResult.status    !== 'ready') return;
  if (marketResult.status !== 'ready') return;

  const bars    = barsResult.data;
  const cvd     = cvdResult.data;
  const ctx     = marketResult.data;
  const fund    = fundResult.status === 'ready' ? fundResult.data : null;
  const catalyst = fund ? catalystGate.computeTags(ticker, fund) : null;

  const currentPrice = bars[bars.length - 1].close;

  const { score, sources, catalystDataQuality } = scoreConfluence(bars, cvd, ctx, catalyst, currentPrice);

  // SCORE-DIAG — real per-component score breakdown, gated + throttled.
  // See _isDiagEnabled / DIAG_THROTTLE_MS above for why.
  if (_isDiagEnabled()) {
    const prevScore   = _lastDiagScore.get(ticker) ?? -1;
    const lastLogAt   = _lastDiagLogAt.get(ticker) ?? 0;
    const scoreChanged = prevScore !== score;
    const dueForLog     = Date.now() - lastLogAt >= DIAG_THROTTLE_MS;
    const crossedGate    = _crossedThreshold(prevScore, score);

    if (crossedGate || (scoreChanged && dueForLog)) {
      console.log(
        `[SCORE-DIAG] ${ticker} total=${score} ` +
        `cvd=${scoreCvd(cvd).points}(call=${cvd.callPct.toFixed(1)},put=${cvd.putPct.toFixed(1)},cls=${cvd.classification}) ` +
        `gex=${scoreGex(ctx, currentPrice).points}(regime=${ctx.gexRegime},flipDist=${(Math.abs(currentPrice - ctx.flipLevel) / currentPrice * 100).toFixed(3)}%) ` +
        `ema=${scoreEmaTrend(bars).points} ` +
        `catalyst=${scoreCatalyst(catalyst).points}(quality=${scoreCatalyst(catalyst).dataQuality}) ` +
        `sources=[${sources.join(',')}]`
      );
      _lastDiagScore.set(ticker, score);
      _lastDiagLogAt.set(ticker, Date.now());
    }
  }

  const signalType = resolveSignalType(score, cvd, ctx, currentPrice);
  if (!signalType) {
    _lastBand.set(ticker, 'none');
    return;
  }

  // Edge-triggered gate: only emit if this is a genuine transition into the
  // current band, not a repeat evaluation while still inside it.
  const band = scoreBand(score);
  if (_lastBand.get(ticker) === band) return;
  _lastBand.set(ticker, band);

  _emit({
    id:           `sig_${++_signalCounter}_${ticker}_${Date.now()}`,
    ticker,
    type:         signalType,
    triggerPrice: currentPrice,
    confidence:   score,
    firedAt:      Date.now(),
    firedAtCT:    barsResult.asOf,
    sources,
    catalystDataQuality,
    // Tagged so paper results can be judged per generator rather than pooled
    // with DUMP/RIP, which fires on an entirely different mechanism.
    sourceEngine: 'scanner',
  });
}

function _onDumpRip(event: DumpRipEvent) {
  // DUMP/RIP signals fire regardless of score — they are direct LULD signals
  const bars = barsStore.getResult(event.ticker);
  const currentPrice = bars.status === 'ready'
    ? bars.data[bars.data.length - 1].close
    : event.triggerPrice;

  _emit({
    id:           `sig_${++_signalCounter}_${event.ticker}_${Date.now()}`,
    ticker:       event.ticker,
    type:         event.signalType,
    triggerPrice: currentPrice,
    confidence:   100, // halt-based signals are high-conviction by definition
    firedAt:      event.detectedAt,
    firedAtCT:    event.detectedAt,
    sources:      ['dumpRipDetector', `luld:${event.luldEvent.type}`],
    // Bypasses scoreConfluence entirely — these outcomes describe a different
    // mechanism and must not be pooled with scored signals.
    sourceEngine: 'dumpRip',
  });
}

function _emit(signal: Signal) {
  console.log(
    `[confluenceEngine] ${signal.ticker} ${signal.type} @ ${signal.triggerPrice} ` +
    `(confidence: ${signal.confidence})`
  );
  for (const fn of _listeners) {
    try { fn(signal); }
    catch (e) { console.error('[confluenceEngine] Listener error:', e); }
  }
}

// ── Pure scoring — exported for unit tests ────────────────────────────────────

export interface ScoreResult {
  score:   number;    // 0–100
  sources: string[];  // which components contributed

  /**
   * Data-quality flag for the catalyst component — makes a genuine "no
   * catalyst today" zero distinguishable from "fundamentals data wasn't
   * loaded yet, so catalyst couldn't even be checked". Without this, both
   * cases previously looked identical in the score (0 points, absent from
   * `sources`). Same "silent zero" class as the halt-gate and LULD-routing
   * bugs — this makes the absence visible instead of indistinguishable.
   *
   * Other factors (cvd/gex/ema) don't currently have a real "absent" case —
   * confluenceEngine's own input gates (barsStore.isDataReady, etc.) already
   * block scoring entirely if their inputs aren't ready. Catalyst is the
   * first factor to adopt this shape because it's the first with a
   * documented real gap; extend the same `<factor>DataQuality` field to any
   * other factor if a similar gap is found for it.
   */
  catalystDataQuality: 'real' | 'absent';
}

/**
 * Score a ticker's confluence across all signal inputs.
 * Pure function — reads only the values passed in, no store access.
 * cvd is required — order-flow confirmation is not optional.
 */
export function scoreConfluence(
  bars:         Bar[],
  cvd:          CvdState,
  ctx:          MarketContext,
  catalyst:     CatalystTags | null,
  currentPrice: number,
): ScoreResult {
  let score  = 0;
  const sources: string[] = [];

  // ── CVD component (25 pts) ────────────────────────────────────────────────
  const cvdScore = scoreCvd(cvd);
  score += cvdScore.points;
  if (cvdScore.points > 0) sources.push('cvd');

  // ── GEX regime alignment (20 pts) ─────────────────────────────────────────
  const gexScore = scoreGex(ctx, currentPrice);
  score += gexScore.points;
  if (gexScore.points > 0) sources.push('gex');

  // ── EMA trend stack (20 pts) ──────────────────────────────────────────────
  const emaScore = scoreEmaTrend(bars);
  score += emaScore.points;
  if (emaScore.points > 0) sources.push('ema');

  // ── Catalyst boost (20 pts) ───────────────────────────────────────────────
  const catalystScore = scoreCatalyst(catalyst);
  score += catalystScore.points;
  if (catalystScore.points > 0) sources.push('catalyst');

  // Cap at 100
  return {
    score: Math.min(100, Math.round(score)),
    sources,
    catalystDataQuality: catalystScore.dataQuality ?? 'real',
  };
}

interface ComponentScore {
  points: number;
  /**
   * 'real'   — the input data needed to score this component was actually
   *            available (even if the score itself came out 0).
   * 'absent' — the input data was missing entirely, so this component
   *            couldn't be evaluated at all. A 0 here is NOT "no signal" —
   *            it's "couldn't check".
   * Defaults to 'real' for components whose inputs are already gated
   * upstream (cvd/gex/ema only run once bars/cvd/ctx are confirmed ready).
   */
  dataQuality?: 'real' | 'absent';
}

export function scoreCvd(cvd: CvdState): ComponentScore {
  // Full 25 pts for strong directional conviction (>70% one side)
  // 12 pts for moderate conviction (>55%)
  // 0 pts for neutral
  if (cvd.callPct > 70 || cvd.putPct > 70) return { points: 25 };
  if (cvd.callPct > 55 || cvd.putPct > 55) return { points: 12 };
  return { points: 0 };
}

export function scoreGex(ctx: MarketContext, currentPrice: number): ComponentScore {
  // In positive GEX regime and price is between walls (pinned range) → bullish context
  // In negative GEX regime (trending) → directional setup
  // At or near flip level (within 0.5%) → highest alignment
  const flipDist = Math.abs(currentPrice - ctx.flipLevel) / currentPrice;
  if (flipDist <= 0.005) return { points: 20 }; // at the flip — maximum GEX alignment

  if (ctx.gexRegime === 'negative') return { points: 15 }; // trending regime
  if (ctx.gexRegime === 'positive') return { points: 10 }; // mean-reverting regime
  return { points: 5 }; // neutral regime
}

export function scoreEmaTrend(bars: Bar[]): ComponentScore {
  if (bars.length < EMA_SLOW) return { points: 0 };

  const closes = bars.map(b => b.close);
  const ema8   = computeEma(closes, EMA_FAST);
  const ema21  = computeEma(closes, EMA_MED);
  const ema55  = computeEma(closes, EMA_SLOW);

  // Full bull stack: EMA8 > EMA21 > EMA55
  if (ema8 > ema21 && ema21 > ema55) return { points: 20 };
  // Full bear stack: EMA8 < EMA21 < EMA55
  if (ema8 < ema21 && ema21 < ema55) return { points: 20 };
  // Partial alignment (two of three in order)
  if (ema8 > ema21 || ema21 > ema55) return { points: 10 };
  return { points: 0 };
}

/**
 * Score the catalyst component. Returns dataQuality: 'absent' when `tags`
 * is null — meaning fundamentals data wasn't loaded for this ticker at
 * scoring time, so catalyst genuinely could not be checked (distinct from
 * a real check that found no active catalyst).
 */
export function scoreCatalyst(tags: CatalystTags | null): ComponentScore {
  if (!tags) return { points: 0, dataQuality: 'absent' };

  let points = 0;
  if (tags.insiderBuy)     points += 12;
  if (tags.materialEvent)  points += 8;
  if (tags.earningsPending) points += 5;
  // insiderSell is a negative modifier — not added here, used by resolveSignalType
  return { points: Math.min(20, points), dataQuality: 'real' };
}

/**
 * Resolve the signal type from score and directional context.
 * Returns null if the score is below the lowest threshold.
 * CVD is required — direction is derived from order flow, not GEX alone.
 */
export function resolveSignalType(
  score:        number,
  cvd:          CvdState,
  ctx:          MarketContext,
  currentPrice: number,
): SignalType | null {
  if (score < EXIT_THRESHOLD) return null;

  const isBullish =
    cvd.classification === 'bullish' && (ctx.gexRegime === 'negative' || currentPrice > ctx.flipLevel);

  if (score >= ENTER_THRESHOLD) {
    // BREAKOUT if price is within 0.3% of a wall (breaking through structure)
    const nearWall =
      Math.abs(currentPrice - ctx.walls.callWall) / currentPrice <= 0.003 ||
      Math.abs(currentPrice - ctx.walls.putWall)  / currentPrice <= 0.003;
    if (nearWall) return 'BREAKOUT';
    return isBullish ? 'ENTER' : 'EXIT';
  }

  if (score >= REVERSAL_THRESHOLD) return 'REVERSAL';
  if (score >= EXIT_THRESHOLD)     return 'EXIT';
  return null;
}

// ── EMA utility — exported for unit tests ────────────────────────────────────

/**
 * Exponential moving average of the last N values in `data`.
 * Uses the standard smoothing factor: k = 2 / (period + 1).
 */
export function computeEma(data: number[], period: number): number {
  if (data.length < period) return data[data.length - 1] ?? 0;
  const k   = 2 / (period + 1);
  let   ema = data.slice(0, period).reduce((s, v) => s + v, 0) / period;
  for (let i = period; i < data.length; i++) {
    ema = data[i] * k + ema * (1 - k);
  }
  return ema;
}
