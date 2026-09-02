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

import type { Bar, MarketStatus } from '../../stores/types.ts';
import { toCentralTime } from '../time.ts';

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

// ── Options snapshot types ────────────────────────────────────────────────────

/** One contract in a Massive /v3/snapshot/options response. */
export interface OptionsContractSnapshot {
  /** Options contract ticker in OCC format, e.g. "O:SPY251219C00650000" */
  details: {
    contract_type:   'call' | 'put';
    strike_price:    number;
    expiration_date: string;  // YYYY-MM-DD
    ticker:          string;
  };
  greeks?: {
    delta: number;
    gamma: number;
    theta: number;
    vega:  number;
  };
  implied_volatility?: number;
  open_interest?:      number;
  day?: {
    volume?: number;
    last?:   number;
  };
  last_quote?: {
    bid?: number;
    ask?: number;
  };
  /** Current underlying price — present in response, avoids barsStore dependency. */
  underlying_asset?: {
    price?: number;
    value?: number;
    ticker?: string;
  };
}

interface MassiveOptionsSnapshotResponse {
  results:    OptionsContractSnapshot[];
  status:     string;
  request_id: string;
  /** Cursor URL for next page — present when more results exist. */
  next_url?:  string;
}

// ── Short Interest types ──────────────────────────────────────────────────────

export interface MassiveShortInterestResult {
  /** Ticker symbol */
  ticker:            string;
  /** Settlement date for this report (YYYY-MM-DD) */
  settlement_date:   string;
  /** Number of shares sold short */
  short_interest:    number;
  /** Average daily trading volume used for days-to-cover */
  avg_daily_volume?: number;
  /** Days-to-cover (short_interest / avg_daily_volume) */
  days_to_cover?:    number;
  /** Short interest as pct of float (0–100) */
  short_pct_float?:  number;
  /** Massive internal report id — used as primary key in DB */
  report_id?:        string;
}

interface MassiveShortInterestResponse {
  results:  MassiveShortInterestResult[];
  status:   string;
  count?:   number;
}

// ── Float types ────────────────────────────────────────────────────────────────

/**
 * Real endpoint: GET /stocks/vX/float — confirmed live 2026-09-02 against
 * Massive's own docs and a real call. NOT a time series the way short
 * interest is: a query with no date filter returned exactly one row per
 * ticker (TSLA's only real record: effective_date 2026-07-24), consistent
 * with float changing quarterly-ish (buybacks/issuance), not on a report
 * cadence. Real, live-confirmed: an ETF (GLD) returns an empty result set —
 * ETFs structurally have no free-float concept, same "real zero" pattern as
 * GLD's real zero 8-K filings.
 */
export interface MassiveFloatResult {
  ticker:             string;
  effective_date:     string;   // YYYY-MM-DD
  free_float:          number;   // shares freely tradable
  free_float_percent?: number;   // free_float / shares outstanding * 100, rounded to 2dp
}

interface MassiveFloatResponse {
  results:  MassiveFloatResult[];
  status:   string;
  next_url?: string;
}

// ── Short Volume types ────────────────────────────────────────────────────────

export interface MassiveShortVolumeResult {
  /** Ticker symbol */
  ticker:             string;
  /** Trade date (YYYY-MM-DD) */
  date:               string;
  /** Total reported short volume for the day */
  short_volume:       number;
  /** Total reported volume for the day */
  total_volume:       number;
  /**
   * Percentage of total volume that was sold short: (short_volume / total_volume) * 100.
   * Returned directly by the API. The DB column is GENERATED ALWAYS AS STORED so this
   * field must NOT be included in upsert rows — it is here for type accuracy only.
   */
  short_volume_ratio?: number;
  /** Massive internal record id — used as primary key in DB */
  id?:                string;
}

interface MassiveShortVolumeResponse {
  results: MassiveShortVolumeResult[];
  status:  string;
  count?:  number;
}

// ── Form 4 insider transaction types ─────────────────────────────────────────

