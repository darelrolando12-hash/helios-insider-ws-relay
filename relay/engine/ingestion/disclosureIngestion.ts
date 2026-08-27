/**
 * 8-K disclosure ingestion
 *
 * Data source: Massive /stocks/filings/8-K/vX/disclosures — confirmed real
 * endpoint, live-tested 2026-08-14. Distinct path shape from Form 4's
 * /vX/form-4 — do not assume analogous URLs elsewhere without checking docs.
 *
 * Design (same resumable pattern as insiderIngestion.ts):
 *  - Resumable: for each ticker, find the latest filing_date already stored
 *    in sec_filings_8k and fetch only from (lastDate + 1 day) forward.
 *    A restart after partial success costs zero re-fetched filings.
 *  - Window: 90 days on first run per ticker — same rationale as insider
 *    ingestion, recent disclosures are what feed catalyst scoring/gates.
 *  - Serialized: one ticker at a time, same as insider transactions.
 *  - Chunked upsert: same UPSERT_BATCH_SIZE guard as bars_1m/insider —
 *    a wide window across FEED_TICKERS could exceed the PostgREST body limit.
 *
 * Row identity:
 *  `accession_number` is the primary key (confirmed via schema inspection —
 *  NOT composite with ticker, even though one filing can list multiple
 *  tickers). Conflict target is `accession_number`.
 *
 * Category mapping — locked decisions (2026-08-14, revised 2026-08-26 against
 * the provider's published taxonomy endpoint /stocks/taxonomies/vX/disclosures):
 *  - financial_results / earnings_and_performance           → earnings
 *  - financial_results / guidance_and_outlook                → guidance
 *  - strategic_transactions / deal_agreements (acquisition_agreement)
 *    OR deal_completions (acquisition_completion)            → acquisition
 *  - strategic_transactions / deal_agreements (merger_agreement)
 *    OR deal_completions (merger_completion)                 → acquisition (folded in)
 *  - strategic_transactions / deal_agreements (divestiture_agreement) → divestiture
 *  - strategic_transactions / * (spinoff_completion)          → divestiture (folded in)
 *  - operations_and_strategy / restructuring                  → restructuring
 *  - regulatory_and_compliance / *                            → regulatory
 *  - leadership_and_governance / executive_leadership         → leadership
 *  - leadership_and_governance / corporate_control             → leadership (control
 *    acquisition, going-private, reverse merger — genuinely material, even
 *    though 0 real occurrences exist in our sample so far)
 *  - leadership_and_governance / board_of_directors            → other (routine
 *    director appointments — NOT material; previously mis-mapped to leadership)
 *  - leadership_and_governance / governance_documents          → other (bylaw/charter
 *    changes — NOT material; previously mis-mapped to leadership)
 *  - capital_and_financing / shareholder_returns (dividend_declaration,
 *    dividend_policy_change)                                  → dividend
 *  - capital_and_financing / shareholder_returns (share_repurchase_program) → buyback
 *  - capital_and_financing / debt_activity                     → debt (issuance, credit
 *    facilities, retirement — leverage moves that matter for options pricing)
 *  - capital_and_financing / equity_activity                   → equity (offerings,
 *    private placements, warrants — dilution risk)
 *  - shareholder_activity / shareholder_activism               → activism (activist
 *    stakes, proxy fights — real repricing events)
 *  - tender_offer (any tier combo)                            → other (ambiguous: could be
 *    self-tender buyback or takeover bid — real data doesn't disambiguate)
 *  - everything else (debt distress, credit ratings, impairments, litigation,
 *    cybersecurity, insider 10b5-1 plans, shareholder meetings, investor
 *    updates, unmatched combos)                                → other
 *
 * Field mapping notes:
 *  - summary  ← supporting_text (real API has no title/headline field).
 *  - filedAt  ← filing_date (date-only string, parsed as UTC midnight —
 *    consistent with how other date-only fields are handled elsewhere).
 *  - ticker   — one filing can list multiple tickers; a DB row is written
 *    per (accession_number, ticker) pair is NOT possible since the PK is
 *    accession_number alone, so we write one row per filing keyed by its
 *    first listed ticker, but hydrate fundamentalsStore for every ticker
 *    in the filing's tickers[] array so multi-ticker filings still surface
 *    on every affected ticker's cockpit views.
 *
 * TTL: none for sec_filings_8k — filings are immutable, low volume, no
 * retention window specified. Same policy as insider_transactions.
 */

