/**
 * bars_daily backfill ingestion
 *
 * Runs once at boot. For each ticker in FEED_TICKERS:
 *   1. Check the most recent date already stored in bars_daily.
 *   2. If the table is empty for that ticker, fetch 5 years from today.
 *   3. Otherwise, fetch from (last stored date + 1 day) to today — gap-fill only.
 *   4. Upsert all fetched rows (conflict on PRIMARY KEY (ticker, date) is safe).
 *
 * This makes the job resumable: a restart after partial success doesn't re-fetch
 * rows already stored.
 *
 * Zero-bar responses log the full Massive envelope (status, resultsCount, ticker echo)
 * so coverage gaps vs. genuine empty windows can be distinguished without re-running.
 *
 * Row count after each ticker is logged to console for real verification.
 * The job is fire-and-forget from main.tsx — it does not block rendering.
 *
 * Rate limit: calls are serialized per-ticker (not parallel across tickers)
 * to stay within Massive's rate limits. Each ticker = 1 REST call (≤1260 rows
 * fits well under the 50 000-row limit).
 */

import { supabase }                                   from '../lib/supabase';
import { MassiveRestClient, MassiveDailyBarResponse } from '../lib/massive/api';
import { FEED_TICKERS }                               from '../state/directionState';

/**
 * Full set of tickers that need daily bars.
 * Extends FEED_TICKERS with context-only tickers (TLT, HYG, I:VIX) that are
 * used by IndexesCockpit for macro context but deliberately excluded from the
 * signal-generating FEED_TICKERS list.
 */
const BARS_DAILY_TICKERS: readonly string[] = [...FEED_TICKERS, 'TLT', 'HYG', 'I:VIX'];

/**
 * Translates canonical app ticker symbols to the symbol format expected by the
 * Massive REST /v2/aggs/ticker/ endpoint.
 *
 * The discrepancy exists because Massive's WebSocket feed uses an "I:" prefix
 * for indices (e.g. I:VIX) while the REST aggregates endpoint uses the bare
 * symbol (e.g. VIX). This map is applied only to the outbound REST URL — the
 * canonical symbol (with prefix) is always used for storage and everywhere else
 * in the app, so the identity stays consistent across all tables and stores.
 */
const REST_TICKER_MAP: Readonly<Record<string, string>> = {
  'I:VIX': 'VIX',
};

// ── Helpers ───────────────────────────────────────────────────────────────────

/** YYYY-MM-DD string for a Date object */
function toDateStr(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** YYYY-MM-DD for N years before today (UTC-based, safe on server or browser) */
function yearsAgo(n: number): string {
  const d = new Date();
  d.setUTCFullYear(d.getUTCFullYear() - n);
  return toDateStr(d);
}

/** YYYY-MM-DD for tomorrow (ensures today's bar is included when market is open) */
function tomorrow(): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + 1);
  return toDateStr(d);
}

/** Add one day to a YYYY-MM-DD string */
function addOneDay(dateStr: string): string {
  const d = new Date(`${dateStr}T12:00:00Z`); // noon UTC avoids DST boundary issues
  d.setDate(d.getDate() + 1);
  return toDateStr(d);
}

// ── Upsert helper ─────────────────────────────────────────────────────────────

/**
 * Map a Massive daily bar response to DB rows and upsert.
 * Returns the number of rows attempted, or 0 on upsert failure.
 */
