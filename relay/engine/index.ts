/**
 * Engine entry point.
 *
 * Started by relay/index.js only when ENGINE_MODE is not 'off'. The relay never
 * imports this module at the top level — it is dynamically imported after the
 * mode check, so with the engine disabled none of this code is even on the
 * relay's import graph.
 *
 * Boot ordering below mirrors the browser's main.tsx, whose ordering
 * constraints are documented against real observed failures. The stagger
 * constants are deliberately unchanged: each is a scar, and retuning them is a
 * separate evidence-gathering exercise, not a side effect of moving the code.
 */

import {
  MASSIVE_REST_BASE_URL,
  MASSIVE_API_KEY,
  assertConfig,
} from '../config.ts';
import { ENGINE_MODE, IS_ENABLED, logModeBanner } from './mode.ts';
import { massiveBus, type RelayControl } from './bus.ts';
import { MassiveRestClient } from './lib/massive/api.ts';
import { FEED_TICKERS } from './state/directionState.ts';
import { msUntilQuietWindow } from './lib/time.ts';

import * as barsStore        from './stores/barsStore.ts';
import * as luldStore        from './stores/luldStore.ts';
import * as newsStore        from './stores/newsStore.ts';
import * as cvdEngine        from './engines/cvdEngine.ts';
import * as confluenceEngine from './engines/confluenceEngine.ts';
import * as squeezeEngine    from './engines/squeezeEngine.ts';
import * as chainAggregator  from './engines/chainAggregator.ts';
import * as dumpRipDetector  from './engines/dumpRipDetector.ts';

import { initLedger } from './ledger/signalLedger.ts';
import { startResolver, setMarketOpen } from './ledger/outcomeResolver.ts';
import { replayTodaySession } from './engines/backtestEngine.ts';

import { runBarsDailyBackfill }     from './ingestion/barsIngestion.ts';
import { runShortInterestBackfill } from './ingestion/shortInterestIngestion.ts';
import { runBars1mBackfill }        from './ingestion/bars1mIngestion.ts';
import { runInsiderIngestion }      from './ingestion/insiderIngestion.ts';
import { runDisclosureIngestion }   from './ingestion/disclosureIngestion.ts';
import { runRatiosIngestion, REFRESH_INTERVAL_MS as RATIOS_REFRESH_MS } from './ingestion/ratiosIngestion.ts';
import {
  runTickerAllowlistRefresh,
  getAllowlistTickers,
  REFRESH_INTERVAL_MS as ALLOWLIST_REFRESH_MS,
} from './ingestion/tickerAllowlistIngestion.ts';
import { runDailyHighLowBackfill } from './ingestion/dailyHighLowIngestion.ts';
import {
  runEarningsCalendarIngestion,
  hydrateUpcomingEarningsFromDb,
} from './ingestion/earningsCalendarIngestion.ts';

import { rebuildAll } from './session/cvdRebuild.ts';

/**
 * The bus instance, exposed so relay/index.js can feed frames into it without
 * importing bus.ts directly. The relay reaches the engine through exactly two
 * symbols — this and startEngine/stopEngine — which keeps the coupling
 * explicit and one-directional.
 */
export const __bus = massiveBus;

// Context tickers subscribed at boot so they are never stale waiting for a
// cockpit to be opened (the browser had the same list for the same reason).
const CONTEXT_TICKERS = ['TLT', 'HYG', 'I:VIX'] as const;

const MARKET_STATUS_POLL_MS = 60_000;

// ── Shutdown state ───────────────────────────────────────────────────────────

/**
 * Set by the SIGTERM handler. Long-running ingestion loops check this between
 * tickers and between pages so they stop at a boundary rather than mid-page.
 *
 * IMPORTANT: correctness must NOT depend on the drain completing. Railway's
 * SIGTERM-to-SIGKILL buffer defaults to 0 seconds (configurable only via the
 * RAILWAY_DEPLOYMENT_DRAINING_SECONDS service variable), so on a default
 * service this process can be killed effectively immediately. The real
 * protection against half-finished work is the watermark discipline — never
 * advance a watermark for work that did not finish — which is enforced while
 * the work runs, not at shutdown.
 */
let _shuttingDown = false;
export function isShuttingDown(): boolean { return _shuttingDown; }

const _timers = new Set<ReturnType<typeof setTimeout>>();

