/**
 * Layer 3 — brainStore
 *
 * Read-only aggregate store. Groups resolved signal_outcomes by setup
 * fingerprint and computes base rates for each setup.
 *
 * Setup fingerprint = ticker + direction + gexRegime + vixBucket + timeOfDayBucket
 *   vixBucket:       <15 | 15–20 | 20–25 | 25+
 *   timeOfDayBucket: open (9:30–10:30 CT) | midday (10:30–14:00 CT) | close (14:00–16:00 CT)
 *
 * Statistical validity floor:
 *   n < 15 resolved signals → setup exists in state but isStatisticallyValid = false.
 *   Cockpits must check isStatisticallyValid before rendering base-rate numbers.
 *
 * Refresh:
 *   refreshBrainStore() fetches all resolved outcomes from the DB, groups them,
 *   computes base rates, and notifies subscribers. Cockpits call this on mount
 *   and on a 5-minute interval during market hours.
 *
 * This store never writes to the DB.
 */

import { supabase }              from '../lib/supabase.ts';
import { toCentralTime }         from '../lib/time.ts';
import type { Result }           from '../stores/types.ts';
import { ready, loading, error } from '../stores/types.ts';
import type { SignalDirection }  from './signalLedger.ts';

// ── Constants ─────────────────────────────────────────────────────────────────

/** Minimum resolved signals before a setup is considered statistically valid. */
const VALIDITY_FLOOR = 15;

/** Resolution windows — must match outcomeResolver's TARGET_WINDOWS_MS. */
const WINDOW_LABELS: Record<number, string> = {
  [5  * 60 * 1000]: '5m',
  [15 * 60 * 1000]: '15m',
  [30 * 60 * 1000]: '30m',
  [60 * 60 * 1000]: '60m',
};

// ── Exported types ─────────────────────────────────────────────────────────────

export type VixBucket      = '<15' | '15-20' | '20-25' | '25+';
export type TimeOfDayBucket = 'open' | 'midday' | 'close';

export interface SetupFingerprint {
  ticker:       string;
  direction:    SignalDirection;
  gexRegime:    string;   // 'positive' | 'negative' | 'neutral'
  vixBucket:    VixBucket;
  timeOfDay:    TimeOfDayBucket;
  tradeType:    'with_session' | 'counter_session' | 'continuation';
}

/**
 * Aggregated base rate for a setup fingerprint.
 * Only meaningful when isStatisticallyValid is true.
 */
export interface BaseRate {
  fingerprint:          SetupFingerprint;
  n:                    number;    // total resolved signals for this setup
  winRate:              number;    // 0–1
  avgPnl:               number;    // average pnlPct across all windows + signals
  isStatisticallyValid: boolean;  // n >= VALIDITY_FLOOR
  /**
   * The window (e.g. '5m', '15m', '30m', '60m') that produces the highest
   * win rate for this setup fingerprint.
   */
  bestWindow:           string;
  /**
   * Per-window win rates — useful for cockpits that show a sparkline or table.
   * Keys match WINDOW_LABELS values ('5m', '15m', '30m', '60m').
   */
  windowWinRates:       Record<string, number>;
}

// ── Internal types (DB row shapes) ────────────────────────────────────────────

interface ResolvedSignalRow {
  id:          string;
  ticker:      string;
  direction:   SignalDirection;
  entry_tct:   number;    // CT epoch ms — used for timeOfDayBucket
  factors:     {
    gexRegime: string | null;
    vixBucket: VixBucket | null;
    tradeType: 'with_session' | 'counter_session' | 'continuation' | null;
  };
}

interface OutcomeRow {
  signal_id: string;
  window_ms: number;
  pnl_pct:   number;
  result:    'win' | 'loss' | 'scratch';
}

// ── Internal state ─────────────────────────────────────────────────────────────

const _state     = new Map<string, BaseRate>();
const _listeners = new Set<() => void>();
let   _result:   Result<Map<string, BaseRate>> = loading();
let   _refreshing = false;

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Get a base rate for a setup fingerprint.
 * Returns Result<BaseRate> — 'loading' until first refresh, 'error' on DB fail.
 */
export function getBaseRate(fingerprint: SetupFingerprint): Result<BaseRate> {
  if (_result.status !== 'ready') return _result as Result<BaseRate>;

  const key  = _fingerprintKey(fingerprint);
  const rate = _state.get(key);

  if (!rate) {
    return error(`No data for setup: ${key}`);
  }
  return ready(rate);
}

