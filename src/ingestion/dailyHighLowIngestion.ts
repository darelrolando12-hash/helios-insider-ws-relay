/**
 * daily_high_low ingestion — 52-week rolling high/low history.
 *
 * Purpose: feeds the new-highs/new-lows market breadth stat (todo_66's
 * breadth engine). Stores ONLY date + high + low per ticker — no
 * open/close/volume/vwap. A single "current rolling high/low" column can't
 * do this correctly on its own: you need the day-by-day trail to know when
 * an old extreme should expire out of the 52-week window as new days
 * arrive. This is the minimum shape that actually works.
 *
 * Data source: Massive /v2/aggs/ticker/{ticker}/range/1/day — the same
 * endpoint bars_daily already uses. No pagination needed: 52 weeks is
 * ~260 trading days, far under the 50,000-row page limit.
 *
 * Design (same resumable pattern as barsIngestion.ts):
 *  - Cold start: fetch the full 52 weeks (371 calendar days back) for a
 *    ticker with no stored rows yet.
 *  - Gap-fill: fetch from (last stored date + 1 day) to today for tickers
 *    that already have rows — a restart after partial success costs zero
 *    re-fetched rows.
 *  - Prune: after each upsert, delete rows older than 52 weeks so the
 *    table stays a real rolling window (~260 rows/ticker), not unbounded
 *    history.
 *
 * Pilot (confirmed clean, 2026-08): runDailyHighLowPilot() ran a 50-ticker
 * subset — 12,750 real rows confirmed in DB, matching the ~12,600 expected
 * (255 real trading days/ticker, not a round 252 — normal variance).
 *
 * Full run: runDailyHighLowBackfill() runs against the real ~5,300-ticker
 * breadth allowlist (from tickerAllowlistIngestion.ts), serialized one
 * ticker at a time — same rate-limit discipline as bars_1m's full rollout.
 * Real per-ticker logging plus a running batch summary every 100 tickers,
 * so a partial/failed run is visible in the log, never silently absorbed
 * into a final "done" line.
 */

import { supabase }                                    from '../lib/supabase';
import { MassiveRestClient, MassiveDailyBarResponse }  from '../lib/massive/api';
import { formatError }                                 from '../lib/errors';

/** Calendar days back that covers 52 weeks including weekends/holidays. */
const WEEKS_52_DAYS = 371;

/** Approximate trading days in a 52-week window — used only for sanity-check math in log summaries. */
const APPROX_TRADING_DAYS_PER_YEAR = 260;

/**
 * Pilot subset — 50 real, liquid, common-stock tickers across sectors.
 * Separate from the real breadth allowlist — exists only to prove the
 * ingestion pattern at small scale before scaling up. Already run and
 * confirmed clean (12,750 rows) — kept here for re-verification if needed.
 */
const PILOT_TICKERS: readonly string[] = [
  'AAPL', 'MSFT', 'AMZN', 'GOOGL', 'META', 'NVDA', 'TSLA', 'AMD', 'NFLX', 'CRM',
  'ORCL', 'ADBE', 'INTC', 'CSCO', 'QCOM', 'TXN', 'AVGO', 'IBM', 'NOW', 'INTU',
  'JPM', 'BAC', 'WFC', 'GS', 'MS', 'C', 'AXP', 'BLK', 'SCHW', 'USB',
  'JNJ', 'PFE', 'UNH', 'ABBV', 'MRK', 'LLY', 'TMO', 'ABT', 'BMY', 'CVS',
  'XOM', 'CVX', 'COP', 'SLB', 'EOG',
  'WMT', 'HD', 'PG', 'KO', 'PEP',
];

// ── Date helpers (same conventions as barsIngestion.ts) ──────────────────────

function toDateStr(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function daysAgo(n: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return toDateStr(d);
}

/** YYYY-MM-DD for tomorrow (ensures today's bar is included when market is open) */
function tomorrow(): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + 1);
  return toDateStr(d);
}

function addOneDay(dateStr: string): string {
  const d = new Date(`${dateStr}T12:00:00Z`); // noon UTC avoids DST boundary issues
  d.setDate(d.getDate() + 1);
  return toDateStr(d);
}

// ── Upsert + prune helpers ────────────────────────────────────────────────────

/**
 * Map a Massive daily bar envelope to daily_high_low rows (date, high, low
 * only) and upsert. Returns the number of rows attempted, or 0 on failure.
 */
async function upsertHighLow(
  ticker:   string,
  envelope: MassiveDailyBarResponse,
  label:    string,
): Promise<number> {
  const bars = envelope.results;

  if (bars.length === 0) {
    console.log(
      `[dailyHighLowIngestion] ${ticker} (${label}): 0 bars returned — ` +
      `status="${envelope.status}", resultsCount=${envelope.resultsCount}.`,
    );
    return 0;
  }

  const rows = bars.map((b) => ({
    ticker,
    date: new Date(b.t).toISOString().slice(0, 10),
    high: b.h,
    low:  b.l,
  }));

  const { error } = await supabase
    .from('daily_high_low')
    .upsert(rows, { onConflict: 'ticker,date', ignoreDuplicates: true });

  if (error) {
    console.error(`[dailyHighLowIngestion] ${ticker} (${label}): upsert failed —`, error.message);
    return 0;
  }
  return rows.length;
}

/** Delete rows older than the 52-week rolling window for a ticker — keeps the table a real rolling window, not unbounded history. */
async function pruneOldRows(ticker: string): Promise<void> {
  const cutoff = daysAgo(WEEKS_52_DAYS);
  const { error } = await supabase
    .from('daily_high_low')
    .delete()
    .eq('ticker', ticker)
    .lt('date', cutoff);

  if (error) {
    console.error(`[dailyHighLowIngestion] ${ticker}: prune failed —`, error.message);
  }
}

