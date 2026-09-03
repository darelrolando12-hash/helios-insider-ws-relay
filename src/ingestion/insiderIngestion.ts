/**
 * Form 4 insider transaction ingestion
 *
 * Data source: Massive /stocks/filings/vX/form-4 — confirmed real endpoint,
 * live-tested 2026-08-08. Filter param is `tickers` (plural).
 *
 * Design (same resumable pattern as shortInterestIngestion / bars1mIngestion):
 *  - Resumable: for each ticker, find the latest filing_date already stored
 *    in insider_transactions and fetch only from (lastDate + 1 day) forward.
 *    A restart after partial success costs zero re-fetched filings.
 *  - Window: 90 days on first run per ticker (insider activity older than
 *    that is not relevant to the discretionary-signal use case here).
 *  - Serialized: one ticker at a time, same as short interest/volume.
 *  - Chunked upsert: same UPSERT_BATCH_SIZE guard as bars_1m — a single
 *    filing can carry multiple transaction lines, so even a 90-day window
 *    across FEED_TICKERS could exceed the PostgREST body limit.
 *
 * Row identity:
 *  `id` has no DB default — the app must supply it. A single accession_number
 *  (one filing) can contain multiple transaction lines for the same owner
 *  (e.g. one derivative + one non-derivative line, different transaction_code).
 *  Composite key: accession_number + owner_cik + security_type +
 *  transaction_code + transaction_date. Conflict target is `id` (the only
 *  unique constraint that exists on this table).
 *
 * Field mapping notes:
 *  - is_10b5_1 ← aff_10b5_one (added via migration 2026-08-08; this is the
 *    real signal field the Insiders screen's pill depends on).
 *  - insider_title: officer_title only appears when is_officer === true
 *    (confirmed across live samples). Falls back to role booleans when
 *    officer_title is absent.
 *  - transaction_type: derived from transaction_acquired_disposed ('A' → buy,
 *    'D' → sell). transaction_code is the raw SEC code, not stored directly.
 *
 * TTL: none for insider_transactions — filings are immutable, low volume,
 * and no retention window was specified. Revisit if row count history
 * warrants pruning.
 */

import { supabase }           from '../lib/supabase';
import { MassiveRestClient, type MassiveForm4Result } from '../lib/massive/api';
import * as fundamentalsStore from '../stores/fundamentalsStore';
import { FEED_TICKERS }       from '../state/directionState';
import type { InsiderTransaction } from '../stores/types';
import { formatError }             from '../lib/errors';

// ── Constants ─────────────────────────────────────────────────────────────────

/** Max rows per upsert batch — same guard used for bars_1m. */
const UPSERT_BATCH_SIZE = 500;

// ── Helpers ───────────────────────────────────────────────────────────────────

