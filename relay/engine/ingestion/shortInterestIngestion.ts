/**
 * Short Interest + Short Volume + Free Float ingestion
 *
 * Audited 2026-09-02 (W8). Real findings from that audit, fixed here:
 *
 *   - short_pct_float (35 of squeezeEngine's 100 scoring points — the
 *     single largest component) was permanently null: confirmed live
 *     across all 23 FEED_TICKERS, a full year, 483 real reports, 0 ever
 *     populated, and confirmed against Massive's own docs that the
 *     short-interest endpoint's real field list never included it at all
 *     — an invented field, not an occasionally-absent one. Real fix below:
 *     a separate free-float endpoint (/stocks/vX/float, confirmed live)
 *     combined with short_interest via short_interest/free_float*100 — the
 *     same formula Fintel/ORTEX/MarketBeat use. See
 *     fundamentalsStore.computeShortPctOfFloat.
 *   - ignoreDuplicates: true on both upserts below — same bug shape fixed
 *     in disclosureIngestion.ts and insiderIngestion.ts earlier this
 *     session. Fixed to false here too. Now MORE load-bearing than before:
 *     short_pct_float is now a derived value (computed by this codebase,
 *     not read verbatim from the provider), so a future correction to that
 *     derivation needs existing rows to be overwritable, not silently
 *     skipped.
 *   - No periodic refresh existed for short interest/volume — laterOnce
 *     only, no everyInterval, unlike every other real ingestion module.
 *     Fixed in engine/index.ts (this file just exports the function).
 *   - shortVolumeRatio's dataQuality gap: a ticker with real short-interest
 *     data but an incomplete short-volume fetch showed `ready` with
 *     shortVolumeRatio: null — indistinguishable from a genuine 0%. Fixed
 *     via fundamentalsStore.shortVolumeDataQuality, set on every real
 *     upsertShortVolume() call (see that function's own comment).
 *
 * Runs once at boot, THEN periodically (see engine/index.ts). For each
 * ticker in FEED_TICKERS:
 *
 * SHORT INTEREST (2-year window, bi-weekly Massive reports):
 *   1. Check most recent report_date already in short_interest table.
 *   2. Fetch from (last stored date + 1 day) to today, or full 2 years if empty.
 *   3. Upsert to DB using Massive's report_id (or derived key) as PK.
 *   4. After DB write, call fundamentalsStore.upsertShortInterest() with the
 *      most recent report — this is the value squeezeEngine reads immediately.
 *      shortFloat on that snapshot is derived by the store from whatever
 *      free-float value it already has (see FREE FLOAT below) — this
 *      function no longer computes or assigns it directly.
 *
 * SHORT VOLUME (90-day window, daily):
 *   1. Check most recent trade_date already in short_volume table.
 *   2. Fetch from (last stored date + 1 day) to today, or 90 days if empty.
 *   3. Upsert to DB.
 *   4. After DB write, call fundamentalsStore.upsertShortVolume() with the
 *      most recent day's values.
 *
 * FREE FLOAT (own cadence, own function — runFloatBackfill, called and
 * scheduled separately in engine/index.ts):
 *   Real endpoint confirmed live 2026-09-02: not a date-ranged history —
 *   no date-filter params exist, and a real query returns exactly one row
 *   (the current snapshot). Float changes quarterly-ish (buybacks/
 *   issuance); forcing it onto short interest's bi-weekly or short
 *   volume's daily cadence would be real over-fetching for data that
 *   rarely changes. Scheduled on its own, much longer interval instead —
 *   see engine/index.ts.
 *   1. Fetch the current snapshot for the ticker.
 *   2. Upsert to DB (own table, own PK).
 *   3. Call fundamentalsStore.upsertFreeFloat() — this recomputes
 *      shortInterest.shortFloat immediately if a short-interest snapshot
 *      is already known, regardless of which of the two arrived first.
 *
 * TTL enforcement:
 *   short_interest: DELETE rows older than 2 years (updated retention policy).
 *   short_volume:   DELETE rows older than 90 days.
 *   stock_float:    no TTL — one row per ticker, always overwritten in place.
 *   Both dated TTLs run at end of each short-interest/volume backfill.
 *
 * All calls are serialized per-ticker. Fire-and-forget from main.tsx.
 */

