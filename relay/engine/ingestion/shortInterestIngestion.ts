/**
 * Short Interest + Short Volume ingestion
 *
 * Runs once at boot. For each ticker in FEED_TICKERS:
 *
 * SHORT INTEREST (2-year window, bi-weekly Massive reports):
 *   1. Check most recent report_date already in short_interest table.
 *   2. Fetch from (last stored date + 1 day) to today, or full 2 years if empty.
 *   3. Upsert to DB using Massive's report_id (or derived key) as PK.
 *   4. After DB write, call fundamentalsStore.upsertShortInterest() with the
 *      most recent report — this is the value squeezeEngine reads immediately.
 *
 * SHORT VOLUME (90-day window, daily):
 *   1. Check most recent trade_date already in short_volume table.
 *   2. Fetch from (last stored date + 1 day) to today, or 90 days if empty.
 *   3. Upsert to DB.
 *   4. After DB write, call fundamentalsStore.upsertShortVolume() with the
 *      most recent day's values.
 *
 * TTL enforcement:
 *   short_interest: DELETE rows older than 2 years (updated retention policy).
 *   short_volume:   DELETE rows older than 90 days.
 *   Both run at end of each backfill to keep DB clean on each boot.
 *
 * All calls are serialized per-ticker. Fire-and-forget from main.tsx.
 */

import { supabase }              from '../lib/supabase';
import { MassiveRestClient }     from '../lib/massive/api';
import * as fundamentalsStore    from '../stores/fundamentalsStore';
import { FEED_TICKERS }          from '../state/directionState';
import type { ShortInterestSnapshot } from '../stores/types';

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
    short_pct_float:  r.short_pct_float  ?? null,
    settlement_date:  r.settlement_date,
    fetched_at:       new Date().toISOString(),
  }));

  const { error: upsertErr } = await supabase
    .from('short_interest')
    .upsert(rows, { onConflict: 'id', ignoreDuplicates: true });

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

  const snapshot: ShortInterestSnapshot = {
    ticker,
    shortInterest: latest.short_interest,
    shortFloat:    latest.short_pct_float,
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
    shortFloat:    data.short_pct_float  ?? undefined,
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

  const { error: upsertErr } = await supabase
    .from('short_volume')
    .upsert(rows, { onConflict: 'id', ignoreDuplicates: true });

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
