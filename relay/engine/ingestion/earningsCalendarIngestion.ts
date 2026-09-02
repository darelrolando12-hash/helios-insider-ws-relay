/**
 * Earnings calendar ingestion — free, unauthenticated Nasdaq public API.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 * Every "no earnings within N days" check in this codebase (SwingCockpit's
 * F4, ZeroDteCockpit's C8, BestContractsCockpit's earningsWithinDays, and the
 * live confluenceEngine/catalystGate earningsPending flag) was built on top
 * of disclosureIngestion.ts's 8-K data — which is structurally incapable of
 * answering "is earnings coming up", because an 8-K is filed AFTER the event
 * it reports. SwingCockpit's F4 checked `filedAt > Date.now()`, a condition
 * that can never be true for real 8-K data. See CLAUDE.md's KNOWN GAPS /
 * dominant bug class section for the full audit (2026-09-02).
 *
 * This module is the real fix: a genuine forward-looking date source.
 *
 * ── Source, verified live (2026-09-02) ──────────────────────────────────────
 * Endpoint and header shape confirmed against the real, current source of
 * `finance_calendars` (github.com/s-kerin/finance_calendars) — read directly
 * rather than assumed from a package description. Verified live: real data
 * for today, and real forward-looking hits for FEED_TICKERS 41-42 days out
 * (JPM 2026-10-13, BAC 2026-10-14 — plausible real Q3 bank-earnings dates).
 *
 *   GET https://api.nasdaq.com/api/calendar/earnings?date=YYYY-MM-DD
 *
 * No date-range query — one HTTP call per calendar day scanned.
 *
 * NOT part of Massive's data surface — different host, no API key, no SLA.
 * Confirmed live: requests carrying a bot-identifying User-Agent (tested:
 * plain "node-fetch") do not get a clean rejection — they hang until the
 * connection times out (real HeadersTimeoutError observed, not assumed).
 * A bare request with no custom headers at all DID succeed once, but the
 * browser-mimicking header set below is what `finance_calendars` itself
 * relies on and is what this module uses — do not simplify these headers
 * without re-verifying live first.
 *
 * There is no confirmed/estimated distinction in this free source — unlike
 * Massive's paid /benzinga/v1/earnings (real date_status field, confirmed
 * live 2026-09-01, gated behind a plan this account is not entitled to).
 * Every date here is presented flat, as Nasdaq's own expectation. A
 * cross-referenced confidence signal (a matching 8-K pre-announcement near
 * the predicted date = 'confirmed', else 'estimated') plus a simple
 * days-until-date heuristic are a planned fast-follow, NOT implemented here
 * — ship the core forward-looking fix first, verify it working, then layer
 * confidence in. Do not invent a confidence field on UpcomingEarnings that
 * this file doesn't actually compute.
 *
 * ── Table dependency — NOT YET CREATED ──────────────────────────────────────
 * This module writes to `earnings_calendar`, which does not exist yet in the
 * Wegic-managed Supabase project (confirmed live: a 42P01 "relation does not
 * exist" error, 2026-09-02). This engine has no service-role key and cannot
 * run DDL — see relay/config.ts's SUPABASE_ANON_KEY comment. The table must
 * be created out-of-band before this module's DB writes will succeed:
 *
 *   create table public.earnings_calendar (
 *     ticker         text not null,
 *     report_date    date not null,
 *     timing         text,
 *     eps_forecast   numeric,
 *     num_estimates  integer,
 *     fetched_at     timestamptz not null default now(),
 *     primary key (ticker, report_date)
 *   );
 *
 * Until that table exists, runEarningsCalendarIngestion() still fetches real
 * data and hydrates fundamentalsStore in-memory (so catalystGate's forward-
 * looking check works for the life of this process) but every DB upsert will
 * fail and log loudly — by design, never silently swallowed, so the gap is
 * visible in Railway logs rather than looking like a quiet success.
 */

import { supabase } from '../lib/supabase.ts';
import * as fundamentalsStore from '../stores/fundamentalsStore.ts';
import type { UpcomingEarnings } from '../stores/fundamentalsStore.ts';
import { FEED_TICKERS } from '../state/directionState.ts';

