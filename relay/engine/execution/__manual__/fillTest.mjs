/**
 * MANUAL, OPERATOR-RUN fill-realism test — Gate 1 of the Webull design.
 *
 * Submits ONE order for ONE option contract to the Webull PaperTrade sandbox
 * and reports exactly where it filled relative to bid, ask and last. That
 * answered the only question that mattered before building any of this: does
 * the sandbox produce realistic fills, or is it a black-box simulator that
 * would merely replace our synthetic mid-price model with one we understand
 * less?
 *
 * This file is deliberately NOT wired into the engine and is never imported by
 * it. It lives under __manual__ because it places an order, and placing orders
 * is an operator action.
 *
 * ── Gate 1's real, closed answer (2026-09-01) ──────────────────────────────
 * Four real marketable LIMIT orders (calls and puts, thin and genuinely liquid
 * contracts, 30-90s windows) never filled. REST polling was proven NOT to be
 * blind to fills first (it correctly reflected two real cancellations) before
 * that was trusted as a real non-fill. A real MARKET order on the same kind of
 * contract filled in 602ms, matching Massive's independently-sourced real NBBO
 * to the cent (16.5ms apart) — proving the fill was realistic, not synthetic.
 * Conclusion: this sandbox does not cross marketable limit orders, but market
 * orders fill correctly and match the real book. See executionMode.ts, which
 * encodes this as EXECUTION_MODE=paper -> MARKET.
 *
 * Contract selection, the Webull client, and the Massive-discovery pipeline
 * used here are now shared, real modules (contractDiscovery.ts,
 * webullClient.ts) — the same ones paperExecution.ts uses for real order
 * submission. This file is now a thin CLI wrapper, not a second copy.
 *
 * ── Safety ────────────────────────────────────────────────────────────────
 * Every Webull request routes through ../webullEndpoint.ts (via webullClient.ts),
 * so the production host is unreachable: assertSandboxHost() runs on the base
 * URL and again on the final URL, and assertSafeToSubmit() re-checks the
 * endpoint plus the account id immediately before the order goes out. It also
 * refuses to run unless --i-understand-this-places-an-order is passed. Massive
 * access is read-only (chain snapshot) — no orders are ever placed against it.
 *
 * ── Usage ─────────────────────────────────────────────────────────────────
 *   WEBULL_SANDBOX_APP_KEY=... WEBULL_SANDBOX_APP_SECRET=... MASSIVE_API_KEY=... \
 *   node fillTest.mjs --symbol SPY --right CALL --i-understand-this-places-an-order
 *
 * --strike/--expiry pin discovery to an exact contract instead of ranking the
 * chain. --order-type MARKET|LIMIT selects the order type (default LIMIT, to
 * keep this script's default behaviour unsurprising — paperExecution.ts is
 * what actually defaults to MARKET via EXECUTION_MODE).
 *
 * Add --dry-run to do everything up to and including PREVIEW (no side
 * effects) and stop before the real submission. Run that first, always.
 */
import crypto from 'crypto';
import { sandboxBaseUrl } from '../webullEndpoint.ts';
import { WebullClient, webullCredentialsFromEnv, equityFromBalance } from '../webullClient.ts';
import { discoverContract } from '../contractDiscovery.ts';
import { MassiveRestClient } from '../../lib/massive/api.ts';
import { MASSIVE_REST_BASE_URL, MASSIVE_API_KEY } from '../../../config.ts';

const args = Object.fromEntries(
  process.argv.slice(2).flatMap((a, i, arr) =>
    a.startsWith('--') ? [[a.slice(2), arr[i + 1]?.startsWith('--') || !arr[i + 1] ? true : arr[i + 1]]] : []
  )
);

const ARMED = args['i-understand-this-places-an-order'] === true;
const DRY = args['dry-run'] === true;

