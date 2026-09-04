/**
 * chartBarsBackfill — real historical 1-minute bars for HeliosChart's
 * coarser-interval views.
 *
 * The real gap this closes: HeliosChart reads exclusively from barsStore's
 * live, in-memory feed, capped at MAX_BARS_PER_TICKER (500 bars, ~1
 * session). A "15m" or "1h" toggle re-aggregating only that buffer would
 * produce a handful of real candles — barely more informative than the 5m
 * view, and (per bestContractPicker/EMA design work this session) not
 * enough real bars to seed a 55-period EMA at 1h at all. bars_1m already
 * holds up to 2 years of real, persisted history (bars1mIngestion.ts,
 * server-side) — this module is the real, missing read path into it from
 * the browser.
 *
 * Real schema, confirmed live against production (2026-09-03):
 * ticker, t_utc, o, h, l, c, v, vw, n. Mapped to the real Bar shape below —
 * same real entry_tct-mislabeling lesson from chartSignalMarkers.ts applies
 * here too: t_utc is a genuine UTC epoch; tCT must be computed via
 * toCentralTime(t_utc).ctMs, never assumed equal to t_utc.
 */

import { supabase } from './supabase';
import { ready, error, type Result } from '../stores/types';
import { toCentralTime } from './time';
import type { Bar } from '../stores/types';

interface Bars1mRow {
  ticker: string;
  t_utc:  number | string; // BIGINT — Supabase returns as a string
  o: number;
  h: number;
  l: number;
  c: number;
  v: number | string; // BIGINT
  vw: number | null;
  n:  number | null;
}

/**
 * Fetch real historical 1-minute bars for `ticker` over [fromMs, toMs] from
 * the persisted bars_1m table. Pass the same window
 * computeChartBackfillWindow() (chartWindow.ts) produces, sized per the
 * selected interval — see HeliosChart.tsx for the real 7-day/10-day split.
 *
 * Result<Bar[]> — same discriminated union every other real query in this
 * codebase uses (chartSignals.ts, every store). A query failure is
 * distinguishable from a genuine empty range (e.g. a ticker with no real
 * history yet).
 */
export async function fetchBackfilledBars(
  ticker: string,
  fromMs: number,
  toMs:   number,
): Promise<Result<Bar[]>> {
  const { data, error: dbErr } = await supabase
    .from('bars_1m')
    .select('ticker,t_utc,o,h,l,c,v,vw,n')
    .eq('ticker', ticker)
    .gte('t_utc', fromMs)
    .lte('t_utc', toMs)
    .order('t_utc', { ascending: true });

  if (dbErr) {
    return error(`chartBarsBackfill: bars_1m query failed for ${ticker} — ${dbErr.message}`);
  }
  if (!data || data.length === 0) {
    // Real, genuine empty — query succeeded, no persisted history exists
    // for this ticker in this window yet. Distinguishable from the error
    // branch above.
    return ready([], toMs);
  }

  const bars: Bar[] = (data as Bars1mRow[]).map((row) => {
    const tUtc = Number(row.t_utc);
    return {
      ticker: row.ticker,
      open:  row.o,
      high:  row.h,
      low:   row.l,
      close: row.c,
      volume: Number(row.v),
      vwap:  row.vw ?? undefined,
      transactions: row.n ?? undefined,
      tCT:  toCentralTime(tUtc).ctMs,
      tUtc,
    };
  });

  return ready(bars, toMs);
}
