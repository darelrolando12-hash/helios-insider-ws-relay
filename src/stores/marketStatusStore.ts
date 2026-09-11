/**
 * marketStatusStore — the single readable source of truth for "is the feed
 * supposed to be delivering bars right now?".
 *
 * ── Why this exists (2026-09-10) ──────────────────────────────────────────
 * The app had THREE different notions of that question, and the UI was using
 * the two worst ones:
 *
 *   1. Massive's /v1/marketstatus/now, polled every 60s in main.tsx. This is
 *      the authoritative one — it is the venue's own answer, so it gets
 *      holidays and early closes right. But it was WRITE-ONLY: the poll
 *      pushed it into confluenceEngine.setMarketStatus() and
 *      outcomeResolver.setMarketOpen() and nothing else could read it.
 *   2. isFeedScheduleActive() in lib/time.ts — a hardcoded 03:00–19:00 CT
 *      window that documents its own omissions (no weekend check, and
 *      CLAUDE.md records that no holiday calendar exists anywhere in this
 *      system). The Home banner used this.
 *   3. barsStore.getResult() returning `error` for any bar older than two
 *      minutes, with no market awareness whatsoever. HeliosChart used this
 *      to black the whole chart out.
 *
 * So on a closed market the platform said "MARKET CLOSED" from source 2
 * while simultaneously dimming real, correct history behind a "bars are
 * stale" overlay from source 3 — two warnings for one fact, the second one
 * hiding the very data a trader opens the chart to review.
 *
 * This store publishes source 1 so every consumer can share it.
 *
 * NOTE ON STALENESS: barsStore's `error` is not wrong and is deliberately
 * left alone — "the newest bar is over two minutes old" is a true, useful
 * statement, and engines that must not score on stale data still depend on
 * it. What was wrong was the PRESENTATION POLICY: treating "not fresh" as
 * "unusable, hide it". Freshness is a fact; whether it should block the UI
 * is a decision, and that decision needs to know whether the market is even
 * open. See classifyFeedHealth below.
 */

import type { MarketStatusValue } from './types';

// ── State ─────────────────────────────────────────────────────────────────────

/**
 * Starts as null — "we have not heard from the venue yet", which is
 * deliberately distinct from 'closed'. A consumer must not render a
 * confident "MARKET CLOSED" during the first poll's flight.
 */
let _status: MarketStatusValue | null = null;
let _asOf = 0;

const _listeners = new Set<() => void>();

export function setMarketStatus(status: MarketStatusValue, asOfMs: number = Date.now()) {
  const changed = status !== _status;
  _status = status;
  _asOf   = asOfMs;
  if (changed) for (const l of _listeners) l();
}

export function getMarketStatus(): MarketStatusValue | null {
  return _status;
}

export function getAsOf(): number {
  return _asOf;
}

export function subscribe(listener: () => void): () => void {
  _listeners.add(listener);
  return () => { _listeners.delete(listener); };
}

/**
 * Is the feed EXPECTED to be delivering bars right now?
 *
 * Deliberately true for every non-closed value, not just 'open'. This
 * platform genuinely trades and charts extended hours — the chart backfill
 * covers roughly 03:00–19:00 CT and Massive's aggregates span it (verified
 * live: a real SPY day returns ~16 trading hours, not 6.5). During
 * 'early-hours' and 'extended-hours' a silent feed IS a real problem, so
 * those must not be excused as "market closed".
 *
 * Returns null while the first poll is still in flight — unknown, not false.
 */
export function isFeedExpectedLive(): boolean | null {
  if (_status === null) return null;
  return _status !== 'closed';
}

// ── Feed health classification ────────────────────────────────────────────────

/**
 * How stale the newest bar is allowed to get, while the market is genuinely
 * live, before the UI says anything at all.
 *
 * Matches barsStore's own STALE_THRESHOLD_MS so the two never disagree about
 * what "fresh" means.
 */
const DELAYED_AFTER_MS = 2 * 60 * 1000;

/**
 * When a delay stops being a hiccup and starts being an outage.
 *
 * A real trading terminal does not blank its own chart the moment a tick is
 * late — it keeps showing the last good data and tells you how old it is.
 * That is the whole point of the split: 'delayed' is a quiet note, 'down' is
 * a loud one, and NEITHER hides the bars.
 */
const DOWN_AFTER_MS = 10 * 60 * 1000;

export type FeedHealth =
  /** First market-status poll still in flight. Say nothing yet. */
  | { kind: 'unknown' }
  /** Venue is closed. Old bars are CORRECT, not an error. Informational only. */
  | { kind: 'market-closed' }
  /** Live and fresh. Render nothing. */
  | { kind: 'live' }
  /** Live but late. Non-blocking note. */
  | { kind: 'delayed'; ageMs: number }
  /** Live and badly late. Louder, still non-blocking. */
  | { kind: 'down';    ageMs: number };

/**
 * Decide what (if anything) the UI should say about feed freshness.
 *
 * `newestBarUtcMs` is the newest real bar we hold, or null if we hold none.
 * Pure and exported so it can be reasoned about and tested without a chart.
 */
export function classifyFeedHealth(
  newestBarUtcMs: number | null,
  nowMs:          number = Date.now(),
  expectedLive:   boolean | null = isFeedExpectedLive(),
): FeedHealth {
  if (expectedLive === null) return { kind: 'unknown' };
  // Closed: bar age is meaningless as a health signal. Friday's last bar is
  // still Friday's last bar all weekend, and that is correct.
  if (expectedLive === false) return { kind: 'market-closed' };
  if (newestBarUtcMs === null) return { kind: 'down', ageMs: 0 };

  const ageMs = nowMs - newestBarUtcMs;
  if (ageMs < DELAYED_AFTER_MS) return { kind: 'live' };
  if (ageMs < DOWN_AFTER_MS)    return { kind: 'delayed', ageMs };
  return { kind: 'down', ageMs };
}

/** "3m" / "1h 12m" — compact age for a status chip. */
export function formatAge(ms: number): string {
  const totalMin = Math.floor(ms / 60_000);
  if (totalMin < 60) return `${totalMin}m`;
  const h = Math.floor(totalMin / 60);
  return `${h}h ${totalMin % 60}m`;
}