/**
 * Get all computed base rates.
 * Cockpits use this to render setup leaderboards.
 */
export function getAllBaseRates(): Result<BaseRate[]> {
  if (_result.status !== 'ready') return _result as Result<BaseRate[]>;
  return ready(Array.from(_state.values()));
}

export function subscribe(listener: () => void): () => void {
  _listeners.add(listener);
  return () => _listeners.delete(listener);
}

/**
 * Fetch all resolved outcomes from the DB and recompute base rates.
 * Cockpits call this on mount and on a refresh interval.
 */
export async function refreshBrainStore(): Promise<void> {
  if (_refreshing) return;
  _refreshing = true;

  try {
    // Fetch all resolved signals
    const { data: signals, error: sigErr } = await supabase
      .from('signals')
      .select('id, ticker, direction, entry_tct, factors')
      .eq('status', 'resolved');

    if (sigErr) throw new Error(sigErr.message);
    if (!signals || signals.length === 0) {
      _result = ready(new Map());
      _notify();
      return;
    }

    // Fetch all outcome rows for resolved signals
    const signalIds = (signals as ResolvedSignalRow[]).map(s => s.id);

    const { data: outcomes, error: outErr } = await supabase
      .from('signal_outcomes')
      .select('signal_id, window_ms, pnl_pct, result')
      .in('signal_id', signalIds);

    if (outErr) throw new Error(outErr.message);

    // Build a lookup: signalId → outcomes[]
    const outcomesBySignal = new Map<string, OutcomeRow[]>();
    for (const outcome of (outcomes ?? []) as OutcomeRow[]) {
      const list = outcomesBySignal.get(outcome.signal_id) ?? [];
      list.push(outcome);
      outcomesBySignal.set(outcome.signal_id, list);
    }

    // Group signals by fingerprint key
    const groups = new Map<string, {
      fingerprint: SetupFingerprint;
      outcomes:    OutcomeRow[];
    }>();

    for (const sig of signals as ResolvedSignalRow[]) {
      const fp  = _buildFingerprint(sig);
      const key = _fingerprintKey(fp);

      const group = groups.get(key) ?? { fingerprint: fp, outcomes: [] };
      const sigOutcomes = outcomesBySignal.get(sig.id) ?? [];
      group.outcomes.push(...sigOutcomes);
      groups.set(key, group);
    }

    // Compute base rates for each group
    _state.clear();

    for (const [key, group] of groups) {
      const rate = _computeBaseRate(group.fingerprint, group.outcomes);
      _state.set(key, rate);
    }

    _result = ready(_state);
    console.log(`[brainStore] Refreshed — ${_state.size} setup fingerprints.`);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error('[brainStore] Refresh failed:', message);
    _result = error(message);
  } finally {
    _refreshing = false;
    _notify();
  }
}

// ── BaseRate computation ───────────────────────────────────────────────────────

function _computeBaseRate(
  fingerprint: SetupFingerprint,
  outcomes:    OutcomeRow[],
): BaseRate {
  // Count unique signals (n = number of resolved signals, not total outcome rows)
  // Each signal contributes up to 4 outcome rows (one per window).
  // n is unique signal count; win rate is computed per-window then averaged.
  const n = outcomes.length > 0
    ? new Set(outcomes.map(o => o.signal_id)).size
    : 0;

  const isStatisticallyValid = n >= VALIDITY_FLOOR;

  // Per-window aggregation
  const windowGroups = new Map<number, OutcomeRow[]>();
  for (const windowMs of Object.keys(WINDOW_LABELS).map(Number)) {
    windowGroups.set(windowMs, outcomes.filter(o => o.window_ms === windowMs));
  }

  const windowWinRates: Record<string, number> = {};
  let bestWindowMs  = 5 * 60 * 1000;
  let bestWinRate   = -Infinity;

  for (const [windowMs, rows] of windowGroups) {
    if (rows.length === 0) continue;
    const wins   = rows.filter(r => r.result === 'win').length;
    const winRate = wins / rows.length;
    const label  = WINDOW_LABELS[windowMs];
    windowWinRates[label] = winRate;

    if (winRate > bestWinRate) {
      bestWinRate  = winRate;
      bestWindowMs = windowMs;
    }
  }

  // Overall win rate (all windows pooled)
  const totalWins = outcomes.filter(o => o.result === 'win').length;
  const winRate   = outcomes.length > 0 ? totalWins / outcomes.length : 0;

  // Average P&L
  const avgPnl = outcomes.length > 0
    ? outcomes.reduce((sum, o) => sum + o.pnl_pct, 0) / outcomes.length
    : 0;

  return {
    fingerprint,
    n,
    winRate,
    avgPnl,
    isStatisticallyValid,
    bestWindow:      WINDOW_LABELS[bestWindowMs] ?? '5m',
    windowWinRates,
  };
}

