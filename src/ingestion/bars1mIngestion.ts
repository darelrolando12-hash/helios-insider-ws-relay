/**
 * bars_1m historical backfill ingestion
 *
 * Scoped to FEED_TICKERS (23 core tradeable tickers) only.
 * TLT/HYG/I:VIX are deliberately excluded — their live intraday need is
 * served by barsStore's in-memory rolling window; nobody queries 2yr
 * persisted 1-min history for macro context tickers.
 *
 * Design:
 *  - Resumable: for each ticker, query the latest t_utc already in bars_1m
 *    and start the fetch from (lastStoredMs + 1 min). A restart after partial
 *    success costs zero re-fetched rows.
 *  - Serialized: one ticker at a time. No parallel fetches. Avoids
 *    rate-limit exposure and makes progress logs easy to follow.
 *  - Paginated: _fetchBarRange now loops over next_url (fixed in api.ts).
 *    A 2yr window at 1-min resolution is ~196k bars per ticker (~4 pages).
 *    The pagination happens transparently inside fetchBarRange — this writer
 *    just calls the API and accumulates results.
 *
 * Single-ticker pilot:
 *  The runBars1mPilot() export runs SPY alone. Call it first to confirm
 *  the pagination loop actually produces > 50,000 rows before committing
 *  to the full 23-ticker run. Only after SPY's row count is verified does
 *  the full runBars1mBackfill() get wired into main.tsx.
 *
 * Row math (approximate, weekdays only):
 *  2yr × 252 trading days × 390 bars/day = ~196,560 bars per ticker.
 *  At 50,000 rows/page: 4 pages per ticker.
 *  23 tickers × 4 pages = ~92 REST calls total.
 *  Serialized at ~1 s/call → under 2 minutes for full run.
 *
 * Upsert:
 *  Conflict target is (ticker, t_utc) PRIMARY KEY.
 *  ignoreDuplicates: true — safe to re-run; existing rows are untouched.
 *
 * Volume:
 *  bars_1m.v is BIGINT. Massive returns volume as a float from the agg
 *  endpoint. Math.round() applied before upsert (same fix as bars_daily).
 */

import { supabase }             from '../lib/supabase';
import { MassiveRestClient }    from '../lib/massive/api';
import { FEED_TICKERS }         from '../state/directionState';
import { formatError }          from '../lib/errors';

// ── Constants ─────────────────────────────────────────────────────────────────

/**
 * Translates canonical app ticker symbols to the symbol format Massive's
 * REST aggregates endpoint expects for cash-settled indices.
 *
 * Confirmed by chainAggregator.ts: bare 'SPX'/'NDX' return no/empty data
 * from Massive — the 'I:' prefix is required. Storage always uses the
 * bare symbol (SPX/NDX) — this map is applied only at the outbound
 * fetch boundary, matching the pattern already used in barsIngestion.ts
 * for I:VIX.
 */
const REST_TICKER_MAP: Readonly<Record<string, string>> = {
  SPX: 'I:SPX',
  NDX: 'I:NDX',
};

/** 2 years of history as epoch ms */
const TWO_YEARS_MS = 2 * 365 * 24 * 60 * 60 * 1000;

/** 1 minute in ms — used to compute fromMs after last stored bar */
const ONE_MIN_MS = 60 * 1000;

/**
 * Max rows per upsert batch.
 * Supabase PostgREST enforces a ~1–2 MB body limit. At ~9 fields × ~20 bytes
 * each, 1,000 rows ≈ 180 KB — safely under the limit. A single upsert of
 * ~196k rows (the full 2yr SPY fetch) would exceed it and fail silently.
 */
const UPSERT_BATCH_SIZE = 1_000;

// ── Core helpers ──────────────────────────────────────────────────────────────

/**
 * Returns the latest t_utc already stored in bars_1m for `ticker`,
 * or null if the table has no rows for that ticker yet.
 */
async function getLastStoredMs(ticker: string): Promise<number | null> {
  const { data, error } = await supabase
    .from('bars_1m')
    .select('t_utc')
    .eq('ticker', ticker)
    .order('t_utc', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    console.error(`[bars1mIngestion] ${ticker}: DB select for last t_utc failed —`, error.message);
    return null;
  }
  // t_utc is BIGINT — Supabase returns it as a JS string; parse to number.
  return data ? Number(data.t_utc) : null;
}

