/**
 * Layer 1 — fundamentalsStore
 *
 * Batch/scheduled REST data — different update rhythm from every other store.
 * Written by cron jobs (Short Interest, Short Volume: daily after market close;
 * Insider Transactions: on Form 4 filing event; 8-K Disclosures: on SEC event;
 * Financials/Ratios: weekly or on earnings). No WebSocket involvement.
 *
 * All cron writes use upsert with explicit conflict target — never plain insert.
 * Engineering Lesson #8: cron execution is not guaranteed exactly-once.
 *
 * isDataReady(ticker):
 *   'ready' iff at least one data category has been written for the ticker.
 *   Individual category fields may be null if not yet fetched — consumers
 *   check per-field nullability, not the top-level status alone.
 *
 * Swing Cockpit note:
 *   Financial ratios (P/E, EV/EBITDA, etc.) are stored here and exposed only
 *   to the Swing Trade Cockpit. They are intentionally excluded from 0DTE —
 *   fundamentals are noise at that timeframe, real signal for swing trades.
 */

import type {
  InsiderTransaction,
  ShortInterestSnapshot,
  Result,
} from './types.ts';
import { ready, loading } from './types.ts';

// ── 8-K Disclosure ────────────────────────────────────────────────────────────

export type DisclosureCategory =
  | 'earnings'
  | 'guidance'
  | 'acquisition'
  | 'divestiture'
  | 'restructuring'
  | 'regulatory'
  | 'leadership'
  | 'dividend'
  | 'buyback'
  | 'debt'
  | 'equity'
  | 'activism'
  | 'other';

export interface EightKDisclosure {
  ticker:      string;
  category:    DisclosureCategory;
  summary:     string;  // from real API's supporting_text — no title field exists
  filedAt:     number;  // UTC ms
  accessionNo: string;  // SEC EDGAR accession number — unique per filing
}

// ── Financial Ratios (Swing Cockpit only) ─────────────────────────────────────

export interface FinancialRatios {
  /** Price-to-Earnings ratio */
  pe?: number;
  /** Enterprise Value / EBITDA */
  evEbitda?: number;
  /** Price-to-Book ratio */
  pb?: number;
  /** Price-to-Sales ratio */
  ps?: number;
  /** Debt-to-Equity ratio */
  debtEquity?: number;
  /** Return on Equity */
  roe?: number;
  /** Return on Assets */
  roa?: number;
  /** Free Cash Flow Yield */
  fcfYield?: number;
  /** UTC ms of the financial period this snapshot covers */
  periodEnd: number;
}

// ── Upcoming Earnings (forward-looking calendar) ──────────────────────────────

/**
 * A real, forward-looking earnings date from Nasdaq's public calendar API —
 * see ingestion/earningsCalendarIngestion.ts. Distinct from EightKDisclosure
 * above: an 8-K can only ever report something that already happened
 * (filedAt is always a past timestamp), so it structurally cannot answer
 * "is earnings coming up". This type exists specifically to answer that.
 */
export interface UpcomingEarnings {
  /** YYYY-MM-DD — the real calendar date Nasdaq expects this ticker to report. */
  reportDate: string;
  timing: 'bmo' | 'amc' | 'unknown';
  epsForecast: number | null;
  numEstimates: number | null;
  /**
   * No confirmed/estimated distinction exists in this free source (unlike
   * Benzinga's paid /benzinga/v1/earnings, which has a real date_status
   * field) — every date here is Nasdaq's own expectation, presented flat.
   * A cross-referenced confidence signal is a planned fast-follow, not
   * implemented yet — do not invent a confidence field here that the
   * ingestion code doesn't actually compute.
   */
  fetchedAt: number; // UTC ms
}

// ── Free Float ─────────────────────────────────────────────────────────────────

/**
 * Real free-float snapshot from Massive's /stocks/vX/float endpoint (2026-09-02).
 * Distinct refresh cadence from short interest — float changes quarterly-ish
 * (buybacks/issuance); short interest reports bi-weekly. Storing raw shares
 * here (not a derived percentage) so short_pct_float can be recomputed
 * whenever EITHER this or shortInterest updates, in whichever order they
 * arrive — see upsertFreeFloat/upsertShortInterest below.
 */
export interface FreeFloat {
  /** Shares freely tradable in the market. */
  shares: number;
  /** Massive's own float % of shares outstanding, when present — informational only, not used to derive shortFloat. */
  percentOfOutstanding: number | null;
  /** YYYY-MM-DD, Massive's effective_date for this snapshot. */
  effectiveDate: string;
  fetchedAt: number; // UTC ms
}

// ── FundamentalsData ──────────────────────────────────────────────────────────