/** setTimeout that is tracked, so shutdown can cancel it. */
function track(handle: ReturnType<typeof setTimeout>): ReturnType<typeof setTimeout> {
  _timers.add(handle);
  return handle;
}
function laterOnce(fn: () => void, ms: number) {
  track(setTimeout(() => { if (!_shuttingDown) fn(); }, ms));
}
function everyInterval(fn: () => void, ms: number) {
  track(setInterval(() => { if (!_shuttingDown) fn(); }, ms) as unknown as ReturnType<typeof setTimeout>);
}

// ── Boot ─────────────────────────────────────────────────────────────────────

let _booted = false;

/**
 * Start the engine.
 *
 * @param control  The relay's channel-subscription surface. Injected rather
 *                 than imported so the dependency stays one-directional: the
 *                 relay must never end up on the engine's import graph or
 *                 vice-versa.
 * @param opts.waitForUpstream  Resolves once at least one upstream has
 *                 authenticated. Boot waits on this before subscribing or
 *                 backfilling: ~22 cold-start REST backfills firing while the
 *                 upstreams are still inside their 0/20/30s connect stagger
 *                 would pile work into the relay's most fragile window.
 */
export async function startEngine(
  control: RelayControl,
  opts: { waitForUpstream: Promise<void> },
): Promise<void> {
  if (_booted) {
    console.warn('[engine] startEngine called twice — ignoring.');
    return;
  }
  _booted = true;

  // ── Phase 0: validate config, announce mode ───────────────────────────────
  logModeBanner();
  if (!IS_ENABLED) {
    console.log('[engine] ENGINE_MODE=off — not starting.');
    return;
  }
  assertConfig();

  const rest = new MassiveRestClient(MASSIVE_REST_BASE_URL, MASSIVE_API_KEY);
  console.log(`[engine] REST client → ${MASSIVE_REST_BASE_URL} (direct, not via relay proxy).`);

  // ── Phase 2: attach to the in-process fan-out ─────────────────────────────
  massiveBus.attach(control);
  console.log('[engine] Attached to relay broadcast in-process.');

  // ── Phase 2b: wait for an authenticated upstream ──────────────────────────
  console.log('[engine] Waiting for first upstream authentication before subscribing…');
  await opts.waitForUpstream;
  if (_shuttingDown) { console.log('[engine] Shutdown during boot — aborting.'); return; }
  console.log('[engine] Upstream authenticated — proceeding with boot.');

  // ── Phase 3: stores and engines that must exist before any subscription ───
  barsStore.initBarsStore(rest);
  chainAggregator.initChainAggregator(rest);
  cvdEngine.init();   // registers Q and T handlers — must precede subscriptions

  // ── Phase 3b: rebuild CVD from the session open ───────────────────────────
  // Runs BEFORE live subscriptions so the cumulative series starts from the
  // open rather than from this restart. A rebuild that finds nothing reports
  // 'absent' — never a ready CVD of zero.
  try {
    await rebuildAll(rest, FEED_TICKERS);
  } catch (err) {
    console.error('[engine] CVD rebuild failed — continuing with live ticks only. ' +
      'CVD is PARTIAL for this session and must not be read as cumulative-from-open:', err);
  }
  if (_shuttingDown) return;

  // ── Phase 4: subscribe the feed ───────────────────────────────────────────
  for (const ticker of FEED_TICKERS) {
    barsStore.subscribeTicker(ticker);
    cvdEngine.subscribeStock(ticker);
    luldStore.subscribeTicker(ticker);
  }
  for (const ticker of CONTEXT_TICKERS) {
    barsStore.subscribeTicker(ticker);
    cvdEngine.subscribeStock(ticker);
  }
  console.log(`[engine] Subscribed ${FEED_TICKERS.length} feed + ${CONTEXT_TICKERS.length} context ticker(s).`);

  // ── Phase 5: scoring engines ──────────────────────────────────────────────
  confluenceEngine.init();
  for (const ticker of FEED_TICKERS) confluenceEngine.watchTicker(ticker);

  squeezeEngine.init();
  for (const ticker of FEED_TICKERS) squeezeEngine.scoreTicker(ticker);

  dumpRipDetector.setPriceProvider((ticker: string) => {
    const result = barsStore.getResult(ticker);
    if (result.status !== 'ready' || result.data.length === 0) return null;
    return result.data[result.data.length - 1].close;
  });

  newsStore.startPolling();

  // ── Phase 6: ledger and resolver ──────────────────────────────────────────
  // Must follow confluenceEngine.init() — the ledger subscribes to its signal
  // stream.
  initLedger();
  startResolver();

  // ── Phase 7: market status — the highest-risk wiring in the whole boot ────
  // confluenceEngine._marketStatus and outcomeResolver._marketIsOpen BOTH
  // default closed. If this poll never lands, _onStoreUpdate returns early
  // forever and the resolver no-ops forever — and the symptom is
  // indistinguishable from a genuinely quiet market.
  //
  // Therefore: log the result of EVERY cycle, not only on change. A silent
  // success and a silent failure must not look the same in the logs.
  startMarketStatusPolling(rest);

  // ── Phase 8: chain aggregator, 250ms per ticker ───────────────────────────
  // Firing ~22 first fetches in one tick caused Massive to hard-reset every
  // connection (ERR_CONNECTION_RESET — no HTTP response at all).
  FEED_TICKERS.forEach((ticker, i) => {
    laterOnce(() => chainAggregator.subscribe(ticker), i * 250);
  });

  // ── Phase 9-10: background backfills, staggered ───────────────────────────
  // Same root cause as above: every job's first REST call landing in one tick
  // starves everything else behind a boot-time traffic jam. None are
  // latency-sensitive.
  laterOnce(() => void guarded('barsDaily',     () => runBarsDailyBackfill(rest)),      2_000);
  laterOnce(() => void guarded('shortInterest', () => runShortInterestBackfill(rest)),  4_000);
  laterOnce(() => void guarded('bars1m',        () => runBars1mBackfill(rest)),         6_000);

  laterOnce(() => void guarded('insider', () => runInsiderIngestion(rest)), 8_000);
  everyInterval(() => void guarded('insider', () => runInsiderIngestion(rest)), 30 * 60_000);

  laterOnce(() => void guarded('disclosure', () => runDisclosureIngestion(rest)), 10_000);
  everyInterval(() => void guarded('disclosure', () => runDisclosureIngestion(rest)), 30 * 60_000);

  laterOnce(() => void guarded('ratios', () => runRatiosIngestion(rest)), 12_000);
  everyInterval(() => void guarded('ratios', () => runRatiosIngestion(rest)), RATIOS_REFRESH_MS);

  // No MassiveRestClient — this one hits Nasdaq's free public calendar
  // directly (see earningsCalendarIngestion.ts's header for why: a real
  // forward-looking date source, which nothing in Massive's typed surface
  // currently provides at this account's entitlement tier). Hydrate from DB
  // first so a restart doesn't lose calendar data before the first live run
  // lands; daily cadence is enough — earnings dates rarely change day to day.
  laterOnce(() => void guarded('earningsCalendarHydrate', hydrateUpcomingEarningsFromDb), 13_000);
  laterOnce(() => void guarded('earningsCalendar', runEarningsCalendarIngestion), 15_000);
  everyInterval(() => void guarded('earningsCalendar', runEarningsCalendarIngestion), 24 * 60 * 60_000);

  laterOnce(() => void guarded('breadth', () => runBreadthAllowlistChain(rest)), 14_000);
  everyInterval(() => void guarded('breadth', () => runBreadthAllowlistChain(rest)), ALLOWLIST_REFRESH_MS);

  console.log(`[engine] Boot complete — mode=${ENGINE_MODE}.`);
}

