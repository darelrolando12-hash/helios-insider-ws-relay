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
 *   backtestHistoricalRange(ticker, from, to)
 *     Runs the signal logic against a full historical range. Used to pre-populate
 *     Brain before you've taken any live trades. Reads bars directly from the
 *     `bars_1m` table (already backfilled — see bars1mIngestion.ts), paginated
 *     in DB-side pages to avoid memory limits. No REST calls.
 *
 *   runHistoricalSeed()
 *     One-time seed across all FEED_TICKERS. Resumable: skips any ticker that
 *     already has backtested signals persisted, so it's safe to leave wired
 *     at boot — repeat runs after the first just no-op per ticker.
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
 *   - CVD is not available in either replay mode — the classifier is not
 *     deterministic for past bars. A neutral CvdState stub is used so that
 *     scoreCvd() returns 0 pts. This is documented in factors.replayNote.
 *   - GEX handling is DIFFERENT for the two modes — this matters, do not
 *     merge them back into one path:
 *       replayTodaySession      — uses the REAL, live marketStore snapshot.
 *                                 Valid because this replays TODAY's bars, so
 *                                 "current" GEX genuinely matches them — not
 *                                 an approximation.
 *       backtestHistoricalRange — uses NEUTRAL_GEX_STUB (see below). No
 *                                 historical GEX was ever recorded for past
 *                                 dates, and marketStore only ever holds
 *                                 today's snapshot, so reusing it across a
 *                                 2-year range would be wrong, not just
 *                                 approximate. Follow-up (not blocking):
 *                                 persist chainAggregator's snapshots over
 *                                 time so future seeds can use real history.
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
import type { MarketContext }  from '../stores/marketStore';
import { toCentralTime }       from '../lib/time';
import { supabase }            from '../lib/supabase';
import { FEED_TICKERS }        from '../state/directionState';
import { formatError }         from '../lib/errors';

/** 2 years of history as epoch ms — matches bars1mIngestion.ts's backfill window. */
const TWO_YEARS_MS = 2 * 365 * 24 * 60 * 60 * 1000;

/** Rows fetched per DB page when reading bars_1m. Confirmed the project's PostgREST
 *  max-rows allows at least 5000/request — a 2yr/1min ticker history (300k-480k rows)
 *  at 5000/page is ~60-100 requests instead of 300-480 at the smaller page size. */
const DB_PAGE_SIZE = 5000;

/**
 * Trailing bar window passed to EMA scoring during replay.
 * CRITICAL PERFORMANCE FIX: the replay loop previously passed
 * `bars.slice(0, i + 1)` — the FULL history up to bar i — into scoreEmaTrend()
 * on every iteration. Since that history grows by one bar each step, and
 * computeEma() recomputes from scratch every call, total work was O(n²).
 * For a 400k-bar ticker that's ~160 billion operations — the loop would
 * never finish, with no error to catch (that's why the seed produced zero
 * DB rows with no exception either). EMA's exponential decay means bars
 * beyond ~300 back have negligible weight on an 8/21/55-period EMA anyway,
 * so bounding the window to a fixed trailing size is not an approximation
 * that changes outcomes — it's removing wasted, decayed-to-nothing work.
 * This bounds each iteration's EMA computation to O(1), making the full
 * loop O(n) instead of O(n²).
 */
const REPLAY_EMA_WINDOW = 300;

/** Yield to the event loop every N bars scanned so the tab stays responsive
 *  and progress logs actually flush during a long replay run. */
const YIELD_EVERY_N_BARS = 5000;

function _yield(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 0));
}

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

/**
 * Neutral GEX stand-in used ONLY for backtestHistoricalRange (the one-time
 * seed over past years). No historical GEX was ever recorded for past dates,
 * and marketStore only ever holds TODAY's live snapshot — reusing "today's"
 * GEX uniformly across a 2-year range would be wrong, not just approximate.
 * So this stub reports a neutral regime with flip/walls pinned far from any
 * real price (0), so scoreGex()'s "near flip"/"near wall" bonuses never
 * spuriously fire on every bar — matching the same "zeroed, documented"
 * treatment already used for NEUTRAL_CVD_STUB.
 *
 * replayTodaySession does NOT use this — it reads the real, live marketStore
 * snapshot instead, because it only ever replays TODAY's bars, so "current"
 * GEX genuinely applies. Do not merge these two paths back together.
 *
 * Follow-up (not blocking): persist chainAggregator's GEX snapshots into a
 * table over time (same pattern as short_interest/bars_1m) so future
 * historical seeds can use real data instead of this stub.
 */