function toDateStr(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function today(): string {
  return toDateStr(new Date());
}

function daysAgo(n: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return toDateStr(d);
}

function addOneDay(dateStr: string): string {
  const d = new Date(`${dateStr}T12:00:00Z`);
  d.setDate(d.getDate() + 1);
  return toDateStr(d);
}

/**
 * Deterministic row id. One filing (accession_number) can carry multiple
 * transaction lines for the same owner — the extra fields disambiguate them.
 *
 * Form 4 filings mix two record_types: 'transaction' (has transaction_code
 * and transaction_date) and 'holding' (end-of-period position disclosure —
 * NEITHER field exists on these rows, confirmed via live sample). Falling
 * back to the literal string "undefined" for missing fields would collide
 * two different real holding rows onto the same id (confirmed happens live:
 * NVDA/COXE TENCH accession 0001197647-26-000007 has two holding rows that
 * only differ by direct_or_indirect + shares_owned_following_transaction).
 *
 * record_type is included directly, and holding rows additionally use
 * direct_or_indirect + shares_owned_following_transaction as real
 * disambiguators instead of the two always-undefined fields.
 */
function form4RowId(r: MassiveForm4Result): string {
  if (r.record_type === 'holding') {
    return `${r.accession_number}_${r.owner_cik}_${r.security_type}_holding_${r.direct_or_indirect ?? 'na'}_${r.shares_owned_following_transaction ?? 'na'}`;
  }
  return `${r.accession_number}_${r.owner_cik}_${r.security_type}_${r.transaction_code}_${r.transaction_date}`;
}

/**
 * Resolve insider_title from the role booleans + officer_title.
 * officer_title is only present when is_officer === true (confirmed on
 * live samples) — never assume it exists.
 */
function resolveInsiderTitle(r: MassiveForm4Result): string {
  if (r.officer_title) return r.officer_title;
  if (r.is_director) return 'Director';
  if (r.is_ten_percent_owner) return '10% Owner';
  if (r.is_other) return 'Other Insider';
  return 'Insider';
}

function resolveTransactionType(r: MassiveForm4Result): 'buy' | 'sell' | 'other' {
  if (r.transaction_acquired_disposed === 'A') return 'buy';
  if (r.transaction_acquired_disposed === 'D') return 'sell';
  return 'other';
}

/** Map one Massive Form 4 result to an insider_transactions DB row. */
function toDbRow(ticker: string, r: MassiveForm4Result) {
  return {
    id:                  form4RowId(r),
    ticker,
    filing_date:         r.filing_date,
    reported_at:         new Date(`${r.filing_date}T00:00:00Z`).toISOString(),
    insider_name:        r.owner_name,
    insider_title:       resolveInsiderTitle(r),
    transaction_type:    resolveTransactionType(r),
    // BIGINT columns — Massive can return floats; round before upsert.
    shares:              Math.round(r.transaction_shares ?? 0),
    price_per_share:     r.transaction_price_per_share ?? null,
    total_value:         r.transaction_value ?? null,
    shares_owned_after:  r.shares_owned_following_transaction != null
      ? Math.round(r.shares_owned_following_transaction)
      : null,
    is_direct:           r.direct_or_indirect === 'D',
    is_10b5_1:           r.aff_10b5_one,
    fetched_at:          new Date().toISOString(),
  };
}

/** Map a stored DB row to the in-memory InsiderTransaction shape fundamentalsStore expects. */
function dbRowToStoreShape(row: {
  id: string;
  insider_name: string;
  insider_title: string | null;
  transaction_type: string;
  shares: number;
  price_per_share: number | null;
  total_value: number | null;
  is_10b5_1: boolean;
  filing_date: string;
  reported_at: string | null;
}): InsiderTransaction {
  const transactedAtMs = new Date(`${row.filing_date}T00:00:00Z`).getTime();
  return {
    ticker:          '', // caller fills in — kept out of DB round-trip type
    id:              row.id,
    insiderName:     row.insider_name,
    relationship:    row.insider_title ?? 'Insider',
    transactionType: (row.transaction_type as InsiderTransaction['transactionType']) ?? 'other',
    shares:          row.shares,
    pricePerShare:   row.price_per_share ?? 0,
    totalValue:      row.total_value ?? 0,
    is10b51:         row.is_10b5_1,
    filedAt:         row.reported_at ? new Date(row.reported_at).getTime() : transactedAtMs,
    transactedAt:    transactedAtMs,
  };
}

// ── Per-ticker backfill ───────────────────────────────────────────────────────

async function _runForTicker(
  client: MassiveRestClient,
  ticker: string,
): Promise<void> {
  const toDate   = today();
  const fullFrom = daysAgo(90);

  const { data: latestRow, error: selectErr } = await supabase
    .from('insider_transactions')
    .select('filing_date')
    .eq('ticker', ticker)
    .order('filing_date', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (selectErr) {
    console.error(`[insiderIngestion] ${ticker}: select failed —`, selectErr.message);
    return;
  }

  const fromDate = latestRow?.filing_date
    ? addOneDay(latestRow.filing_date as string)
    : fullFrom;

  if (fromDate > toDate) {
    console.log(`[insiderIngestion] ${ticker}: current, skipping fetch.`);
    await _hydrateFromDb(ticker);
    return;
  }

  console.log(`[insiderIngestion] ${ticker}: fetching filings ${fromDate} → ${toDate}…`);

  let filings: MassiveForm4Result[];
  try {
    filings = await client.fetchForm4Filings(ticker, fromDate, toDate);
  } catch (e) {
    console.error(`[insiderIngestion] ${ticker}: fetch failed — ${formatError(e)}`);
    return;
  }

  if (filings.length === 0) {
    console.log(`[insiderIngestion] ${ticker}: no new filings in window.`);
    await _hydrateFromDb(ticker);
    return;
  }

  const rows = filings.map((r) => toDbRow(ticker, r));

  // ── Chunked upsert ────────────────────────────────────────────────────────
  let totalUpserted = 0;
  const totalBatches = Math.ceil(rows.length / UPSERT_BATCH_SIZE);
  console.log(`[insiderIngestion] ${ticker}: upserting ${rows.length} transaction lines in ${totalBatches} batch(es)…`);

  for (let i = 0; i < rows.length; i += UPSERT_BATCH_SIZE) {
    const batch = rows.slice(i, i + UPSERT_BATCH_SIZE);
    const batchNum = Math.floor(i / UPSERT_BATCH_SIZE) + 1;

    const { error: upsertErr } = await supabase
      .from('insider_transactions')
      .upsert(batch, { onConflict: 'id', ignoreDuplicates: true });

    if (upsertErr) {
      console.error(`[insiderIngestion] ${ticker}: upsert batch ${batchNum}/${totalBatches} failed —`, upsertErr.message);
      continue;
    }
    totalUpserted += batch.length;
  }

  console.log(`[insiderIngestion] ${ticker}: upserted ${totalUpserted}/${rows.length} rows.`);

  await _hydrateFromDb(ticker);
}

/**
 * Read the most recent stored rows for `ticker` from DB and push them into
 * fundamentalsStore. Runs after every write, and also on the "already
 * current" skip path so a restarted app still hydrates from persisted data.
 */
async function _hydrateFromDb(ticker: string): Promise<void> {
  const { data, error } = await supabase
    .from('insider_transactions')
    .select('id, insider_name, insider_title, transaction_type, shares, price_per_share, total_value, is_10b5_1, filing_date, reported_at')
    .eq('ticker', ticker)
    .order('filing_date', { ascending: false })
    .limit(50);

  if (error) {
    console.error(`[insiderIngestion] ${ticker}: hydrate select failed —`, error.message);
    return;
  }
  if (!data || data.length === 0) return;

  const transactions = data.map((row) => ({
    ...dbRowToStoreShape(row),
    ticker,
  }));

  fundamentalsStore.upsertInsiderTransactions(ticker, transactions);
  console.log(`[insiderIngestion] ${ticker}: fundamentalsStore wired — ${transactions.length} rows hydrated.`);
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Run Form 4 insider transaction backfill + resumable sync for all
 * FEED_TICKERS. Called once from main.tsx — non-blocking (async, fire-and-forget).
 * Safe to call again later (e.g. on a periodic timer) — resumable per ticker.
 */
export async function runInsiderIngestion(client: MassiveRestClient): Promise<void> {
  console.log('[insiderIngestion] Starting Form 4 insider transaction ingestion…');

  for (const ticker of FEED_TICKERS) {
    try {
      await _runForTicker(client, ticker);
    } catch (e) {
      console.error(`[insiderIngestion] ${ticker}: unexpected error — ${formatError(e)}`);
    }
  }

  console.log('[insiderIngestion] Ingestion pass complete.');
}
