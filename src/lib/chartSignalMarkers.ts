/**
 * chartSignalMarkers — pure transforms from real signal/outcome rows to
 * ChartSignalMarker[]. Zero I/O, zero Supabase, zero React — same contract
 * as catalystGate.ts's computeTags / newsSentimentGate.ts's
 * scoreNewsSentiment: stateless, deterministic, fully testable standalone.
 * See chartSignals.ts for the real query layer that calls these.
 *
 * ── A real, live data bug found while building this, worked around per an
 *    already-documented known gap ─────────────────────────────────────────
 * `signals.entry_tct` is NOT a real Central-Time pseudo-epoch despite its
 * name — confirmed live (2026-09-03) against a real signal: entry_utc
 * 1787664651866 (2026-08-25T13:30:51.866Z, real UTC) has a stored
 * entry_tct of 1787664540000, whose raw ISO reading (13:29:00Z) is a
 * bar-aligned truncation of entry_utc itself, NOT the real CT conversion
 * (toCentralTime(entry_utc).ctMs computes 08:30:51 CT, a ~5 hour
 * difference). This matches CLAUDE.md's own documented Known Gap
 * verbatim: "`entry_tct` is misnamed. It holds a real UTC epoch ... not a
 * CT value ... Consumers happen to be correct because toCentralTime()
 * expects UTC." buildEntryMarker below is exactly that kind of consumer —
 * it converts via toCentralTime(signal.entry_tct).ctMs rather than using
 * the stored value directly, which would otherwise place every entry
 * marker 5 real hours off its actual bar on the chart.
 *
 * By contrast, signal_outcomes.exit_tct is already correct — verified
 * live on the same real signal: outcomeResolver.ts sources it directly
 * from barsStore's own bar.tCT (already computed via the real, DST-aware
 * toCentralTime() at bar-construction time — see massiveAggToBar in
 * api.ts), so buildExitMarker below uses outcome.exit_tct as-is, with no
 * conversion. The two fields look identical by name but are NOT
 * interchangeable in what they actually hold — treating them the same way
 * would have been the exact bug this comment exists to prevent.
 */

import type { ChartSignalMarker, SignalMarkerState } from '../components/HeliosChart';
import { toCentralTime } from './time';

// ── Real row shapes — must match the live schema exactly ───────────────────
// (relay/engine/ledger/signalLedger.ts and outcomeResolver.ts are the real
// writers; column names here are copied from those files, not guessed.)

export type SignalTypeRow =
  | 'ENTER'
  | 'EXIT'
  | 'REVERSAL'
  | 'DUMP'
  | 'RIP'
  | 'BREAKOUT';

export interface SignalRow {
  id:          string;
  ticker:      string;
  direction:   'call' | 'put';
  signal_type: SignalTypeRow;
  entry_price: number;
  entry_tct:   number; // CT pseudo-UTC epoch — matches ChartSignalMarker.tCT directly
}

export interface OutcomeRow {
  signal_id: string;
  window_ms: number;
  exit_tct:  number;
  /**
   * Already percentage-scale (e.g. -1.3 means -1.3%), NOT a fraction —
   * confirmed against outcomeResolver.ts's real computePnlPct:
   * `((exitPrice - entryPrice) / entryPrice) * 100`, direction-adjusted.
   * Do not re-multiply by 100 when building a marker's pnlPct.
   */
  pnl_pct:   number;
}

/** Real resolution windows, largest first — see pickBestOutcome. */
export const WINDOW_PREFERENCE_MS = [60 * 60_000, 30 * 60_000, 15 * 60_000, 5 * 60_000];

/**
 * Maps a real SignalType onto the existing SignalMarkerState taxonomy —
 * reusing HeliosChart's already-proven states rather than inventing new
 * ones (per explicit instruction).
 *
 * ENTER / BREAKOUT -> TRIGGERING: confluenceEngine's two top-tier entry
 *   thresholds (>=75, see CLAUDE.md's scoring reference) — a real signal
 *   worth entering on, matching TRIGGERING's documented "medium circle,
 *   bold" weight. Deliberately NOT 'ACTIVE' — that state is reserved for
 *   an actually-open live position (see ZeroDteCockpit.tsx's own usage);
 *   a historical chart marker for a resolved-or-unknown-outcome signal
 *   should not visually claim a position is still open.
 * REVERSAL -> FLIP: REVERSAL is confluenceEngine's mid-tier threshold
 *   (65-74) representing a real directional change — FLIP's own
 *   "directional arrow" shape fits that concept directly.
 * DUMP / RIP -> DUMP_RIP: an existing state built for exactly this pair.
 * EXIT -> CONSOLIDATING: real naming collision worth flagging explicitly —
 *   SignalType 'EXIT' is confluenceEngine's WEAKEST entry-tier bucket
 *   (score 55-64, see resolveSignalType in confluenceEngine.ts), not a
 *   trade-closing event. Mapping it to the CONSOLIDATING marker state
 *   (hollow, smaller circle) communicates "weaker signal" honestly,
 *   without falsely implying this is where a trade closed — that concept
 *   is handled separately by buildExitMarker below, from real
 *   signal_outcomes data, never from this signal-type mapping.
 */
export function mapEntryMarkerState(signalType: SignalTypeRow): SignalMarkerState {
  switch (signalType) {
    case 'ENTER':
    case 'BREAKOUT':
      return 'TRIGGERING';
    case 'REVERSAL':
      return 'FLIP';
    case 'DUMP':
    case 'RIP':
      return 'DUMP_RIP';
    case 'EXIT':
      return 'CONSOLIDATING';
  }
}

/**
 * Choose the single real outcome to represent a signal's exit, from
 * whichever of the 4 resolution windows have actually resolved.
 * Prefers the largest available window — the most complete real picture
 * of how the signal played out, not the earliest (noisiest) one.
 * Returns null if none of the 4 windows have resolved for this signal.
 */
export function pickBestOutcome(outcomes: readonly OutcomeRow[]): OutcomeRow | null {
  for (const windowMs of WINDOW_PREFERENCE_MS) {
    const match = outcomes.find((o) => o.window_ms === windowMs);
    if (match) return match;
  }
  return null;
}

export function buildEntryMarker(signal: SignalRow): ChartSignalMarker {
  return {
    id:        `entry_${signal.id}`,
    ticker:    signal.ticker,
    state:     mapEntryMarkerState(signal.signal_type),
    direction: signal.direction,
    // NOT signal.entry_tct directly — see this file's header comment.
    // entry_tct is a mislabeled raw UTC value; the real CT pseudo-epoch
    // (matching the candle chart's own tCT axis) requires converting it.
    tCT:       toCentralTime(signal.entry_tct).ctMs,
    price:     signal.entry_price,
  };
}

export function buildExitMarker(signal: SignalRow, outcome: OutcomeRow): ChartSignalMarker {
  return {
    id:        `exit_${signal.id}_${outcome.window_ms}`,
    ticker:    signal.ticker,
    state:     'EXIT',
    direction: signal.direction,
    tCT:       outcome.exit_tct,
    price:     signal.entry_price, // EXIT marker renders pnlPct as its text, not a price — see HeliosChart's _buildLtwMarkers
    pnlPct:    outcome.pnl_pct, // already percentage-scale — see OutcomeRow.pnl_pct's comment
    parentId:  `entry_${signal.id}`,
  };
}