export interface MassiveForm4Result {
  tickers:                             string[];
  issuer_cik:                          string;
  owner_cik:                           string;
  accession_number:                    string;
  form_type:                           string;
  filing_date:                         string;   // YYYY-MM-DD
  period_of_report:                    string;
  issuer_name:                         string;
  owner_name:                          string;
  is_director:                         boolean;
  is_officer:                          boolean;
  is_ten_percent_owner:                boolean;
  is_other:                            boolean;
  officer_title?:                      string;
  security_type:                       string;   // 'derivative' | 'non_derivative'
  record_type:                         string;
  security_title:                      string;
  transaction_timeliness?:             string;
  aff_10b5_one:                        boolean;
  transaction_date?:                   string;   // YYYY-MM-DD — absent on 'holding' record_type
  transaction_code?:                   string;   // e.g. 'A', 'S', 'P' — absent on 'holding' record_type
  transaction_acquired_disposed:       string;   // 'A' | 'D'
  transaction_shares?:                 number;
  transaction_price_per_share?:        number;
  transaction_value?:                  number;
  shares_owned_following_transaction?: number;
  direct_or_indirect?:                 string;   // 'D' | 'I'
  /**
   * Free-text description of an indirect holding's ownership vehicle, e.g.
   * "By Trust", "By Limited Liability Company 1". Present when
   * direct_or_indirect === 'I'. Added 2026-09-02: two real NVDA holding rows
   * for the same owner, same accession, same running share total collided
   * on every other field — genuinely different entities (two separate LLCs)
   * that happened to report an identical share count. This field is what
   * actually distinguishes them; see form4RowId() in insiderIngestion.ts.
   */
  nature_of_ownership?:                string;
  filing_url:                          string;
}

interface MassiveForm4Response {
  results:  MassiveForm4Result[];
  status:   string;
  next_url?: string;
  request_id?: string;
}

// ── 8-K disclosure types ──────────────────────────────────────────────────────

export interface MassiveEightKResult {
  tickers:             string[];
  cik:                 string;
  accession_number:    string;
  filing_date:         string;   // YYYY-MM-DD
  primary_category:    string;
  secondary_category:  string;
  tertiary_category:   string;
  supporting_text:     string;
  filing_url:          string;
}

interface MassiveEightKResponse {
  results:     MassiveEightKResult[];
  status:      string;
  next_url?:   string;
  request_id?: string;
}

// ── Financials + Ticker Overview types (for financial ratios) ────────────────

/**
 * Subset of the /vX/reference/financials TTM response actually used to
 * compute financial ratios. Real fields confirmed to exist via live call
 * 2026-08-09 — depreciation, cash balance, and capex are NOT present on
 * this endpoint (confirmed absent across full/quarterly/include_sources
 * variants), which is why evEbitda and fcfYield cannot be computed and
 * are always stored as null.
 */
export interface MassiveFinancialsResult {
  start_date:      string;  // YYYY-MM-DD
  end_date:        string;  // YYYY-MM-DD — used as periodEnd
  fiscal_period:   string;  // 'TTM' for the timeframe used here
  timeframe:       string;  // 'ttm'
  financials: {
    income_statement: {
      revenues?:        { value: number };
      net_income_loss?: { value: number };
    };
    balance_sheet: {
      equity?:      { value: number };
      liabilities?: { value: number };
      assets?:      { value: number };
    };
  };
}

interface MassiveFinancialsResponse {
  results: MassiveFinancialsResult[];
  status:  string;
}

/** Subset of /v3/reference/tickers/{ticker} actually used — just market cap. */
export interface MassiveTickerOverviewResult {
  market_cap?: number;
}

interface MassiveTickerOverviewResponse {
  results: MassiveTickerOverviewResult;
  status:  string;
}

/**
 * Subset of /v3/reference/tickers (list form) actually used to build the
 * breadth allowlist. This is the LIST endpoint (plural, no {ticker} path
 * param) — a different response shape from MassiveTickerOverviewResponse
 * above, which fetches a single ticker's overview.
 */
export interface MassiveReferenceTickerResult {
  ticker:           string;
  primary_exchange: string;  // e.g. 'XNYS', 'XNAS', 'XASE'
  type:             string;  // 'CS' = common stock (already filtered server-side)
  active:           boolean;
}

interface MassiveReferenceTickersResponse {
  results:   MassiveReferenceTickerResult[];
  status:    string;
  next_url?: string;
}

