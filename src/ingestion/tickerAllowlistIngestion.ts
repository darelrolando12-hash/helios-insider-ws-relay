/**
 * ticker_allowlist ingestion — the real market-breadth universe.
 *
 * Data source: Massive /v3/reference/tickers?market=stocks&type=CS&active=true
 * (paginated via next_url — confirmed live to be ~5,300 tickers across ~6
 * pages of 1,000; see fetchReferenceTickers() in api.ts for the full
 * pagination-necessity rationale).
 *
 * This is a SEPARATE ticker universe from FEED_TICKERS (23 signal-generating
 * tickers) and from PILOT_TICKERS in dailyHighLowIngestion.ts (50-ticker
 * proof-of-pattern subset). It exists only to feed the market-breadth engine
 * (todo_66): advancers/decliners, up/down volume, new-highs/new-lows across
 * the real market, not a watchlist.
 *
 * Cadence: refreshed once every 24h. The list barely changes day to day, but
 * not never — IPOs, delistings, and ticker changes happen — so this is not a
 * fetch-once-at-boot-forever job. Same cadence as ratiosIngestion.ts.
 *
 * Write pattern: full delete + reinsert per refresh (not incremental
 * upsert-only), because tickers that delist need to actually leave the
 * allowlist — an upsert-only approach would let delisted/renamed tickers
 * accumulate forever with no removal path.
 */

import { supabase }          from '../lib/supabase';
import { MassiveRestClient } from '../lib/massive/api';
import { formatError }       from '../lib/errors';

/** Exchanges eligible for the breadth universe — NYSE, Nasdaq, AMEX only. */
const ALLOWED_EXCHANGES = new Set(['XNYS', 'XNAS', 'XASE']);

export const REFRESH_INTERVAL_MS = 24 * 60 * 60_000; // 24 hours

/**
 * Run the full ticker-allowlist refresh: fetch, filter, delete-and-reinsert.
 * Real per-page and final row-count logging throughout — a partial run must
 * be visible in the log, never silently absorbed into a success summary.
 */
export async function runTickerAllowlistRefresh(client: MassiveRestClient): Promise<void> {
  console.log('[tickerAllowlistIngestion] Starting reference ticker list fetch (paginated)…');

  let fetched: Awaited<ReturnType<typeof client.fetchReferenceTickers>>;
  try {
    fetched = await client.fetchReferenceTickers();
  } catch (e) {
    console.error(`[tickerAllowlistIngestion] fetchReferenceTickers threw — aborting refresh, keeping existing allowlist — ${formatError(e)}`);
    return;
  }

  console.log(`[tickerAllowlistIngestion] Fetch complete — ${fetched.length} raw tickers returned across all pages.`);

  if (fetched.length === 0) {
    console.error('[tickerAllowlistIngestion] 0 tickers returned — aborting refresh, keeping existing allowlist (refusing to wipe a working table on an empty response).');
    return;
  }

  const filtered = fetched.filter((t) => ALLOWED_EXCHANGES.has(t.primary_exchange));
  console.log(`[tickerAllowlistIngestion] Filtered to NYSE/Nasdaq/AMEX common stock: ${filtered.length} of ${fetched.length}.`);

  const rows = filtered.map((t) => ({
    ticker:           t.ticker,
    primary_exchange: t.primary_exchange,
    updated_at:        new Date().toISOString(),
  }));

  // Delete-and-reinsert so delisted/renamed tickers actually leave the table.
  const { error: deleteErr } = await supabase
    .from('ticker_allowlist')
    .delete()
    .neq('ticker', ''); // delete all rows (no-op filter that matches everything)

  if (deleteErr) {
    console.error('[tickerAllowlistIngestion] delete-existing failed — aborting before insert to avoid duplicate/partial state —', deleteErr.message);
    return;
  }

  const INSERT_BATCH_SIZE = 1_000;
  let totalInserted = 0;
  const totalBatches = Math.ceil(rows.length / INSERT_BATCH_SIZE);

  for (let i = 0; i < rows.length; i += INSERT_BATCH_SIZE) {
    const batch = rows.slice(i, i + INSERT_BATCH_SIZE);
    const batchNum = Math.floor(i / INSERT_BATCH_SIZE) + 1;

    const { error: insertErr } = await supabase
      .from('ticker_allowlist')
      .insert(batch);

    if (insertErr) {
      console.error(`[tickerAllowlistIngestion] insert batch ${batchNum}/${totalBatches} failed —`, insertErr.message);
      continue; // keep going — partial progress beats aborting entirely
    }

    totalInserted += batch.length;
    console.log(`[tickerAllowlistIngestion] insert batch ${batchNum}/${totalBatches} done (${totalInserted}/${rows.length} rows).`);
  }

  const { count, error: countErr } = await supabase
    .from('ticker_allowlist')
    .select('*', { count: 'exact', head: true });

  const confirmed = countErr ? '(count query failed)' : String(count ?? 0);
  console.log(
    `[tickerAllowlistIngestion] Refresh complete. Attempted insert: ${totalInserted}. ` +
    `Confirmed in DB: ${confirmed}. Next refresh in 24h.`,
  );
}

/** Read the current allowlist tickers from the DB. Returns [] on query failure — callers must treat that as "do not proceed", not "empty universe". */
export async function getAllowlistTickers(): Promise<string[]> {
  const { data, error } = await supabase
    .from('ticker_allowlist')
    .select('ticker');

  if (error) {
    console.error('[tickerAllowlistIngestion] getAllowlistTickers query failed —', error.message);
    return [];
  }
  return (data ?? []).map((r) => r.ticker as string);
}
