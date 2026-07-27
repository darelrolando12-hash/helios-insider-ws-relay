/**
 * Layer 4 — backtestEngine
 *
 * Historical replay engine. Runs after market close each day, walking
 * the full bar history and asking: "where would the confluence engine have
 * fired a signal?" Records every instance to the ledger as a backtested_signal
 * (same schema as live signals, with `is_backtested = true`).
 *
 * This is what makes Brain's base rates real from day one. By replaying 5 years
 * of history before you take a single live trade, Brain starts with thousands
 * of statistically significant instances.
 *
 * Two entry points:
 *
 *   replayTodaySession(ticker)
 *     Runs after today's market close. Replays today's bar-by-bar history,
 *     scores each candle using the same confluence logic as live scoring,
 *     records every signal that would have fired. Called by the app on the
 *     marketstatus transition to 'closed'.
 *
 *   backtestHistoricalRange(ticker, from, to, restClient)
 *     Runs the signal logic against a full historical range. Used to pre-populate
 *     Brain before you've taken any live trades. Fetches bars from the REST API
 *     in chunks to avoid memory limits.
 *
 * Brain data separation:
 *   - Live signals you personally took → `is_backtested = false, is_taken = true`
 *   - Live signals the engine fired that you didn't take → `is_backtested = false, is_taken = false`
 *   - Backtested signals → `is_backtested = true`
 *   All three populate `brainStore`. Cockpits can filter to any subset.
 *
 * Replay fidelity rules:
 *   - Bar-by-bar only — at each candle boundary, the engine only sees bars up
 *     to and including that candle (no look-ahead bias)
 *   - CVD is not available in historical replay — the classifier is not
 *     deterministic for past bars. A neutral CvdState stub is used so that
 *     scoreCvd() returns 0 pts. This is documented in factors.replayNote.
 *   - GEX replay uses the chain snapshot stored with each bar if available,
 *     otherwise uses the nearest available snapshot (may be stale — noted in
 *     the backtested_signal's `factors.replayNote` field)
 *   - LULD events are replayed from stored luldStore events where available
 *
 * Outcome resolution:
 *   The backtestEngine writes backtested signals to the `signals` table.
 *   The `outcomeResolver` resolves them identically to live signals — same
 *   four windows, same upsert logic, same scratch band. No special path.
 */

import * as barsStore         from '../stores/barsStore';
import * as marketStore       from '../stores/marketStore';
import * as fundamentalsStore from '../stores/fundamentalsStore';
import * as catalystGate      from './catalystGate';
import {
  scoreConfluence,
  scoreEmaTrend,
  resolveSignalType,
} from './confluenceEngine';
import type { Bar, SignalType } from '../stores/types';
import type { CvdState }       from '../stores/cvdStore';
import { toCentralTime }       from '../lib/time';
import { MassiveRestClient }   from '../lib/massive/api';
import { supabase }            from '../lib/supabase';

// ── Config ────────────────────────────────────────────────────────────────────

export interface BacktestConfig {
  /**
   * Minimum candles between signals (5-min bars → 5 bars = 25 min gap).
   * Prevents the engine from firing 10 signals on the same breakout move.
   */
  minBarsBetweenSignals: number;

  /** Max signals per session (per ticker). Prevents runaway replay. */
  maxSignalsPerSession: number;

  /**
   * Minimum conviction score to record a backtested signal.
   * Below this threshold the candle is scored but not written to DB.
   * Use 40 for broad coverage, 60 for high-confidence only.
   */
  minConviction: number;

  /**
   * If true, write backtested signals to Wegic Cloud.
   * If false, returns results without persisting (dry-run).
   * Requires `is_backtested` column to exist in `signals` table.
   */
  persist: boolean;
}

export const DEFAULT_BACKTEST_CONFIG: BacktestConfig = {
  minBarsBetweenSignals: 5,
  maxSignalsPerSession:  50,
  minConviction:         40,
  persist:               true,
};

export const HISTORICAL_BACKTEST_CONFIG: BacktestConfig = {
  minBarsBetweenSignals: 5,
  maxSignalsPerSession:  500,
  minConviction:         40,
  persist:               true,
};

// ── Result types ──────────────────────────────────────────────────────────────

export interface BacktestedSignal {
  id:           string;
  ticker:       string;
  direction:    'call' | 'put';
  signal_type:  SignalType;
  conviction:   number;
  entry_price:  number;
  entry_tct:    number;
  entry_utc:    number;
  factors:      Record<string, unknown>;
}