// ── Fingerprint helpers ────────────────────────────────────────────────────────

function _buildFingerprint(sig: ResolvedSignalRow): SetupFingerprint {
  return {
    ticker:    sig.ticker,
    direction: sig.direction,
    gexRegime: sig.factors?.gexRegime ?? 'neutral',
    // Real value written at signal-fire time. Falls back to '<15' only for
    // historical rows written before this fix existed (factors.vixBucket is null).
    vixBucket: sig.factors?.vixBucket ?? '<15',
    timeOfDay: _timeOfDayBucket(sig.entry_tct),
    // Real value written at signal-fire time. Falls back to 'with_session' only
    // for historical rows written before this fix existed (factors.tradeType is null).
    tradeType: sig.factors?.tradeType ?? 'with_session',
  };
}

/**
 * Serialise a fingerprint to a stable string key.
 * Order is intentional — changing this invalidates in-memory grouping.
 */
function _fingerprintKey(fp: SetupFingerprint): string {
  return `${fp.ticker}|${fp.direction}|${fp.gexRegime}|${fp.vixBucket}|${fp.timeOfDay}|${fp.tradeType}`;
}

// ── Time-of-day bucketing ──────────────────────────────────────────────────────

/**
 * Bucket a signal's timestamp into a trading session period.
 *
 * WHAT THIS ACTUALLY DOES (corrected 2026-08-31 — the previous comment
 * described boundaries the code does not implement):
 *
 *   open:   anything BEFORE 10:30 CT — there is NO lower bound
 *   midday: 10:30 CT to before 14:00 CT
 *   close:  14:00 CT onward — there is NO upper bound
 *
 * The old comment claimed "open: 9:30–10:30 CT" and "close: 14:00–16:00 CT".
 * Both were wrong twice over: the real regular session is 8:30–15:00 CT
 * (9:30–16:00 ET; see forcedClose.ts's DEFAULT_FORCED_CLOSE for the verified
 * source), and the code has never had either outer bound anyway.
 *
 * KNOWN GAP, deliberately not fixed here: because 'open' has no lower bound,
 * a genuinely pre-market timestamp would silently bucket as 'open'. That is
 * currently unreachable for live signals — confluenceEngine gates on real
 * market status — but replayTodaySession reads barsStore, which is not
 * gated by market hours, so a backtest path could reach it. Adding a naive
 * `>= 8:30 CT` lower bound would be WRONG: 3,426 of 29,294 real rows in the
 * signals table carry entry_tct = 08:29 CT, one minute before the open,
 * because entry_tct is the BAR START timestamp and the opening bar is
 * labelled 08:29. Those are legitimate opening signals, not pre-market ones.
 * Any lower bound must account for that convention.
 *
 * PARAMETER NAMING, verified against real data: despite the name `ctMs` and
 * the column name `entry_tct`, the value passed here is a REAL UTC epoch
 * (barsStore's `asOf`, which is the bar's `tUtc`). Confirmed by querying live
 * rows: entry_tct and entry_utc differ by 0.0 hours. That makes the
 * toCentralTime() call below correct — it expects UTC — but the names are
 * actively misleading and should not be trusted over this note.
 */
export function timeOfDayBucket(ctMs: number): TimeOfDayBucket {
  const { hour, minute } = toCentralTime(ctMs);
  const minutesSinceMidnight = hour * 60 + minute;

  // 10:30 = 630, 14:00 = 840.
  if (minutesSinceMidnight < 630)  return 'open';
  if (minutesSinceMidnight < 840)  return 'midday';
  return 'close';
}

const _timeOfDayBucket = timeOfDayBucket;

// ── VIX bucketing — exported for future VIX feed integration ─────────────────

/**
 * Bucket a VIX value into a regime label.
 * Caller supplies the VIX level; brainStore does not fetch VIX independently.
 */
export function vixBucket(vix: number): VixBucket {
  if (vix < 15)  return '<15';
  if (vix < 20)  return '15-20';
  if (vix < 25)  return '20-25';
  return '25+';
}

// ── Notify ────────────────────────────────────────────────────────────────────

function _notify() {
  for (const fn of _listeners) fn();
}
