/**
 * Layer 0 — REST backfill client (server-side only).
 *
 * This module runs inside the Railway relay (or a Vercel serverless function).
 * It is NEVER imported by browser code. The API key is injected via the
 * constructor — no import.meta.env or process.env references inside this file.
 *
 * Responsibilities:
 *   1. Cold-start backfill: fetch recent bars for a ticker on initial load.
 *   2. Reconnect gap-fill: fetch trades since the last known bar when
 *      websocket.ts emits 'reconnected' and barStore detects a stale ticker.
 *
 * Nothing else calls Massive REST directly. All live data comes from the
 * WebSocket relay. This module is the only permitted REST → Massive path.
 */

import type { Bar, MarketStatus } from '../../stores/types';
import { toCentralTime } from '../time';

// ── Internal types ────────────────────────────────────────────────────────────

interface MassiveAggResult {
  o:  number;   // open
  h:  number;   // high
  l:  number;   // low
  c:  number;   // close
  v:  number;   // volume
  vw: number;   // vwap
  n:  number;   // transactions
  t:  number;   // bar start time (UTC ms)
}

interface MassiveAggResponse {
  status:     string;
  resultsCount: number;
  results:    MassiveAggResult[];
  ticker:     string;
  queryCount: number;
  adjusted:   boolean;
  next_url?:  string;
}

interface MassiveTradeResult {
  price:       number;
  size:        number;
  timestamp:   number;  // UTC ms
  conditions?: number[];
  exchange?:   number;
}

interface MassiveTradeResponse {
  status:  string;
  results: MassiveTradeResult[];
  next_url?: string;
}

interface MassiveMarketStatusResponse {
  market:     string;
  serverTime: string;
  exchanges: {
    nyse:   string;
    nasdaq: string;
    otc:    string;
  };
}

// ── MassiveRestClient ─────────────────────────────────────────────────────────

export class MassiveRestClient {
  private readonly _apiKey:  string;
  private readonly _baseUrl: string;

  constructor(apiKey: string, baseUrl = 'https://api.massive.com') {
    this._apiKey  = apiKey;
    this._baseUrl = baseUrl;
  }

  // ── Bars ───────────────────────────────────────────────────────────────────

  /**
   * Cold-start backfill: fetch `limit` minute bars ending now for `ticker`.
   *
   * Used on initial load to populate `barsStore` before WebSocket data arrives.
   * Supports both stock tickers (e.g. "SPY") and options tickers
   * (e.g. "O:SPY251219C00650000") — the `aggs` endpoint handles both.
   *
   * @param ticker   Stock or options ticker
   * @param minutes  Bar width in minutes (default: 1)
   * @param limit    Number of bars to fetch (default: 390 — one full session)
   */
  public async fetchRecentBars(
    ticker:  string,
    minutes = 1,
    limit   = 390,
  ): Promise<Bar[]> {
    // Build a from/to window: `limit` minutes before now → now
    const toMs   = Date.now();
    const fromMs = toMs - limit * minutes * 60 * 1000;

    return this._fetchBarRange(ticker, minutes, fromMs, toMs);
  }

  /**
   * Reconnect gap-fill: fetch bars between `fromUtcMs` and `toUtcMs`.
   *
   * Called by barStore when it detects a stale ticker (last bar > 2 minutes
   * old) after a websocket reconnect. Fills the gap without re-fetching the
   * entire session.
   *
   * Engineering Lesson #9: reconnect triggers a cold-start re-sync only for
   * tickers whose last bar is > 2 minutes old. This method handles that sync.
   */
  public async fetchBarRange(
    ticker:    string,
    fromUtcMs: number,
    toUtcMs:   number,
    minutes  = 1,
  ): Promise<Bar[]> {
    return this._fetchBarRange(ticker, minutes, fromUtcMs, toUtcMs);
  }

  // ── Trades (reconnect gap-fill only) ──────────────────────────────────────

