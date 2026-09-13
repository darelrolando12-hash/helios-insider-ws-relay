/**
 * Forward log of the gamma regime — the one input that cannot be recovered
 * later.
 *
 * Everything else a backtest needs is re-fetchable from Massive whenever we
 * want it: minute bars, trades, quotes, option prices. The gamma flip is not.
 * Probed 2026-09-11: `/v3/snapshot/options` ignores `as_of` and returns
 * today's chain, there is no open-interest endpoint, and option daily
 * aggregates carry no OI — so the flip's sign on a past day is gone.
 *
 * That matters because regime is the one untested interaction left. A setup
 * that only works in negative gamma tests as zero unconditionally, which is
 * exactly what every direction test in relay/backtests has produced. The
 * only way to test it is to start recording now and wait.
 *
 * So: every REGIME_LOG_INTERVAL_MS during the regular session, one row per
 * ticker with the flip as the engine computed it. Setups are deliberately
 * NOT logged — they are pure functions of bars, so they can be recomputed
 * for any past day; storing them would just be a slower way to get the same
 * answer.
 *
 * Writes through supabaseObservations (not shadow-gated): nothing else
 * writes this table, so there is no duplicate-write risk, and a shadow-gated
 * log would accrue nothing — see lib/supabase.ts.
 *
 * Table DDL: backups/gex-regime-log-table.sql. Until it exists the write
 * fails and says so, once per process.
 */

import { supabaseObservations } from '../lib/supabase.ts';
import { toCentralTime } from '../lib/time.ts';
import type { MarketContext } from '../stores/marketStore.ts';

export const REGIME_LOG_INTERVAL_MS = 5 * 60_000;

export interface RegimeLogRow {
  observed_at:   string;
  session_date:  string;
  ticker:        string;
  spot:          number | null;
  flip_level:    number | null;
  flip_absent_reason: string | null;
  gex_regime:    string;
  call_wall:     number | null;
  put_wall:      number | null;
  /** Age of the chain snapshot the flip came from, in seconds. */
  snapshot_age_s: number | null;
}

/**
 * One row per ticker whose context the engine actually holds. Pure — the
 * caller supplies the contexts and the clock, so the shape is testable
 * without a database or a market.
 */
export function buildRegimeRows(contexts: readonly MarketContext[], nowUtcMs: number): RegimeLogRow[] {
  const ct = toCentralTime(nowUtcMs);
  const sessionDate = `${ct.year}-${String(ct.month).padStart(2, '0')}-${String(ct.day).padStart(2, '0')}`;
  return contexts.map((c) => ({
    observed_at:  new Date(nowUtcMs).toISOString(),
    session_date: sessionDate,
    ticker:       c.ticker,
    spot:         c.spotPrice ?? null,
    flip_level:   c.flipLevel,
    flip_absent_reason: c.flipAbsentReason ?? null,
    gex_regime:   c.gexRegime,
    call_wall:    c.walls?.callWall ?? null,
    put_wall:     c.walls?.putWall ?? null,
    snapshot_age_s: c.asOf > 0 ? Math.round((nowUtcMs - c.asOf) / 1000) : null,
  }));
}

let _missingTableReported = false;
let _rowsWritten = 0;

/** Rows written since boot — for the boot/daily summary log. */
export function regimeRowsWritten(): number { return _rowsWritten; }

/**
 * Rows waiting for their realised outcome. The regime is only interesting
 * against what price then did, and joining a 5-minute log back to minute bars
 * months later is fiddly enough to be worth avoiding — so each row's +30 and
 * +60 minute move is filled in from the next snapshots.
 *
 * Best-effort by design: a restart loses what is pending, and those rows keep
 * null forward returns. That is recoverable — bars can always be re-fetched —
 * unlike the flip itself, which is why the flip is written immediately rather
 * than held back until the outcome is known.
 */
interface Pending { id: number; ticker: string; spot: number; at: number; done30: boolean; done60: boolean }
const _pending: Pending[] = [];

export function pendingOutcomeCount(): number { return _pending.length; }

/** Fill in +30 / +60 minute moves for earlier rows, using this tick's spots. */
export async function settleOutcomes(rows: readonly RegimeLogRow[], nowUtcMs: number): Promise<void> {
  const spotOf = new Map(rows.filter((r) => r.spot !== null).map((r) => [r.ticker, r.spot as number]));
  for (const p of _pending) {
    const spot = spotOf.get(p.ticker);
    if (spot === undefined || !(p.spot > 0)) continue;
    const age = nowUtcMs - p.at;
    const patch: Record<string, number> = {};
    if (!p.done30 && age >= 30 * 60_000 && age < 45 * 60_000) { patch.fwd_30m_pct = (spot - p.spot) / p.spot; p.done30 = true; }
    if (!p.done60 && age >= 60 * 60_000 && age < 75 * 60_000) { patch.fwd_60m_pct = (spot - p.spot) / p.spot; p.done60 = true; }
    if (Object.keys(patch).length === 0) continue;
    const { error } = await supabaseObservations.from('gex_regime_log').update(patch).eq('id', p.id);
    if (error) console.error(`[regimeLog] outcome update failed — ${error.message}`);
  }
  // Drop anything past the 60-minute window, settled or not.
  for (let i = _pending.length - 1; i >= 0; i--) {
    if (nowUtcMs - _pending[i].at >= 75 * 60_000) _pending.splice(i, 1);
  }
}

export async function writeRegimeSnapshot(rows: readonly RegimeLogRow[], nowUtcMs: number = Date.now()): Promise<void> {
  if (rows.length === 0) return;
  const { data, error } = await supabaseObservations.from('gex_regime_log').insert(rows as RegimeLogRow[]).select('id, ticker, spot');
  if (!error && data) {
    for (const r of data as { id: number; ticker: string; spot: number | null }[]) {
      if (r.spot !== null && r.spot > 0) _pending.push({ id: r.id, ticker: r.ticker, spot: r.spot, at: nowUtcMs, done30: false, done60: false });
    }
    await settleOutcomes(rows, nowUtcMs);
  }
  if (error) {
    if (/does not exist/i.test(error.message)) {
      if (!_missingTableReported) {
        _missingTableReported = true;
        console.error(
          '[regimeLog] MIGRATION NOT RUN: create table public.gex_regime_log ' +
          '(backups/gex-regime-log-table.sql). The gamma flip is the only input that cannot be ' +
          'rebuilt from vendor history — every session without this table is a session that can never ' +
          'be tested for regime interaction.'
        );
      }
      return;
    }
    console.error(`[regimeLog] insert failed — ${error.message}`);
    return;
  }
  _rowsWritten += rows.length;
}