// ── Constants ─────────────────────────────────────────────────────────────────

/** How far ahead to scan. This is a forward-only calendar — no historical backfill needed. */
const LOOKAHEAD_DAYS = 30;

/** Real HeadersTimeoutError observed live against a bot-identifying UA — never let a call hang indefinitely. */
const REQUEST_TIMEOUT_MS = 10_000;

/** Verified live 2026-09-02 — see this file's header for why these specific headers matter. */
const NASDAQ_HEADERS: Record<string, string> = {
  authority: 'api.nasdaq.com',
  accept: 'application/json, text/plain, */*',
  'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  origin: 'https://www.nasdaq.com',
  'sec-fetch-site': 'same-site',
  'sec-fetch-mode': 'cors',
  'sec-fetch-dest': 'empty',
  referer: 'https://www.nasdaq.com/',
  'accept-language': 'en-US,en;q=0.9',
};

// ── Real response row shape (Nasdaq's public calendar API) ────────────────────

interface NasdaqEarningsRow {
  symbol?: string;
  time?: string;         // 'time-pre-market' | 'time-after-hours' | 'time-not-supplied'
  epsForecast?: string;  // e.g. "$2.83" or "($0.51)" — accounting-negative format
  noOfEsts?: string;
}

interface NasdaqEarningsResponse {
  data: {
    asOf?: string;
    rows?: NasdaqEarningsRow[];
  } | null;
}

// ── Pure helpers — exported for unit tests ────────────────────────────────────

export function toDateStr(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** 'time-pre-market' -> 'bmo', 'time-after-hours' -> 'amc', anything else -> 'unknown'. */
export function normaliseTiming(raw: string | undefined): UpcomingEarnings['timing'] {
  if (raw === 'time-pre-market') return 'bmo';
  if (raw === 'time-after-hours') return 'amc';
  return 'unknown';
}

/**
 * Parses Nasdaq's real EPS forecast string format, including accounting-
 * negative parentheses (e.g. "($0.51)" -> -0.51). Real format, confirmed
 * live 2026-09-02 (SNOW's forecast came back exactly this way).
 */
export function parseMoney(raw: string | undefined | null): number | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  const negative = /^\(.*\)$/.test(trimmed);
  const cleaned = trimmed.replace(/[()$,]/g, '');
  const n = Number(cleaned);
  if (!Number.isFinite(n)) return null;
  return negative ? -Math.abs(n) : n;
}

