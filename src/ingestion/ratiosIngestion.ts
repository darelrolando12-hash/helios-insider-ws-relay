/**
 * Financial ratios ingestion — Swing Cockpit F8 only.
 *
 * Data source: Massive /vX/reference/financials (TTM) + /v3/reference/tickers
 * (market cap) — confirmed real, live-verified 2026-08-09.
 *
 * Computable ratios (verified against AAPL's real known values before
 * shipping): pe, pb, ps, debtEquity, roe, roa.
 *
 * NOT computable from this data source — always stored as null, never faked:
 *  - evEbitda: needs depreciation/amortization (to derive EBITDA) and cash
 *    balance (to derive Enterprise Value). Neither field exists anywhere in
 *    the financials response (confirmed absent across TTM/quarterly/
 *    include_sources variants).
 *  - fcfYield: needs capital expenditures (Free Cash Flow = CFO - capex).
 *    No capex field exists either. Using operating cash flow alone as a
 *    stand-in would coincidentally look right for low-capex companies (e.g.
 *    AAPL) and be silently wrong for capital-heavy ones — rejected.
 *
 * Cadence: these are TTM figures that only change on quarterly earnings;
 * market cap is the only daily-moving input and doesn't swing enough to
 * justify faster polling. Runs once at boot + once every 24h per ticker,
 * not on the 30s/30min cadence used elsewhere.
 *
 * Not resumable in the date-range sense (short interest/insiders) — this is
 * a single current snapshot per ticker, not a growing history. Re-running
 * simply overwrites the one row per ticker with fresh numbers.
 */

import { supabase }           from '../lib/supabase';
import { MassiveRestClient }  from '../lib/massive/api';
import * as fundamentalsStore from '../stores/fundamentalsStore';
import { FEED_TICKERS, CASH_SETTLED_TICKERS } from '../state/directionState';
import type { FinancialRatios } from '../stores/fundamentalsStore';
import { formatError }          from '../lib/errors';

const REFRESH_INTERVAL_MS = 24 * 60 * 60_000; // 24 hours

async function _runForTicker(client: MassiveRestClient, ticker: string): Promise<void> {
  // Cash-settled indexes (SPX, NDX) have no company financials or market
  // cap — they aren't equities. Skip cleanly rather than let the calls
  // throw "ticker not found" every refresh cycle.
  if (CASH_SETTLED_TICKERS.has(ticker)) {
    console.log(`[ratiosIngestion] ${ticker}: cash-settled index, no financials to fetch — skipping.`);
    return;
  }

  try {
    const [financials, overview] = await Promise.all([
      client.fetchFinancials(ticker),
      client.fetchTickerOverview(ticker),
    ]);

    if (!financials) {
      console.log(`[ratiosIngestion] ${ticker}: no financials data returned, skipping.`);
      return;
    }
    const marketCap = overview?.market_cap;
    if (marketCap == null) {
      console.log(`[ratiosIngestion] ${ticker}: no market_cap returned, skipping.`);
      return;
    }

    const income  = financials.financials.income_statement;
    const balance = financials.financials.balance_sheet;

    const netIncome   = income.net_income_loss?.value;
    const revenue     = income.revenues?.value;
    const equity      = balance.equity?.value;
    const liabilities = balance.liabilities?.value;
    const assets       = balance.assets?.value;

    const pe         = netIncome && netIncome > 0 ? marketCap / netIncome : undefined;
    const pb         = equity    && equity    > 0 ? marketCap / equity    : undefined;
    const ps         = revenue   && revenue   > 0 ? marketCap / revenue   : undefined;
    const debtEquity = liabilities != null && equity && equity > 0 ? liabilities / equity : undefined;
    const roe        = netIncome != null && equity && equity > 0 ? netIncome / equity : undefined;
    const roa        = netIncome != null && assets  && assets  > 0 ? netIncome / assets  : undefined;

    const periodEnd = new Date(`${financials.end_date}T12:00:00Z`).getTime();

    const row = {
      ticker,
      pe:          pe          ?? null,
      pb:          pb          ?? null,
      ps:          ps          ?? null,
      debt_equity: debtEquity  ?? null,
      roe:         roe         ?? null,
      roa:         roa         ?? null,
      ev_ebitda:   null, // not computable — see module header
      fcf_yield:   null, // not computable — see module header
      period_end:  financials.end_date,
      fetched_at:  new Date().toISOString(),
    };

    const { error: upsertErr } = await supabase
      .from('financial_ratios')
      .upsert(row, { onConflict: 'ticker' });

    if (upsertErr) {
      console.error(`[ratiosIngestion] ${ticker}: upsert failed —`, upsertErr.message);
      return;
    }

    const ratios: FinancialRatios = {
      pe, pb, ps, debtEquity, roe, roa,
      evEbitda: undefined,
      fcfYield: undefined,
      periodEnd,
    };
    fundamentalsStore.upsertRatios(ticker, ratios);
    console.log(
      `[ratiosIngestion] ${ticker}: wired — pe=${pe?.toFixed(1) ?? 'n/a'}, ` +
      `pb=${pb?.toFixed(1) ?? 'n/a'}, ps=${ps?.toFixed(1) ?? 'n/a'}, ` +
      `debtEquity=${debtEquity?.toFixed(2) ?? 'n/a'}, roe=${roe != null ? (roe * 100).toFixed(1) + '%' : 'n/a'}, ` +
      `roa=${roa != null ? (roa * 100).toFixed(1) + '%' : 'n/a'} (evEbitda/fcfYield always null — see module header).`
    );
  } catch (e) {
    console.error(`[ratiosIngestion] ${ticker}: unexpected error — ${formatError(e)}`);
  }
}

/**
 * Run financial ratios ingestion for all FEED_TICKERS.
 * Called once from main.tsx, then re-run every 24h via setInterval — not
 * resumable/windowed like other ingestion jobs, since this is always just
 * the current snapshot per ticker.
 */
export async function runRatiosIngestion(client: MassiveRestClient): Promise<void> {
  console.log('[ratiosIngestion] Starting financial ratios ingestion…');
  for (const ticker of FEED_TICKERS) {
    await _runForTicker(client, ticker);
  }
  console.log('[ratiosIngestion] Ingestion pass complete.');
}

export { REFRESH_INTERVAL_MS };