import { supabase }              from '../lib/supabase.ts';
import { MassiveRestClient }     from '../lib/massive/api.ts';
import * as fundamentalsStore    from '../stores/fundamentalsStore.ts';
import { FEED_TICKERS }          from '../state/directionState.ts';
import type { ShortInterestSnapshot } from '../stores/types.ts';
import type { FreeFloat }        from '../stores/fundamentalsStore.ts';

// ── Helpers ───────────────────────────────────────────────────────────────────

function toDateStr(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function daysAgo(n: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return toDateStr(d);
}

function yearsAgo(n: number): string {
  const d = new Date();
  d.setUTCFullYear(d.getUTCFullYear() - n);
  return toDateStr(d);
}

function today(): string {
  return toDateStr(new Date());
}

function addOneDay(dateStr: string): string {
  const d = new Date(`${dateStr}T12:00:00Z`);
  d.setDate(d.getDate() + 1);
  return toDateStr(d);
}

/**
 * Derive a stable PK for a short interest report.
 * Massive may return a report_id field; if absent, use ticker+settlement_date.
 */
function shortInterestPk(ticker: string, r: { settlement_date: string; report_id?: string }): string {
  return r.report_id ?? `${ticker}_${r.settlement_date}`;
}

// ── Short Interest ────────────────────────────────────────────────────────────

async function _runShortInterestForTicker(
  client: MassiveRestClient,
  ticker: string,
): Promise<void> {
  const toDate   = today();
  const fullFrom = yearsAgo(2);

  // Find latest stored report
  const { data: latestRow, error: selectErr } = await supabase
    .from('short_interest')
    .select('report_date')
    .eq('ticker', ticker)
    .order('report_date', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (selectErr) {
    console.error(`[shortInterestIngestion] ${ticker}: select failed —`, selectErr.message);
    return;
  }

  const fromDate = latestRow?.report_date
    ? addOneDay(latestRow.report_date as string)
    : fullFrom;

  if (fromDate > toDate) {
    console.log(`[shortInterestIngestion] ${ticker}: short interest current, skipping.`);
    // Still wire the latest value into fundamentalsStore from DB
    await _hydrateShortInterestFromDb(ticker);
    return;
  }

  const reports = await client.fetchShortInterest(ticker, fromDate, toDate);

  if (reports.length === 0) {
    console.log(`[shortInterestIngestion] ${ticker}: no short interest reports returned.`);
    await _hydrateShortInterestFromDb(ticker);
    return;
  }

  const rows = reports.map((r) => ({
    id:               shortInterestPk(ticker, r),
    ticker,
    report_date:      r.settlement_date,
    // BIGINT columns — Massive returns floats; Math.round() required
    short_interest:   Math.round(r.short_interest),
    avg_daily_volume: r.avg_daily_volume != null ? Math.round(r.avg_daily_volume) : null,
    days_to_cover:    r.days_to_cover    ?? null,
    // Always null: Massive's real /stocks/v1/short-interest response never
    // includes this field (confirmed live and against Massive's own docs,
    // 2026-09-02 — see this file's header). Kept as a real DB column
    // reflecting what the provider actually sends, not backfilled with the
    // derived value here — the derived, actually-consumed value lives in
    // fundamentalsStore (see upsertShortInterest), not duplicated into this
    // table's history for every report row.
    short_pct_float:  r.short_pct_float  ?? null,
    settlement_date:  r.settlement_date,
    fetched_at:       new Date().toISOString(),
  }));

  // ignoreDuplicates must stay false: same bug shape as disclosureIngestion.ts
  // and insiderIngestion.ts, fixed for the same reason here — see this
  // file's header. A conflicting id needs its row overwritten, not skipped.
  const { error: upsertErr } = await supabase
    .from('short_interest')
    .upsert(rows, { onConflict: 'id', ignoreDuplicates: false });

  if (upsertErr) {
    console.error(`[shortInterestIngestion] ${ticker}: upsert failed —`, upsertErr.message);
    return;
  }

  console.log(`[shortInterestIngestion] ${ticker}: upserted ${rows.length} short interest reports.`);

  // Wire most recent report into in-memory fundamentalsStore
  // Sort descending by settlement_date to find the newest
  const sorted = [...reports].sort((a, b) =>
    b.settlement_date.localeCompare(a.settlement_date)
  );
  const latest = sorted[0];

  // shortFloat is deliberately NOT set here — fundamentalsStore.
  // upsertShortInterest derives it from whatever freeFloat it already has
  // (short_pct_float doesn't exist in Massive's real response; see this
  // file's header). Passing shortFloat here would be dead code — the store
  // ignores it and computes its own.
  const snapshot: ShortInterestSnapshot = {
    ticker,
    shortInterest: latest.short_interest,
    daysToCover:   latest.days_to_cover,
    reportDate:    new Date(`${latest.settlement_date}T12:00:00Z`).getTime(),
  };

  fundamentalsStore.upsertShortInterest(ticker, snapshot);
  console.log(`[shortInterestIngestion] ${ticker}: fundamentalsStore wired — shortInterest=${latest.short_interest}, daysToCover=${latest.days_to_cover ?? 'n/a'}.`);
}

/**
 * If the ticker's short interest is already current in DB but not yet in
 * fundamentalsStore (e.g. app restarted, data already stored), read the
 * most recent row from DB and hydrate the in-memory store.
 */
async function _hydrateShortInterestFromDb(ticker: string): Promise<void> {
  const { data, error } = await supabase
    .from('short_interest')
    .select('*')
    .eq('ticker', ticker)
    .order('report_date', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error || !data) return;

  const snapshot: ShortInterestSnapshot = {
    ticker,
    shortInterest: data.short_interest as number,
    daysToCover:   data.days_to_cover    ?? undefined,
    reportDate:    new Date(`${data.report_date}T12:00:00Z`).getTime(),
  };

  fundamentalsStore.upsertShortInterest(ticker, snapshot);
  console.log(`[shortInterestIngestion] ${ticker}: hydrated from DB — shortInterest=${data.short_interest}.`);
}

// ── Short Volume ──────────────────────────────────────────────────────────────

async function _runShortVolumeForTicker(
  client: MassiveRestClient,
  ticker: string,
): Promise<void> {
  const toDate   = today();
  const fullFrom = daysAgo(90);

  const { data: latestRow, error: selectErr } = await supabase
    .from('short_volume')
    .select('trade_date')
    .eq('ticker', ticker)
    .order('trade_date', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (selectErr) {
    console.error(`[shortInterestIngestion] ${ticker}: short_volume select failed —`, selectErr.message);
    return;
  }

  const fromDate = latestRow?.trade_date
    ? addOneDay(latestRow.trade_date as string)
    : fullFrom;

  if (fromDate > toDate) {
    console.log(`[shortInterestIngestion] ${ticker}: short volume current, skipping.`);
    await _hydrateShortVolumeFromDb(ticker);
    return;
  }

  const records = await client.fetchShortVolume(ticker, fromDate, toDate);

  if (records.length === 0) {
    console.log(`[shortInterestIngestion] ${ticker}: no short volume records returned.`);
    await _hydrateShortVolumeFromDb(ticker);
    return;
  }

  const rows = records.map((r) => ({
    // short_vol_ratio is GENERATED ALWAYS AS STORED — must NOT be included in upsert
    id:           r.id ?? `${ticker}_${r.date}`,
    ticker,
    trade_date:   r.date,
    // BIGINT columns — Massive returns floats; Math.round() required
    short_volume: Math.round(r.short_volume),
    total_volume: Math.round(r.total_volume),
    fetched_at:   new Date().toISOString(),
  }));

  // ignoreDuplicates false, same reasoning as short_interest above — a
  // conflicting id should be overwritten, not silently skipped.
  const { error: upsertErr } = await supabase
    .from('short_volume')
    .upsert(rows, { onConflict: 'id', ignoreDuplicates: false });

  if (upsertErr) {
    console.error(`[shortInterestIngestion] ${ticker}: short_volume upsert failed —`, upsertErr.message);
    return;
  }

  console.log(`[shortInterestIngestion] ${ticker}: upserted ${rows.length} short volume records.`);

  // Wire most recent value into fundamentalsStore
  const sorted = [...records].sort((a, b) => b.date.localeCompare(a.date));
  const latest = sorted[0];

  fundamentalsStore.upsertShortVolume(ticker, latest.short_volume, latest.total_volume);
  console.log(`[shortInterestIngestion] ${ticker}: fundamentalsStore short volume wired — ${latest.short_volume}/${latest.total_volume} (${latest.date}).`);
}

async function _hydrateShortVolumeFromDb(ticker: string): Promise<void> {
  const { data, error } = await supabase
    .from('short_volume')
    .select('short_volume, total_volume, trade_date')
    .eq('ticker', ticker)
    .order('trade_date', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error || !data) return;

  fundamentalsStore.upsertShortVolume(ticker, data.short_volume as number, data.total_volume as number);
  console.log(`[shortInterestIngestion] ${ticker}: hydrated short volume from DB (${data.trade_date}).`);
}

// ── Free Float ────────────────────────────────────────────────────────────────
//
// Own cadence, own functions, scheduled separately in engine/index.ts — NOT
// looped inside runShortInterestBackfill. See this file's header for why:
// float changes quarterly-ish, forcing it onto short interest's bi-weekly
// or short volume's daily cadence would be real over-fetching.
//
// NOT YET CREATED: this writes to `stock_float`, which does not exist yet
// (same situation as earnings_calendar earlier this session — this engine
// has no service-role key and cannot run DDL). Required SQL, to run
// out-of-band:
//
//   create table public.stock_float (
//     ticker                text primary key,
//     free_float            bigint not null,
//     free_float_percent    numeric,
//     effective_date        date not null,
//     fetched_at            timestamptz not null default now()
//   );
//
// Until that table exists, this still fetches real data and calls
// fundamentalsStore.upsertFreeFloat() (so squeezeEngine's derived
// shortFloat works for the life of the process) — every DB write fails
// loudly and is logged, never silently swallowed.

async function _runFloatForTicker(client: MassiveRestClient, ticker: string): Promise<void> {
  let results: Awaited<ReturnType<MassiveRestClient['fetchFloat']>>;
  try {
    results = await client.fetchFloat(ticker);
  } catch (e) {
    console.error(`[shortInterestIngestion] ${ticker}: float fetch failed —`, e);
    return;
  }

  if (results.length === 0) {
    // Real, confirmed case — ETFs (e.g. GLD) have no real free-float concept.
    // Not an error, not retried, just genuinely nothing to store.
    console.log(`[shortInterestIngestion] ${ticker}: no free-float data (real — e.g. ETFs have no float concept).`);
    return;
  }

  const latest = results[0];
  const row = {
    ticker,
    free_float:         Math.round(latest.free_float), // BIGINT — Massive may return a float
    free_float_percent: latest.free_float_percent ?? null,
    effective_date:     latest.effective_date,
    fetched_at:         new Date().toISOString(),
  };

  const { error: upsertErr } = await supabase
    .from('stock_float')
    .upsert(row, { onConflict: 'ticker', ignoreDuplicates: false });

  if (upsertErr) {
    console.error(`[shortInterestIngestion] ${ticker}: stock_float upsert failed —`, upsertErr.message);
    // Fall through anyway — the in-memory store still gets the real value,
    // same discipline as earningsCalendarIngestion.
  } else {
    console.log(`[shortInterestIngestion] ${ticker}: upserted stock_float (${latest.effective_date}).`);
  }

  const freeFloat: FreeFloat = {
    shares:               latest.free_float,
    percentOfOutstanding: latest.free_float_percent ?? null,
    effectiveDate:        latest.effective_date,
    fetchedAt:            Date.now(),
  };
  fundamentalsStore.upsertFreeFloat(ticker, freeFloat);
  console.log(`[shortInterestIngestion] ${ticker}: fundamentalsStore free float wired — ${latest.free_float} shares (${latest.effective_date}).`);
}

/**
 * Run free-float backfill for all FEED_TICKERS. Own export so
 * engine/index.ts can schedule it on its own, much longer interval instead
 * of bundling it with runShortInterestBackfill's tighter cadence.
 */
export async function runFloatBackfill(client: MassiveRestClient): Promise<void> {
  console.log('[shortInterestIngestion] Starting free float backfill…');
  for (const ticker of FEED_TICKERS) {
    try {
      await _runFloatForTicker(client, ticker);
    } catch (e) {
      console.error(`[shortInterestIngestion] ${ticker}: unexpected float error —`, e);
    }
  }
  console.log('[shortInterestIngestion] Free float backfill complete.');
}

/**
 * Hydrate free float from DB on boot, same pattern as the other hydrate
 * functions — so a restart doesn't lose the derived shortFloat until the
 * next scheduled float run (which could be up to a week away).
 */
export async function hydrateFreeFloatFromDb(): Promise<void> {
  const { data, error } = await supabase
    .from('stock_float')
    .select('ticker, free_float, free_float_percent, effective_date, fetched_at')
    .in('ticker', FEED_TICKERS as unknown as string[]);

  if (error) {
    console.error(`[shortInterestIngestion] free float hydrate failed —`, error.message);
    return;
  }
  if (!data || data.length === 0) return;

  for (const row of data) {
    fundamentalsStore.upsertFreeFloat(row.ticker as string, {
      shares:               row.free_float as number,
      percentOfOutstanding: (row.free_float_percent as number | null) ?? null,
      effectiveDate:        row.effective_date as string,
      fetchedAt:            row.fetched_at ? new Date(row.fetched_at as string).getTime() : Date.now(),
    });
  }
  console.log(`[shortInterestIngestion] hydrated free float for ${data.length} ticker(s) from DB.`);
}

// ── TTL cleanup ───────────────────────────────────────────────────────────────

async function _runTtlCleanup(): Promise<void> {
  // short_interest: 2-year retention
  const { error: siErr } = await supabase
    .from('short_interest')
    .delete()
    .lt('report_date', yearsAgo(2));

  if (siErr) console.error('[shortInterestIngestion] TTL cleanup (short_interest) failed:', siErr.message);
  else console.log('[shortInterestIngestion] short_interest TTL cleanup complete (>2yr removed).');

  // short_volume: 90-day retention
  const { error: svErr } = await supabase
    .from('short_volume')
    .delete()
    .lt('trade_date', daysAgo(90));

  if (svErr) console.error('[shortInterestIngestion] TTL cleanup (short_volume) failed:', svErr.message);
  else console.log('[shortInterestIngestion] short_volume TTL cleanup complete (>90d removed).');
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Run short interest + short volume backfill for all FEED_TICKERS.
 * Called once from main.tsx — non-blocking (async, fire-and-forget).
 */
export async function runShortInterestBackfill(client: MassiveRestClient): Promise<void> {
  console.log('[shortInterestIngestion] Starting short interest + volume backfill…');

  for (const ticker of FEED_TICKERS) {
    try {
      await _runShortInterestForTicker(client, ticker);
      await _runShortVolumeForTicker(client, ticker);
    } catch (e) {
      console.error(`[shortInterestIngestion] ${ticker}: unexpected error —`, e);
    }
  }

  await _runTtlCleanup();

  console.log('[shortInterestIngestion] Backfill complete.');
}
