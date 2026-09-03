/**
 * Layer 2 — chainAggregator
 *
 * Polls Massive REST /v3/snapshot/options/{ticker} on a 30-second cadence,
 * maps the response to StrikeData[], and calls gexEngine.processChainSnapshot().
 * This unblocks ChainCockpit from perpetual skeleton state.
 *
 * Design constraints:
 *   - REST-only: Q-channel quotes carry bid/ask but not OI or greeks.
 *     The options snapshot endpoint is the only correct data source for those.
 *   - subscribe()/unsubscribe() are on-demand primitives — a ticker only
 *     polls while subscribed. The browser's ChainCockpit uses them exactly
 *     that way (subscribe() on mount/ticker-change, unsubscribe() on
 *     unmount). The relay does NOT: index.ts subscribes every FEED_TICKER
 *     permanently at boot and never unsubscribes — real, continuous,
 *     whole-watchlist polling every POLL_INTERVAL_MS, not "whatever's on
 *     screen." Load-planning (MAX_CONCURRENT_POLLS below) is sized for
 *     that reality, not the on-demand one.
 *   - At most one active poll loop at a time per ticker. subscribe() for an
 *     already-subscribed ticker is idempotent.
 *
 * Data flow:
 *   MassiveRestClient.fetchOptionsSnapshot(ticker)
 *     → group contracts by strike
 *     → build StrikeData[] (merge call + put sides per strike)
 *     → gexEngine.processChainSnapshot(ticker, spotPrice, strikes, now)
 *     → marketStore.writeContext(ticker, ctx)   [done inside gexEngine]
 *     → ChainCockpit re-renders with real data
 */

import { MassiveRestClient, type OptionsContractSnapshot } from '../lib/massive/api.ts';
import * as gexEngine from './gexEngine.ts';
import type { StrikeData } from './gexEngine.ts';
import * as barsStore from '../stores/barsStore.ts';

// ── Constants ──────────────────────────────────────────────────────────────────

/** How often to re-fetch the options snapshot while subscribed (ms). */
const POLL_INTERVAL_MS = 30_000;

/**
 * Max number of tickers allowed to have an active poll in flight at once.
 *
 * Raised from 5 to 40 (2026-09-02) after Wegic traced a real 71% chain-fetch
 * failure rate in the browser to this exact queueing mechanism: at
 * concurrency=5, N tickers must wait in batches of 5, and each batch adds a
 * full round-trip of wall time before the next can even start — under a
 * real Massive-side slowdown this compounds into the reported 84–114s
 * fetches. Real load-tested against Massive's actual options-snapshot
 * endpoint (not mocked) before shipping:
 *
 *   concurrency=5,  23 tickers (today's FEED_TICKERS) -> 5.7s wall, 0 failures
 *   concurrency=5,  62 tickers (2.7x growth headroom)  -> 19.0s wall, 0 failures
 *   concurrency=25, 62 tickers                          -> 3.4s wall, 0 failures
 *   concurrency=40, 62 tickers                          -> 3.1s wall, 0 failures (best measured)
 *   concurrency=62, 62 tickers (fully unbounded)         -> 3.6s wall, avg fetch
 *                                                            latency rose 2.6x
 *                                                            (contention, no gain)
 *
 * 40 fully clears today's 23-ticker count with zero queueing and gives the
 * best measured result at 2.7x growth — going higher (tested: unbounded)
 * stopped improving wall time and started adding real per-request latency
 * from connection contention instead. Massive's documented rate limit is
 * 100 req/s; this codebase runs ~1 req/s in steady state, so 40 concurrent
 * in-flight polls (each still paginating its own chain sequentially) is
 * nowhere near that ceiling. The load-test harness used to produce the
 * numbers above was a temporary local tool, not shipped — see this
 * constant's introducing commit message for the full real dataset.
 */
const MAX_CONCURRENT_POLLS = 40;

