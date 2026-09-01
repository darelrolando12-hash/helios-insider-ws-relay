/**
 * MANUAL, OPERATOR-RUN end-to-end execution test.
 *
 * Fires ONE synthetic signal through paperExecution.ts's real entry path
 * (real equity, real exposure/daily-limit checks, real Massive discovery,
 * real sizing, real Webull order submission) and, once filled, forces a real
 * exit through the same module's exit path (forced-close / hard-stop /
 * confirmation precedence, real closing order). Same pattern as
 * engine/__manual__/riskSimulation.mjs — chains the REAL, tested modules, no
 * narrated arithmetic — except this hits the real broker instead of a
 * scripted mock, because that is the one thing a scripted simulation cannot
 * prove.
 *
 * This file is deliberately NOT wired into the engine and is never imported
 * by it. It lives under __manual__ because it places real orders.
 *
 * NOT a live-signal test: this fires ONE hand-built SignalInput, not
 * anything from confluenceEngine. paperExecution.ts is not subscribed to the
 * live signal stream anywhere in engine/index.ts — that wiring is deliberately
 * held until Track B (the shadow-mode diff against the browser) closes. See
 * paperExecution.ts's header and CLAUDE.md's SHADOW MODE section.
 *
 * ── Usage ─────────────────────────────────────────────────────────────────
 *   WEBULL_SANDBOX_APP_KEY=... WEBULL_SANDBOX_APP_SECRET=... MASSIVE_API_KEY=... \
 *   node signalTest.mjs --symbol SPY --direction put --i-understand-this-places-an-order
 */
import { WebullClient, webullCredentialsFromEnv } from '../webullClient.ts';
import { MassiveRestClient } from '../../lib/massive/api.ts';
import { MASSIVE_REST_BASE_URL, MASSIVE_API_KEY } from '../../../config.ts';
import { executeEntry, evaluateExit, executeExit } from '../paperExecution.ts';
import { EXECUTION_MODE, logExecutionModeBanner } from '../executionMode.ts';
import { DEFAULT_FORCED_CLOSE } from '../../risk/forcedClose.ts';
import { toCentralTime } from '../../lib/time.ts';

const args = Object.fromEntries(
  process.argv.slice(2).flatMap((a, i, arr) =>
    a.startsWith('--') ? [[a.slice(2), arr[i + 1]?.startsWith('--') || !arr[i + 1] ? true : arr[i + 1]]] : []
  )
);
const ARMED = args['i-understand-this-places-an-order'] === true;

let creds;
try { creds = webullCredentialsFromEnv(); } catch (e) { console.error(e.message); process.exit(1); }
if (!MASSIVE_API_KEY) { console.error('Missing MASSIVE_API_KEY.'); process.exit(1); }
if (!ARMED) {
  console.error('Refusing to run. Pass --i-understand-this-places-an-order — this submits');
  console.error('two real orders (entry + exit) to the Webull PaperTrade sandbox.');
  process.exit(1);
}

// Same reference values as engine/__manual__/riskSimulation.mjs — see that
// file's header for why these are representative-but-not-authoritative
// (no real production caller of these configs exists yet server-side).
const CONFIG = {
  riskPct: 0.02,
  maxPremiumLossPct: 0.50,
  caps: { maxContractsPerPosition: 50, maxPositionPctOfEquity: 0.30, minEquityToTrade: 100 },
  exposureLimits: { maxTotalDeployedPct: 0.70, maxTotalRiskPct: 0.10, maxConcurrentPositions: 5 },
  dailyLimits: { maxDailyLossPct: 0.06 },
  tiers: { breakevenAt: 0.30, trailTier1At: 0.80, trailTier1Pct: 0.25, trailTier2At: 1.50, trailTier2Pct: 0.20, initialStopLossPct: 0.50 },
  confirmation: { minSustainedTicks: 3, requireBarClose: true },
  forcedCloseSchedule: DEFAULT_FORCED_CLOSE,
  ladder: { tickSize: 0.01, attemptTimeoutsMs: [2000, 2000, 3000], maxSlippagePct: 0.10, allowMarketOnExhaustion: true },
  minDaysOut: 14,
  pollIntervalMs: 1500,
  maxPolls: 20,
};