/**
 * Fetch and upsert bars for a single ticker over the given window.
 * Returns the number of rows successfully upserted (0 on fetch error).
 *
 * Upsert is chunked into UPSERT_BATCH_SIZE batches to stay under the
 * Supabase PostgREST body-size limit (~1–2 MB). A single upsert of the
 * full 2yr fetch (~196k rows) would exceed the limit and fail silently.
 *
 * Every stage logs explicitly so the line where it stalls is always visible.
 */
async function backfillTicker(
  client:   MassiveRestClient,
  ticker:   string,
  fromMs:   number,
  toMs:     number,
): Promise<number> {
  // ── Step 1: fetch ──────────────────────────────────────────────────────────
  // Translate to REST symbol at the boundary only (e.g. SPX -> I:SPX) — the
  // canonical bare ticker is kept for storage below.
  const restSymbol = REST_TICKER_MAP[ticker] ?? ticker;
  console.log(`[bars1mIngestion] ${ticker}: fetching bars…`);
  let bars;
  try {
    bars = await client.fetchBarRange(restSymbol, fromMs, toMs, 1);
  } catch (e) {
    console.error(`[bars1mIngestion] ${ticker}: fetchBarRange threw — ${formatError(e)}`);
    return 0;
  }
  console.log(`[bars1mIngestion] ${ticker}: fetch complete — ${bars.length} bars returned across all pages.`);

  if (bars.length === 0) {
    console.log(`[bars1mIngestion] ${ticker}: 0 bars for window ` +
      `${new Date(fromMs).toISOString().slice(0, 10)} → ${new Date(toMs).toISOString().slice(0, 10)}`);
    return 0;
  }

  // ── Step 2: map to DB rows ─────────────────────────────────────────────────
  const rows = bars.map((b) => ({
    ticker,
    t_utc: b.tUtc,
    o:     b.open,
    h:     b.high,
    l:     b.low,
    c:     b.close,
    // Index tickers (SPX, NDX) have no volume concept — Massive returns no
    // usable value for them, and JSON.stringify would turn Math.round(NaN)
    // into a silent `null` anyway. Write NULL explicitly for that case
    // rather than fabricating a 0 — the column is nullable for this reason.
    v:     b.volume != null ? Math.round(b.volume) : null,
    vw:    b.vwap         ?? null,
    n:     b.transactions ?? null,
  }));

  // ── Step 3: chunked upsert ─────────────────────────────────────────────────
  // Single upsert of ~196k rows exceeds PostgREST body limit — batch it.
  let totalUpserted = 0;
  const totalBatches = Math.ceil(rows.length / UPSERT_BATCH_SIZE);
  console.log(`[bars1mIngestion] ${ticker}: upserting ${rows.length} rows in ${totalBatches} batches…`);

  for (let i = 0; i < rows.length; i += UPSERT_BATCH_SIZE) {
    const batch = rows.slice(i, i + UPSERT_BATCH_SIZE);
    const batchNum = Math.floor(i / UPSERT_BATCH_SIZE) + 1;

    const { error: upsertErr } = await supabase
      .from('bars_1m')
      .upsert(batch, { onConflict: 'ticker,t_utc', ignoreDuplicates: true });

    if (upsertErr) {
      console.error(`[bars1mIngestion] ${ticker}: upsert batch ${batchNum}/${totalBatches} failed —`, upsertErr.message);
      // Continue to next batch — partial progress beats aborting entirely
      continue;
    }

    totalUpserted += batch.length;
    console.log(`[bars1mIngestion] ${ticker}: batch ${batchNum}/${totalBatches} done (${totalUpserted}/${rows.length} rows).`);
  }

  return totalUpserted;
}

/**
 * Verify row count in the DB after upsert — the only honest confirmation.
 * Returns the actual DB count, or -1 if the count query failed.
 */
async function getConfirmedCount(ticker: string): Promise<number> {
  const { count, error } = await supabase
    .from('bars_1m')
    .select('*', { count: 'exact', head: true })
    .eq('ticker', ticker);

  if (error) {
    console.error(`[bars1mIngestion] ${ticker}: count query failed —`, error.message);
    return -1;
  }
  return count ?? 0;
}

// ── Pilot: SPY only ───────────────────────────────────────────────────────────