/**
 * Hard ceiling on how long a single _poll() call may run, independent of
 * whatever timeout _get()/fetchOptionsSnapshot() applies internally. Without
 * this, a hung fetch stalls that ticker's _scheduleNext() chain forever with
 * nothing noticing — this guarantees the chain always keeps moving.
 */
const POLL_HARD_TIMEOUT_MS = 30_000;

// ── Module state ──────────────────────────────────────────────────────────────

let _client: MassiveRestClient | null = null;

/** ticker → next-poll timeout handle (null while a poll is actively running). */
const _polls = new Map<string, ReturnType<typeof setTimeout> | null>();

/** Concurrency semaphore state — caps how many tickers can poll simultaneously. */
let _activePolls = 0;
const _waitQueue: Array<() => void> = [];

// Cash-settled indices require an 'I:' prefix when addressing Massive's
// options-snapshot endpoint directly — confirmed via live comparison:
// bare 'SPX' returns contracts with empty greeks/no IV; 'I:SPX' returns
// full real data. Extend this set as more indices are added to FEED_TICKERS.
const INDEX_TICKERS = new Set(['SPX', 'NDX']);

function _toMassiveUnderlying(ticker: string): string {
  return INDEX_TICKERS.has(ticker) ? `I:${ticker}` : ticker;
}

async function _acquireSlot(): Promise<void> {
  if (_activePolls < MAX_CONCURRENT_POLLS) {
    _activePolls++;
    return;
  }
  return new Promise((resolve) => {
    _waitQueue.push(() => {
      _activePolls++;
      resolve();
    });
  });
}

function _releaseSlot(): void {
  _activePolls--;
  const next = _waitQueue.shift();
  if (next) next();
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Inject the REST client. Must be called before subscribe().
 * Shares the same client instance used by barsStore — call once in main.tsx.
 */
export function initChainAggregator(client: MassiveRestClient) {
  _client = client;
}

/**
 * Start polling options snapshot for `ticker`.
 * Fires one immediate fetch, then repeats every POLL_INTERVAL_MS.
 * Idempotent — calling twice for the same ticker is a no-op.
 */
export function subscribe(ticker: string) {
  if (_polls.has(ticker)) return;
  if (!_client) {
    console.warn('[chainAggregator] Client not initialised — call initChainAggregator() first.');
    return;
  }

  _polls.set(ticker, null); // marks ticker as actively subscribed
  _scheduleNext(ticker);
  console.log(`[chainAggregator] Subscribed ${ticker} (poll every ${POLL_INTERVAL_MS / 1000}s).`);
}

async function _scheduleNext(ticker: string) {
  if (!_polls.has(ticker)) return; // unsubscribed while a poll was in flight — stop the chain
  await _poll(ticker);
  if (!_polls.has(ticker)) return; // check again — unsubscribe could've happened during the poll
  const handle = setTimeout(() => _scheduleNext(ticker), POLL_INTERVAL_MS);
  _polls.set(ticker, handle);
}

/**
 * Stop polling for `ticker`. Call on component unmount or ticker change.
 */
export function unsubscribe(ticker: string) {
  const handle = _polls.get(ticker);
  if (handle !== undefined) {
    if (handle !== null) clearTimeout(handle);
    _polls.delete(ticker);
    console.log(`[chainAggregator] Unsubscribed ${ticker}.`);
  }
}

// ── Internal ──────────────────────────────────────────────────────────────────

async function _poll(ticker: string) {
  if (!_client) return;

  await _acquireSlot();
  try {
    const contracts = await Promise.race([
      _client.fetchOptionsSnapshot(_toMassiveUnderlying(ticker)),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`_poll hard-timeout for ${ticker} after ${POLL_HARD_TIMEOUT_MS / 1000}s`)), POLL_HARD_TIMEOUT_MS)
      ),
    ]);
    if (contracts.length === 0) {
      console.warn(`[chainAggregator] ${ticker}: empty snapshot response.`);
      return;
    }

    // Prefer spot price from the response itself (underlying_asset.price for
    // equities/ETFs, underlying_asset.value for indices — Massive uses a
    // different field name depending on asset type, so check both).
    // Falls back to barsStore last close — barsStore may not be ready on the
    // very first poll if REST backfill is still in flight.
    let spotPrice: number = contracts[0]?.underlying_asset?.price
      ?? contracts[0]?.underlying_asset?.value
      ?? 0;

    if (spotPrice === 0) {
      const barsResult = barsStore.getResult(ticker);
      if (barsResult.status === 'ready' && barsResult.data.length > 0) {
        spotPrice = barsResult.data[barsResult.data.length - 1].close;
      }
    }

    if (spotPrice === 0) {
      console.warn(`[chainAggregator] ${ticker}: no spot price available, skipping snapshot.`);
      return;
    }

    const strikes = _mapToStrikeData(contracts, ticker);
    if (strikes.length === 0) {
      console.warn(`[chainAggregator] ${ticker}: no valid strike data mapped.`);
      return;
    }

    gexEngine.processChainSnapshot(ticker, spotPrice, strikes, Date.now());
    console.log(`[chainAggregator] ${ticker}: processed ${strikes.length} strikes @ spot ${spotPrice}`);
  } catch (e) {
    console.error(`[chainAggregator] ${ticker} poll failed:`, e);
  } finally {
    _releaseSlot();
  }
}