import { supabase }           from '../lib/supabase';
import { MassiveRestClient, type MassiveEightKResult } from '../lib/massive/api';
import * as fundamentalsStore from '../stores/fundamentalsStore';
import type { DisclosureCategory, EightKDisclosure } from '../stores/fundamentalsStore';
import { FEED_TICKERS }       from '../state/directionState';
import { MATERIAL_CATEGORIES } from '../engines/catalystGate';

// ── Constants ─────────────────────────────────────────────────────────────────

/** Max rows per upsert batch — same guard used for bars_1m / insider ingestion. */
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

function subtractDays(dateStr: string, n: number): string {
  const d = new Date(`${dateStr}T12:00:00Z`);
  d.setDate(d.getDate() - n);
  return toDateStr(d);
}

// Re-fetch this many days before the last stored filing on every run, even
// though we already have rows in that range. A run interrupted partway
// through (network drop, tab closed) can leave the newest few rows repaired
// while older ones in the same batch stay broken — the watermark would then
// jump past that gap forever, since it only looks at "newest row I have",
// not "did I finish everything before that". Re-touching a small window
// lets DO UPDATE quietly repair anything an earlier interrupted run missed,
// on the very next scheduled call, with no manual backfill ever needed.
const WATERMARK_OVERLAP_DAYS = 7;

/**
 * Map a real disclosure's category tiers to the app's DisclosureCategory.
 * Explicit lookup against real confirmed tier strings — no fuzzy matching.
 */
export function categorize(
  primary:   string,
  secondary: string,
  tertiary:  string,
): DisclosureCategory {
  if (primary === 'financial_results' && secondary === 'earnings_and_performance') {
    return 'earnings';
  }
  if (primary === 'financial_results' && secondary === 'guidance_and_outlook') {
    return 'guidance';
  }
  if (
    primary === 'strategic_transactions' &&
    (tertiary === 'acquisition_agreement' || tertiary === 'acquisition_completion' ||
     tertiary === 'merger_agreement'      || tertiary === 'merger_completion')
  ) {
    return 'acquisition';
  }
  if (
    primary === 'strategic_transactions' &&
    (tertiary === 'divestiture_agreement' || tertiary === 'spinoff_completion')
  ) {
    return 'divestiture';
  }
  if (primary === 'operations_and_strategy' && secondary === 'restructuring') {
    return 'restructuring';
  }
  if (primary === 'regulatory_and_compliance') {
    return 'regulatory';
  }
  if (
    primary === 'leadership_and_governance' &&
    (secondary === 'executive_leadership' || secondary === 'corporate_control')
  ) {
    return 'leadership';
  }
  if (
    primary === 'capital_and_financing' && secondary === 'shareholder_returns' &&
    (tertiary === 'dividend_declaration' || tertiary === 'dividend_policy_change')
  ) {
    return 'dividend';
  }
  if (
    primary === 'capital_and_financing' && secondary === 'shareholder_returns' &&
    tertiary === 'share_repurchase_program'
  ) {
    return 'buyback';
  }
  if (primary === 'capital_and_financing' && secondary === 'debt_activity') {
    return 'debt';
  }
  if (primary === 'capital_and_financing' && secondary === 'equity_activity') {
    return 'equity';
  }
  if (primary === 'shareholder_activity' && secondary === 'shareholder_activism') {
    return 'activism';
  }
  // leadership_and_governance / board_of_directors, governance_documents — routine,
  // NOT material (previously incorrectly folded into 'leadership' above).
  // tender_offer (self-tender vs takeover bid — real data doesn't disambiguate),
  // debt_distress, credit_ratings, and everything else (impairments, litigation,
  // cybersecurity, insider 10b5-1 plans, shareholder meetings, investor updates)
  return 'other';
}

/**
 * Collapse duplicate entries sharing one accession_number down to one row.
 *
 * The provider can return several entries for the same filing: either
 * redundant text chunks (same category, different quoted excerpt — e.g. one
 * AMZN credit-facility filing returned as 4 near-identical rows), or a filing
 * that genuinely carries two classifications at once (e.g. one accession
 * tagged both equity_activity and debt_activity).
 *
 * Rule: if any duplicate's category is material, keep a material one —
 * scoring only checks "is there ANY material category present", so which
 * material one survives doesn't change the gate result. Otherwise keep the
 * first. This preserves every real scoring outcome without needing the
 * schema to hold more than one category per accession_number.
 */