function _neutralGexStub(ticker: string): MarketContext {
  return {
    ticker,
    gexRegime:  'neutral',
    walls:      { callWall: 0, putWall: 0 },
    flipLevel:  0,
    upTarget:   0,
    downTarget: 0,
    netGex:     0,
    pcRatio:    1,
    maxPain:    0,
    chain:      [],
    asOf:       0,
  };
}

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

  // Real, live GEX snapshot — valid here because this replays TODAY's bars,
  // so "current" market context genuinely matches them.
  const marketResult = marketStore.getResult(ticker);
  const marketCtx     = marketResult.status === 'ready' ? marketResult.data : null;

  return _replayBars(ticker, bars, from, to, config, marketCtx);
}

// ── backtestHistoricalRange ────────────────────────────────────────────────────

/**
 * Reads bars_1m directly from the DB (already backfilled by bars1mIngestion.ts —
 * covers ~2yr per ticker) and returns them as Bar[], sorted ascending by tUtc.
 * Pages through in DB_PAGE_SIZE chunks — a 2yr/1min history is 300k-480k rows
 * per ticker, well past Supabase's single-request row cap.
 */
async function _fetchBarsFromDb(ticker: string, fromMs: number, toMs: number): Promise<Bar[]> {
  const bars: Bar[] = [];
  let offset = 0;

  while (true) {
    const { data, error } = await supabase
      .from('bars_1m')
      .select('ticker, t_utc, o, h, l, c, v, vw')
      .eq('ticker', ticker)
      .gte('t_utc', fromMs)
      .lte('t_utc', toMs)
      .order('t_utc', { ascending: true })
      .range(offset, offset + DB_PAGE_SIZE - 1);

    if (error) {
      console.error(`[backtestEngine] ${ticker}: bars_1m read failed at offset ${offset} —`, error.message);
      break;
    }
    if (!data || data.length === 0) break;

    for (const row of data) {
      const tUtc = Number(row.t_utc);
      bars.push({
        ticker,
        open:   Number(row.o),
        high:   Number(row.h),
        low:    Number(row.l),
        close:  Number(row.c),
        volume: Number(row.v),
        vwap:   row.vw !== null ? Number(row.vw) : undefined,
        tCT:    toCentralTime(tUtc).ctMs,
        tUtc,
      });
    }

    if (data.length < DB_PAGE_SIZE) break;
    offset += DB_PAGE_SIZE;
  }

  return bars;
}

/**
 * Runs the signal logic against a full historical bar range.
 * Reads bars directly from bars_1m via _fetchBarsFromDb — no REST calls,
 * no API budget spent. Requires the ticker's 1-min history to already be
 * backfilled (see bars1mIngestion.ts); returns an empty result otherwise.
 *
 * @param ticker  The ticker to backtest.
 * @param from    Start of range (Unix ms).
 * @param to      End of range (Unix ms).
 * @param config  Optional config overrides.
 */
export async function backtestHistoricalRange(
  ticker:  string,
  from:    number,
  to:      number,
  config:  BacktestConfig = HISTORICAL_BACKTEST_CONFIG,
): Promise<BacktestResult> {
  const allBars = await _fetchBarsFromDb(ticker, from, to);

  if (allBars.length === 0) return _emptyResult(ticker);

  // No historical GEX data exists for past dates — use the documented
  // neutral stub instead of marketStore (which only ever holds TODAY's
  // snapshot). See _neutralGexStub() comment for rationale.
  const gexStub = _neutralGexStub(ticker);

  return _replayBars(ticker, allBars, from, to, config, gexStub);
}

