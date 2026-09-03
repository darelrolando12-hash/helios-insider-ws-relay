import { StrictMode }    from 'react'
import { createRoot }    from 'react-dom/client'
import { RouterProvider } from 'react-router-dom';
import { router }         from '@/routes';
import * as newsStore         from './stores/newsStore';
import * as barsStore         from './stores/barsStore';
import * as cvdEngine         from './engines/cvdEngine';
import * as confluenceEngine  from './engines/confluenceEngine';
import * as squeezeEngine     from './engines/squeezeEngine';
import * as luldStore         from './stores/luldStore';
import * as dumpRipDetector   from './engines/dumpRipDetector';
import * as chainAggregator from './engines/chainAggregator';
import { initLedger }     from './ledger/signalLedger';
import { startResolver, setMarketOpen } from './ledger/outcomeResolver';
import { replayTodaySession } from './engines/backtestEngine';
import { MassiveRestClient } from './lib/massive/api';
import { massiveBus }     from './lib/massive/websocket';
import { FEED_TICKERS }   from './state/directionState';
import { runBarsDailyBackfill }      from './ingestion/barsIngestion';
import { runShortInterestBackfill }  from './ingestion/shortInterestIngestion';
import { runBars1mBackfill }            from './ingestion/bars1mIngestion';
import { runInsiderIngestion }          from './ingestion/insiderIngestion';
import { runDisclosureIngestion }       from './ingestion/disclosureIngestion';
import { runRatiosIngestion, REFRESH_INTERVAL_MS as RATIOS_REFRESH_MS } from './ingestion/ratiosIngestion';
import { runTickerAllowlistRefresh, getAllowlistTickers, REFRESH_INTERVAL_MS as ALLOWLIST_REFRESH_MS } from './ingestion/tickerAllowlistIngestion';
import { runDailyHighLowBackfill } from './ingestion/dailyHighLowIngestion';
import { msUntilQuietWindow } from './lib/time';
import './index.css'

// ── Open WebSocket connections ───────────────────────────────────────────────
// Must be called before any store subscribes — the bus is inert until connect().
// The bus itself handles reconnect automatically on any close event (5s backoff).
massiveBus.connect();

// ── Initialise REST backfill client ──────────────────────────────────────────
// MassiveRestClient now routes through the relay's /rest proxy — the relay
// attaches the Massive API key server-side. The browser never holds or sends it.
const _restClient = new MassiveRestClient();

barsStore.initBarsStore(_restClient);
chainAggregator.initChainAggregator(_restClient);

// ── Initialise CVD engine ────────────────────────────────────────────────────
// Registers Q and T handlers on massiveBus. Must run before any ticker
// subscriptions so the handlers are in place when the first messages arrive.
cvdEngine.init();

// Subscribe all feed tickers on startup so cold-start backfill runs
// before any cockpit mounts. Cockpit-level subscribeTicker() calls are
// idempotent — safe to call again per the store's guard.
for (const ticker of FEED_TICKERS) {
  barsStore.subscribeTicker(ticker);
  cvdEngine.subscribeStock(ticker);
}

// Subscribe context tickers at boot so IndexesCockpit isn't the only
// place that triggers TLT/HYG/I:VIX subscriptions. Without this, they
// stay stale for hours if IndexesCockpit hasn't been visited yet.
for (const t of ['TLT', 'HYG', 'I:VIX']) {
  barsStore.subscribeTicker(t);
  cvdEngine.subscribeStock(t);
}

// ── Start news polling ───────────────────────────────────────────────────────
newsStore.startPolling();

// ── Boot confluenceEngine at app level ──────────────────────────────────────
// Previously only initialised inside ScannerCockpit's useEffect, meaning
// signal scoring was dead on every screen unless Scanner was opened first.
// Must run after cvdEngine.init() so the CVD gate is armed on first score.
confluenceEngine.init();
for (const ticker of FEED_TICKERS) {
  confluenceEngine.watchTicker(ticker);
}

// ── Wire real market status into confluenceEngine + outcomeResolver ────────
// setMarketStatus() existed but had zero call sites — _marketStatus stayed
// stuck on its 'closed' default forever, so _onStoreUpdate's gate
// (if (_marketStatus !== 'open') return;) silently killed every score pass,
// at any time, regardless of actual market hours. Fixed: poll the real
// Massive market-status endpoint (same one Settings' health row already
// uses) and push the real value in. Runs once immediately, then every 60s.
//
// outcomeResolver.setMarketOpen() had the exact same problem: zero call
// sites, _marketIsOpen stuck on its `false` default forever, so the
// resolver's 60s interval (started below via startResolver()) always
// no-op'd on the `if (!_marketIsOpen) return;` gate — pending signals could
// never resolve to outcomes. Same poll now drives both.
//
// Also drives backtestEngine.replayTodaySession(): on the open → closed
// transition, replay today's session for every FEED_TICKER so Brain keeps
// accumulating backtested instances daily, not just from the one-time seed.
let _wasMarketOpen: boolean | null = null;
function _refreshMarketStatus() {
  _restClient.fetchMarketStatus()
    .then(status => {
      const isOpen = status.market === 'open';
      console.error(`[main] Market status poll result: ${status.market}`);
      confluenceEngine.setMarketStatus(status.market);
      setMarketOpen(isOpen);

      if (_wasMarketOpen === true && isOpen === false) {
        console.log('[main] Market just closed — running today\'s backtest replay for all FEED_TICKERS.');
        for (const ticker of FEED_TICKERS) {
          replayTodaySession(ticker)
            .then(r => console.log(`[backtestEngine] ${ticker} today-replay: scanned ${r.barsScanned} bars, fired ${r.signalsFired}, persisted ${r.persisted}.`))
            .catch(e => console.error(`[backtestEngine] ${ticker} today-replay failed —`, e));
        }
        massiveBus.rolloverExpiredOptions(Date.now());
      }
      _wasMarketOpen = isOpen;
    })
    .catch(e => console.error('[main] fetchMarketStatus failed — leaving last known status in place:', e));
}
_refreshMarketStatus();
setInterval(_refreshMarketStatus, 60_000);

