/**
 * Layer 3 — outcomeResolver
 *
 * Background watcher that resolves pending signals to outcomes.
 *
 * For each signal with status 'pending', it looks up the bar nearest to each
 * target window using barsStore.findBarNear (±5 min tolerance), computes
 * direction-adjusted P&L, and writes a signal_outcomes row. The parent signal
 * is updated to 'resolved' only when all four windows are filled.
 *
 * Resolution schedule:
 *   - Runs every 60 seconds while the market is open.
 *   - Paused when market is closed (no point checking — bars aren't coming in).
 *
 * Target windows: 5 min, 15 min, 30 min, 60 min — resolved independently.
 * All four must be filled before the signal graduates from 'pending'.
 *
 * Expiry rule:
 *   A signal older than 24 hours with outstanding windows is marked 'expired'.
 *   No forced resolution — a bar that isn't there isn't there.
 *
 * DB writes:
 *   - signal_outcomes: upsert with explicit conflict on (signal_id, window_ms)
 *   - signals: update status to 'resolved' or 'expired' — the ONLY two updates
 *     ever made to a signal row after the initial insert.
 *
 * Scratch band: |pnlPct| <= 2.0% → result 'scratch'
 */

import { supabase }             from '../lib/supabase';
import * as barsStore           from '../stores/barsStore';
import type { SignalDirection } from './signalLedger';

// ── Constants ─────────────────────────────────────────────────────────────────

/** Resolution windows in ms, all checked independently. */
const TARGET_WINDOWS_MS = [
  5  * 60 * 1000,   //  5 min
  15 * 60 * 1000,   // 15 min
  30 * 60 * 1000,   // 30 min
  60 * 60 * 1000,   // 60 min
] as const;

/** A signal older than this without full resolution is marked 'expired'. */
const EXPIRY_THRESHOLD_MS = 24 * 60 * 60 * 1000;

/** P&L within this band (inclusive) is a scratch, not a win or loss. */
const SCRATCH_BAND_PCT = 2.0;

/** Interval between resolution passes. */
const POLL_INTERVAL_MS = 60 * 1000;

// ── Types ─────────────────────────────────────────────────────────────────────

type OutcomeResult = 'win' | 'loss' | 'scratch';

/** Shape of a row in the signal_outcomes table. */
interface OutcomeRow {
  signal_id:  string;
  ticker:     string;
  window_ms:  number;
  exit_price: number;
  exit_tct:   number;
  exit_utc:   number;
  pnl_pct:    number;
  result:     OutcomeResult;
}

/** Minimal shape we read from the signals table per resolution pass. */
interface PendingSignalRow {
  id:          string;
  ticker:      string;
  direction:   SignalDirection;
  entry_price: number;
  entry_utc:   number;
  created_at:  string;  // ISO 8601
}

// ── Internal state ─────────────────────────────────────────────────────────────

let _intervalId:   ReturnType<typeof setInterval> | null = null;
let _marketIsOpen  = false;

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Start the resolution loop.
 * Safe to call multiple times — idempotent.
 */
export function startResolver() {
  if (_intervalId !== null) return;

  _intervalId = setInterval(_runResolutionPass, POLL_INTERVAL_MS);
  console.log('[outcomeResolver] Started — polling every 60 s.');
}

/**
 * Inform the resolver whether the market is currently open.
 * The loop skips each pass when market is closed — no bars are coming in.
 * Logs on every actual flip so the fix can be confirmed live (was silent
 * before — setMarketOpen() had zero callers, so this line never printed).
 */
export function setMarketOpen(isOpen: boolean) {
  if (isOpen !== _marketIsOpen) {
    console.error(`[outcomeResolver] Market open flag flipped → ${isOpen}.`);
  }
  _marketIsOpen = isOpen;
}

// ── Resolution pass ────────────────────────────────────────────────────────────

async function _runResolutionPass(): Promise<void> {
  if (!_marketIsOpen) {
    console.log('[outcomeResolver] Pass skipped — market closed.');
    return;
  }

  console.error('[outcomeResolver] Pass running — market open, checking pending signals.');

  const nowMs = Date.now();

  // Fetch all pending signals from the DB
  const { data: pending, error: fetchError } = await supabase
    .from('signals')
    .select('id, ticker, direction, entry_price, entry_utc, created_at')
    .eq('status', 'pending');

  if (fetchError) {
    console.error('[outcomeResolver] Failed to fetch pending signals:', fetchError.message);
    return;
  }

  if (!pending || pending.length === 0) return;

  for (const signal of pending as PendingSignalRow[]) {
    await _resolveSignal(signal, nowMs);
  }
}