// ── Daily bar types ───────────────────────────────────────────────────────────

export interface MassiveDailyBarResult {
  /** Bar open time (UTC ms) */
  t:  number;
  o:  number;
  h:  number;
  l:  number;
  c:  number;
  v:  number;
  vw: number;
  n:  number;
}

export interface MassiveDailyBarResponse {
  results:      MassiveDailyBarResult[];
  /** "OK", "NO_RESULTS", "NOT_FOUND", etc. — always present even on empty responses */
  status:       string;
  resultsCount: number;
  /** Massive echoes the requested ticker back — useful for diagnosing coverage gaps */
  ticker:       string;
}

// ── MassiveRestClient ─────────────────────────────────────────────────────────

export class MassiveRestClient {
  private readonly _baseUrl: string;
  private readonly _apiKey:  string;

  /**
   * @param baseUrl  Request origin. Server-side this MUST be the direct
   *                 Massive origin (https://api.massive.com) — routing
   *                 through the relay's own /rest/ proxy would be a loopback
   *                 to itself. See relay/config.ts MASSIVE_REST_BASE_URL.
   * @param apiKey   Massive API key, attached to every outgoing request.
   *
   *                 This parameter did not previously exist: in the browser
   *                 the client deliberately sent NO key, because it talked to
   *                 the relay's /rest/ proxy, which attached the key
   *                 server-side (relay/index.js). Talking direct to Massive,
   *                 that proxy is gone — so without a key here every single
   *                 REST call would come back 401. Both call sites that build
   *                 URLs (_url and _relayUrl) attach it.
   *
   *                 Defaults to '' so browser/proxy usage keeps its old
   *                 behaviour of sending nothing.
   */
  constructor(baseUrl: string, apiKey = '') {
    this._baseUrl = baseUrl;
    this._apiKey  = apiKey;
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

  // ── Options snapshot ──────────────────────────────────────────────────────

  /**
   * Fetch a full options chain snapshot for an underlying ticker.
   *
   * Uses Massive's /v3/snapshot/options/{underlyingAsset} endpoint which
   * returns current greeks, OI, IV, bid/ask, last price per contract.
   * This is the only correct data source for OI + greeks — Q-channel quotes
   * carry only bid/ask and no OI or gamma fields.
   *
   * Max 250 per page (API limit). Paginates via next_url to collect all
   * contracts up to `maxContracts` total.
   *
   * @param ticker        Underlying stock ticker (e.g. 'SPY', 'QQQ')
   * @param maxContracts  Total contracts to fetch across all pages (default: 1000)
   */
  public async fetchOptionsSnapshot(
    ticker: string,
    maxContracts = 2000,
  ): Promise<OptionsContractSnapshot[]> {
    const PAGE_LIMIT = 250; // API hard max per page
    const all: OptionsContractSnapshot[] = [];

    // First page.
    // Sort by expiration_date THEN strike_price so the nearest expiry is fetched
    // completely before far-dated expiries. Without this, strike_price-sorted
    // pagination fills the 2000-contract cap with near-term contracts only,
    // starving all far-dated expiry tabs of data.
    let url: string | null = this._url(
      `/v3/snapshot/options/${encodeURIComponent(ticker)}`,
      { limit: String(PAGE_LIMIT), order: 'asc', sort: 'expiration_date' },
    );

    while (url !== null && all.length < maxContracts) {
      const json: MassiveOptionsSnapshotResponse = await this._get<MassiveOptionsSnapshotResponse>(url);
      if (json.results?.length) {
        all.push(...json.results);
      }
      // Massive's next_url cursor is rewritten to route through the relay.
      if (json.next_url) {
        url = this._relayUrl(json.next_url);
      } else {
        url = null;
      }
    }

    return all;
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

  // ── Short Interest ─────────────────────────────────────────────────────────

  /**
   * Fetch short interest reports for `ticker`.
   *
   * Endpoint: GET /stocks/v1/short-interest
   * Confirmed available on plan.
   *
   * @param ticker    Stock ticker (e.g. 'SPY')
   * @param fromDate  YYYY-MM-DD — oldest report date to include
   * @param toDate    YYYY-MM-DD — most recent report date (default: today)
   * @param limit     Max results per page (default: 100)
   */
  public async fetchShortInterest(
    ticker:   string,
    fromDate: string,
    toDate:   string,
    limit   = 100,
  ): Promise<MassiveShortInterestResult[]> {
    const url = this._url(
      `/stocks/v1/short-interest`,
      {
        ticker,
        'settlement_date.gte': fromDate,
        'settlement_date.lte': toDate,
        limit:                 String(limit),
        sort:                  'settlement_date.asc',
      },
    );
    const json = await this._get<MassiveShortInterestResponse>(url);
    return json.results ?? [];
  }

  // ── Float ──────────────────────────────────────────────────────────────────

  /**
   * Fetch the current free-float snapshot for `ticker`.
   *
   * Endpoint: GET /stocks/vX/float — confirmed live 2026-09-02. Not a date-
   * ranged history: no date-filter params exist on this endpoint (confirmed
   * against real docs), and a real query returned exactly one row (the
   * current snapshot). Returns [] for tickers with no real free-float
   * concept (confirmed live: GLD, an ETF).
   */
  public async fetchFloat(ticker: string): Promise<MassiveFloatResult[]> {
    const url = this._url('/stocks/vX/float', { ticker, limit: '5' });
    const json = await this._get<MassiveFloatResponse>(url);
    return json.results ?? [];
  }

  // ── Short Volume ───────────────────────────────────────────────────────────

  /**
   * Fetch daily short volume for `ticker`.
   *
   * Endpoint: GET /stocks/v1/short-volume
   * Confirmed available on plan.
   *
   * @param ticker    Stock ticker
   * @param fromDate  YYYY-MM-DD
   * @param toDate    YYYY-MM-DD
   * @param limit     Max results per page (default: 100)
   */
  public async fetchShortVolume(
    ticker:   string,
    fromDate: string,
    toDate:   string,
    limit   = 100,
  ): Promise<MassiveShortVolumeResult[]> {
    const url = this._url(
      `/stocks/v1/short-volume`,
      {
        ticker,
        'date.gte': fromDate,
        'date.lte': toDate,
        limit:      String(limit),
        sort:       'date.asc',
      },
    );
    const json = await this._get<MassiveShortVolumeResponse>(url);
    return json.results ?? [];
  }

  // ── Form 4 insider transactions ───────────────────────────────────────────

  /**
   * Fetch Form 4 insider transaction filings for `ticker`.
   *
   * Endpoint: GET /stocks/filings/vX/form-4
   * Confirmed available on plan — real live data verified 2026-08-08.
   *
   * Filter param is `tickers` (plural) — singular `ticker` is silently
   * ignored by this endpoint and returns unfiltered results.
   *
   * Paginates via next_url (same apiKey re-attach fix as options snapshot —
   * Massive's cursor omits the key on every endpoint that uses it).
   *
   * @param ticker    Stock ticker (e.g. 'AAPL')
   * @param fromDate  YYYY-MM-DD — oldest filing_date to include
   * @param toDate    YYYY-MM-DD — most recent filing_date (default: today)
   * @param maxResults Total records to fetch across all pages (default: 500)
   */
  public async fetchForm4Filings(
    ticker:     string,
    fromDate:   string,
    toDate:     string,
    maxResults = 500,
  ): Promise<MassiveForm4Result[]> {
    const PAGE_LIMIT = 100;
    const all: MassiveForm4Result[] = [];

    let url: string | null = this._url(
      `/stocks/filings/vX/form-4`,
      {
        tickers:            ticker,
        'filing_date.gte':  fromDate,
        'filing_date.lte':  toDate,
        limit:              String(PAGE_LIMIT),
        sort:               'filing_date.asc',
      },
    );

    while (url !== null && all.length < maxResults) {
      const json: MassiveForm4Response = await this._get<MassiveForm4Response>(url);
      if (json.results?.length) {
        all.push(...json.results);
      }
      if (json.next_url) {
        url = this._relayUrl(json.next_url);
      } else {
        url = null;
      }
    }

    return all;
  }

  /**
   * Fetch 8-K disclosure filings for `ticker` between `fromDate` and `toDate`
   * (inclusive, YYYY-MM-DD). Real endpoint confirmed 2026-08-14 — same
   * pagination pattern as fetchForm4Filings (filing_date.gte/lte, next_url
   * cursor). Note: endpoint path is /8-K/ (uppercase K, hyphenated), distinct
   * from Form 4's /vX/form-4 path shape — do not assume analogous URLs
   * elsewhere without checking the real docs first.
   *
   * @param maxResults Total records to fetch across all pages (default: 500)
   */
  public async fetchEightKFilings(
    ticker:     string,
    fromDate:   string,
    toDate:     string,
    maxResults = 500,
  ): Promise<MassiveEightKResult[]> {
    const PAGE_LIMIT = 100; // confirmed real API max is 1000; using 100 to match Form 4's per-page cadence
    const all: MassiveEightKResult[] = [];

    let url: string | null = this._url(
      `/stocks/filings/8-K/vX/disclosures`,
      {
        tickers:           ticker,
        'filing_date.gte': fromDate,
        'filing_date.lte': toDate,
        limit:             String(PAGE_LIMIT),
        sort:              'filing_date.asc',
      },
    );

    while (url !== null && all.length < maxResults) {
      const json: MassiveEightKResponse = await this._get<MassiveEightKResponse>(url);
      if (json.results?.length) {
        all.push(...json.results);
      }
      if (json.next_url) {
        url = this._relayUrl(json.next_url);
      } else {
        url = null;
      }
    }

    return all;
  }

  // ── Daily bars ─────────────────────────────────────────────────────────────

  /**
   * Fetch daily OHLCV bars for `ticker` between two calendar dates.
   *
   * Uses the same /v2/aggs/ticker endpoint as minute bars, with multiplier=1
   * and timespan=day. Limit 50000 covers 5 years (1260 days) in one page.
   *
   * Returns the full Massive response envelope (not just results[]) so the
   * caller can inspect `status`, `resultsCount`, and the echoed `ticker` field
   * to distinguish "ticker not covered on this plan" (status="NOT_FOUND" or
   * status="NO_RESULTS") from a real empty window.
   *
   * @param ticker    Stock ticker
   * @param fromDate  YYYY-MM-DD (inclusive)
   * @param toDate    YYYY-MM-DD (inclusive)
   */
  public async fetchDailyBars(
    ticker:   string,
    fromDate: string,
    toDate:   string,
  ): Promise<MassiveDailyBarResponse> {
    const url = this._url(
      `/v2/aggs/ticker/${encodeURIComponent(ticker)}/range/1/day/${fromDate}/${toDate}`,
      { adjusted: 'true', sort: 'asc', limit: '50000' },
    );
    const json = await this._get<MassiveDailyBarResponse>(url);
    // Normalise: ensure results is always an array even if Massive omits the field
    return { ...json, results: json.results ?? [] };
  }

  // ── Financials + Ticker Overview (for financial ratios) ────────────────────

  /**
   * Fetch trailing-twelve-month financial statements for `ticker`.
   *
   * Endpoint: GET /vX/reference/financials?timeframe=ttm (default)
   * Confirmed real, live-verified 2026-08-09. Provides income statement and
   * balance sheet figures needed for P/E, P/B, P/S, Debt/Equity, ROE, ROA.
   * Does NOT provide depreciation, cash balance, or capex — EV/EBITDA and
   * FCF Yield cannot be computed from this endpoint.
   */
  public async fetchFinancials(ticker: string): Promise<MassiveFinancialsResult | null> {
    const url = this._url(`/vX/reference/financials`, { ticker, limit: '1' });
    const json = await this._get<MassiveFinancialsResponse>(url);
    return json.results?.[0] ?? null;
  }

  /**
   * Fetch ticker overview for `ticker`, used here only for market_cap —
   * the piece financials statements don't carry, needed to turn raw
   * income/balance-sheet figures into market-relative ratios.
   *
   * Endpoint: GET /v3/reference/tickers/{ticker}
   * Confirmed real, live-verified 2026-08-09.
   */
  public async fetchTickerOverview(ticker: string): Promise<MassiveTickerOverviewResult | null> {
    const url = this._url(`/v3/reference/tickers/${encodeURIComponent(ticker)}`);
    const json = await this._get<MassiveTickerOverviewResponse>(url);
    return json.results ?? null;
  }

  // ── Reference ticker list (for market breadth allowlist) ───────────────────

  /**
   * Fetch the full list of active common-stock tickers on NYSE/Nasdaq/AMEX.
   *
   * Endpoint: GET /v3/reference/tickers?market=stocks&type=CS&active=true
   * Confirmed real, live-verified — this endpoint carries `primary_exchange`
   * and `type` fields (the full market snapshot endpoint used for breadth
   * price/volume data does NOT carry these, which is why this separate call
   * exists — it's the only way to filter out non-NYSE/Nasdaq/AMEX and
   * non-common-stock tickers before computing breadth).
   *
   * Paginated via next_url — confirmed live to be ~5,300 tickers across
   * ~6 pages of 1,000. A single-page fetch would silently drop 80%+ of
   * the real list, the same failure class already fixed for options
   * snapshots and 1-min bars — so this loop is mandatory, not optional.
   * next_url cursor omits apiKey; re-attached explicitly on every page.
   */
  public async fetchReferenceTickers(): Promise<MassiveReferenceTickerResult[]> {
    const url = this._url('/v3/reference/tickers', {
      market: 'stocks',
      type:   'CS',
      active: 'true',
      limit:  '1000',
    });

    let nextUrl: string | null = url;
    const all: MassiveReferenceTickerResult[] = [];

    while (nextUrl !== null) {
      const page: MassiveReferenceTickersResponse = await this._get<MassiveReferenceTickersResponse>(nextUrl);
      if (page.results?.length) {
        all.push(...page.results);
      }
      if (page.next_url) {
        nextUrl = this._relayUrl(page.next_url);
      } else {
        nextUrl = null;
      }
    }

    return all;
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

    // Paginate via next_url — 2yr × 1-min bars ≈ 196k rows per ticker,
    // which exceeds the 50k-row page cap. Same pattern as fetchOptionsSnapshot.
    // next_url cursor omits apiKey; re-attach explicitly on every follow-up.
    let nextUrl: string | null = url;
    const all: Bar[] = [];

    while (nextUrl !== null) {
      const page: MassiveAggResponse = await this._get<MassiveAggResponse>(nextUrl);
      if (page.results?.length) {
        all.push(...page.results.map((r: MassiveAggResult) => massiveAggToBar(ticker, r)));
      }
      if (page.next_url) {
        nextUrl = this._relayUrl(page.next_url);
      } else {
        nextUrl = null;
      }
    }

    return all;
  }

  private _url(path: string, params: Record<string, string> = {}): string {
    const qs = new URLSearchParams(params);
    if (this._apiKey) qs.set('apiKey', this._apiKey);
    return `${this._baseUrl}${path}?${qs.toString()}`;
  }

  /**
   * Rewrites a Massive-issued `next_url` (real api.massive.com cursor link)
   * onto this client's own base origin.
   *
   * The inbound cursor's apiKey is always stripped first, then this client's
   * own key is re-attached if it has one. That ordering matters in both
   * directions: against the relay proxy the key must NOT be forwarded (the
   * proxy adds its own), and against Massive direct the cursor's key must be
   * replaced rather than trusted.
   */
  private _relayUrl(rawNextUrl: string): string {
    const parsed = new URL(rawNextUrl);
    parsed.searchParams.delete('apiKey');
    if (this._apiKey) parsed.searchParams.set('apiKey', this._apiKey);
    const search = parsed.searchParams.toString();
    return `${this._baseUrl}${parsed.pathname}${search ? '?' + search : ''}`;
  }

  private async _get<T>(url: string): Promise<T> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 25000);

    try {
      const res = await fetch(url, {
        method:  'GET',
        headers: { Accept: 'application/json' },
        signal:  controller.signal,
      });
      if (!res.ok) {
        throw new Error(`MassiveREST ${res.status} ${res.statusText} — ${url.split('?')[0]}`);
      }
      return await res.json() as T;
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        throw new Error(`MassiveREST timeout after 25s — ${url.split('?')[0]}`);
      }
      throw err;
    } finally {
      clearTimeout(timeoutId);
    }
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
