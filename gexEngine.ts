/**
 * Layer 2 — confluenceEngine
 *
 * Signal-scoring brain. Reads all Layer 1 stores and the dumpRipDetector
 * event stream. Scores each ticker 0–100 and emits typed Signal events.
 *
 * Input gates (all must pass before scoring runs):
 *   1. barsStore.isDataReady(ticker)  — need real price context
 *   2. luldStore.isHalted(ticker) !== true  — no signals during active halts
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

import * as barsStore        from '../stores/barsStore';
import * as marketStore      from '../stores/marketStore';
import * as cvdStore         from '../stores/cvdStore';
import * as luldStore        from '../stores/luldStore';
import * as fundamentalsStore from '../stores/fundamentalsStore';
import * as catalystGate     from './catalystGate';
import * as dumpRipDetector  from './dumpRipDetector';
import type { Signal, SignalType, Bar, MarketStatusValue } from '../stores/types';
import type { CvdState }     from '../stores/cvdStore';
import type { MarketContext } from '../stores/marketStore';
import type { CatalystTags } from './catalystGate';
import type { DumpRipEvent } from './dumpRipDetector';

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
  _marketStatus = status;
}

export function watchTicker(ticker: string) {
  _watchedTickers.add(ticker);
  dumpRipDetector.watchTicker(ticker);
}

export function unwatchTicker(ticker: string) {
  _watchedTickers.delete(ticker);
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
  }
}

function _scoreTicker(ticker: string) {
  // Gate 1: bars ready
  if (!barsStore.isDataReady(ticker)) return;

  // Gate 2: not halted (null = unknown = don't fire)
  const halted = luldStore.isHalted(ticker);
  if (halted === true || halted === null) return;

  const barsResult   = barsStore.getResult(ticker);
  const cvdResult    = cvdStore.getResult(ticker);
  const marketResult = marketStore.getResult(ticker);
  const fundResult   = fundamentalsStore.getResult(ticker);

  if (barsResult.status   !== 'ready') return;
  if (cvdResult.status    !== 'ready') return;
  if (marketResult.status !== 'ready') return;

  const bars    = barsResult.data;
  const cvd     = cvdResult.data;
  const ctx     = marketResult.data;
  const fund    = fundResult.status === 'ready' ? fundResult.data : null;
  const catalyst = fund ? catalystGate.computeTags(ticker, fund) : null;

  const currentPrice = bars[bars.length - 1].close;

  const { score, sources } = scoreConfluence(bars, cvd, ctx, catalyst, currentPrice);

  const signalType = resolveSignalType(score, cvd, ctx, currentPrice);
  if (!signalType) return;

  _emit({
    id:           `sig_${++_signalCounter}_${ticker}_${Date.now()}`,
    ticker,
    type:         signalType,
    triggerPrice: currentPrice,
    confidence:   score,
    firedAt:      Date.now(),
    firedAtCT:    barsResult.asOf,
    sources,
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
}

/**
 * Score a ticker's confluence across all signal inputs.
 * Pure function — reads only the values passed in, no store access.
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
  if (catalyst) {
    const catalystScore = scoreCatalyst(catalyst);
    score += catalystScore.points;
    if (catalystScore.points > 0) sources.push('catalyst');
  }

  // Cap at 100
  return { score: Math.min(100, Math.round(score)), sources };
}

interface ComponentScore { points: number }

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

export function scoreCatalyst(tags: CatalystTags): ComponentScore {
  let points = 0;
  if (tags.insiderBuy)     points += 12;
  if (tags.materialEvent)  points += 8;
  if (tags.earningsPending) points += 5;
  // insiderSell is a negative modifier — not added here, used by resolveSignalType
  return { points: Math.min(20, points) };
}

/**
 * Resolve the signal type from score and directional context.
 * Returns null if the score is below the lowest threshold.
 */
export function resolveSignalType(
  score:        number,
  cvd:          CvdState,
  ctx:          MarketContext,
  currentPrice: number,
): SignalType | null {
  if (score < EXIT_THRESHOLD) return null;

  const isBullish = cvd.classification === 'bullish' &&
    (ctx.gexRegime === 'negative' || currentPrice > ctx.flipLevel);

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