export interface FundamentalsData {
  ticker: string;

  /**
   * Most recent short interest snapshot.
   * null until the cron has run at least once for this ticker.
   *
   * shortFloat on this snapshot is DERIVED (short_interest / freeFloat.shares
   * * 100) by this store, not read directly off Massive's short-interest
   * response — that field (short_pct_float) does not exist in the real API
   * (confirmed live and against Massive's own docs, 2026-09-02: 0/483 real
   * reports across all FEED_TICKERS ever had it, and the endpoint's
   * documented field list doesn't include it at all). Requires freeFloat to
   * be known; undefined until both real inputs are available.
   */
  shortInterest: ShortInterestSnapshot | null;

  /**
   * Raw free-float shares, from a separate endpoint/cadence — see FreeFloat
   * above. null until the float cron has run at least once for this ticker.
   */
  freeFloat: FreeFloat | null;

  /**
   * Raw short volume data — separate from shortInterest (different endpoints,
   * different reporting cadences). Swing and 0DTE cockpits both read this.
   */
  shortVolume: number | null;

  /**
   * Short volume as a percentage of total reported volume for the period.
   * Derived field: shortVolume / reportedVolume * 100.
   */
  shortVolumeRatio: number | null;

  /**
   * Whether short volume was actually, successfully fetched for this ticker
   * — 'real' once a fetch has succeeded (regardless of the computed ratio),
   * 'absent' if it never has. shortVolumeRatio === null is ambiguous alone:
   * it means either "fetched, genuinely nothing to report" or "the fetch
   * hasn't completed" (a real, plausible state — short interest and short
   * volume are two separate sequential calls per ticker). squeezeEngine
   * must read this rather than treat a null ratio as a confirmed 0%.
   */
  shortVolumeDataQuality: 'real' | 'absent';

  /**
   * Insider transactions from Form 4 — ALL transaction types and both
   * 10b5-1 states, unfiltered (see upsertInsiderTransactions below for why:
   * an earlier version of this comment claimed write-time filtering that
   * never actually existed — stale and corrected 2026-09-02, caught the
   * same way `insiderSell`'s dead-code claim was, by checking the comment
   * against the real code rather than trusting it). Filtering to
   * discretionary buy/sell happens at READ time in catalystGate.ts.
   * Array is sorted descending by transactedAt.
   */
  insiderTransactions: InsiderTransaction[];

  /**
   * Whether insider data was actually, successfully checked for this
   * ticker — 'real' once any fetch (even a genuine zero-result one) or DB
   * hydrate has succeeded, 'absent' if it never has. Distinct from
   * `insiderTransactions.length === 0`, which is ambiguous on its own: a
   * ticker genuinely checked with no recent activity and a ticker whose
   * Form 4 fetch has simply never succeeded both produce an empty array —
   * this field is what tells them apart. Never downgraded by a later
   * transient failure once 'real' — see insiderIngestion.ts.
   */
  insiderDataQuality: 'real' | 'absent';

  /**
   * Recent 8-K filings, pre-categorized using Massive taxonomy endpoint.
   * Both cockpits read this for catalyst context.
   */
  recentDisclosures: EightKDisclosure[];

  /**
   * Financial ratios — Swing Cockpit only.
   * null for any ticker where financials haven't been fetched.
   * 0DTE cockpit must not render this field even if non-null.
   */
  ratios: FinancialRatios | null;

  /**
   * The nearest real, forward-looking earnings date, from Nasdaq's public
   * calendar. null means no upcoming date was found within the ingestion
   * job's scanned window (LOOKAHEAD_DAYS in earningsCalendarIngestion.ts) —
   * that is "absent within this window", never a proven "no earnings ever".
   * Consumers checking earnings-proximity must still apply their own window
   * check against reportDate (see catalystGate.ts) rather than treating a
   * non-null value alone as "soon".
   */
  upcomingEarnings: UpcomingEarnings | null;

  /** UTC ms of the most recent write to this record (any field). */
  lastUpdatedAt: number;
}

// ── Internal state ────────────────────────────────────────────────────────────

const _state     = new Map<string, FundamentalsData>();
const _listeners = new Set<() => void>();

// ── Public read API ───────────────────────────────────────────────────────────

/**
 * Get the current Result<FundamentalsData> for `ticker`.
 *
 * status: 'loading' — cron hasn't written data yet.
 * status: 'ready'   — at least one write has occurred; individual fields
 *                     may still be null if their specific cron hasn't run.
 */
export function getResult(ticker: string): Result<FundamentalsData> {
  const data = _state.get(ticker);
  if (!data) return loading();
  return ready(data, data.lastUpdatedAt);
}

