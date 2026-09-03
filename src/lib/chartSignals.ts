/**
 * chartSignals — real signal history for HeliosChart.
 *
 * The real gap this closes: ZeroDteCockpit's embedded chart already passes
 * real signal markers (its own active position's entry — see
 * ChartSignalMarker usage in ZeroDteCockpit.tsx), proving the marker
 * infrastructure (createSeriesMarkers, SignalMarkerState) works end-to-end.
 * But the main trading-view chart — the one showing full price + VWAP/EMA/
 * GEX history for a ticker — passes zero markers, so it shows no signal
 * history at all. This module is the query layer that fixes that: real
 * historical signals + real resolved outcomes, mapped (via
 * chartSignalMarkers.ts's pure functions) into the exact ChartSignalMarker[]
 * shape HeliosChart already accepts. Zero changes to HeliosChart.tsx or
 * ZeroDteCockpit.tsx are needed — `markers` is already just a prop.
 *
 * ── A real file-location problem, surfaced rather than worked around ──────
 * The requesting brief referenced `Home/index.tsx:771` as where this wires
 * in. That file, in THIS repo, is an 11-line Wegic placeholder page (just a
 * logo image) — it does not import HeliosChart, has no ticker-selection
 * state, and is nowhere near 771 lines. Grepped the whole src/ tree: the
 * ONLY real usage of <HeliosChart> anywhere in this repository is
 * ZeroDteCockpit.tsx's embedded mini-chart. Per CLAUDE.md: "The live
 * frontend is hosted by Wegic ... and is NOT built from this repo" — the
 * real main Chart screen the brief describes lives only in Wegic's actual,
 * separate live codebase, which this session has no access to. This module
 * is therefore built and verified against real data here, the same way
 * chainAggregator's concurrency fix and chartBars.ts were — as the exact,
 * validated spec for Wegic to wire into their real Home page, not as a
 * literal edit to a file that doesn't match what was described.
 *
 * ── Two real writers of signal_outcomes, checked live before assuming ─────
 * signal_outcomes has two structurally different real writers in this
 * codebase: outcomeResolver.ts (relay/engine/ledger, server-side, writes
 * one row per resolution window — 5/15/30/60 min, keyed by window_ms) and
 * ZeroDteCockpit.tsx's manual "Confirm Exit" flow (browser-side, would
 * write one row per real discretionary exit, WITHOUT window_ms). Queried
 * the real table live (2026-09-03): 84,935 total rows, all 84,935 carry a
 * real window_ms. Zero manual-exit-shaped rows exist. The manual exit path
 * has never actually written to production — either that UI isn't part of
 * Wegic's real live build, or it has simply never been used. This settles
 * which shape to build against: the only real exit data that exists is the
 * resolver's windowed outcomes.
 *
 * ── Real dataQuality discipline (per explicit instruction) ────────────────
 * fetchChartSignalMarkers returns Result<ChartSignalMarker[]> — the exact
 * same discriminated union every other store in this codebase already
 * uses (stores/types.ts). A query failure returns 'error' with a real
 * reason string; a query that succeeds and finds nothing returns 'ready'
 * with an empty array. Those are never conflated: a caller checking
 * `status === 'error'` can render an explicit "couldn't load signal
 * history" state instead of a chart that silently looks like a ticker with
 * no signals ever fired. If the outcomes half of the query fails after
 * signals succeeded, entries are still real and still returned — an outage
 * on exit data does not invalidate the entry markers that already loaded
 * successfully.
 *
 * A real bug this surfaced only at real scale, found and fixed: live-tested
 * against SPY's real 13-day signal history (2,663 real rows) — the naive
 * `.in('signal_id', signalIds)` outcomes query failed outright with a real
 * "URI too long" error. Supabase's `.in()` filter is a GET query param, not
 * a request body — real signal ids are ~26 real characters each (e.g.
 * sig_1698_SPY_1787664651866), so 2,663 of them in one filter is a ~70KB
 * URL, well past any real gateway's URL-length limit. A small fixture never
 * would have hit this. Fixed by chunking the id list
 * (OUTCOME_QUERY_BATCH_SIZE below) and merging results — same batching
 * principle bars1mIngestion.ts already uses for its own PostgREST
 * body-size limit, applied here to a URL-length limit instead.
 */

