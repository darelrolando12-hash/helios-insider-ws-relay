/**
 * Forward record of the signals the engine WOULD have written.
 *
 * Step 1 of "let it run forward". The engine runs in shadow: it scores, it
 * decides, and every write is intercepted and logged instead of executed
 * (lib/supabase.ts). Those decisions are real and timestamped, and once they
 * scroll out of Railway's log buffer they are gone — Railway keeps the last
 * few hundred lines, and this app logs ingestion constantly.
 *
 * So this writes them to a table of its own, through the observation-only
 * client. No duplicate-write risk: nothing else writes `engine_shadow_signals`
 * — not the browser, not signalLedger (which owns `signals` and stays
 * shadow-gated). This is a measurement record, never a user-visible signal
 * and never replayed into the ledger.
 *
 * Why it matters: every backtest in relay/backtests can be wrong about its
 * own assumptions. A forward record of live decisions, with the inputs that
 * produced them, is the one test that cannot be — and it costs nothing to
 * start accruing now, months before anyone needs it.
 *
 * Step 2 — the shadow→live cutover, where the engine owns the real `signals`
 * table and browser writes are disabled in the same step — is a separate,
 * coordinated decision (CLAUDE.md, SHADOW MODE). This does not anticipate it.
 *
 * Table DDL: backups/engine-shadow-signals-table.sql.
 */

import { supabaseObservations } from '../lib/supabase.ts';
import { toCentralTime } from '../lib/time.ts';
import type { Signal } from '../stores/types.ts';

export interface ShadowSignalRow {
  observed_at:   string;
  session_date:  string;
  ticker:        string;
  signal_type:   string;
  /** The confluence score, 0–100. */
  confidence:    number;
  trigger_price: number;
  /** UTC ms the signal fired, so it joins straight to minute bars later. */
  fired_at:      number;
  sources:       string[];
  /** 'absent' means the catalyst inputs were missing, not that there was no catalyst. */
  catalyst_data_quality: string | null;
  signal_id:     string;
}

/** Pure: one row from one signal, so the shape is testable without a database. */
export function buildShadowSignalRow(signal: Signal, nowUtcMs: number): ShadowSignalRow {
  const ct = toCentralTime(signal.firedAt || nowUtcMs);
  return {
    observed_at:   new Date(nowUtcMs).toISOString(),
    session_date:  `${ct.year}-${String(ct.month).padStart(2, '0')}-${String(ct.day).padStart(2, '0')}`,
    ticker:        signal.ticker,
    signal_type:   signal.type,
    confidence:    signal.confidence,
    trigger_price: signal.triggerPrice,
    fired_at:      signal.firedAt,
    sources:       signal.sources ?? [],
    catalyst_data_quality: signal.catalystDataQuality ?? null,
    signal_id:     signal.id,
  };
}

let _missingTableReported = false;
let _written = 0;
export function shadowSignalsWritten(): number { return _written; }

export async function writeShadowSignal(row: ShadowSignalRow): Promise<void> {
  const { error } = await supabaseObservations.from('engine_shadow_signals').insert([row]);
  if (error) {
    if (/does not exist/i.test(error.message)) {
      if (!_missingTableReported) {
        _missingTableReported = true;
        console.error(
          '[shadowSignalLog] MIGRATION NOT RUN: create table public.engine_shadow_signals ' +
          '(backups/engine-shadow-signals-table.sql). Live engine decisions are not being recorded; ' +
          'Railway log retention is not a substitute.'
        );
      }
      return;
    }
    console.error(`[shadowSignalLog] insert failed — ${error.message}`);
    return;
  }
  _written++;
}