/**
 * Runs a background job, swallowing its failure.
 *
 * A backfill throwing must never take down the process — the process also
 * holds the market-data connection. Skipped entirely once shutdown begins so a
 * queued job cannot start work that will be killed mid-flight.
 */
async function guarded(name: string, fn: () => Promise<void>): Promise<void> {
  if (_shuttingDown) {
    console.log(`[engine] ${name}: skipped — shutting down.`);
    return;
  }
  try {
    await fn();
  } catch (err) {
    console.error(`[engine] ${name} failed:`, err instanceof Error ? err.message : err);
  }
}

// ── Market status polling ────────────────────────────────────────────────────

let _wasMarketOpen: boolean | null = null;

function startMarketStatusPolling(rest: MassiveRestClient) {
  const poll = () => {
    rest.fetchMarketStatus()
      .then((status) => {
        const isOpen = status.market === 'open';

        // Every cycle, unconditionally. This line is the proof the gates are
        // being driven at all; its absence is the failure signal.
        console.log(`[engine] market-status poll OK — market=${status.market} (open=${isOpen})`);

        confluenceEngine.setMarketStatus(status.market);
        setMarketOpen(isOpen);

        if (_wasMarketOpen === true && isOpen === false) {
          console.log('[engine] Market just closed — replaying today\'s session for FEED_TICKERS.');
          for (const ticker of FEED_TICKERS) {
            replayTodaySession(ticker)
              .then(r => console.log(`[engine] ${ticker} today-replay: ${r.barsScanned} bars, ${r.signalsFired} fired, ${r.persisted} persisted.`))
              .catch(e => console.error(`[engine] ${ticker} today-replay failed —`, e));
          }
        }
        _wasMarketOpen = isOpen;
      })
      .catch((err) => {
        // Loud: a persistently failing poll leaves both gates closed forever,
        // which looks exactly like a quiet market.
        console.error(
          `[engine] market-status poll FAILED — ${err instanceof Error ? err.message : err}. ` +
          `Gates keep their last known values (currently open=${_wasMarketOpen}). ` +
          `If this repeats, scoring and outcome resolution are BOTH stalled.`
        );
      });
  };

  poll();
  everyInterval(poll, MARKET_STATUS_POLL_MS);
}

