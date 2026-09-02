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
 *  - transaction_type: derived from transaction_code (SEC's own General
 *    Transaction Codes), NOT from transaction_acquired_disposed. See the
 *    correction below — this was wrong for months before 2026-09-02.
 *
 * ── transaction_type correction (2026-09-02) ───────────────────────────────
 * Previously derived from transaction_acquired_disposed alone ('A' → buy,
 * 'D' → sell). Real, quantified impact, audited 2026-09-02: of 136 real
 * "A" (acquired) rows across 7 FEED_TICKERS over 3 months, only 3 (2.2%)
 * were code 'P' (a genuine open-market purchase). 48 (35.3%) were code 'A'
 * — a company-granted compensation award, not a discretionary buy — and 85
 * (62.5%) were code 'M' — a derivative/option exercise, also not a fresh
 * open-market purchase. The existing !is10b51 filter in catalystGate.ts did
 * essentially nothing to screen these out (48/48 grants and 64/85 exercises
 * passed it unchanged) because 10b5-1 status is orthogonal to whether a
 * transaction happened on the open market at all.
 *
 * Confirmed against a real SEC Form 5 filing's own instructions plus four
 * independent sources, all converging on the same convention: P/S ("General
 * Transaction Codes") are a structurally distinct category from A/D/F/M/G/
 * C/J/I ("Rule 16b-3" and "Derivative Securities" codes) — not a less-common
 * variant, a different KIND of event. Only P (buy) and S (sell, still gated
 * by !is10b51 exactly as before) represent a real, voluntary, open-market
 * transaction. Every other code — grants, exercises, gifts, conversions,
 * dispositions back to the issuer — is neither, regardless of which
 * direction transaction_acquired_disposed happens to report.
 *
 * TTL: none for insider_transactions — filings are immutable, low volume,
 * and no retention window was specified. Revisit if row count history
 * warrants pruning.
 */

import { supabase }           from '../lib/supabase.ts';
import { MassiveRestClient, type MassiveForm4Result } from '../lib/massive/api.ts';
import * as fundamentalsStore from '../stores/fundamentalsStore.ts';
import { FEED_TICKERS }       from '../state/directionState.ts';
import type { InsiderTransaction } from '../stores/types.ts';

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
 *
 * ── shares_owned_following_transaction added to the 'transaction' branch
 *    too (2026-09-02) ──────────────────────────────────────────────────────
 * Real collision found running the ignoreDuplicates:false fix for real (a
 * batch containing two rows with the same id fails the whole batch outright
 * — "ON CONFLICT DO UPDATE command cannot affect row a second time" — a
 * failure ignoreDuplicates:true had been silently absorbing this whole
 * time, the same "redundancy was hiding a fault" shape as the LULD/N²
 * broadcast incident in CLAUDE.md). Real example, NVDA accession
 * 0001199039-26-000005: one insider sold 100,000 shares at a weighted-avg
 * $217.655, then 400,000 more at $220.371, same day, same code (S), same
 * accession — SEC requires separate lines when a sale crosses a material
 * price band within the day. accession+owner+security_type+code+date is
 * NOT unique for this real, legitimate case. shares_owned_following_
 * transaction is a running total that differs after any real nonzero-share
 * transaction, so it disambiguates real same-day multi-tranche filings the
 * same way it already disambiguates holding rows above.
 *
 * ── nature_of_ownership added (2026-09-02, same pass) ──────────────────────
 * Even with the above fix, a real residual collision remained: NVDA
 * accession 0001197649-26-000008 reports TWO holding rows for HUANG JEN
 * HSUN — same accession, owner, security_type, direct_or_indirect ('I'),
 * AND the same shares_owned_following_transaction (6,632,667) — because two
 * genuinely different indirect ownership vehicles (real footnotes: "TARG S1
 * LLC" vs "TARG M1 LLC") happened to report an identical share count.
 * nature_of_ownership ("By Limited Liability Company 1" vs "...2") is the
 * only field that actually distinguishes them. Included on both branches —
 * a real, always-safe additional discriminator, not just the holding case
 * it was first found on.
 *
 * ── security_title added (2026-09-02, same pass) ────────────────────────────
 * Still a real collision after the above: GOOGL accession
 * 0001193125-26-274727 reports two holding rows for the same trust, same
 * accession, same running share total (199,100 — again a real coincidence)
 * — one for "Class A Common Stock", one for "Class C Capital Stock". Real,
 * genuinely different instruments. security_type ('non_derivative' /
 * 'derivative') is too coarse to catch this; security_title is the actual
 * specific instrument description and is always present on a real row.
 *
 * ── transaction_shares + transaction_price_per_share ADDED alongside
 *    shares_owned_following_transaction, not instead of it (2026-09-02) ────
 * Even with every fix above, 5 real collisions remained across NFLX, PLTR,
 * SOFI and MSTR. Root cause: shares_owned_following_transaction alone is
 * NOT reliable — real filings routinely report it as the SAME value across
 * genuinely distinct lines, two different shapes of this:
 *   - Multiple option-lot exercises in one filing all settle to the
 *     underlying non-derivative side, so the derivative line's own running
 *     total is 0 for every lot (real NFLX example: 6 distinct option
 *     exercises, 6 different exercise prices/share counts, ALL with
 *     shares_owned_following_transaction = 0).
 *   - SEC allows reporting ONE end-of-day running total for a "related
 *     series of transactions" rather than a per-line total (real PLTR/MSTR
 *     examples: 2-3 real same-day sale tranches at genuinely different
 *     sizes and weighted-average prices, all sharing one post-day total).
 * transaction_shares/transaction_price_per_share catch those. An EARLIER
 * version of this fix REPLACED shares_owned_following_transaction with
 * these two fields and regressed GOOGL back to 15 collisions: two DEU/GSU
 * grant tranches for the same director, same date/code, same 1-share/$0
 * line shape, differ ONLY by running total (accession
 * 0001193125-26-274731, Ferguson — 1558 vs 1026 shares owned after).
 * Neither field is sufficient alone; all three are combined below.
 * Verified live against all 23 FEED_TICKERS with all three combined:
 * 0 colliding keys across 1,734 real rows.
 */
export function form4RowId(r: MassiveForm4Result): string {
  const ownership = r.nature_of_ownership ?? 'na';
  const line = `${r.shares_owned_following_transaction ?? 'na'}_${r.transaction_shares ?? 'na'}_${r.transaction_price_per_share ?? 'na'}`;
  if (r.record_type === 'holding') {
    return `${r.accession_number}_${r.owner_cik}_${r.security_type}_${r.security_title}_holding_${r.direct_or_indirect ?? 'na'}_${r.shares_owned_following_transaction ?? 'na'}_${ownership}`;
  }
  return `${r.accession_number}_${r.owner_cik}_${r.security_type}_${r.security_title}_${r.transaction_code}_${r.transaction_date}_${line}_${ownership}`;
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

/**
 * 'buy'/'sell' only for SEC's real General Transaction Codes P/S — a genuine
 * open-market or private purchase/sale. Every other real code (A grant, D
 * disposition-to-issuer, F tax withholding, M derivative exercise, G gift,
 * C conversion, J other, I discretionary, K equity swap, V transaction
 * voluntarily reported, W will/trust, X exercise of in-the-money, Z deposit/
 * withdrawal from voting trust) is 'other' — regardless of which direction
 * transaction_acquired_disposed reports. See this file's header for the
 * real, quantified reason this stopped inferring from A/D alone.
 */
export function resolveTransactionType(r: MassiveForm4Result): 'buy' | 'sell' | 'other' {
  if (r.transaction_code === 'P') return 'buy';
  if (r.transaction_code === 'S') return 'sell';
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
  forceFullWindow = false,
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

  const fromDate = forceFullWindow
    ? fullFrom
    : latestRow?.filing_date
      ? addOneDay(latestRow.filing_date as string)
      : fullFrom;

  if (fromDate > toDate) {
    console.log(`[insiderIngestion] ${ticker}: current, skipping fetch.`);
    // A successful select confirming "already current" IS a real check —
    // mark it even though nothing gets fetched or upserted this run.
    fundamentalsStore.markInsiderDataChecked(ticker);
    await _hydrateFromDb(ticker);
    return;
  }

  console.log(`[insiderIngestion] ${ticker}: fetching filings ${fromDate} → ${toDate}…`);

  let filings: MassiveForm4Result[];
  try {
    filings = await client.fetchForm4Filings(ticker, fromDate, toDate);
  } catch (e) {
    // Deliberately NOT marking checked here — a failed fetch tells us
    // nothing real. Leaves insiderDataQuality at whatever it was, per
    // markInsiderDataChecked's "never downgrade" contract.
    console.error(`[insiderIngestion] ${ticker}: fetch failed —`, e);
    return;
  }

  // The fetch itself succeeded — real information, even if it's a real zero.
  fundamentalsStore.markInsiderDataChecked(ticker);

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

    // ignoreDuplicates must stay false: same bug shape as disclosureIngestion.ts
    // (see that file's comment). A conflicting id needs its row overwritten
    // (DO UPDATE), not skipped — DO NOTHING would leave every pre-existing
    // row permanently stuck on whatever transaction_type the OLD (buggy,
    // A/D-derived) resolveTransactionType() computed, even after the
    // 2026-09-02 fix. NOTE this alone is not sufficient: the resumable
    // watermark means a ticker with no NEW filings since the fix never gets
    // its old rows re-fetched at all, so this upsert never even runs against
    // them. See runInsiderIngestion's forceFullWindow param — a one-off
    // manual run with it set is what actually re-touches every existing row.
    const { error: upsertErr } = await supabase
      .from('insider_transactions')
      .upsert(batch, { onConflict: 'id', ignoreDuplicates: false });

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
  if (!data || data.length === 0) {
    // A successful, empty select is still a real check — the DB genuinely
    // has zero rows for this ticker, distinct from "never successfully queried".
    fundamentalsStore.markInsiderDataChecked(ticker);
    return;
  }

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
 *
 * @param forceFullWindow  One-off manual flag to re-fetch each ticker's full
 * 90-day window instead of resuming from its watermark. Required to correct
 * EXISTING rows after the 2026-09-02 resolveTransactionType() fix: the
 * normal resumable path only re-fetches dates after the latest stored
 * filing_date, so a ticker with no NEW filings since the fix would never
 * have its old, mislabeled rows re-touched at all, regardless of
 * ignoreDuplicates. This flag is the same escape hatch
 * disclosureIngestion.ts already has, for the same reason. Run once,
 * manually, after deploying the fix; the periodic scheduled call never
 * passes this.
 */
export async function runInsiderIngestion(
  client: MassiveRestClient,
  forceFullWindow = false,
): Promise<void> {
  console.log('[insiderIngestion] Starting Form 4 insider transaction ingestion…');

  for (const ticker of FEED_TICKERS) {
    try {
      await _runForTicker(client, ticker, forceFullWindow);
    } catch (e) {
      console.error(`[insiderIngestion] ${ticker}: unexpected error —`, e);
    }
  }

  console.log('[insiderIngestion] Ingestion pass complete.');
}
