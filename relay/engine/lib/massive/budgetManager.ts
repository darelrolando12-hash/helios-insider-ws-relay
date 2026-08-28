import { toCTMidnight } from '../time.ts';

export interface OptionContractInfo {
  ticker:     string;  // e.g. O:SPY251219C00650000
  underlying: string;  // e.g. SPY
  strike:     number;  // dollar value, e.g. 650.00
  expiry:     number;  // CT-midnight pseudo-UTC ms of expiration day
  isCall:     boolean;
}

export interface SubscribeResult {
  allowed: boolean;
  evicted: string | null; // ticker that was unsubscribed to make room, if any
}

/**
 * Subscription budget manager for the Options Q (quotes) WebSocket channel.
 *
 * The Massive Options WS enforces a hard 1,000-contract cap per connection.
 * This class owns the canonical Set of active Q subscriptions and is the only
 * place that enforces that cap. websocket.ts calls subscribe/evict here before
 * sending any WS subscribe/unsubscribe frame.
 *
 * Eviction policy: furthest OTM in dollar terms from the caller-supplied
 * current underlying price. Both calls and puts are measured as:
 *   calls: max(0, strike − underlyingPrice)   [OTM when strike > price]
 *   puts:  max(0, underlyingPrice − strike)   [OTM when price > strike]
 * ITM contracts have distance 0 and are never the first to be evicted.
 */
export class OptionSubscriptionBudgetManager {
  private readonly _contracts = new Map<string, OptionContractInfo>();
  private readonly _maxContracts: number;

  constructor(maxContracts = 1000) {
    this._maxContracts = maxContracts;
  }

  // ── Public API ───────────────────────────────────────────────────────────

  /**
   * Register a contract for Q subscription tracking.
   *
   * If at capacity, evicts the furthest-OTM contract (measured against
   * `underlyingPrice`) before adding the new one.
   *
   * @param ticker         Options ticker, e.g. O:SPY251219C00650000
   * @param underlyingPrice Current price of the underlying — required for
   *                        correct OTM-distance eviction. Caller must supply
   *                        a fresh value; budget manager does not fetch prices.
   */
  public subscribe(ticker: string, underlyingPrice: number): SubscribeResult {
    if (this._contracts.has(ticker)) {
      return { allowed: true, evicted: null };
    }

    const info = parseTicker(ticker);
    if (!info) {
      console.warn(`[BudgetMgr] Unrecognised ticker format, rejected: ${ticker}`);
      return { allowed: false, evicted: null };
    }

    let evicted: string | null = null;

    if (this._contracts.size >= this._maxContracts) {
      evicted = this._findFurthestOTM(underlyingPrice);
      if (evicted === null) {
        // All contracts are equidistant (or map is somehow empty) — shouldn't
        // happen in practice, but guard against it.
        console.warn('[BudgetMgr] At capacity but could not determine furthest-OTM contract.');
        return { allowed: false, evicted: null };
      }
      this._contracts.delete(evicted);
    }

    this._contracts.set(ticker, info);
    return { allowed: true, evicted };
  }

  /**
   * Explicitly remove a contract from subscription tracking.
   * Called by websocket.ts after sending the WS unsubscribe frame.
   */
  public evict(ticker: string): boolean {
    return this._contracts.delete(ticker);
  }

  /**
   * Evict all contracts whose CT expiration date is strictly before today
   * (in Central Time). Returns the list of evicted tickers so websocket.ts
   * can send the corresponding WS unsubscribe frames.
   *
   * Call once at market close / daily rollover.
   */
  public evictExpired(currentUtcMs: number): string[] {
    // toCTMidnight gives the CT midnight of today as a pseudo-UTC ms value,
    // using the same convention as contract expiry stored in this manager.
    const todayCtMidnight = toCTMidnight(currentUtcMs);
    const evicted: string[] = [];

    for (const [ticker, info] of this._contracts) {
      // info.expiry is the CT midnight of the expiration day.
      // If that midnight is strictly before today's CT midnight, it has expired.
      if (info.expiry < todayCtMidnight) {
        this._contracts.delete(ticker);
        evicted.push(ticker);
      }
    }

    return evicted;
  }

  public get size(): number {
    return this._contracts.size;
  }

  public getAll(): string[] {
    return Array.from(this._contracts.keys());
  }

  // ── Private helpers ──────────────────────────────────────────────────────

  /**
   * Scans all active contracts and returns the ticker with the greatest
   * OTM dollar distance from `underlyingPrice`.
   *
   * If two contracts tie, the first one found wins (Map insertion order).
   * Returns null only if the map is empty.
   */
  private _findFurthestOTM(underlyingPrice: number): string | null {
    let furthestTicker: string | null = null;
    let maxDistance = -1;

    for (const [ticker, info] of this._contracts) {
      const distance = otmDistance(info, underlyingPrice);
      if (distance > maxDistance) {
        maxDistance = distance;
        furthestTicker = ticker;
      }
    }

    return furthestTicker;
  }
}

// ── Module-level pure functions ──────────────────────────────────────────────

/**
 * Dollar OTM distance of a contract relative to the current underlying price.
 *
 *   Call is OTM when strike > underlyingPrice  → distance = strike − price
 *   Put  is OTM when strike < underlyingPrice  → distance = price  − strike
 *   ITM contracts of either type               → distance = 0
 *
 * Distance is always ≥ 0. ITM contracts are never preferentially evicted.
 */
export function otmDistance(info: OptionContractInfo, underlyingPrice: number): number {
  if (info.isCall) {
    return info.strike > underlyingPrice ? info.strike - underlyingPrice : 0;
  } else {
    return info.strike < underlyingPrice ? underlyingPrice - info.strike : 0;
  }
}

/**
 * Parse a Massive options ticker into its components.
 *
 * Format: O:{UNDERLYING}{YY}{MM}{DD}{C|P}{8-digit-strike}
 * Strike encoding: 5 integer digits + 3 decimal digits, no decimal point.
 * Example: O:SPY251219C00650000 → SPY, 2025-12-19, Call, strike $650.00
 */
export function parseTicker(ticker: string): OptionContractInfo | null {
  // Underlying can be 1–6 uppercase letters; strike is exactly 8 digits.
  const regex = /^O:([A-Z]{1,6})(\d{2})(\d{2})(\d{2})([CP])(\d{8})$/;
  const match = ticker.match(regex);
  if (!match) return null;

  const [, underlying, yy, mm, dd, cp, strikePad] = match;
  const year  = 2000 + parseInt(yy,  10);
  const month =        parseInt(mm,  10);  // 1-based, kept 1-based for toCTMidnight
  const day   =        parseInt(dd,  10);
  const strike = parseInt(strikePad, 10) / 1000; // e.g. "00650000" → 650.000

  // Store expiry as CT midnight (pseudo-UTC ms) using the same convention
  // as toCTMidnight, so evictExpired comparisons are apples-to-apples.
  const expiry = Date.UTC(year, month - 1, day, 0, 0, 0, 0);

  return {
    ticker,
    underlying,
    strike,
    expiry,
    isCall: cp === 'C',
  };
}