// ── Historical backtest seed — INTENTIONALLY NOT WIRED ──────────────────────
// backtestHistoricalRange() (and its SPY pilot) is not called at boot.
// Root cause: no real historical options-market data exists for past dates,
// so GEX is neutral-stubbed for that path (see backtestEngine.ts). Combined
// with CVD already being zeroed for replay, the highest score any past
// candle could ever reach is well below the engine's lowest signal
// threshold — the seed would always scan bars and record zero signals, no
// matter how long it ran. Decision: skip the historical seed entirely and
// build Brain's track record live, going forward, via replayTodaySession()
// below (which uses real, live market data and is unaffected by this).

// ── Boot chainAggregator at app level ───────────────────────────────────────
// Previously only subscribed inside ChainCockpit's mount/unmount effect,
// meaning marketStore only received GEX writes while someone happened to
// have the Chain screen open on that exact ticker — every other cockpit
// (Best Contracts, 0DTE, Swing, Indexes) read a permanently empty store.
// Now runs continuously for the full watchlist from boot, same as
// cvdEngine/confluenceEngine above. No unsubscribe — this is a permanent
// background feed, not a screen-scoped resource.
//
// Staggered by 250ms per ticker: firing all ~22 initial fetches in the same
// tick caused Massive to hard-reset every connection (net::ERR_CONNECTION_RESET,
// confirmed via Network tab — no HTTP response at all, not a rate-limit
// status code). Spacing out only the FIRST fetch per ticker avoids that
// concurrent-connection ceiling; each ticker's own 30s poll interval starts
// from its staggered first call and continues independently after that.
FEED_TICKERS.forEach((ticker, i) => {
  setTimeout(() => chainAggregator.subscribe(ticker), i * 250);
});

// ── Wire signal ledger and outcome resolver ─────────────────────────────────
// initLedger() subscribes to confluenceEngine's signal stream and writes
// every auto-fired signal to the DB. Must run after confluenceEngine.init().
// startResolver() polls every 60s and resolves pending signals to outcomes.
// Both were previously unwired — zero auto-signal rows existed in the DB.
initLedger();
startResolver();

// ── Group 2: squeezeEngine, luldStore, dumpRipDetector ──────────────────────

// Wire squeezeEngine at boot.
// init() subscribes to fundamentalsStore updates and re-scores all tickers
// whenever fundamentals data changes. Must run after barsStore so bar data
// is available for the momentum component of the score.
// NOTE: squeezeEngine will not produce non-zero scores until fundamentalsStore
// has real data (shortInterest, daysToCover, shortVolumeRatio). Those fields
// are permanently empty until todo_43 (cron+REST ingestion) is implemented.
// What is NOW fixed: the engine is alive and will score immediately the moment
// fundamentalsStore receives any data. Previously it never ran at all.
squeezeEngine.init();
for (const ticker of FEED_TICKERS) {
  squeezeEngine.scoreTicker(ticker); // prime the state map; no-ops if no fundamentals yet
}

// Wire luldStore per-ticker at boot.
// Without this, the LULD.* WebSocket channel is never registered for any ticker,
// so IndexesCockpit's LULD panel and dumpRipDetector both read from an empty store.
// subscribeTicker() is idempotent — safe to call again from a cockpit.
for (const ticker of FEED_TICKERS) {
  luldStore.subscribeTicker(ticker);
}

// Wire dumpRipDetector price provider at boot.
// Without setPriceProvider(), every band-crossing check falls back to the
// band midpoint — a conservative estimate that may miss real DUMP/RIP signals.
// barsStore.getResult(ticker) returns Bar[] when ready; the last bar's close
// is the best available real-time price from the 1-min bar stream.
dumpRipDetector.setPriceProvider((ticker: string) => {
  const result = barsStore.getResult(ticker);
  if (result.status !== 'ready' || result.data.length === 0) return null;
  return result.data[result.data.length - 1].close;
});