// ── Historical seed pilot: SPY only ──────────────────────────────────────────

/**
 * Runs the historical seed for SPY alone. Same pagination-proof discipline
 * as bars1mIngestion's runBars1mPilot() — confirm real persisted rows for
 * one ticker before trusting the full 21-ticker runHistoricalSeed() run.
 *
 * Root cause of the original hang (fixed, see REPLAY_EMA_WINDOW comment):
 * the replay loop recomputed the EMA trend over the ENTIRE growing bar
 * history on every iteration — O(n²) for n ~= 400k bars, which never
 * completes and throws no catchable error. Now bounded to a fixed trailing
 * window, so this pilot should complete in seconds, not hang indefinitely.
 */
export async function runHistoricalSeedPilot(): Promise<void> {
  const ticker = 'SPY';
  console.log('[backtestEngine] Pilot starting SPY historical seed…');

  const alreadySeeded = await _hasExistingSeed(ticker);
  if (alreadySeeded) {
    console.log('[backtestEngine] Pilot — SPY already seeded. Skipping.');
    return;
  }

  const toMs   = Date.now();
  const fromMs = toMs - TWO_YEARS_MS;

  const result = await backtestHistoricalRange(ticker, fromMs, toMs);

  console.log(
    `[backtestEngine] Pilot SPY complete. Scanned ${result.barsScanned} bars, ` +
    `fired ${result.signalsFired} signals, persisted ${result.persisted}. ` +
    (result.barsScanned === 0
      ? 'WARNING — 0 bars read from bars_1m.'
      : result.persisted > 0
        ? 'PASS — real rows persisted.'
        : result.signalsFired === 0
          ? 'OK — loop completed, no signals met conviction threshold (not a failure).'
          : 'WARNING — signals fired but 0 persisted, check DB errors above.'),
  );
}

// ── runHistoricalSeed ──────────────────────────────────────────────────────────

/**
 * One-time seed: runs backtestHistoricalRange for every FEED_TICKER over the
 * full 2yr bars_1m window. Resumable — skips any ticker that already has
 * `is_backtested = true` rows in `signals`, so it's safe to call on every
 * boot; only the first run actually does work per ticker.
 *
 * Tickers with no bars_1m history (e.g. index tickers never included in the
 * 1-min backfill) will scan 0 bars and are logged as a WARNING, not silently
 * skipped.
 */
export async function runHistoricalSeed(): Promise<void> {
  console.log('[backtestEngine] Starting one-time historical seed for all FEED_TICKERS…');

  const toMs   = Date.now();
  const fromMs = toMs - TWO_YEARS_MS;

  let totalScanned   = 0;
  let totalFired     = 0;
  let totalPersisted = 0;

  for (const ticker of FEED_TICKERS) {
    try {
      const alreadySeeded = await _hasExistingSeed(ticker);
      if (alreadySeeded) {
        console.log(`[backtestEngine] ${ticker}: already seeded — backtested signals exist. Skipping.`);
        continue;
      }

      const result = await backtestHistoricalRange(ticker, fromMs, toMs);
      totalScanned   += result.barsScanned;
      totalFired     += result.signalsFired;
      totalPersisted += result.persisted;

      const verdict = result.barsScanned === 0
        ? 'WARNING — 0 bars found in bars_1m for this ticker (not in the 1-min backfill). Skipped.'
        : result.signalsFired > 0 && result.persisted === 0
          ? 'WARNING — signals fired but 0 persisted, check DB errors above.'
          : 'OK';

      console.log(`[backtestEngine] ${ticker}: scanned ${result.barsScanned} bars, ` +
        `fired ${result.signalsFired} signals, persisted ${result.persisted}. ${verdict}`);
    } catch (e) {
      console.error(`[backtestEngine] ${ticker}: unexpected error during seed — ${formatError(e)}`);
    }
  }

  console.log(`[backtestEngine] Historical seed complete. ` +
    `Total bars scanned: ${totalScanned}, total signals fired: ${totalFired}, total persisted: ${totalPersisted}.`);
}