// ── Breadth chain ────────────────────────────────────────────────────────────

async function runBreadthAllowlistChain(rest: MassiveRestClient): Promise<void> {
  await runTickerAllowlistRefresh(rest);
  if (_shuttingDown) return;

  const allowlist = await getAllowlistTickers();
  if (allowlist.length === 0) {
    console.error('[engine] Allowlist empty after refresh — skipping high/low backfill this cycle.');
    return;
  }

  // ~5,300 serialised REST calls, consumed by nothing live yet. Held off the
  // network until outside the 8:00 AM–3:30 PM CT session window so it never
  // competes with live chain polling.
  const delay = msUntilQuietWindow();
  if (delay > 0) {
    console.log(`[engine] High/low backfill deferred ${Math.round(delay / 60_000)}min — waiting for the quiet window.`);
    laterOnce(() => void guarded('highLow', () => runDailyHighLowBackfill(rest, allowlist)), delay);
  } else {
    await runDailyHighLowBackfill(rest, allowlist);
  }
}

// ── Shutdown ─────────────────────────────────────────────────────────────────

/**
 * Stop engine work at a safe boundary.
 *
 * Deliberately bounded and best-effort. Railway's SIGTERM→SIGKILL buffer
 * defaults to 0 seconds — verified from Railway's docs, configurable only via
 * the RAILWAY_DEPLOYMENT_DRAINING_SECONDS service variable — so on a default
 * service none of this may get to run at all.
 *
 * That is survivable precisely because nothing here is load-bearing for
 * correctness:
 *   - Watermarks are never advanced for unfinished work; that rule is applied
 *     inside the ingestion jobs, not here.
 *   - Every job is resumable and re-reads its watermark on the next boot.
 *   - The watermark − 7 day overlap covers a partially-written page.
 *
 * What this DOES buy, when a drain budget exists: loops stop between tickers
 * instead of mid-page, timers stop firing new work, and in-flight DB writes
 * get a moment to settle.
 *
 * Ordering matters: engine work is stopped BEFORE the relay closes its
 * upstream sockets, so nothing is left computing against a feed that is
 * already gone.
 */
export async function stopEngine(reason: string): Promise<void> {
  if (_shuttingDown) return;
  _shuttingDown = true;

  console.log(`[engine] Shutdown requested (${reason}). Stopping at the next safe boundary.`);
  console.log(
    '[engine] NOTE: Railway\'s SIGTERM→SIGKILL buffer defaults to 0s. If this process ' +
    'disappears before the lines below, that is expected and safe — no watermark is ' +
    'advanced for unfinished work, and every job resumes from its last completed unit.'
  );

  for (const handle of _timers) {
    clearTimeout(handle);
    clearInterval(handle as unknown as ReturnType<typeof setInterval>);
  }
  _timers.clear();

  console.log('[engine] Timers cleared. Engine is quiescent.');
}