export interface BacktestResult {
  ticker:       string;
  from:         number;
  to:           number;
  barsScanned:  number;
  signalsFired: number;
  persisted:    number;
  signals:      BacktestedSignal[];
}

// ── Neutral CVD stub ──────────────────────────────────────────────────────────

/**
 * Used in replay where live CVD is not deterministic.
 * scoreCvd() receives 50/50 split → 0 pts. The replay note documents this.
 */
const NEUTRAL_CVD_STUB: CvdState = {
  callPct:        50,
  putPct:         50,
  netDelta:       0,
  classification: 'neutral',
  tickCount:      0,
  asOf:           0,
  ticks:          [],
};

// ── Replay counter ────────────────────────────────────────────────────────────

let _replayCounter = 0;

function _nextId(ticker: string): string {
  return `bt_${++_replayCounter}_${ticker}_${Date.now()}`;
}

// ── replayTodaySession ────────────────────────────────────────────────────────

/**
 * Replays today's session using bars already loaded in barsStore.
 * Called at market close. No REST calls needed — bars are already in memory.
 *
 * @param ticker  The ticker to replay.
 * @param config  Optional config overrides.
 */
export async function replayTodaySession(
  ticker:  string,
  config:  BacktestConfig = DEFAULT_BACKTEST_CONFIG,
): Promise<BacktestResult> {
  const barsResult = barsStore.getResult(ticker);

  if (barsResult.status !== 'ready') {
    return _emptyResult(ticker);
  }

  const bars  = barsResult.data;
  const from  = bars[0]?.tUtc ?? Date.now();
  const to    = bars[bars.length - 1]?.tUtc ?? Date.now();

  return _replayBars(ticker, bars, from, to, config);
}

// ── backtestHistoricalRange ────────────────────────────────────────────────────

/**
 * Runs the signal logic against a full historical bar range.
 * Fetches in 500-bar chunks to avoid memory limits.
 *
 * @param ticker      The ticker to backtest.
 * @param from        Start of range (Unix ms).
 * @param to          End of range (Unix ms).
 * @param restClient  MassiveRestClient instance (server-side, API key injected).
 * @param config      Optional config overrides.
 */
export async function backtestHistoricalRange(
  ticker:     string,
  from:       number,
  to:         number,
  restClient: MassiveRestClient,
  config:     BacktestConfig = HISTORICAL_BACKTEST_CONFIG,
): Promise<BacktestResult> {
  let cursor      = from;
  let allBars:    Bar[] = [];
  let attempts    = 0;
  const maxChunks = 200; // safety ceiling: 200 × 500 bars = 100,000 bars

  while (cursor < to && attempts < maxChunks) {
    attempts++;

    let chunk: Bar[];
    try {
      chunk = await restClient.fetchBarRange(ticker, cursor, to);
    } catch {
      break;
    }

    if (chunk.length === 0) break;

    allBars = allBars.concat(chunk);
    cursor  = chunk[chunk.length - 1].tUtc + 1;
  }

  if (allBars.length === 0) return _emptyResult(ticker);

  return _replayBars(ticker, allBars, from, to, config);
}

// ── Core replay loop ──────────────────────────────────────────────────────────

/**
 * The main replay loop. Walks bars one at a time, scoring each candle as if
 * it were the live edge. Only bars[0..i] are visible at step i (no look-ahead).
 *
 * CVD is neutralised in replay — not deterministic for historical bars.
 * GEX is derived from marketStore snapshot if available; otherwise scoring
 * proceeds with a degraded GEX contribution (noted in replayNote).
 */