/**
 * Group contracts by strike AND expiry, merge call and put sides into StrikeData[].
 * Only includes strikes that have data on at least one side.
 */
function _mapToStrikeData(
  contracts: OptionsContractSnapshot[],
  _ticker: string,
): StrikeData[] {
  // Group by "expiry|strike" composite key to keep expiries separate
  const byKey = new Map<string, { expiry: string; strike: number; call?: OptionsContractSnapshot; put?: OptionsContractSnapshot }>();

  for (const c of contracts) {
    const strike = c.details.strike_price;
    const expiry = c.details.expiration_date;
    const key    = `${expiry}|${strike}`;
    if (!byKey.has(key)) byKey.set(key, { expiry, strike });
    const entry = byKey.get(key)!;

    if (c.details.contract_type === 'call') {
      entry.call = c;
    } else {
      entry.put = c;
    }
  }

  const strikes: StrikeData[] = [];

  for (const { expiry, strike, call, put } of byKey.values()) {
    const callOI    = call?.open_interest ?? 0;
    const putOI     = put?.open_interest  ?? 0;
    const callGamma = call?.greeks?.gamma ?? 0;
    const putGamma  = put?.greeks?.gamma  ?? 0;

    // Need at least one side with OI to be useful for chain display.
    // Gamma is NOT a required drop condition — far-dated options have real OI
    // but Massive may return greeks: undefined for them. Dropping on gamma=0
    // would silently starve far-dated expiry tabs of all data.
    if (callOI === 0 && putOI === 0) continue;

    strikes.push({
      strike,
      expiry,

      // Required fields
      callOI,
      putOI,
      callGamma,
      putGamma,
      callVolume: call?.day?.volume ?? 0,
      putVolume:  put?.day?.volume  ?? 0,

      // Optional greeks
      callDelta: call?.greeks?.delta ?? 0,
      callTheta: call?.greeks?.theta ?? 0,
      callVega:  call?.greeks?.vega  ?? 0,
      putDelta:  put?.greeks?.delta  ?? 0,
      putTheta:  put?.greeks?.theta  ?? 0,
      putVega:   put?.greeks?.vega   ?? 0,

      // Optional pricing
      callBid:  call?.last_quote?.bid ?? 0,
      callAsk:  call?.last_quote?.ask ?? 0,
      callLast: call?.day?.last ?? 0,
      callIV:   call?.implied_volatility ?? 0,
      putBid:   put?.last_quote?.bid ?? 0,
      putAsk:   put?.last_quote?.ask ?? 0,
      putLast:  put?.day?.last ?? 0,
      putIV:    put?.implied_volatility ?? 0,
    });
  }

  return strikes;
}