async function _resolveSignal(
  signal: PendingSignalRow,
  nowMs:  number,
): Promise<void> {
  const signalAgeMs = nowMs - signal.entry_utc;

  // Expiry check: signal is too old and still has unresolved windows
  if (signalAgeMs > EXPIRY_THRESHOLD_MS) {
    await _markExpired(signal.id);
    return;
  }

  const outcomeRows: OutcomeRow[] = [];

  for (const windowMs of TARGET_WINDOWS_MS) {
    const targetUtcMs = signal.entry_utc + windowMs;

    // Don't attempt to resolve a window that hasn't elapsed yet
    if (targetUtcMs > nowMs) continue;

    const bar = barsStore.findBarNear(signal.ticker, targetUtcMs);
    if (!bar) continue;  // bar not in memory yet — try again next pass

    const pnlPct = _computePnlPct(signal.entry_price, bar.close, signal.direction);
    const result  = _classifyOutcome(pnlPct);

    outcomeRows.push({
      signal_id:  signal.id,
      ticker:     signal.ticker,
      window_ms:  windowMs,
      exit_price: bar.close,
      exit_tct:   bar.tCT,
      exit_utc:   bar.tUtc,
      pnl_pct:    pnlPct,
      result,
    });
  }

  if (outcomeRows.length === 0) return;

  // Upsert outcomes — explicit conflict on (signal_id, window_ms)
  const { error: upsertError } = await supabase
    .from('signal_outcomes')
    .upsert(outcomeRows, { onConflict: 'signal_id,window_ms' });

  if (upsertError) {
    console.error(
      `[outcomeResolver] Upsert failed for signal ${signal.id}:`,
      upsertError.message,
    );
    return;
  }

  // Check if all four windows are now resolved — query the DB for the count
  await _checkAndCloseSignal(signal.id, signal.entry_utc, nowMs);
}

/**
 * Check how many outcome rows exist for this signal.
 * If all four windows that have elapsed are resolved, mark the signal 'resolved'.
 */
async function _checkAndCloseSignal(
  signalId:    string,
  entryUtcMs:  number,
  nowMs:       number,
): Promise<void> {
  // Count elapsed windows
  const elapsedWindows = TARGET_WINDOWS_MS.filter(
    w => entryUtcMs + w <= nowMs,
  ).length;

  // Count resolved outcome rows
  const { count, error: countError } = await supabase
    .from('signal_outcomes')
    .select('*', { count: 'exact', head: true })
    .eq('signal_id', signalId);

  if (countError) {
    console.error(
      `[outcomeResolver] Count failed for signal ${signalId}:`,
      countError.message,
    );
    return;
  }

  if ((count ?? 0) >= elapsedWindows && elapsedWindows === TARGET_WINDOWS_MS.length) {
    const { error: updateError } = await supabase
      .from('signals')
      .update({ status: 'resolved' })
      .eq('id', signalId);

    if (updateError) {
      console.error(
        `[outcomeResolver] Failed to mark signal ${signalId} resolved:`,
        updateError.message,
      );
    } else {
      console.log(`[outcomeResolver] Signal ${signalId} fully resolved.`);
    }
  }
}

async function _markExpired(signalId: string): Promise<void> {
  const { error } = await supabase
    .from('signals')
    .update({ status: 'expired' })
    .eq('id', signalId);

  if (error) {
    console.error(
      `[outcomeResolver] Failed to mark signal ${signalId} expired:`,
      error.message,
    );
  } else {
    console.warn(`[outcomeResolver] Signal ${signalId} expired — < 24 h, windows incomplete.`);
  }
}

// ── Pure helpers — exported for unit tests ────────────────────────────────────

/**
 * Direction-adjusted P&L as a percentage.
 *
 * call: positive when exit > entry (price went up)
 * put:  positive when exit < entry (price went down)
 */
export function computePnlPct(
  entryPrice: number,
  exitPrice:  number,
  direction:  SignalDirection,
): number {
  const raw = ((exitPrice - entryPrice) / entryPrice) * 100;
  return direction === 'put' ? -raw : raw;
}

/**
 * Classify an outcome from direction-adjusted P&L.
 * Scratch band: |pnlPct| <= SCRATCH_BAND_PCT (2%).
 */
export function classifyOutcome(pnlPct: number): OutcomeResult {
  if (Math.abs(pnlPct) <= SCRATCH_BAND_PCT) return 'scratch';
  return pnlPct > 0 ? 'win' : 'loss';
}

// ── Module-private aliases (avoid name collision with exports) ─────────────────

const _computePnlPct    = computePnlPct;
const _classifyOutcome  = classifyOutcome;
