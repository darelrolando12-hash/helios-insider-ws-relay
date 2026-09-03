/**
 * chartWindow — browser copy of computeChartBackfillWindow.
 *
 * A tracked, deliberate duplicate — same pattern CLAUDE.md documents for
 * relay/engine vs src/ engine logic during the shadow-mode migration,
 * applied here to one small, pure, framework-free function instead of a
 * whole engine tree. Real source of truth: computeChartBackfillWindow in
 * relay/engine/lib/chartBars.ts (verified live 2026-09-02 — real SPY query
 * against bars_1m, 7,739 real bars returned for a 7-trading-day lookback).
 * If that function's formula ever changes, this copy must change with it.
 *
 * Kept separate from chartSignals.ts/chartSignalMarkers.ts (which have no
 * server-side counterpart) because this one function genuinely does — no
 * reason to re-derive or risk drifting from the already-validated formula.
 */

/**
 * Compute the real [fromMs, toMs] UTC range to query over, given a target
 * number of real TRADING days of lookback (not calendar days). See the
 * real source in relay/engine/lib/chartBars.ts for the full real-data
 * verification and design reasoning — reproduced in miniature here:
 * scales by the real 7/5 calendar-to-trading-day ratio, plus a fixed
 * 3-day safety margin, deliberately over-fetching rather than
 * under-covering (no holiday calendar exists anywhere in this system —
 * same documented, inherited gap as everywhere else, not new here).
 */
export function computeChartBackfillWindow(
  nowMs: number,
  tradingDaysLookback: number = 7,
): { fromMs: number; toMs: number } {
  const calendarDaysLookback = Math.ceil((tradingDaysLookback * 7) / 5) + 3;
  const fromMs = nowMs - calendarDaysLookback * 24 * 60 * 60 * 1000;
  return { fromMs, toMs: nowMs };
}