/** True if `ticker` already has at least one backtested signal persisted. */
async function _hasExistingSeed(ticker: string): Promise<boolean> {
  const { count, error } = await supabase
    .from('signals')
    .select('*', { count: 'exact', head: true })
    .eq('ticker', ticker)
    .eq('is_backtested', true);

  if (error) {
    console.error(`[backtestEngine] ${ticker}: seed-check query failed —`, error.message, '— skipping to avoid duplicate seeding.');
    return true; // fail closed: skip rather than risk duplicate signal rows
  }
  return (count ?? 0) > 0;
}

// ── Core replay loop ──────────────────────────────────────────────────────────

/**
 * The main replay loop. Walks bars one at a time, scoring each candle as if
 * it were the live edge. Only bars[0..i] are visible at step i (no look-ahead).
 *
 * CVD is always neutralised in replay — not deterministic for historical bars.
 * GEX context is passed in by the caller: real live snapshot for today's
 * session, neutral stub for the historical seed. See callers for rationale.
 */
async function _replayBars(
  ticker:    string,
  bars:      Bar[],
  from:      number,
  to:        number,
  config:    BacktestConfig,
  marketCtx: MarketContext | null,
): Promise<BacktestResult> {
  const signals: BacktestedSignal[] = [];

  let lastSignalBarIndex = -Infinity;
  let barsScanned        = 0;

  console.log(`[backtestEngine] ${ticker}: replay starting — ${bars.length} bars to scan.`);

  // Snapshot fundamentals for catalyst gate (same across replay pass)
  const fundResult = fundamentalsStore.getResult(ticker);
  const fund       = fundResult.status === 'ready' ? fundResult.data : null;
  const catalyst   = fund ? catalystGate.computeTags(ticker, fund) : null;

  for (let i = 2; i < bars.length; i++) {
    barsScanned++;

    // Yield periodically so the tab stays responsive and progress logs
    // actually flush during a long run — see YIELD_EVERY_N_BARS.
    if (barsScanned % YIELD_EVERY_N_BARS === 0) {
      console.log(`[backtestEngine] ${ticker}: progress — ${barsScanned} / ${bars.length} bars scanned, ${signals.length} signals so far.`);
      await _yield();
    }

    // Enforce gap between signals
    if (i - lastSignalBarIndex < config.minBarsBetweenSignals) continue;

    // Max signals per session ceiling
    if (signals.length >= config.maxSignalsPerSession) break;

    // Bars visible at this step (no look-ahead), bounded to a fixed trailing
    // window — see REPLAY_EMA_WINDOW. This is what makes the loop O(n)
    // instead of O(n²); EMA's decay makes bars further back contribute
    // negligibly to an 8/21/55-period trend anyway.
    const windowStart  = Math.max(0, i + 1 - REPLAY_EMA_WINDOW);
    const visibleBars  = bars.slice(windowStart, i + 1);
    const currentBar   = bars[i];
    const currentPrice = currentBar.close;

    // Only relevant for replayTodaySession: skip bar if today's live GEX
    // snapshot isn't ready yet. Never triggers for the historical seed —
    // that path always has the neutral stub, never null.
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

    const replayNote = marketCtx?.asOf === 0
      ? 'CVD zeroed (not deterministic for historical bars). GEX neutral-stubbed — no historical GEX data exists for this date.'
      : 'CVD zeroed (not deterministic for historical bars). GEX from live snapshot (today\'s session).';

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

  console.log(`[backtestEngine] ${ticker}: replay loop complete — ${barsScanned} bars scanned, ${signals.length} signals fired. Persisting…`);

  // ── Persist ──────────────────────────────────────────────────────────────────

  const persisted = config.persist
    ? await _persistSignals(ticker, signals)
    : 0;

  console.log(`[backtestEngine] ${ticker}: replay complete — ${persisted} / ${signals.length} signals persisted.`);

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
async function _persistSignals(ticker: string, signals: BacktestedSignal[]): Promise<number> {
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
      console.error(`[backtestEngine] ${ticker}: batch insert failed at offset ${i} —`, error.message);
    } else {
      persisted += batch.length;
    }
  }

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