async function upsertBars(
  ticker:   string,
  envelope: MassiveDailyBarResponse,
  label:    string,   // log context string, e.g. "gap-fill" or "2022-gap"
): Promise<number> {
  const bars = envelope.results;

  if (bars.length === 0) {
    // Log the full envelope so we can distinguish plan-tier coverage gaps from
    // genuine empty windows without a re-run.
    console.log(
      `[barsIngestion] ${ticker} (${label}): 0 bars returned — ` +
      `Massive status="${envelope.status}", resultsCount=${envelope.resultsCount}, ` +
      `ticker echo="${envelope.ticker}"`,
    );
    return 0;
  }

  const rows = bars.map((b) => ({
    ticker,
    date: new Date(b.t).toISOString().slice(0, 10),
    o:    b.o,
    h:    b.h,
    l:    b.l,
    c:    b.c,
    v:    Math.round(b.v),   // BIGINT rejects fractional values from Massive agg
    vw:   b.vw ?? null,
    n:    b.n  ?? null,
  }));

  const { error: upsertErr } = await supabase
    .from('bars_daily')
    .upsert(rows, { onConflict: 'ticker,date', ignoreDuplicates: true });

  if (upsertErr) {
    console.error(`[barsIngestion] ${ticker} (${label}): upsert failed —`, upsertErr.message);
    return 0;
  }

  return rows.length;
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Run the bars_daily backfill for all FEED_TICKERS.
 * Called once from main.tsx — non-blocking (async, fire-and-forget).
 *
 * Phase 0 (runs first): targeted gap-fills for known internal holes confirmed
 * by the gap-detection query. Each entry is: [ticker, gapStart, gapEnd].
 * These are window-scoped fetches — they do NOT re-fetch the full 5yr history.
 *
 * Phase 1: the normal per-ticker incremental gap-fill (last stored date → today).
 */
export async function runBarsDailyBackfill(client: MassiveRestClient): Promise<void> {
  console.log('[barsIngestion] Starting bars_daily backfill…');

  const toDate   = tomorrow();
  const fromFull = yearsAgo(5);

  // ── Phase 0 — targeted window fills for confirmed internal gaps ─────────────
  //
  // Source: gap-detection query run 2026-07-31.
  // Only META had a gap (132 calendar days, 2022-01-28 → 2022-06-09).
  // Fetch the exact window so we don't re-fetch the surrounding 5yr history.
  // Add entries here if the gap-detection query ever surfaces new holes.
  //
  const KNOWN_GAPS: Array<{ ticker: string; from: string; to: string }> = [
    { ticker: 'META', from: '2022-01-28', to: '2022-06-09' },
  ];

  for (const gap of KNOWN_GAPS) {
    try {
      const envelope = await client.fetchDailyBars(gap.ticker, gap.from, gap.to);
      const attempted = await upsertBars(gap.ticker, envelope, `targeted-gap ${gap.from}→${gap.to}`);
      if (attempted > 0) {
        // Re-query actual count for this ticker to confirm the fill
        const { count, error: countErr } = await supabase
          .from('bars_daily')
          .select('*', { count: 'exact', head: true })
          .eq('ticker', gap.ticker);
        const confirmed = countErr ? '(count query failed)' : String(count ?? 0);
        console.log(
          `[barsIngestion] ${gap.ticker} targeted gap fill: attempted ${attempted}, ` +
          `confirmed in DB: ${confirmed}.`,
        );
      }
    } catch (e) {
      console.error(`[barsIngestion] ${gap.ticker} targeted gap fill: unexpected error —`, e);
    }
  }

  // ── Phase 1 — normal incremental gap-fill for all BARS_DAILY_TICKERS ────────

  let totalAttempted = 0;
  let totalInserted  = 0;

  for (const ticker of BARS_DAILY_TICKERS) {
    try {
      // 1. Find the most recent date already in the DB for this ticker
      const { data: latestRow, error: selectErr } = await supabase
        .from('bars_daily')
        .select('date')
        .eq('ticker', ticker)
        .order('date', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (selectErr) {
        console.error(`[barsIngestion] ${ticker}: DB select failed —`, selectErr.message);
        continue;
      }

      // 2. Decide fetch window: full 5yr or gap-fill from day after last stored
      const fromDate = latestRow?.date
        ? addOneDay(latestRow.date as string)
        : fromFull;

      // If already up-to-date (last stored date is today or tomorrow), skip
      if (fromDate >= toDate) {
        console.log(`[barsIngestion] ${ticker}: already current (last: ${latestRow?.date ?? 'none'}), skipping.`);
        continue;
      }

      // 3. Fetch from Massive — translate to REST symbol at the boundary only.
      //    The canonical ticker (e.g. I:VIX) is kept for storage; only the
      //    outbound URL uses the REST-format symbol (e.g. VIX).
      const restSymbol = REST_TICKER_MAP[ticker] ?? ticker;
      const envelope   = await client.fetchDailyBars(restSymbol, fromDate, toDate);
      const attempted = await upsertBars(ticker, envelope, `gap-fill ${fromDate}→${toDate}`);

      if (attempted === 0) continue;

      totalAttempted += attempted;

      // Re-query actual DB count — the only honest row count.
      const { count, error: countErr } = await supabase
        .from('bars_daily')
        .select('*', { count: 'exact', head: true })
        .eq('ticker', ticker);

      const confirmed = countErr ? '(count query failed)' : String(count ?? 0);
      totalInserted += count ?? 0;
      console.log(`[barsIngestion] ${ticker}: attempted ${attempted}, confirmed in DB: ${confirmed}.`);

    } catch (e) {
      console.error(`[barsIngestion] ${ticker}: unexpected error —`, e);
    }
  }

  if (totalAttempted === 0) {
    console.log('[barsIngestion] bars_daily backfill complete — all tickers already current, 0 new rows needed.');
  } else {
    console.log(`[barsIngestion] bars_daily backfill complete. Attempted: ${totalAttempted} new rows, confirmed inserted: ${totalInserted}.`);
  }
}