(async () => {
  logExecutionModeBanner();

  const webull = new WebullClient(creds);
  const massive = new MassiveRestClient(MASSIVE_REST_BASE_URL, MASSIVE_API_KEY);

  const accounts = await webull.listAccounts();
  if (accounts.status !== 200 || !Array.isArray(accounts.body)) {
    console.error('account/list failed:', accounts.status, accounts.body); process.exit(1);
  }
  const acct = accounts.body.find((a) => a.account_class === 'INDIVIDUAL_MARGIN')
            ?? accounts.body.find((a) => a.account_class === 'INDIVIDUAL_CASH');
  console.log(`account: ${acct.account_label} (${acct.account_id})`);

  const symbol = args.symbol ?? 'SPY';
  const direction = (args.direction ?? 'put').toLowerCase() === 'call' ? 'call' : 'put';
  const settlementType = ['SPX', 'NDX'].includes(symbol.toUpperCase()) ? 'cash' : 'physical';

  const signal = {
    ticker: symbol,
    direction,
    stopDistance: 5.00, // real underlying $ distance — same reference value as riskSimulation.mjs
    entryBand: 'ENTER_BREAKOUT',
    settlementType,
  };
  console.log(`\nsignal: ${JSON.stringify(signal)}`);

  const deps = { massive, webull, accountId: acct.account_id };

  // ── ENTRY ───────────────────────────────────────────────────────────────
  console.log('\n=== EXECUTE ENTRY ===');
  const entry = await executeEntry(signal, CONFIG, deps);
  entry.log.forEach((l) => console.log('  ' + l));
  if (!entry.ok) {
    console.error(`\nENTRY FAILED: ${entry.reason}`);
    process.exit(1);
  }
  console.log(`\nENTRY FILLED: ${entry.position.contracts}x ${entry.position.webullSymbol} @ $${entry.position.entryPrice} (${entry.orderType})`);

  // Verify the real position actually exists, not just that the poll said FILLED.
  const posCheck = await webull.getPositions(acct.account_id);
  const realPosition = Array.isArray(posCheck.body)
    ? posCheck.body.find((p) => p.legs?.[0]?.symbol === entry.position.rootSymbol
        && Number(p.legs?.[0]?.option_exercise_price) === Number(entry.position.strikePrice))
    : null;
  console.log(`real position on account: ${realPosition ? 'CONFIRMED' : 'NOT FOUND — check manually'}`);

  // ── EXIT DECISION — deterministic, not waiting on real price movement ──
  // Prices are unlikely to move enough during this test to trigger a real
  // exit on their own. Rather than idle-poll hoping for one, this constructs
  // a live state well past the initial stop (entryPrice * (1 - 50%)) so
  // evaluateExit's hard-stop path fires for real and deterministically —
  // exercising tradeManagement.ts's real decision function against the real
  // entry price this run just produced, not a fabricated one.
  const nowCT = toCentralTime(Date.now());
  const todayCT = `${nowCT.year}-${String(nowCT.month).padStart(2, '0')}-${String(nowCT.day).padStart(2, '0')}`;
  const minuteOfDayCT = nowCT.hour * 60 + nowCT.minute;

  const liveState = {
    currentPrice: +(entry.position.entryPrice * 0.40).toFixed(2), // well past the 50% initial stop
    peakPrice: entry.position.entryPrice,
    currentBand: entry.position.entryBand,
    recentCvdSides: [],
    barClosed: false,
    todayCT,
    minuteOfDayCT,
  };
  console.log(`\n=== EXIT DECISION === (currentPrice=$${liveState.currentPrice} vs entry $${entry.position.entryPrice})`);
  const decision = evaluateExit(entry.position, liveState, CONFIG);
  console.log(`  ${JSON.stringify(decision)}`);

  if (!decision.shouldExit) {
    console.error('\nExit decision did not fire — this is unexpected for a price 60% below entry. Position left OPEN. Investigate before re-running.');
    process.exit(1);
  }

  // ── EXIT ────────────────────────────────────────────────────────────────
  console.log('\n=== EXECUTE EXIT ===');
  const exit = await executeExit(entry.position, decision, CONFIG, deps);
  exit.log.forEach((l) => console.log('  ' + l));
  if (!exit.ok) {
    console.error(`\nEXIT FAILED: ${exit.reason} — POSITION MAY STILL BE OPEN, check manually.`);
    process.exit(1);
  }
  console.log(`\nEXIT FILLED: @ $${exit.fill.fillPrice} (${exit.orderType}) — source: ${decision.source}`);

  const posCheckAfter = await webull.getPositions(acct.account_id);
  const stillOpen = Array.isArray(posCheckAfter.body)
    ? posCheckAfter.body.some((p) => p.legs?.[0]?.symbol === entry.position.rootSymbol)
    : false;
  console.log(`\nposition after exit: ${stillOpen ? 'STILL OPEN — check manually' : 'FLAT (confirmed via assets/positions)'}`);

  console.log(`\n=== SUMMARY ===`);
  console.log(`EXECUTION_MODE=${EXECUTION_MODE}`);
  console.log(`entry: ${entry.orderType} @ $${entry.position.entryPrice} x ${entry.position.contracts}`);
  console.log(`exit : ${exit.orderType} @ $${exit.fill.fillPrice} — ${decision.reason}`);
})().catch((e) => { console.error('FAILED:', e.stack || e.message); process.exit(1); });
