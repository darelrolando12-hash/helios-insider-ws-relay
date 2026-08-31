/**
 * Layer 1 — canonical types.
 *
 * Every store and every Layer 2 engine reads and writes these types.
 * No other file defines domain types; this is the single source of truth.
 *
 * Architectural rule: every value that crosses a layer boundary is wrapped
 * in Result<T>. Consumers either have good data (status: 'ready') or know
 * explicitly that they don't (status: 'loading' | 'error'). There is no
 * partial/degraded state a consumer has to independently judge.
 */

// ── Result<T> ────────────────────────────────────────────────────────────────

/**
 * Discriminated union for all inter-layer data passing.
 *
 * - 'loading'  — store is initialising or waiting on its first data.
 * - 'ready'    — data is present and trustworthy. `asOf` is the UTC ms
 *                timestamp of the most recent update.
 * - 'error'    — ingestion or computation failed. `reason` is a human-
 *                readable description safe to surface in UI.
 *
 * "ready" specifically means the store's `isDataReady` condition is met
 * (see individual store files for per-store definitions). A store that is
 * connected but has not yet received a valid first payload stays 'loading',
 * not 'ready'.
 */
export type Result<T> =
  | { status: 'loading' }
  | { status: 'ready';  data: T; asOf: number }
  | { status: 'error';  reason: string };

// ── Type guards ──────────────────────────────────────────────────────────────

export function isLoading<T>(r: Result<T>): r is { status: 'loading' } {
  return r.status === 'loading';
}

// ── Factory helpers ──────────────────────────────────────────────────────────

export const loading = (): Result<never> => ({ status: 'loading' });

export const ready = <T>(data: T, asOf = Date.now()): Result<T> => ({
  status: 'ready',
  data,
  asOf,
});

export const error = (reason: string): Result<never> => ({
  status: 'error',
  reason,
});

// ── Bar (candle) — written by barsStore, read by every engine and chart ──────

export interface Bar {
  /** Underlying or options ticker this bar belongs to */
  ticker: string;

  open:   number;
  high:   number;
  low:    number;
  close:  number;

  /** Share/contract volume for the interval */
  volume: number;

  /** Volume-weighted average price — present on aggregated bars, absent on raw */
  vwap?: number;

  /** Number of transactions in the interval (Massive field: n) */
  transactions?: number;

  /**
   * Bar open time expressed as a Central Time pseudo-UTC epoch.
   * This is CentralTimeInfo.ctMs — derived from Intl-parsed CT components,
   * NOT unixMs ± a fixed offset. Chart libraries that render local-time axes
   * should use tCT, never tUtc.
   */
  tCT: number;

  /** Original UTC epoch ms as received from Massive — stored for audit/gap-fill */
  tUtc: number;
}

// ── MarketContextSnapshot — written by GEX engine, read by cockpits ──────────

export type GexRegime = 'positive' | 'negative' | 'neutral';

export interface GexWalls {
  /** Largest call OI cluster above current price — acts as resistance */
  callWall: number;
  /** Largest put OI cluster below current price — acts as support */
  putWall: number;
}

export interface MarketContextSnapshot {
  ticker: string;

  /** GEX sign (+ dealers long gamma → mean-reversion; - dealers short gamma → trending) */
  gexRegime: GexRegime;

  /** Key gamma exposure price levels */
  walls: GexWalls;

  /**
   * Price at which net GEX crosses zero — market tends to shift character
   * (mean-reverting ↔ trending) around this level.
   */
  flipLevel: number;

  /**
   * Dominant vanna exposure level — price point where delta sensitivity to
   * vol changes is highest; relevant for pre-FOMC / high-IV environments.
   */
  vannaLevel?: number;

  /**
   * Dominant charm exposure level — price point where delta sensitivity to
   * time decay is highest; primarily relevant for 0DTE.
   */
  charmLevel?: number;

  /** UTC ms of the chain snapshot this was computed from */
  asOf: number;
}

// ── CvdTick — written by cvdStore, read by CVD engine ────────────────────────