  /**
   * Fetch raw trades for `ticker` after `afterUtcMs`.
   *
   * Confirmed available on-plan. Used exclusively for reconnect gap-fill of
   * trade history — NOT a live CVD source. Live CVD comes from the WS T/Q
   * channels only. Do not call this for any other purpose.
   *
   * @param ticker     Stock or options ticker
   * @param afterUtcMs Only return trades with timestamp > this value
   * @param limit      Max results (default: 1000)
   */
  public async fetchTradesSince(
    ticker:    string,
    afterUtcMs: number,
    limit      = 1000,
  ): Promise<MassiveTradeResult[]> {
    const url = this._url(
      `/v3/trades/${encodeURIComponent(ticker)}`,
      { timestamp: `gt.${afterUtcMs}`, limit: String(limit), sort: 'timestamp' },
    );

    const json = await this._get<MassiveTradeResponse>(url);
    return json.results ?? [];
  }

  // ── Market status ──────────────────────────────────────────────────────────

  /**
   * Current market status (open / closed / extended-hours).
   * Called once on cold start and periodically to update cockpit status banners.
   */
  public async fetchMarketStatus(): Promise<MarketStatus> {
    const url  = this._url('/v1/marketstatus/now');
    const json = await this._get<MassiveMarketStatusResponse>(url);

    const serverTimeMs = new Date(json.serverTime).getTime();

    return {
      market:       normaliseStatus(json.market),
      serverTime:   json.serverTime,
      serverTimeMs,
      exchanges: {
        nyse:   normaliseStatus(json.exchanges.nyse),
        nasdaq: normaliseStatus(json.exchanges.nasdaq),
        otc:    normaliseStatus(json.exchanges.otc),
      },
    };
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  private async _fetchBarRange(
    ticker:    string,
    minutes:   number,
    fromUtcMs: number,
    toUtcMs:   number,
  ): Promise<Bar[]> {
    // Dates must be YYYY-MM-DD strings for the aggs endpoint
    const from = utcMsToDate(fromUtcMs);
    const to   = utcMsToDate(toUtcMs);

    const url = this._url(
      `/v2/aggs/ticker/${encodeURIComponent(ticker)}/range/${minutes}/minute/${from}/${to}`,
      { adjusted: 'true', sort: 'asc', limit: '50000' },
    );

    const json = await this._get<MassiveAggResponse>(url);

    if (!json.results || json.results.length === 0) return [];

    return json.results.map((r) => massiveAggToBar(ticker, r));
  }

  private _url(path: string, params: Record<string, string> = {}): string {
    const qs = new URLSearchParams({
      ...params,
      apiKey: this._apiKey,
    });
    return `${this._baseUrl}${path}?${qs.toString()}`;
  }

  private async _get<T>(url: string): Promise<T> {
    const res = await fetch(url, {
      method:  'GET',
      headers: { Accept: 'application/json' },
    });

    if (!res.ok) {
      throw new Error(
        `MassiveREST ${res.status} ${res.statusText} — ${url.split('?')[0]}`,
      );
    }

    return res.json() as Promise<T>;
  }
}

// ── Module-level pure helpers ─────────────────────────────────────────────────

/**
 * Convert a Massive agg result to a canonical Bar.
 *
 * tUtc is stored as-is from Massive (UTC ms).
 * tCT is derived via toCentralTime — DST-correct CT pseudo-epoch.
 * This is the only place in the app that constructs Bar objects from REST data.
 */
export function massiveAggToBar(ticker: string, r: MassiveAggResult): Bar {
  const ct = toCentralTime(r.t);
  return {
    ticker,
    open:         r.o,
    high:         r.h,
    low:          r.l,
    close:        r.c,
    volume:       r.v,
    vwap:         r.vw,
    transactions: r.n,
    tCT:          ct.ctMs,
    tUtc:         r.t,
  };
}

/**
 * Convert UTC ms to a YYYY-MM-DD string for the Massive aggs endpoint.
 * Uses UTC date (not CT) because the endpoint expects calendar dates in
 * the context of exchange session days, which Massive interprets in ET.
 * Fetching slightly wider than needed (a full UTC day) is safe — extra
 * bars outside CT market hours are filtered by the store's isDataReady check.
 */
function utcMsToDate(utcMs: number): string {
  const d = new Date(utcMs);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * Normalise a Massive market status string to the app's MarketStatusValue union.
 * Massive can return values like "open", "closed", "extended-hours" — map
 * anything unrecognised to "closed" so consumers never handle unexpected strings.
 */
function normaliseStatus(s: string): MarketStatus['market'] {
  switch (s.toLowerCase()) {
    case 'open':           return 'open';
    case 'extended-hours': return 'extended-hours';
    case 'early-hours':    return 'early-hours';
    default:               return 'closed';
  }
}