import { supabase } from './supabase';
import { ready, error, type Result } from '../stores/types';
import type { ChartSignalMarker } from '../components/HeliosChart';
import {
  buildEntryMarker,
  buildExitMarker,
  pickBestOutcome,
  type SignalRow,
  type OutcomeRow,
} from './chartSignalMarkers';

/**
 * Max signal ids per outcomes `.in()` query. Sized conservatively for a
 * real ~26-char id (e.g. sig_1698_SPY_1787664651866) plus separator: 200
 * ids is comfortably under an ~8KB URL, the commonly-cited safe ceiling
 * across gateways/CDNs, with real margin for longer ids than today's.
 */
const OUTCOME_QUERY_BATCH_SIZE = 200;

/**
 * Fetch real entry + exit signal markers for `ticker` over [fromMs, toMs].
 * Pass the same window computeChartBackfillWindow() (chartBars.ts) produces
 * for bars, so signal history and price history cover the same real range
 * (per explicit instruction — this function does not compute its own
 * window).
 */
export async function fetchChartSignalMarkers(
  ticker: string,
  fromMs: number,
  toMs:   number,
): Promise<Result<ChartSignalMarker[]>> {
  const { data: signals, error: signalsErr } = await supabase
    .from('signals')
    .select('id,ticker,direction,signal_type,entry_price,entry_tct')
    .eq('ticker', ticker)
    .gte('entry_utc', fromMs)
    .lte('entry_utc', toMs);

  if (signalsErr) {
    return error(`chartSignals: signals query failed for ${ticker} — ${signalsErr.message}`);
  }
  if (!signals || signals.length === 0) {
    // Real, genuine empty — query succeeded, this ticker fired no signals
    // in this window. Distinguishable from the error branch above, per
    // explicit instruction.
    return ready([], toMs);
  }

  const entryMarkers = (signals as SignalRow[]).map(buildEntryMarker);

  // Batched — see OUTCOME_QUERY_BATCH_SIZE's comment. A real chart window
  // easily produces thousands of signal ids (SPY: 2,663 in 13 real days),
  // and a single unbatched .in() blew a real URL-length limit in testing.
  const signalIds = (signals as SignalRow[]).map((s) => s.id);
  const outcomesBySignal = new Map<string, OutcomeRow[]>();
  let outcomesFailed = false;

  for (let i = 0; i < signalIds.length; i += OUTCOME_QUERY_BATCH_SIZE) {
    const batch = signalIds.slice(i, i + OUTCOME_QUERY_BATCH_SIZE);
    const { data: outcomes, error: outcomesErr } = await supabase
      .from('signal_outcomes')
      .select('signal_id,window_ms,exit_tct,pnl_pct')
      .in('signal_id', batch);

    if (outcomesErr) {
      // Entries are still real and still valuable even if outcomes failed
      // to load — degrade to entry-only markers rather than discarding
      // real data because one batch of a second, independent query
      // failed. Logged, not silent. Continues to the next batch rather
      // than aborting entirely — a transient failure on one batch
      // shouldn't cost every other batch's real exit data too.
      console.error(`[chartSignals] outcomes query batch failed for ${ticker} — ${outcomesErr.message}`);
      outcomesFailed = true;
      continue;
    }

    for (const o of (outcomes ?? []) as OutcomeRow[]) {
      const list = outcomesBySignal.get(o.signal_id);
      if (list) list.push(o);
      else outcomesBySignal.set(o.signal_id, [o]);
    }
  }

  if (outcomesFailed && outcomesBySignal.size === 0) {
    // Every batch failed — no real exit data at all this pass.
    return ready(entryMarkers, toMs);
  }

  const exitMarkers: ChartSignalMarker[] = [];
  for (const signal of signals as SignalRow[]) {
    const signalOutcomes = outcomesBySignal.get(signal.id);
    if (!signalOutcomes) continue; // genuinely unresolved — no exit marker, not faked
    const best = pickBestOutcome(signalOutcomes);
    if (best) exitMarkers.push(buildExitMarker(signal, best));
  }

  return ready([...entryMarkers, ...exitMarkers], toMs);
}