export function isDataReady(ticker: string): boolean {
  return getResult(ticker).status === 'ready';
}

/**
 * Return all tickers that have ever had any fundamentals data written.
 * Used by squeezeEngine to enumerate tickers to re-score on fundamentals update.
 */
export function getTickers(): string[] {
  return Array.from(_state.keys());
}

export function subscribe(listener: () => void): () => void {
  _listeners.add(listener);
  return () => _listeners.delete(listener);
}

// ── Write API — called by cron jobs only ─────────────────────────────────────

/**
 * short_interest / freeFloat * 100 — the real formula (Fintel/ORTEX/
 * MarketBeat all use this), NOT read directly from Massive (there is no
 * such field in the real short-interest response). Pure, exported for tests.
 */
export function computeShortPctOfFloat(shortInterestShares: number, freeFloatShares: number): number | null {
  if (!Number.isFinite(shortInterestShares) || !Number.isFinite(freeFloatShares) || freeFloatShares <= 0) {
    return null;
  }
  return (shortInterestShares / freeFloatShares) * 100;
}

/**
 * Upsert short interest snapshot for `ticker`.
 *
 * Uses an explicit conflict target (ticker) — caller must ensure only one
 * record per ticker is active. Never append without deduplicating.
 * Engineering Lesson #8.
 *
 * snapshot.shortFloat, if the caller set it, is IGNORED and recomputed here
 * from the store's own freeFloat state — single source of truth for the
 * derivation, see computeShortPctOfFloat. If freeFloat isn't known yet,
 * shortFloat is left undefined (not a fake 0) until it arrives — see
 * upsertFreeFloat below, which recomputes this the other direction.
 */
export function upsertShortInterest(ticker: string, snapshot: ShortInterestSnapshot) {
  const data = _getOrCreate(ticker);
  const shortFloat = data.freeFloat
    ? computeShortPctOfFloat(snapshot.shortInterest, data.freeFloat.shares) ?? undefined
    : undefined;
  data.shortInterest = { ...snapshot, shortFloat };

  // Derive shortVolumeRatio if shortVolume is available
  if (snapshot.shortVolume !== undefined && snapshot.shortVolume > 0) {
    data.shortVolume = snapshot.shortVolume;
    // shortVolumeRatio requires total volume — store raw value; ratio computed
    // when total volume is also available via upsertShortVolume().
  }

  data.lastUpdatedAt = Date.now();
  _state.set(ticker, data);
  _notify();
}

/**
 * Upsert the raw free-float snapshot for `ticker` and, if a short interest
 * snapshot already exists, recompute its shortFloat with the fresh float
 * value. Handles arrival in either order (float-before-short-interest or
 * the reverse) — whichever of the two updates last is what triggers the
 * recompute using the other's already-stored value.
 */
export function upsertFreeFloat(ticker: string, freeFloat: FreeFloat) {
  const data = _getOrCreate(ticker);
  data.freeFloat = freeFloat;

  if (data.shortInterest) {
    const shortFloat = computeShortPctOfFloat(data.shortInterest.shortInterest, freeFloat.shares) ?? undefined;
    data.shortInterest = { ...data.shortInterest, shortFloat };
  }

  data.lastUpdatedAt = Date.now();
  _state.set(ticker, data);
  _notify();
}

/**
 * Upsert raw short volume and compute ratio.
 *
 * `reportedVolume` is the total market volume for the reporting period,
 * used to derive shortVolumeRatio. Sourced from the short-volume endpoint.
 *
 * shortVolumeDataQuality is set to 'real' unconditionally on any call here
 * — a real fetch succeeded, regardless of whether the ratio computed to a
 * real number or null (reportedVolume <= 0 is itself real information, not
 * an absence). Never call this on a failed fetch.
 */
export function upsertShortVolume(
  ticker:          string,
  shortVolume:     number,
  reportedVolume:  number,
) {
  const data = _getOrCreate(ticker);
  data.shortVolume      = shortVolume;
  data.shortVolumeRatio = reportedVolume > 0
    ? (shortVolume / reportedVolume) * 100
    : null;
  data.shortVolumeDataQuality = 'real';
  data.lastUpdatedAt    = Date.now();
  _state.set(ticker, data);
  _notify();
}

/**
 * Upsert insider transactions for `ticker`.
 *
 * Stores every transaction type and both 10b5-1 states as-is — no write-time
 * filtering. "Which rows matter most" is a display-layer judgment (the
 * cockpit's filter tabs + pill color), not a store-level decision. An earlier
 * version of this function dropped every sell and every 10b5-1 transaction
 * before it reached the store, which made the Sells/10b5-1 filter tabs and
 * the pill's two-color contrast structurally impossible — that was the bug,
 * not the cockpit's expectations.
 * Deduplicates by (insiderName + transactedAt) as conflict target.
 * Merges with existing transactions; result is sorted descending by transactedAt.
 */