function dedupeByAccession(filings: MassiveEightKResult[]): MassiveEightKResult[] {
  const byAccession = new Map<string, MassiveEightKResult>();

  for (const r of filings) {
    const existing = byAccession.get(r.accession_number);
    if (!existing) {
      byAccession.set(r.accession_number, r);
      continue;
    }
    const existingIsMaterial = MATERIAL_CATEGORIES.has(
      categorize(existing.primary_category, existing.secondary_category, existing.tertiary_category),
    );
    if (existingIsMaterial) continue; // already keeping a material row, nothing to gain

    const candidateIsMaterial = MATERIAL_CATEGORIES.has(
      categorize(r.primary_category, r.secondary_category, r.tertiary_category),
    );
    if (candidateIsMaterial) byAccession.set(r.accession_number, r);
    // else: neither is material, keep the first (existing) — no change.
  }

  return Array.from(byAccession.values());
}

/** Deterministic DB row shape — one row per filing, PK is accession_number. */
function toDbRow(r: MassiveEightKResult) {
  return {
    accession_number:   r.accession_number,
    ticker:             r.tickers[0] ?? '',
    tickers:            r.tickers,
    filed_at:           new Date(`${r.filing_date}T00:00:00Z`).toISOString(),
    items:              [],
    headline:           null,
    document_url:       r.filing_url ?? null,
    fetched_at:         new Date().toISOString(),
    primary_category:   r.primary_category,
    secondary_category: r.secondary_category,
    tertiary_category:  r.tertiary_category,
    supporting_text:    r.supporting_text,
  };
}

/** Convert a real filing result directly to the store shape for a given ticker. */
function toStoreShape(r: MassiveEightKResult, ticker: string): EightKDisclosure {
  return {
    ticker,
    category:    categorize(r.primary_category, r.secondary_category, r.tertiary_category),
    summary:     r.supporting_text ?? '',
    filedAt:     new Date(`${r.filing_date}T00:00:00Z`).getTime(),
    accessionNo: r.accession_number,
  };
}

// ── Per-ticker backfill ───────────────────────────────────────────────────────

/** Per-ticker run outcome, rolled up by runDisclosureIngestion() into one summary line. */
interface TickerRunResult {
  fetched:  number;
  upserted: number;
  errors:   number;
}

async function _runForTicker(
  client: MassiveRestClient,
  ticker: string,
  forceFullWindow = false,
): Promise<TickerRunResult> {
  const toDate   = today();
  const fullFrom = daysAgo(90);

  const { data: latestRow, error: selectErr } = await supabase
    .from('sec_filings_8k')
    .select('filed_at')
    .contains('tickers', [ticker])
    .order('filed_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (selectErr) {
    console.error(`[disclosureIngestion] ${ticker}: select failed —`, selectErr.message);
    return { fetched: 0, upserted: 0, errors: 1 };
  }

  const fromDate = forceFullWindow
    ? fullFrom
    : latestRow?.filed_at
      ? subtractDays(addOneDay((latestRow.filed_at as string).slice(0, 10)), WATERMARK_OVERLAP_DAYS)
      : fullFrom;

  if (fromDate > toDate) {
    console.log(`[disclosureIngestion] ${ticker}: current, skipping fetch.`);
    await _hydrateFromDb(ticker);
    return { fetched: 0, upserted: 0, errors: 0 };
  }

  console.log(`[disclosureIngestion] ${ticker}: fetching filings ${fromDate} → ${toDate}…`);

  let filings: MassiveEightKResult[];
  try {
    filings = await client.fetchEightKFilings(ticker, fromDate, toDate);
  } catch (e) {
    console.error(`[disclosureIngestion] ${ticker}: fetch failed —`, e);
    return { fetched: 0, upserted: 0, errors: 1 };
  }

  if (filings.length === 0) {
    console.log(`[disclosureIngestion] ${ticker}: no new filings in window.`);
    await _hydrateFromDb(ticker);
    return { fetched: 0, upserted: 0, errors: 0 };
  }

  // Provider can return multiple entries sharing one accession_number
  // (redundant text chunks, or genuinely multi-category filings) — collapse
  // to one row per accession before upserting, since accession_number is
  // the conflict target and DO UPDATE cannot touch the same row twice in
  // one statement.
  const deduped = dedupeByAccession(filings);
  const rows = deduped.map((r) => toDbRow(r));

  // ── Chunked upsert ────────────────────────────────────────────────────────
  let totalUpserted = 0;
  let upsertErrors = 0;
  const totalBatches = Math.ceil(rows.length / UPSERT_BATCH_SIZE);
  console.log(`[disclosureIngestion] ${ticker}: upserting ${rows.length} filing(s) in ${totalBatches} batch(es)…`);

  for (let i = 0; i < rows.length; i += UPSERT_BATCH_SIZE) {
    const batch = rows.slice(i, i + UPSERT_BATCH_SIZE);
    const batchNum = Math.floor(i / UPSERT_BATCH_SIZE) + 1;

    // ignoreDuplicates must stay false: a conflicting accession_number needs
    // its row overwritten (DO UPDATE), not skipped. DO NOTHING left every
    // pre-existing row permanently stuck on whatever `tickers`/category shape
    // it had at first write, even after toDbRow()/categorize() were fixed.
    const { error: upsertErr } = await supabase
      .from('sec_filings_8k')
      .upsert(batch, { onConflict: 'accession_number', ignoreDuplicates: false });

    if (upsertErr) {
      console.error(`[disclosureIngestion] ${ticker}: upsert batch ${batchNum}/${totalBatches} failed —`, upsertErr.message);
      upsertErrors += 1;
      continue;
    }
    totalUpserted += batch.length;
  }

  console.log(`[disclosureIngestion] ${ticker}: upserted ${totalUpserted}/${rows.length} rows (${filings.length} entries fetched, ${filings.length - deduped.length} duplicate accession(s) collapsed).`);

  // Push straight from the fetched results into every listed ticker's store
  // entry — covers multi-ticker filings even though only one DB row exists.
  for (const filing of filings) {
    for (const t of filing.tickers) {
      if (!FEED_TICKERS.includes(t as typeof FEED_TICKERS[number])) continue;
      fundamentalsStore.upsertDisclosures(t, [toStoreShape(filing, t)]);
    }
  }

  return { fetched: filings.length, upserted: totalUpserted, errors: upsertErrors };
}