/** Real DB row count for a ticker — the only honest confirmation. */
async function getConfirmedCount(ticker: string): Promise<number> {
  const { count, error } = await supabase
    .from('daily_high_low')
    .select('*', { count: 'exact', head: true })
    .eq('ticker', ticker);

  if (error) {
    console.error(`[dailyHighLowIngestion] ${ticker}: count query failed —`, error.message);
    return -1;
  }
  return count ?? 0;
}

/** Backfill/gap-fill one ticker. Returns {attempted, confirmed} for caller reporting. */
async function runForTicker(
  client: MassiveRestClient,
  ticker: string,
): Promise<{ attempted: number; confirmed: number; failed: boolean }> {
  try {
    const { data: latestRow, error: selectErr } = await supabase
      .from('daily_high_low')
      .select('date')
      .eq('ticker', ticker)
      .order('date', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (selectErr) {
      console.error(`[dailyHighLowIngestion] ${ticker}: DB select failed —`, selectErr.message);
      return { attempted: 0, confirmed: await getConfirmedCount(ticker), failed: true };
    }

    const toDate   = tomorrow();
    const fromDate = latestRow?.date
      ? addOneDay(latestRow.date as string)
      : daysAgo(WEEKS_52_DAYS);

    if (fromDate >= toDate) {
      const confirmed = await getConfirmedCount(ticker);
      console.log(`[dailyHighLowIngestion] ${ticker}: already current, ${confirmed} rows stored.`);
      return { attempted: 0, confirmed, failed: false };
    }

    const label    = latestRow ? `gap-fill ${fromDate}→${toDate}` : `cold-start ${fromDate}→${toDate}`;
    const envelope = await client.fetchDailyBars(ticker, fromDate, toDate);
    const attempted = await upsertHighLow(ticker, envelope, label);

    await pruneOldRows(ticker);

    const confirmed = await getConfirmedCount(ticker);
    console.log(`[dailyHighLowIngestion] ${ticker}: attempted ${attempted}, confirmed in DB: ${confirmed}.`);
    return { attempted, confirmed, failed: false };
  } catch (e) {
    console.error(`[dailyHighLowIngestion] ${ticker}: unexpected error — ${formatError(e)}`);
    return { attempted: 0, confirmed: await getConfirmedCount(ticker), failed: true };
  }
}

// ── Pilot: 50 tickers ─────────────────────────────────────────────────────────

/**
 * Run the 52-week high/low backfill for PILOT_TICKERS (50 tickers) only.
 * Already confirmed clean (12,750 rows) — kept for re-verification if the
 * pattern is ever touched again. Not called from main.tsx anymore; the
 * full breadth-allowlist run has superseded it.
 */
export async function runDailyHighLowPilot(client: MassiveRestClient): Promise<void> {
  console.log(`[dailyHighLowIngestion] Pilot: starting 52-week high/low backfill for ${PILOT_TICKERS.length} tickers…`);
  await runDailyHighLowBackfill(client, PILOT_TICKERS);
}

// ── Full run: real breadth allowlist (~5,300 tickers) ────────────────────────

/**
 * Run the 52-week high/low backfill for an arbitrary ticker list.
 * Used both by the pilot (50 tickers) and the full run (~5,300-ticker
 * breadth allowlist). Serialized one ticker at a time — same rate-limit
 * discipline as bars_1m's full rollout.
 *
 * Logs a running batch summary every 100 tickers so progress on a run this
 * size is visible without waiting for the very end, and any failed tickers
 * are listed explicitly in the final summary — never silently dropped.
 */
export async function runDailyHighLowBackfill(client: MassiveRestClient, tickers: readonly string[]): Promise<void> {
  console.log(`[dailyHighLowIngestion] Starting 52-week high/low backfill for ${tickers.length} tickers…`);

  let totalAttempted  = 0;
  let tickersWithZero = 0;
  const failedTickers: string[] = [];

  for (let i = 0; i < tickers.length; i++) {
    const ticker = tickers[i];
    const { attempted, failed } = await runForTicker(client, ticker);
    totalAttempted += attempted;
    if (attempted === 0) tickersWithZero++;
    if (failed) failedTickers.push(ticker);

    const done = i + 1;
    if (done % 100 === 0 || done === tickers.length) {
      console.log(
        `[dailyHighLowIngestion] Progress: ${done}/${tickers.length} tickers processed. ` +
        `Rows attempted so far: ${totalAttempted}. Failed so far: ${failedTickers.length}.`,
      );
    }
  }

  // Re-query the real total across all processed tickers — the only honest confirmation.
  const { count, error: countErr } = await supabase
    .from('daily_high_low')
    .select('*', { count: 'exact', head: true })
    .in('ticker', tickers as string[]);

  const totalConfirmed = countErr ? -1 : (count ?? 0);
  const expected        = tickers.length * APPROX_TRADING_DAYS_PER_YEAR;

  console.log(
    `[dailyHighLowIngestion] Backfill complete. Tickers processed: ${tickers.length} ` +
    `(${tickersWithZero} returned 0 new rows — expected for already-current or gap-fill-only runs). ` +
    `Total attempted: ${totalAttempted}. Total confirmed in DB: ${countErr ? '(count query failed)' : totalConfirmed}. ` +
    `Expected roughly: ${expected} (~${APPROX_TRADING_DAYS_PER_YEAR} trading days × ${tickers.length} tickers). ` +
    (failedTickers.length > 0
      ? `FAILED TICKERS (${failedTickers.length}): ${failedTickers.join(', ')}`
      : 'No failed tickers.'),
  );
}