export function upsertInsiderTransactions(
  ticker:       string,
  transactions: InsiderTransaction[],
) {
  const data = _getOrCreate(ticker);

  // Deduplicate against existing by real DB id (accession_number + owner_cik +
  // security_type + transaction_code + transaction_date) — insiderName+transactedAt
  // is not unique: one filing can carry multiple transaction lines for the same
  // owner on the same date (e.g. a derivative + non-derivative line).
  const existing = new Set(data.insiderTransactions.map((t) => t.id));
  const newOnes = transactions.filter((t) => !existing.has(t.id));

  data.insiderTransactions = [
    ...data.insiderTransactions,
    ...newOnes,
  ].sort((a, b) => b.transactedAt - a.transactedAt);

  data.insiderDataQuality = 'real'; // a real upsert call is itself proof of a successful check
  data.lastUpdatedAt = Date.now();
  _state.set(ticker, data);
  _notify();
}

/**
 * Mark that insider data was successfully checked for `ticker`, independent
 * of whether any transactions were found. Needed because
 * upsertInsiderTransactions is never called on a genuine zero-result check
 * (empty fetch, empty DB hydrate) — without this, a ticker with truly no
 * recent insider activity is indistinguishable from one whose fetch has
 * simply never succeeded. Only ever call with 'real' — there is
 * deliberately no way to set 'absent' explicitly; the default already
 * covers "never checked", and a later transient failure must not downgrade
 * a ticker that was genuinely checked before (see insiderIngestion.ts).
 */
export function markInsiderDataChecked(ticker: string) {
  const data = _getOrCreate(ticker);
  if (data.insiderDataQuality === 'real') return; // already real — no-op, no spurious notify
  data.insiderDataQuality = 'real';
  data.lastUpdatedAt = Date.now();
  _state.set(ticker, data);
  _notify();
}

/**
 * Upsert 8-K disclosures for `ticker`.
 *
 * Deduplicates by accessionNo (unique per SEC filing).
 */
export function upsertDisclosures(
  ticker:      string,
  disclosures: EightKDisclosure[],
) {
  const data = _getOrCreate(ticker);

  const existing = new Set(data.recentDisclosures.map((d) => d.accessionNo));
  const newOnes  = disclosures.filter((d) => !existing.has(d.accessionNo));

  data.recentDisclosures = [
    ...data.recentDisclosures,
    ...newOnes,
  ].sort((a, b) => b.filedAt - a.filedAt);

  data.lastUpdatedAt = Date.now();
  _state.set(ticker, data);
  _notify();
}

/**
 * Upsert financial ratios for `ticker`.
 * Swing Cockpit only — conflict target is ticker (one active ratio record per ticker).
 */
export function upsertRatios(ticker: string, ratios: FinancialRatios) {
  const data = _getOrCreate(ticker);
  data.ratios        = ratios;
  data.lastUpdatedAt = Date.now();
  _state.set(ticker, data);
  _notify();
}

/**
 * Upsert the nearest upcoming earnings date for `ticker`.
 *
 * Overwrite-only, never explicitly cleared: if a later ingestion run finds
 * nothing for this ticker within its scanned window, that is "not found in
 * THIS window", not "confirmed no earnings" — actively nulling the field
 * would assert something the caller never checked. A stored date past its
 * own window simply reads as "not soon" via the caller's own date
 * comparison (see catalystGate.ts) — no mutation needed to make that true.
 */
export function upsertUpcomingEarnings(ticker: string, entry: UpcomingEarnings) {
  const data = _getOrCreate(ticker);
  data.upcomingEarnings = entry;
  data.lastUpdatedAt    = Date.now();
  _state.set(ticker, data);
  _notify();
}

// ── Internal ──────────────────────────────────────────────────────────────────

function _getOrCreate(ticker: string): FundamentalsData {
  const existing = _state.get(ticker);
  if (existing) return existing;

  const blank: FundamentalsData = {
    ticker,
    shortInterest:          null,
    freeFloat:              null,
    shortVolume:            null,
    shortVolumeRatio:       null,
    shortVolumeDataQuality: 'absent',
    insiderTransactions:    [],
    insiderDataQuality:     'absent',
    recentDisclosures:      [],
    ratios:                 null,
    upcomingEarnings:       null,
    lastUpdatedAt:          0,
  };
  _state.set(ticker, blank);
  return blank;
}

function _notify() {
  for (const fn of _listeners) fn();
}