/**
 * Read the most recent stored rows for `ticker` from DB and push them into
 * fundamentalsStore. Runs after every write, and also on the "already
 * current" skip path so a restarted app still hydrates from persisted data.
 */
async function _hydrateFromDb(ticker: string): Promise<void> {
  const { data, error } = await supabase
    .from('sec_filings_8k')
    .select('accession_number, filed_at, primary_category, secondary_category, tertiary_category, supporting_text')
    .contains('tickers', [ticker])
    .order('filed_at', { ascending: false })
    .limit(50);

  if (error) {
    console.error(`[disclosureIngestion] ${ticker}: hydrate select failed —`, error.message);
    return;
  }
  if (!data || data.length === 0) return;

  const disclosures: EightKDisclosure[] = data.map((row) => ({
    ticker,
    category:    categorize(
      (row.primary_category as string) ?? '',
      (row.secondary_category as string) ?? '',
      (row.tertiary_category as string) ?? '',
    ),
    summary:     (row.supporting_text as string) ?? '',
    filedAt:     new Date(row.filed_at as string).getTime(),
    accessionNo: row.accession_number as string,
  }));

  fundamentalsStore.upsertDisclosures(ticker, disclosures);
  console.log(`[disclosureIngestion] ${ticker}: fundamentalsStore wired — ${disclosures.length} rows hydrated.`);
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Run 8-K disclosure backfill + resumable sync for all FEED_TICKERS.
 * Called once from main.tsx — non-blocking (async, fire-and-forget).
 * Safe to call again later (e.g. on a periodic timer) — resumable per ticker.
 *
 * @param forceFullWindow  One-off manual flag to re-fetch each ticker's full
 * 90-day window instead of resuming from its watermark. Only needed to clear
 * a pre-existing backlog (e.g. rows written before the watermark overlap
 * existed); the periodic scheduled call below never passes this — the 7-day
 * overlap keeps normal runs self-healing without a full re-fetch.
 */
export async function runDisclosureIngestion(
  client: MassiveRestClient,
  forceFullWindow = false,
): Promise<void> {
  console.log('[disclosureIngestion] Starting 8-K disclosure ingestion…');

  let totalFetched  = 0;
  let totalUpserted = 0;
  let totalErrors   = 0;

  for (const ticker of FEED_TICKERS) {
    try {
      const result = await _runForTicker(client, ticker, forceFullWindow);
      totalFetched  += result.fetched;
      totalUpserted += result.upserted;
      totalErrors   += result.errors;
    } catch (e) {
      console.error(`[disclosureIngestion] ${ticker}: unexpected error —`, e);
      totalErrors += 1;
    }
  }

  console.log(
    `[disclosureIngestion] run complete — fetched ${totalFetched}, upserted ${totalUpserted}, errors ${totalErrors}`,
  );
}