function parseInt10(raw: string | undefined | null): number | null {
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

// ── Fetch one day, real network call ──────────────────────────────────────────

async function fetchEarningsForDate(dateStr: string): Promise<NasdaqEarningsRow[]> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(
      `https://api.nasdaq.com/api/calendar/earnings?date=${dateStr}`,
      { headers: NASDAQ_HEADERS, signal: controller.signal },
    );
    if (!res.ok) {
      throw new Error(`Nasdaq calendar HTTP ${res.status} for ${dateStr}`);
    }
    const json = await res.json() as NasdaqEarningsResponse;
    return json?.data?.rows ?? [];
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error(`Nasdaq calendar timeout after ${REQUEST_TIMEOUT_MS}ms for ${dateStr} — the endpoint is known to silently stall rather than reject`);
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Scan the next LOOKAHEAD_DAYS days of Nasdaq's public earnings calendar,
 * keep only rows matching FEED_TICKERS, and write them to both the DB
 * (earnings_calendar — see this file's header for the table it needs) and
 * fundamentalsStore (so catalystGate's forward-looking check works
 * immediately, independent of whether the DB write succeeds).
 *
 * A failed day (timeout, non-200, malformed response) is logged loudly and
 * skipped — it is NEVER treated as "no earnings that day". Silently treating
 * a fetch failure as a real negative would recreate the exact silent-zero
 * shape this module exists to fix.
 */
export async function runEarningsCalendarIngestion(): Promise<void> {
  console.log(`[earningsCalendarIngestion] Starting — scanning ${LOOKAHEAD_DAYS} days ahead for ${FEED_TICKERS.length} feed tickers…`);

  const feedSet = new Set<string>(FEED_TICKERS);
  const today = new Date();

  let totalHits = 0;
  let dbUpserts = 0;
  let dbErrors = 0;
  let dayErrors = 0;

  for (let i = 0; i < LOOKAHEAD_DAYS; i++) {
    const d = new Date(today.getTime() + i * 86_400_000);
    const dateStr = toDateStr(d);

    let rows: NasdaqEarningsRow[];
    try {
      rows = await fetchEarningsForDate(dateStr);
    } catch (e) {
      console.error(`[earningsCalendarIngestion] ${dateStr}: fetch failed — ${e instanceof Error ? e.message : e}. ` +
        `Skipping this day — NOT treated as "no earnings".`);
      dayErrors += 1;
      continue;
    }

    const hits = rows.filter((r) => r.symbol && feedSet.has(r.symbol));
    if (hits.length === 0) continue;

    for (const r of hits) {
      const symbol = r.symbol as string;
      const entry: UpcomingEarnings = {
        reportDate: dateStr,
        timing: normaliseTiming(r.time),
        epsForecast: parseMoney(r.epsForecast),
        numEstimates: parseInt10(r.noOfEsts),
        fetchedAt: Date.now(),
      };

      // Store-side write happens regardless of DB outcome — the live
      // catalystGate check must not depend on a table that may not exist yet.
      fundamentalsStore.upsertUpcomingEarnings(symbol, entry);
      totalHits += 1;

      const { error } = await supabase
        .from('earnings_calendar')
        .upsert(
          {
            ticker: symbol,
            report_date: dateStr,
            timing: entry.timing,
            eps_forecast: entry.epsForecast,
            num_estimates: entry.numEstimates,
            fetched_at: new Date().toISOString(),
          },
          { onConflict: 'ticker,report_date' },
        );

      if (error) {
        console.error(`[earningsCalendarIngestion] ${symbol} ${dateStr}: DB upsert failed — ${error.message}`);
        dbErrors += 1;
        continue;
      }
      dbUpserts += 1;
    }
  }

  console.log(
    `[earningsCalendarIngestion] run complete — ${totalHits} FEED_TICKER hit(s) across ${LOOKAHEAD_DAYS} days ` +
    `(${dayErrors} day(s) failed to fetch), ${dbUpserts} DB upsert(s) ok, ${dbErrors} DB upsert(s) failed.`
  );
}

/**
 * Hydrate fundamentalsStore from the DB on boot, so a restart doesn't lose
 * calendar data until the next scheduled run. Only pulls rows whose
 * report_date hasn't passed yet — a past date is not "upcoming" regardless
 * of what's stored.
 *
 * Safe to call even if earnings_calendar doesn't exist yet — logs the
 * failure loudly and returns, same discipline as the main run.
 */
export async function hydrateUpcomingEarningsFromDb(): Promise<void> {
  const todayStr = toDateStr(new Date());
  const { data, error } = await supabase
    .from('earnings_calendar')
    .select('ticker, report_date, timing, eps_forecast, num_estimates, fetched_at')
    .gte('report_date', todayStr)
    .in('ticker', FEED_TICKERS as unknown as string[]);

  if (error) {
    console.error(`[earningsCalendarIngestion] hydrate failed — ${error.message}`);
    return;
  }
  if (!data || data.length === 0) return;

  for (const row of data) {
    fundamentalsStore.upsertUpcomingEarnings(row.ticker as string, {
      reportDate: row.report_date as string,
      timing: (row.timing as UpcomingEarnings['timing']) ?? 'unknown',
      epsForecast: row.eps_forecast != null ? Number(row.eps_forecast) : null,
      numEstimates: row.num_estimates != null ? Number(row.num_estimates) : null,
      fetchedAt: row.fetched_at ? new Date(row.fetched_at as string).getTime() : Date.now(),
    });
  }
  console.log(`[earningsCalendarIngestion] hydrated ${data.length} upcoming-earnings row(s) from DB.`);
}