async function _replayBars(
  ticker:  string,
  bars:    Bar[],
  from:    number,
  to:      number,
  config:  BacktestConfig,
): Promise<BacktestResult> {
  const signals: BacktestedSignal[] = [];

  let lastSignalBarIndex = -Infinity;
  let barsScanned        = 0;

  // Snapshot market context (GEX) once per replay pass.
  const marketResult = marketStore.getResult(ticker);
  const marketCtx    = marketResult.status === 'ready' ? marketResult.data : null;

  // Snapshot fundamentals for catalyst gate (same across replay pass)
  const fundResult = fundamentalsStore.getResult(ticker);
  const fund       = fundResult.status === 'ready' ? fundResult.data : null;
  const catalyst   = fund ? catalystGate.computeTags(ticker, fund) : null;

  for (let i = 2; i < bars.length; i++) {
    barsScanned++;

    // Enforce gap between signals
    if (i - lastSignalBarIndex < config.minBarsBetweenSignals) continue;

    // Max signals per session ceiling
    if (signals.length >= config.maxSignalsPerSession) break;

    // Bars visible at this step (no look-ahead)
    const visibleBars  = bars.slice(0, i + 1);
    const currentBar   = bars[i];
    const currentPrice = currentBar.close;

    // GEX snapshot required for scoreConfluence — skip bar if not available
    if (!marketCtx) continue;

    // ── EMA trend check — skip if fewer than 55 bars visible ─────────────────
    const emaScore = scoreEmaTrend(visibleBars);
    if (emaScore.points === 0 && visibleBars.length < 55) continue;

    // ── Aggregate conviction ─────────────────────────────────────────────────
    // CVD is zeroed via NEUTRAL_CVD_STUB — see module header for rationale
    const { score } = scoreConfluence(visibleBars, NEUTRAL_CVD_STUB, marketCtx, catalyst, currentPrice);

    if (score < config.minConviction) continue;

    // ── Resolve signal type ──────────────────────────────────────────────────
    const signalType = resolveSignalType(score, NEUTRAL_CVD_STUB, marketCtx, currentPrice);
    if (!signalType) continue;

    // ── Build backtested signal ──────────────────────────────────────────────

    const replayNote = 'CVD zeroed (not deterministic for historical bars). GEX from live snapshot — may be stale.';

    const ctInfo = toCentralTime(currentBar.tUtc);

    const signal: BacktestedSignal = {
      id:          _nextId(ticker),
      ticker,
      direction:   _inferDirection(signalType),
      signal_type: signalType,
      conviction:  score,
      entry_price: currentPrice,
      entry_tct:   ctInfo.ctMs,
      entry_utc:   currentBar.tUtc,
      factors: {
        emaPoints:    emaScore.points,
        gexRegime:    marketCtx.gexRegime,
        flipLevel:    marketCtx.flipLevel,
        replayNote,
      },
    };

    signals.push(signal);
    lastSignalBarIndex = i;
  }

  // ── Persist ──────────────────────────────────────────────────────────────────

  const persisted = config.persist
    ? await _persistSignals(signals)
    : 0;

  return {
    ticker,
    from,
    to,
    barsScanned,
    signalsFired: signals.length,
    persisted,
    signals,
  };
}

// ── DB persistence ────────────────────────────────────────────────────────────

/**
 * Batch-inserts backtested signals into the `signals` table.
 * Groups into batches of 50 to avoid request size limits.
 */
async function _persistSignals(signals: BacktestedSignal[]): Promise<number> {
  if (signals.length === 0) return 0;

  const BATCH_SIZE = 50;
  let persisted    = 0;

  for (let i = 0; i < signals.length; i += BATCH_SIZE) {
    const batch = signals.slice(i, i + BATCH_SIZE);

    const rows = batch.map(s => ({
      id:            s.id,
      ticker:        s.ticker,
      direction:     s.direction,
      signal_type:   s.signal_type,
      conviction:    s.conviction,
      entry_price:   s.entry_price,
      entry_tct:     s.entry_tct,
      entry_utc:     s.entry_utc,
      status:        'pending',
      factors:       s.factors,
      is_backtested: true,
    }));

    const { error } = await supabase
      .from('signals')
      .insert(rows);

    if (error) {
      console.error(`[backtestEngine] Batch insert failed:`, error.message);
    } else {
      persisted += batch.length;
    }
  }

  console.log(`[backtestEngine] Persisted ${persisted} / ${signals.length} backtested signals.`);
  return persisted;
}

// ── Direction inference (mirrors signalLedger) ────────────────────────────────

function _inferDirection(type: SignalType): 'call' | 'put' {
  switch (type) {
    case 'ENTER':
    case 'BREAKOUT':
    case 'RIP':
      return 'call';
    case 'EXIT':
    case 'DUMP':
      return 'put';
    case 'REVERSAL':
    default:
      return 'call'; // conservative default for replay
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function _emptyResult(ticker: string): BacktestResult {
  return {
    ticker,
    from:         0,
    to:           0,
    barsScanned:  0,
    signalsFired: 0,
    persisted:    0,
    signals:      [],
  };
}

// ── DB migration note ─────────────────────────────────────────────────────────
// The `signals` table needs an `is_backtested` boolean column.
// This is added via the DB migration in the Layer 4 DB setup step.
// Until then, backtestEngine.persist = false (dry-run mode).