export type TradeSide  = 'buy' | 'sell';
export type AssetClass = 'stock' | 'option';

export interface CvdTick {
  ticker: string;

  /**
   * Trade classification against the prevailing bid/ask at tick time.
   * Quote must have been processed before this tick (enforced by websocket.ts
   * quote-before-trade sort) so this is never scored against a stale spread.
   */
  side: TradeSide;

  /** Number of shares / contracts */
  size: number;

  /** Execution price */
  price: number;

  /** Signed dollar flow: positive = buy-side, negative = sell-side */
  dollarFlow: number;

  /** CT pseudo-UTC epoch (CentralTimeInfo.ctMs) */
  tCT: number;

  /** Raw UTC epoch ms from Massive */
  tUtc: number;

  assetClass: AssetClass;
}

// ── LuldEvent — written by luldStore, read by DUMP/RIP detector ──────────────

export type LuldEventType =
  | 'halt'       // trading halted
  | 'resume'     // halt lifted, trading resumed
  | 'luld_band'  // new limit-up/limit-down band published (no halt yet)
  | 'luld_pause'; // momentary LULD pause (less severe than halt)

export interface LuldEvent {
  ticker: string;
  type:   LuldEventType;

  /** Upper LULD band price, if applicable */
  upperBand?: number;

  /** Lower LULD band price, if applicable */
  lowerBand?: number;

  /** CT pseudo-UTC epoch */
  tCT: number;

  /** Raw UTC epoch ms */
  tUtc: number;
}

// ── InsiderTransaction — written by fundamentalsStore, read by catalyst gate ─

export type InsiderTransactionType = 'buy' | 'sell' | 'other';

export interface InsiderTransaction {
  ticker: string;

  /**
   * Real DB primary key — accession_number + owner_cik + security_type +
   * transaction_code + transaction_date. One filing can contain multiple
   * transaction lines for the same owner on the same date (e.g. a
   * derivative + non-derivative line), so this is the only field that
   * safely distinguishes them. Never key UI lists on insiderName+date alone.
   */
  id: string;

  /** Reporting person's name as filed on Form 4 */
  insiderName: string;

  /** Relationship to issuer, e.g. "CEO", "Director", "10% Owner" */
  relationship: string;

  transactionType: InsiderTransactionType;

  /** Number of shares transacted */
  shares: number;

  /** Price per share at time of transaction */
  pricePerShare: number;

  /** Total dollar value (shares × pricePerShare) */
  totalValue: number;

  /**
   * True if this transaction is under a pre-arranged 10b5-1 plan.
   * These are scheduled sales, not discretionary signals.
   * The catalyst gate filters these out — only non-10b5-1 buys surface
   * as insider activity signals.
   */
  is10b51: boolean;

  /** UTC ms when the Form 4 was filed with the SEC */
  filedAt: number;

  /** UTC ms of the actual transaction date */
  transactedAt: number;
}

// ── ShortInterestSnapshot — written by fundamentalsStore, read by squeeze engine

export interface ShortInterestSnapshot {
  ticker: string;

  /** Number of shares currently sold short */
  shortInterest: number;

  /** Percentage of float that is short */
  shortFloat?: number;

  /** Days-to-cover (shortInterest / average daily volume) */
  daysToCover?: number;

  /** Total short volume for the reporting period */
  shortVolume?: number;

  /** UTC ms of the settlement date this snapshot represents */
  reportDate: number;
}

// ── Signal (Layer 3 ledger input) ─────────────────────────────────────────────

export type SignalType =
  | 'ENTER'
  | 'EXIT'
  | 'REVERSAL'
  | 'DUMP'
  | 'RIP'
  | 'BREAKOUT';

export interface Signal {
  id: string;
  ticker: string;
  type: SignalType;

  /** Price at signal time */
  triggerPrice: number;

  /** Confluence score 0–100 from the scoring engine */
  confidence: number;

  /** UTC ms when the signal was fired */
  firedAt: number;

  /** CT pseudo-UTC epoch */
  firedAtCT: number;

