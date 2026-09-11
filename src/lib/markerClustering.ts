/**
 * markerClustering — real display clustering for signal markers on a
 * coarser chart interval.
 *
 * The real gap this closes: fetchChartSignalMarkers can return thousands of
 * real markers over a real multi-day window (SPY: 2,663 real entries in 13
 * real days, live-verified this session). Plotted raw at a 1h/multi-week
 * zoom, dozens of 1-minute-precision markers would visually stack on the
 * same handful of displayed candles. Left undefined would mean either a
 * visually broken chart or an arbitrary, undocumented decision buried in
 * render code — this module makes the real, deliberate call instead.
 *
 * Real rule: markers within the SAME bucket as the currently-displayed
 * candle interval (reusing aggregateBars.ts's own groupByTimeBucket — the
 * same real time-bucketing primitive, not a second implementation) collapse
 * to ONE representative marker when the bucket is direction-and-type
 * homogeneous. A bucket that mixes directions, or mixes entries with exits,
 * is real, meaningful information (e.g. a coarse candle containing both a
 * signal's entry and its own resolution) and is never force-collapsed —
 * those markers pass through individually.
 *
 * At 1m (native marker resolution), this is a real no-op: the bucket width
 * equals a marker's own resolution, so every bucket already holds exactly
 * one marker. No interval-based special-casing is needed for "don't
 * cluster at fine zoom" — it falls out of the same rule automatically.
 */

import { groupByTimeBucket } from './aggregateBars';
import type { ChartSignalMarker, SignalMarkerState } from '../components/HeliosChart';

/**
 * Real "strength" ordering used to pick the representative marker for a
 * collapsed, homogeneous bucket — matches confluenceEngine's own real
 * threshold ordering (TRIGGERING = the two top-tier entry types, FLIP =
 * REVERSAL's mid-tier, DUMP_RIP = its own real component, CONSOLIDATING =
 * the weakest bucket). EXIT is deliberately absent — a bucket containing
 * any EXIT marker is never eligible for collapse (see the homogeneity
 * check below), so EXIT never needs a rank here.
 */
const STATE_STRENGTH: Partial<Record<SignalMarkerState, number>> = {
  TRIGGERING: 4,
  FLIP: 3,
  DUMP_RIP: 2,
  CONSOLIDATING: 1,
};

function _pickRepresentative(group: ChartSignalMarker[]): ChartSignalMarker {
  let best = group[0];
  for (const m of group) {
    if ((STATE_STRENGTH[m.state] ?? 0) > (STATE_STRENGTH[best.state] ?? 0)) best = m;
  }
  return best;
}

/**
 * Cluster `markers` for display at `bucketMs` (the currently-selected
 * candle interval's own bucket width, in ms — e.g.
 * INTERVAL_MINUTES['1h'] * 60_000). Returns a new array — never mutates
 * `markers`.
 */
export function clusterMarkersForDisplay(
  markers: readonly ChartSignalMarker[],
  bucketMs: number,
): ChartSignalMarker[] {
  if (markers.length === 0) return [];

  const groups = groupByTimeBucket(markers, bucketMs, (m) => m.tCT);
  const result: ChartSignalMarker[] = [];

  for (const group of groups) {
    if (group.length === 1) {
      result.push(group[0]);
      continue;
    }

    const allSameDirection = group.every((m) => m.direction === group[0].direction);
    const noneAreExits     = group.every((m) => m.state !== 'EXIT');

    if (!allSameDirection || !noneAreExits) {
      // Real, meaningful mix — never force a collapse that would hide it.
      result.push(...group);
      continue;
    }

    const representative = _pickRepresentative(group);
    result.push({ ...representative, clusterCount: group.length });
  }

  return result;
}

/**
 * 1D: one marker per day per direction, carrying the day's entry count.
 *
 * clusterMarkersForDisplay's "never collapse a mix" rule is right intraday,
 * where a call and a put inside one 5-minute candle is a real event worth
 * seeing. A daily candle holds a whole session, so a mix is the normal
 * case, not an event — and the rule collapses nothing. Measured 2026-09-10,
 * SPY, the chart's real 7-trading-day signal window: 445 markers over 8
 * daily candles, 445 after clustering, drawn as a solid column ~55 markers
 * tall on each candle.
 *
 * So at 1D each direction is clustered on its own — every group is then
 * homogeneous and collapses to its strongest marker with a count (×N).
 * EXIT markers are left out: their text is one signal's P&L, which has no
 * meaning summed over a day; the outcomes are on the intraday charts.
 */
export function summariseMarkersByDay(
  markers: readonly ChartSignalMarker[],
  dayMs: number,
): ChartSignalMarker[] {
  const entries = markers.filter((m) => m.state !== 'EXIT');
  return [
    ...clusterMarkersForDisplay(entries.filter((m) => m.direction === 'call'), dayMs),
    ...clusterMarkersForDisplay(entries.filter((m) => m.direction !== 'call'), dayMs),
  ].sort((a, b) => a.tCT - b.tCT);
}
