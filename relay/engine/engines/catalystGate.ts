/**
 * Layer 2 — catalystGate
 *
 * Tags each ticker with active catalyst flags derived from fundamentalsStore.
 * The confluenceEngine reads these tags as signal modifiers.
 *
 * Inputs:
 *   fundamentalsStore.recentDisclosures  — 8-K, pre-categorized
 *   fundamentalsStore.insiderTransactions — all real transactions (buys, sells,
 *                      both 10b5-1 states); filtering to discretionary buys/sells
 *                      happens here in computeTags(), not at the store level
 *
 * Output (CatalystTags per ticker):
 *   earningsPending  — an earnings-category 8-K filed within the last 7 days
 *   materialEvent    — a material 8-K category (acquisition, restructuring,
 *                      regulatory, leadership) filed within the last 3 days
 *   insiderBuy       — at least one non-10b5-1 buy filed within the last 30 days
 *   insiderSell      — at least one non-10b5-1 sell filed within the last 30 days
 *                      (surfaced as a negative modifier in confluenceEngine)
 *
 * This module is stateless — computeTags() is a pure function.
 * No store writes, no event emission.
 */

import type { FundamentalsData, EightKDisclosure, DisclosureCategory, UpcomingEarnings } from '../stores/fundamentalsStore.ts';

// ── CatalystTags ──────────────────────────────────────────────────────────────

export interface CatalystTags {
  earningsPending: boolean;
  materialEvent:   boolean;
  insiderBuy:      boolean;
  insiderSell:     boolean;

  /**
   * Whether insider data was actually, successfully checked for this ticker
   * — carried straight from fundamentalsStore.insiderDataQuality (see that
   * field's comment). `insiderBuy`/`insiderSell` being false is ambiguous on
   * its own: it means either "checked, genuinely nothing recent" or "never
   * successfully fetched" — this field is what tells them apart. NOT yet
   * folded into any aggregate score-level dataQuality (see confluenceEngine's
   * scoreCatalyst) — that combination is a separate decision, deliberately
   * not made here.
   */
  insiderDataQuality: 'real' | 'absent';

  /**
   * The most recent material disclosure, if any.
   * Cockpits can surface this for display without re-querying the store.
   */
  leadDisclosure: EightKDisclosure | null;

  /** UTC ms at which these tags were computed. */
  computedAt: number;
}

// ── Category sets ─────────────────────────────────────────────────────────────

const EARNINGS_CATEGORIES: Set<DisclosureCategory> = new Set([
  'earnings',
  'guidance',
]);

// Exported so any other pipeline needing "is this category material" (e.g.
// disclosureIngestion's duplicate-accession dedupe) reuses this single list
// instead of maintaining a second copy that can drift.
export const MATERIAL_CATEGORIES: Set<DisclosureCategory> = new Set([
  'acquisition',
  'divestiture',
  'restructuring',
  'regulatory',
  'leadership',
  'buyback',
  'debt',
  'equity',
  'activism',
]);

// ── Time windows ──────────────────────────────────────────────────────────────

const EARNINGS_WINDOW_MS   = 7  * 24 * 60 * 60 * 1000;  // 7 days (backward — an 8-K just filed)
const EARNINGS_LOOKAHEAD_MS = 7 * 24 * 60 * 60 * 1000;  // 7 days (forward — a real calendar date coming up)
const MATERIAL_WINDOW_MS = 3  * 24 * 60 * 60 * 1000;  // 3 days
const INSIDER_WINDOW_MS  = 30 * 24 * 60 * 60 * 1000;  // 30 days

// ── Pure computation — exported for unit tests ────────────────────────────────

/**
 * Compute catalyst tags for a ticker given its current fundamentals data.
 * Pure function — all inputs are passed in, no store reads.
 *
 * @param _ticker  Provided for logging / debugging; not used in computation
 * @param fund     FundamentalsData from fundamentalsStore
 * @param nowMs    Current UTC ms — defaults to Date.now() for production use;
 *                 pass explicitly in tests for deterministic results
 */
export function computeTags(
  _ticker: string,
  fund:    FundamentalsData,
  nowMs  = Date.now(),
): CatalystTags {
  // earningsPending is real if EITHER a real forward-looking calendar date is
  // coming up (the case this flag is actually named for) OR an 8-K reporting
  // earnings was just filed (catches same-day/next-day volatility even after
  // the forward-looking date has passed or aged out of the ingestion job's
  // scanned window). An 8-K's filedAt is always in the past by construction
  // — see disclosureIngestion.ts — so only the calendar check can ever be
  // genuinely forward-looking; that half was previously entirely absent.
  const earningsPending =
    hasRecentDisclosure(fund.recentDisclosures, EARNINGS_CATEGORIES, EARNINGS_WINDOW_MS, nowMs) ||
    hasUpcomingEarnings(fund.upcomingEarnings, EARNINGS_LOOKAHEAD_MS, nowMs);
  const materialEvent   = hasRecentDisclosure(fund.recentDisclosures, MATERIAL_CATEGORIES, MATERIAL_WINDOW_MS, nowMs);

  const recentInsider = fund.insiderTransactions.filter(
    (t) => nowMs - t.filedAt <= INSIDER_WINDOW_MS
  );

  const insiderBuy  = recentInsider.some((t) => t.transactionType === 'buy'  && !t.is10b51);
  const insiderSell = recentInsider.some((t) => t.transactionType === 'sell' && !t.is10b51);

  const leadDisclosure = mostRecentMaterialDisclosure(fund.recentDisclosures, nowMs) ?? null;

  return {
    earningsPending,
    materialEvent,
    insiderBuy,
    insiderSell,
    insiderDataQuality: fund.insiderDataQuality,
    leadDisclosure,
    computedAt: nowMs,
  };
}

/**
 * Check whether any disclosure in `disclosures` falls within the
 * given category set and time window.
 */
export function hasRecentDisclosure(
  disclosures: EightKDisclosure[],
  categories:  Set<DisclosureCategory>,
  windowMs:    number,
  nowMs:       number,
): boolean {
  return disclosures.some(
    (d) => categories.has(d.category) && nowMs - d.filedAt <= windowMs
  );
}

/**
 * Real, forward-looking check — is a real calendar earnings date within
 * `windowMs` ahead of now? Source: earningsCalendarIngestion.ts (Nasdaq's
 * public calendar). Distinct from hasRecentDisclosure, which can only ever
 * look backward because an 8-K's filedAt is always a past timestamp.
 *
 * A stored date that has already passed reads as false here without any
 * store-side mutation — the comparison does the work, not a cleared field.
 */
export function hasUpcomingEarnings(
  upcoming: UpcomingEarnings | null,
  windowMs: number,
  nowMs:    number,
): boolean {
  if (!upcoming) return false;
  const reportMs = new Date(`${upcoming.reportDate}T00:00:00Z`).getTime();
  if (!Number.isFinite(reportMs)) return false;
  return reportMs >= nowMs && reportMs - nowMs <= windowMs;
}

/**
 * Return the most recent disclosure from any material category,
 * within the material window, or undefined if none.
 */
export function mostRecentMaterialDisclosure(
  disclosures: EightKDisclosure[],
  nowMs:       number,
): EightKDisclosure | undefined {
  return disclosures
    .filter(
      (d) =>
        (MATERIAL_CATEGORIES.has(d.category) || EARNINGS_CATEGORIES.has(d.category)) &&
        nowMs - d.filedAt <= MATERIAL_WINDOW_MS
    )
    .sort((a, b) => b.filedAt - a.filedAt)[0];
}
