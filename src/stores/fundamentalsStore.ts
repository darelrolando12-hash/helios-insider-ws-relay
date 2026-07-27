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
} from './types';
import { ready, loading } from './types';

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
  | 'other';

export interface EightKDisclosure {
  ticker:      string;
  category:    DisclosureCategory;
  title:       string;
  summary:     string;
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

// ── FundamentalsData ──────────────────────────────────────────────────────────

export interface FundamentalsData {
  ticker: string;

  /**
   * Most recent short interest snapshot.
   * null until the cron has run at least once for this ticker.
   */
  shortInterest: ShortInterestSnapshot | null;

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
   * Insider transactions from Form 4, filtered to discretionary buys only.
   * Transactions where is10b51 === true are excluded at write time — they are
   * scheduled sales, not discretionary signals (per spec).
   * Array is sorted descending by transactedAt.
   */
  insiderTransactions: InsiderTransaction[];

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

export function subscribe(listener: () => void): () => void {
  _listeners.add(listener);
  return () => _listeners.delete(listener);
}

// ── Write API — called by cron jobs only ─────────────────────────────────────

/**
 * Upsert short interest snapshot for `ticker`.
 *
 * Uses an explicit conflict target (ticker) — caller must ensure only one
 * record per ticker is active. Never append without deduplicating.
 * Engineering Lesson #8.
 */
export function upsertShortInterest(ticker: string, snapshot: ShortInterestSnapshot) {
  const data = _getOrCreate(ticker);
  data.shortInterest = snapshot;

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
 * Upsert raw short volume and compute ratio.
 *
 * `reportedVolume` is the total market volume for the reporting period,
 * used to derive shortVolumeRatio. Sourced from the short-volume endpoint.
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
  data.lastUpdatedAt    = Date.now();
  _state.set(ticker, data);
  _notify();
}

/**
 * Upsert insider transactions for `ticker`.
 *
 * Filters out 10b5-1 transactions at write time — they never reach consumers.
 * Deduplicates by (insiderName + transactedAt) as conflict target.
 * Merges with existing transactions; result is sorted descending by transactedAt.
 */
export function upsertInsiderTransactions(
  ticker:       string,
  transactions: InsiderTransaction[],
) {
  const data = _getOrCreate(ticker);

  // Filter: only non-10b5-1 buys surface as signals (per spec)
  const discretionaryBuys = transactions.filter(
    (t) => !t.is10b51 && t.transactionType === 'buy'
  );

  // Deduplicate against existing by (insiderName + transactedAt)
  const existing = new Set(
    data.insiderTransactions.map((t) => `${t.insiderName}:${t.transactedAt}`)
  );
  const newOnes = discretionaryBuys.filter(
    (t) => !existing.has(`${t.insiderName}:${t.transactedAt}`)
  );

  data.insiderTransactions = [
    ...data.insiderTransactions,
    ...newOnes,
  ].sort((a, b) => b.transactedAt - a.transactedAt);

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

// ── Internal ──────────────────────────────────────────────────────────────────

function _getOrCreate(ticker: string): FundamentalsData {
  const existing = _state.get(ticker);
  if (existing) return existing;

  const blank: FundamentalsData = {
    ticker,
    shortInterest:       null,
    shortVolume:         null,
    shortVolumeRatio:    null,
    insiderTransactions: [],
    recentDisclosures:   [],
    ratios:              null,
    lastUpdatedAt:       0,
  };
  _state.set(ticker, blank);
  return blank;
}

function _notify() {
  for (const fn of _listeners) fn();
}