let creds;
try { creds = webullCredentialsFromEnv(); } catch (e) { console.error(e.message); process.exit(1); }
if (!MASSIVE_API_KEY) {
  console.error('Missing MASSIVE_API_KEY — contract discovery requires real chain data.');
  process.exit(1);
}
if (!ARMED && !DRY) {
  console.error('Refusing to run. Pass --dry-run to inspect (through PREVIEW, no side');
  console.error('effects), or --i-understand-this-places-an-order to actually submit.');
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Reference risk parameters. No real production caller of affordablePremiumBand
// exists yet server-side outside this file's own callers — these are the same
// values the module's own test suite treats as a representative account, used
// here only to bound contract discovery, not as a claim about this specific
// account's real risk settings.
const REFERENCE_RISK_PCT = 0.02;
const REFERENCE_MAX_PREMIUM_LOSS_PCT = 0.50;
const REFERENCE_CAPS = { maxContractsPerPosition: 50, maxPositionPctOfEquity: 0.30, minEquityToTrade: 100 };

(async () => {
  const symbol = args.symbol ?? 'SPY';
  const right = (args.right ?? 'CALL').toUpperCase();
  const wantExpiry = typeof args.expiry === 'string' ? args.expiry : null;
  const wantStrike = args.strike != null && args.strike !== true ? Number(args.strike) : null;
  const orderType = (args['order-type'] ?? 'LIMIT').toUpperCase();
  if (orderType !== 'LIMIT' && orderType !== 'MARKET') {
    console.error(`Unknown --order-type "${orderType}" — must be LIMIT or MARKET.`);
    process.exit(1);
  }

  console.log(`endpoint: ${sandboxBaseUrl()}  (PaperTrade — production host is unreachable from this file)`);

  const webull = new WebullClient(creds);
  const massive = new MassiveRestClient(MASSIVE_REST_BASE_URL, MASSIVE_API_KEY);

  const accounts = await webull.listAccounts();
  if (accounts.status !== 200 || !Array.isArray(accounts.body)) {
    console.error('account/list failed:', accounts.status, accounts.body); process.exit(1);
  }
  const ids = accounts.body.map((a) => a.account_id);
  const acct = accounts.body.find((a) => a.account_class === 'INDIVIDUAL_MARGIN')
            ?? accounts.body.find((a) => a.account_class === 'INDIVIDUAL_CASH');
  console.log(`account : ${acct.account_label} (${acct.account_id})`);

  const balance = await webull.getBalance(acct.account_id);
  const equity = equityFromBalance(balance.body);
  if (!Number.isFinite(equity) || equity <= 0) {
    console.error('Could not read real equity from assets/balance — cannot compute an affordable premium band.');
    console.error(JSON.stringify(balance.body).slice(0, 500));
    process.exit(1);
  }
  console.log(`equity  : $${equity.toFixed(2)} (real, from assets/balance)`);

  console.log(`\n--- Massive chain: ${symbol} ${right} ---`);
  const discovery = await discoverContract(
    {
      symbol, right, equity,
      riskPct: REFERENCE_RISK_PCT, maxPremiumLossPct: REFERENCE_MAX_PREMIUM_LOSS_PCT, caps: REFERENCE_CAPS,
      wantExpiry, wantStrike,
    },
    { massive, webull },
  );

  console.log(`underlying price (Massive): ${discovery.underlyingPrice ?? 'unavailable'}`);
  if (discovery.band) {
    console.log(`affordable premium band: $${discovery.band.minPremium.toFixed(2)} - $${discovery.band.maxPremium.toFixed(2)} (tradeable=${discovery.band.tradeable}, reason=${discovery.band.reason})`);
  }
  if (discovery.attempts) {
    console.log(`\nWebull coverage attempts (in Massive rank order):`);
    for (const a of discovery.attempts) console.log(`  ${a.ticker}: ${a.result}`);
  }
  if (!discovery.ok) {
    console.error(`\n${discovery.reason}`);
    console.error('Nothing was submitted.');
    process.exit(1);
  }

  console.log(`\nselected (Massive, rank #${discovery.rank}): ${discovery.candidate.massiveTicker}  strike ${discovery.candidate.strike}  expiry ${discovery.candidate.expiration}`);
  console.log(`  bid=${discovery.candidate.bid}  ask=${discovery.candidate.ask}  mid=${discovery.candidate.mid.toFixed(2)}  spread%=${(discovery.candidate.spreadPctOfMid * 100).toFixed(1)}%`);
  console.log(`  volume=${discovery.candidate.volume ?? 'n/a'}  openInterest=${discovery.candidate.openInterest ?? 'n/a'}  hasRealVolume=${discovery.candidate.hasRealVolume}  delta=${discovery.candidate.delta ?? 'n/a'}`);
  console.log(`Webull match: ${discovery.webull.symbol}  strike ${discovery.webull.strikePrice}  expiry ${discovery.webull.expirationDate}  id ${discovery.webull.instrumentId}`);

  const quote = await webull.optionSnapshot(discovery.webull.symbol);
  console.log('\n--- pre-order quote (Webull) ---');
  console.log(JSON.stringify(quote.body, null, 2).slice(0, 1200));

  const q = Array.isArray(quote.body) ? quote.body[0] : quote.body;
  const bid = Number(q?.bid ?? q?.bid_price ?? q?.bidPrice ?? NaN);
  const ask = Number(q?.ask ?? q?.ask_price ?? q?.askPrice ?? NaN);
  const last = Number(q?.last ?? q?.close ?? q?.latest_price ?? NaN);
  if (!Number.isFinite(bid) || !Number.isFinite(ask)) {
    console.error('\nNo usable bid/ask in the Webull snapshot response — cannot pick a marketable price.');
    console.error('Nothing was submitted. Response:', JSON.stringify(q).slice(0, 400));
    process.exit(1);
  }
  const spread = ask - bid;
  console.log(`\nbid=${bid}  ask=${ask}  last=${last}  spread=${spread.toFixed(4)} (${((spread / ask) * 100).toFixed(1)}% of ask)`);

  const limitPrice = orderType === 'LIMIT' ? ask.toFixed(2) : null;
  const clientOrderId = crypto.randomUUID().replace(/-/g, '');
  const orderBody = {
    new_orders: [{
      client_order_id: clientOrderId,
      combo_type: 'NORMAL',
      order_type: orderType,
      quantity: '1',
      ...(limitPrice != null ? { limit_price: limitPrice } : {}),
      option_strategy: 'SINGLE',
      side: 'BUY',
      time_in_force: 'DAY',
      entrust_type: 'QTY',
      orders: [{
        side: 'BUY',
        quantity: '1',
        symbol: discovery.webull.rootSymbol,
        strike_price: discovery.webull.strikePrice,
        init_exp_date: discovery.webull.expirationDate,
        instrument_type: 'OPTION',
        option_type: right,
        market: 'US',
      }],
    }],
    account_id: acct.account_id,
  };

  console.log('\n--- order body ---');
  console.log(JSON.stringify(orderBody, null, 2));

  const preview = await webull.previewOptionOrder(orderBody);
  console.log('\n--- preview (no side effects) ---');
  console.log('HTTP', preview.status, JSON.stringify(preview.body));
  if (preview.status !== 200) {
    console.error('\nPreview rejected the order — nothing was submitted. Fix the body above first.');
    process.exit(1);
  }

  if (DRY) { console.log('\nDRY RUN — preview succeeded, stopping before real submission.'); return; }

  webull.assertSafeToSubmit(acct.account_id, ids);

  const placed = await webull.placeOptionOrder(orderBody);
  console.log('\n--- submit ---');
  console.log('HTTP', placed.status, JSON.stringify(placed.body));
  if (placed.status !== 200) { console.error('Order was not accepted — stopping.'); process.exit(1); }

  for (let i = 0; i < 20; i++) {
    await sleep(1500);
    const det = await webull.orderDetail(acct.account_id, clientOrderId);
    const o = det.body?.orders?.[0];
    const status = o?.status;
    console.log(`poll ${i + 1}: status=${status} filled=${o?.filled_quantity ?? '?'} price=${o?.filled_price ?? '?'}`);
    if (status && /FILLED|CANCEL|REJECT|FAILED/i.test(String(status))) {
      const avg = Number(o?.filled_price ?? NaN);
      const latencyMs = Number(o?.filled_time) && Number(o?.place_time)
        ? Number(o.filled_time) - Number(o.place_time) : null;
      console.log('\n=== RESULT ===');
      console.log(`order type      : ${orderType}${limitPrice != null ? ` (limit ${limitPrice}, at ask)` : ''}`);
      console.log(`filled at       : ${avg}`);
      console.log(`bid/ask/last    : ${bid} / ${ask} / ${last}`);
      if (latencyMs != null) console.log(`latency         : ${latencyMs}ms (place -> fill)`);
      if (Number.isFinite(avg)) {
        if (Math.abs(avg - ask) < 1e-6) console.log('-> filled AT THE ASK — consistent with a real marketable buy.');
        else if (Math.abs(avg - (bid + ask) / 2) < 1e-6) console.log('-> filled AT THE MID — simulator, NOT realistic.');
        else if (Math.abs(avg - last) < 1e-6) console.log('-> filled AT LAST PRICE — matches consumer paperTrade rules, not a real book.');
        else if (avg < bid || avg > ask) console.log(`-> filled OUTSIDE the live bid/ask entirely — check the real NBBO at the fill timestamp before trusting this reading (a stale comparison quote can look like this too).`);
        else console.log('-> filled inside the spread but not at ask/mid/last; record and compare.');
      }
      break;
    }
  }
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