/**
 * Run the 2yr backfill for SPY alone.
 *
 * This is the single-ticker pagination proof. The confirmed DB row count
 * must be meaningfully above 50,000 before runBars1mBackfill() (full 23
 * tickers) gets wired into main.tsx.
 *
 * What to look for in the log:
 *   attempted: N   — bars returned by the API (sum across all pages)
 *   confirmed: N   — rows actually written and queryable in bars_1m
 *
 * If either number is exactly 50,000 (or a small multiple thereof with no
 * remainder), that is the pagination-failure signature: the loop stopped at
 * one page. If the number is ~196,000+, pagination is working correctly.
 */
export async function runBars1mPilot(client: MassiveRestClient): Promise<void> {
  const ticker = 'SPY';
  console.log('[bars1mIngestion] Pilot: starting SPY 2yr backfill…');

  const toMs     = Date.now();
  const fromFull = toMs - TWO_YEARS_MS;

  const lastMs = await getLastStoredMs(ticker);
  const fromMs = lastMs !== null ? lastMs + ONE_MIN_MS : fromFull;

  if (fromMs >= toMs) {
    const confirmed = await getConfirmedCount(ticker);
    console.log(`[bars1mIngestion] Pilot: SPY already current. DB rows confirmed: ${confirmed}.`);
    return;
  }

  const fromLabel = new Date(fromMs).toISOString().slice(0, 10);
  const toLabel   = new Date(toMs).toISOString().slice(0, 10);
  console.log(`[bars1mIngestion] Pilot: SPY fetching ${fromLabel} → ${toLabel} ` +
    `(${lastMs !== null ? `resuming from last stored ${new Date(lastMs).toISOString()}` : 'cold start'})`);

  const attempted = await backfillTicker(client, ticker, fromMs, toMs);

  // Always query the real DB count — the only honest confirmation.
  // Print the completion line regardless of attempted count so the result
  // is always visible even if upsert partially failed.
  const confirmed = await getConfirmedCount(ticker);
  console.log(
    `[bars1mIngestion] Pilot: SPY complete. ` +
    `Upserted: ${attempted}. Confirmed in DB: ${confirmed}. ` +
    (confirmed > 50_000
      ? 'PAGINATION PASS — next_url followed.'
      : attempted === 0
        ? 'WARNING — 0 rows upserted, check fetch/upsert errors above.'
        : 'WARNING — count <= 50k, check pagination.'),
  );
}

// ── Full backfill: all FEED_TICKERS ──────────────────────────────────────────

/**
 * Run the 2yr backfill for all 23 FEED_TICKERS.
 *
 * Wire this into main.tsx ONLY after runBars1mPilot() confirms SPY's row
 * count is > 50,000. Until that confirmation exists, this function should
 * not be called at boot.
 *
 * Serialized by ticker — not parallel. Each ticker completes fully before
 * the next begins, so a mid-run failure leaves all prior tickers complete.
 */
export async function runBars1mBackfill(client: MassiveRestClient): Promise<void> {
  console.log('[bars1mIngestion] Starting full bars_1m backfill for all FEED_TICKERS…');

  const toMs     = Date.now();
  const fromFull = toMs - TWO_YEARS_MS;
  let totalAttempted = 0;
  let totalConfirmed = 0;

  for (const ticker of FEED_TICKERS) {
    try {
      const lastMs = await getLastStoredMs(ticker);
      const fromMs = lastMs !== null ? lastMs + ONE_MIN_MS : fromFull;

      if (fromMs >= toMs) {
        const confirmed = await getConfirmedCount(ticker);
        console.log(`[bars1mIngestion] ${ticker}: already current. DB rows: ${confirmed}.`);
        totalConfirmed += confirmed;
        continue;
      }

      const attempted = await backfillTicker(client, ticker, fromMs, toMs);
      const confirmed = await getConfirmedCount(ticker);
      totalAttempted += attempted;
      totalConfirmed += confirmed;

      const verdict = attempted === 0
        ? 'WARNING — 0 rows upserted, check fetch/upsert errors above.'
        : confirmed > 0
          ? 'OK'
          : 'WARNING — upsert attempted but confirmed count is 0.';
      console.log(`[bars1mIngestion] ${ticker}: attempted ${attempted}, confirmed ${confirmed}. ${verdict}`);
    } catch (e) {
      console.error(`[bars1mIngestion] ${ticker}: unexpected error — ${formatError(e)}`);
    }
  }

  console.log(`[bars1mIngestion] Full backfill complete. ` +
    `Total attempted: ${totalAttempted}, total confirmed: ${totalConfirmed}.`);
}