  /** Which engines contributed to this signal */
  sources: string[];

  /**
   * Whether the catalyst component's input data was actually available at
   * scoring time ('real') or missing entirely ('absent'). Lets consumers
   * (signalLedger, Brain stats) tell a genuine "no catalyst today" zero
   * apart from "fundamentals hadn't loaded yet" — both previously looked
   * identical. Optional for signals that bypass scoreConfluence entirely
   * (e.g. DUMP/RIP, which fires directly off dumpRipDetector and never
   * touches catalyst scoring).
   */
  catalystDataQuality?: 'real' | 'absent';

  /**
   * Which generator produced this signal.
   *
   * Recorded at write time so paper results can be judged PER GENERATOR
   * rather than pooled. Scanner, Swing and 0DTE are different strategies with
   * different holding periods and different real win rates; pooling them
   * produces a blended number that describes none of them and hides which one
   * actually works. A generator that loses money can be masked indefinitely by
   * one that makes it.
   *
   * Optional so historical rows written before this existed keep parsing —
   * consumers must treat `undefined` as "unattributed", never silently fold it
   * into one of the known buckets.
   */
  sourceEngine?: SourceEngine;
}

/**
 * The signal generators. `dumpRip` is listed separately from `scanner`
 * because it bypasses scoreConfluence entirely and fires off LULD events —
 * its outcomes describe a different mechanism and must not be pooled with
 * scored signals.
 */
export type SourceEngine = 'scanner' | 'swing' | 'zerodte' | 'dumpRip';

export interface SignalOutcome {
  signalId: string;
  ticker:   string;

  /**
   * Resolved result, matched against `bars` within a ±5-minute tolerance
   * window around `firedAt`. Exact-timestamp matching is intentionally not
   * used — it silently misses and biases win-rate data.
   */
  result: 'win' | 'loss' | 'scratch' | 'pending';

  /** Price used for outcome resolution */
  resolvedPrice: number;

  /** UTC ms of the bar used for resolution */
  resolvedAt: number;

  /** P&L in dollar terms (positive = win) */
  pnl?: number;
}

// ── ChainRow — per-strike options chain data, written by gexEngine ───────────

/**
 * One row of a full options chain snapshot.
 * Written by gexEngine.processChainSnapshot into MarketContext.chain.
 * Read only by ChainCockpit — no other cockpit consumes per-strike chain data.
 */
export interface ChainRow {
  strike: number;

  /** YYYY-MM-DD expiration date — populated by chainAggregator from Massive details.expiration_date */
  expiry: string;

  // Call side
  callBid:    number;
  callAsk:    number;
  callLast:   number;
  callIV:     number;   // implied volatility 0–1 (e.g. 0.35 = 35%)
  callVolume: number;   // contracts traded this session
  callOI:     number;
  callDelta:  number;   // 0 to 1
  callGamma:  number;
  callTheta:  number;   // negative (cost per day)
  callVega:   number;

  // Put side
  putBid:    number;
  putAsk:    number;
  putLast:   number;
  putIV:     number;
  putVolume: number;
  putOI:     number;
  putDelta:  number;   // -1 to 0
  putGamma:  number;
  putTheta:  number;
  putVega:   number;

  // GEX (computed by gexEngine, stored here for GEX tab)
  callGex:   number;   // positive
  putGex:    number;   // positive magnitude
  netGex:    number;   // callGex - putGex

  /** Max-pain flag — true if this strike is the max-pain level */
  isMaxPain: boolean;
}

// ── MarketStatus — read from REST, used by all cockpits ──────────────────────

export type MarketStatusValue = 'open' | 'closed' | 'extended-hours' | 'early-hours';

export interface MarketStatus {
  market:       MarketStatusValue;
  serverTime:   string;  // ISO 8601 string from Massive
  serverTimeMs: number;  // parsed to UTC ms
  exchanges: {
    nyse:   MarketStatusValue;
    nasdaq: MarketStatusValue;
    otc:    MarketStatusValue;
  };
}
