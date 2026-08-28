/**
 * Layer 2 — cvdEngine
 *
 * Owns tick classification for both stocks and options.
 * Reads T.* and Q.* from massiveBus. Writes classified ticks to cvdStore
 * via appendClassifiedTick() and updateSpread().
 *
 * cvdStore holds the accumulation; this engine owns the logic that decides
 * whether each tick is a buy or a sell.
 *
 * Classification rule:
 *   1. Quote test (primary): trade.price >= ask → buy; <= bid → sell
 *   2. Uptick rule (fallback when mid-spread): price > prev → buy; < prev → sell
 *   3. Delta inherit (unchanged price): buy if running buyDelta >= sellDelta
 *
 * The quote-before-trade sort in websocket.ts guarantees Q messages are
 * processed before T messages in each batch, so updateSpread() always runs
 * before classifyTick() for trades in the same millisecond window.
 *
 * Options side:
 *   Options T/Q subscriptions are managed here alongside stock subscriptions.
 *   Caller must supply current underlying price when subscribing options.
 *
 *   NOTE (server-side): the budget claim that used to sit on this line —
 *   "the budgetManager in massiveBus enforces the 1,000-contract Q cap" — is
 *   no longer true and has been removed rather than left to mislead. The
 *   in-process bus does not consult a budget; see engine/bus.ts
 *   subscribeOption for why that is correct here.
 */

import { massiveBus, type WSMessageWithCT } from '../bus.ts';
import * as cvdStore from '../stores/cvdStore';
import type { CvdTick, AssetClass, TradeSide } from '../stores/types';

// ── Engine lifecycle ──────────────────────────────────────────────────────────

let _initialised = false;

/**
 * Initialise cvdEngine — registers Q and T handlers on massiveBus.
 * Call once at app startup. Idempotent.
 */
export function init() {
  if (_initialised) return;
  _initialised = true;

  massiveBus.on('Q', _handleQuote);
  massiveBus.on('T', _handleTrade);

  console.log('[cvdEngine] Initialised.');
}

export function teardown() {
  massiveBus.off('Q', _handleQuote);
  massiveBus.off('T', _handleTrade);
  _initialised = false;
}

// ── Subscription API ──────────────────────────────────────────────────────────

/**
 * Subscribe to CVD for a stock ticker.
 * Registers the ticker in cvdStore and subscribes T+Q on the stock bus.
 */
export function subscribeStock(ticker: string) {
  cvdStore.subscribeTicker(ticker, 'stock');
  massiveBus.subscribeStock('Q', ticker);
  massiveBus.subscribeStock('T', ticker);
}

export function unsubscribeStock(ticker: string) {
  massiveBus.unsubscribeStock('Q', ticker);
  massiveBus.unsubscribeStock('T', ticker);
  cvdStore.unsubscribeTicker(ticker);
}

/**
 * Subscribe to CVD for an options contract ticker.
 * Passes underlyingPrice to the budget manager for correct OTM eviction.
 */
export function subscribeOption(ticker: string, underlyingPrice: number) {
  cvdStore.subscribeTicker(ticker, 'option');
  massiveBus.subscribeOption('T', ticker, underlyingPrice);
  massiveBus.subscribeOption('Q', ticker, underlyingPrice);
}

export function unsubscribeOption(ticker: string) {
  massiveBus.unsubscribeOption('T', ticker);
  massiveBus.unsubscribeOption('Q', ticker);
  cvdStore.unsubscribeTicker(ticker);
}

// ── Message handlers ──────────────────────────────────────────────────────────

function _handleQuote(msg: WSMessageWithCT) {
  const bid = (msg.bp as number | undefined) ?? 0;
  const ask = (msg.ap as number | undefined) ?? 0;
  if (bid > 0 || ask > 0) {
    cvdStore.updateSpread(msg.sym, bid, ask);
  }
}

function _handleTrade(msg: WSMessageWithCT) {
  const price = (msg.p as number | undefined) ?? 0;
  const size  = (msg.s as number | undefined) ?? 0;
  if (price === 0 || size === 0) return;

  // Determine asset class from ticker prefix
  const assetClass: AssetClass = msg.sym.startsWith('O:') ? 'option' : 'stock';

  const spread    = cvdStore.getSpread(msg.sym);
  const side      = classifyTick(price, spread.bid, spread.ask, spread.prevPrice, {});

  const tick: CvdTick = {
    ticker:     msg.sym,
    side,
    size,
    price,
    dollarFlow: side === 'buy' ? price * size : -(price * size),
    tCT:        msg._ct.ctMs,
    tUtc:       msg._ct.utcMs,
    assetClass,
  };

  cvdStore.appendClassifiedTick(msg.sym, tick);
}

// ── Pure classification — exported for unit tests ─────────────────────────────

/**
 * Classify a single trade tick against the prevailing bid/ask spread.
 *
 * All parameters are plain numbers — no store reads inside this function.
 * This makes it straightforward to unit-test in isolation.
 *
 * @param price      Trade execution price
 * @param bid        Current best bid (0 if unavailable)
 * @param ask        Current best ask (0 if unavailable)
 * @param prevPrice  Most recent prior trade price (0 on first tick)
 * @param state      Running delta state for the unchanged-price fallback
 */
export function classifyTick(
  price:     number,
  bid:       number,
  ask:       number,
  prevPrice: number,
  state:     { buyDelta?: number; sellDelta?: number },
): TradeSide {
  // Primary: quote test — only when a live spread exists
  if (bid > 0 && ask > 0) {
    if (price >= ask) return 'buy';
    if (price <= bid) return 'sell';
  }

  // Fallback: uptick rule
  if (prevPrice > 0) {
    if (price > prevPrice) return 'buy';
    if (price < prevPrice) return 'sell';
  }

  // Last resort: inherit from running delta direction
  const buyDelta  = state.buyDelta  ?? 0;
  const sellDelta = state.sellDelta ?? 0;
  return buyDelta >= sellDelta ? 'buy' : 'sell';
}