// ── Historical data backfills ────────────────────────────────────────────────
// Both are fire-and-forget: they run asynchronously after boot and write to
// the DB in the background. Neither blocks rendering. Each is resumable —
// if the app restarts mid-backfill, only missing rows are fetched.
//
// Staggered by 2s per job — same root cause as chainAggregator's 250ms
// per-ticker stagger above: firing every job's FIRST REST call in the same
// tick piles onto barsStore's 23 concurrent cold-start backfills and
// chainAggregator's own ramp-up, starving brainStore's initial load (and
// everything else) behind a boot-time connection traffic jam. None of these
// jobs are latency-sensitive — a few seconds of delay costs nothing since
// they write to the DB in the background — so 2s spacing is cheap insurance
// against the same kind of connection-reset pile-up, without meaningfully
// delaying data availability.
//
// runBarsDailyBackfill: one row per ticker per trading day, 5yr history,
//   permanent retention. Runs in ~22 REST calls total (23 FEED_TICKERS +
//   TLT/HYG/I:VIX context tickers).
//
// runShortInterestBackfill: short interest (2yr, bi-weekly reports) +
//   short volume (90d, daily). After each ticker completes, the most recent
//   values are written into fundamentalsStore — this is what unblocks
//   squeezeEngine from its data-starved state.
//
// runBars1mBackfill: full 23-ticker 2yr 1-min bars backfill. SPY pilot
//   confirmed 426,392 rows with PAGINATION PASS — next_url followed. Now
//   running the full FEED_TICKERS set. Serialized by ticker; resumable.
//   Heaviest single job — staggered last among the three.
setTimeout(() => void runBarsDailyBackfill(_restClient),     2_000);
setTimeout(() => void runShortInterestBackfill(_restClient), 4_000);
setTimeout(() => void runBars1mBackfill(_restClient),        6_000);

// runInsiderIngestion: Form 4 insider transaction filings (90d window),
// resumable per ticker — same pattern as short interest/volume above.
// Filings are immutable once public, but new ones are published continuously
// during market hours, so this re-runs every 30 minutes (not one-shot).
setTimeout(() => void runInsiderIngestion(_restClient), 8_000);
setInterval(() => void runInsiderIngestion(_restClient), 30 * 60_000);

// runDisclosureIngestion: 8-K SEC disclosure filings (90d window), resumable
// per ticker — same pattern as insider transactions above. New 8-Ks get
// filed continuously during market hours, so this re-runs every 30 minutes.
setTimeout(() => void runDisclosureIngestion(_restClient), 10_000);
setInterval(() => void runDisclosureIngestion(_restClient), 30 * 60_000);

// runRatiosIngestion: financial ratios (P/E, P/B, P/S, Debt/Equity, ROE, ROA)
// for Swing Cockpit's F8 factor. TTM figures only move on quarterly earnings,
// so this refreshes once every 24h — not the faster cadence used elsewhere.
// evEbitda/fcfYield are always null — data source doesn't carry the raw
// figures (depreciation, cash balance, capex) needed to compute them for real.
setTimeout(() => void runRatiosIngestion(_restClient), 12_000);
setInterval(() => void runRatiosIngestion(_restClient), RATIOS_REFRESH_MS);

// runTickerAllowlistRefresh: real NYSE/Nasdaq/AMEX common-stock universe
// (~5,300 tickers, paginated) for the market-breadth engine (todo_66).
// Refreshes every 24h — tickers get added/delisted over time. After each
// refresh completes, kick off the 52-week high/low backfill against the
// real (fresh) list — not the 50-ticker pilot, which already proved the
// pattern clean (12,750 rows confirmed).
//
// The high/low backfill (~5,300 serialized REST calls) is the heaviest,
// least time-sensitive job in the app — its data isn't consumed by anything
// live yet (todo_66/67 breadth stats aren't wired up), so there's no cost
// to delaying it. Running it during the live session means every one of
// those ~5,300 calls competes with chainAggregator's continuous polling
// for the same network path. msUntilQuietWindow() holds it off the network
// entirely until the session's regular trading window (8:00 AM–3:30 PM CT)
// has passed — the allowlist refresh itself is cheap (a few paginated calls)
// and stays on its normal 14s boot stagger either way.
async function runBreadthAllowlistChain(): Promise<void> {
  await runTickerAllowlistRefresh(_restClient);
  const allowlist = await getAllowlistTickers();
  if (allowlist.length === 0) {
    console.error('[main] Allowlist is empty after refresh — skipping high/low backfill this cycle.');
    return;
  }

  const delay = msUntilQuietWindow();
  if (delay > 0) {
    console.log(`[main] High/low backfill deferred ${Math.round(delay / 60_000)}min — waiting for quiet window (outside 8:00 AM–3:30 PM CT).`);
    setTimeout(() => void runDailyHighLowBackfill(_restClient, allowlist), delay);
  } else {
    await runDailyHighLowBackfill(_restClient, allowlist);
  }
}
setTimeout(() => void runBreadthAllowlistChain(), 14_000);
setInterval(() => void runBreadthAllowlistChain(), ALLOWLIST_REFRESH_MS);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
)
