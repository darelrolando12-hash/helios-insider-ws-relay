/**
 * MANUAL, OPERATOR-RUN fill-realism test — Gate 1 of the Webull design.
 *
 * Submits ONE marketable limit order for ONE option contract to the Webull
 * PaperTrade sandbox and reports exactly where it filled relative to bid, ask
 * and last. That answers the only question that matters before building any of
 * this: does the sandbox produce realistic fills, or is it a black-box
 * simulator that would merely replace our synthetic mid-price model with one
 * we understand less?
 *
 * This file is deliberately NOT wired into the engine and is never imported by
 * it. It lives under __manual__ because it places an order, and placing orders
 * is an operator action.
 *
 * ── Source correction (2026-08-31) ───────────────────────────────────────
 * The paths and body shape below were rebuilt from webull-inc/
 * webull-openapi-python-sdk (the CURRENT, maintained repo). The first version
 * of this file was built from webull-inc/openapi-python-sdk, which carries an
 * explicit deprecation notice pointing at the current one. The signing
 * algorithm (HMAC-SHA1, canonical-string construction) is byte-identical
 * between the two repos — only the URIs, versions, and body shapes moved.
 *
 * NOTE: the current repo's signature composer contains a line that
 * unconditionally overrides the signer to SHA-256
 * (`signer_spec = sha_hmac256_new` in default_signature_composer.py,
 * ignoring whatever was passed in). Every live call made during this
 * investigation used HMAC-SHA1 and returned real 200s against the sandbox,
 * so that source line is not trusted here — per this project's standing
 * rule, the wire wins over docs (and here, over source that contradicts a
 * working live call). Flagged rather than silently resolved: if Webull ever
 * enforces that override, every call in this file starts failing signature
 * verification, and the fix is to switch the algorithm/header to SHA-256.
 *
 * ── Contract selection comes from Massive, not Webull (2026-09-01) ────────
 * A prior version of this file asked Webull's own
 * /openapi/instrument/option/contracts for a contract to trade. That endpoint
 * is not a real chain: near-dated real (non-FLEX) contracts are frequently
 * absent, and where present, checked live across six underlyings
 * (SPY/AAPL/QQQ/TSLA/MSFT/NVDA), every available near-dated strike was deep
 * ITM (delta >= 0.975) — the strike ladder simply doesn't reach current
 * price. A naive pick from that list landed on QQQ260918C00615000, volume=3
 * for the entire session against 6,726 open interest — dead by construction,
 * not a meaningful fill-realism test.
 *
 * Discovery now happens against Massive's real, complete, live chain
 * (engine/lib/massive/api.ts, direct REST, already used in production),
 * filtered through the same risk modules a real trade would clear —
 * contractQuality.ts (spread, liquidity) and positionSizing.ts's
 * affordablePremiumBand() (what premium this account can actually afford).
 * Webull is used for EXECUTION ONLY: once Massive names a real, liquid,
 * near-the-money contract, this file looks that EXACT strike+expiry up in
 * Webull's instrument list and submits it. If Webull doesn't carry that
 * specific contract, that is reported as its own coverage-gap finding —
 * never silently swapped for a different one.
 *
 * ── Safety ────────────────────────────────────────────────────────────────
 * Every Webull request routes through ../webullEndpoint.ts, so the production
 * host is unreachable: assertSandboxHost() runs on the base URL and again on
 * the final URL, and assertSafeToSubmit() re-checks the endpoint plus the
 * account id immediately before the order goes out. It also refuses to run
 * unless --i-understand-this-places-an-order is passed. Massive access is
 * read-only (chain snapshot) — no orders are ever placed against Massive.
 *
 * ── Usage ─────────────────────────────────────────────────────────────────
 *   WEBULL_SANDBOX_APP_KEY=... WEBULL_SANDBOX_APP_SECRET=... MASSIVE_API_KEY=... \
 *   node fillTest.mjs --symbol SPY --right CALL --i-understand-this-places-an-order
 *
 * --strike/--expiry pin discovery to an exact contract instead of ranking the
 * chain (still validated for a real quote and looked up in Webull the same
 * way — this is an override of WHICH contract to pick, not a bypass of the
 * Webull-coverage check).
 *
 * Add --dry-run to do everything up to and including PREVIEW (no side
 * effects) and stop before the real submission. Run that first, always.
 */
import crypto from 'crypto';
import {
  sandboxBaseUrl,
  assertSandboxHost,
  assertSafeToSubmit,
} from '../webullEndpoint.ts';
import { MassiveRestClient } from '../../lib/massive/api.ts';
import { MASSIVE_REST_BASE_URL, MASSIVE_API_KEY } from '../../../config.ts';
import { assessContractQuality } from '../../risk/contractQuality.ts';
import { affordablePremiumBand } from '../../risk/positionSizing.ts';

const APP_KEY = process.env.WEBULL_SANDBOX_APP_KEY;
const APP_SECRET = process.env.WEBULL_SANDBOX_APP_SECRET;

const args = Object.fromEntries(
  process.argv.slice(2).flatMap((a, i, arr) =>
    a.startsWith('--') ? [[a.slice(2), arr[i + 1]?.startsWith('--') || !arr[i + 1] ? true : arr[i + 1]]] : []
  )
);

const ARMED = args['i-understand-this-places-an-order'] === true;
const DRY = args['dry-run'] === true;

if (!APP_KEY || !APP_SECRET) {
  console.error('Missing WEBULL_SANDBOX_APP_KEY / WEBULL_SANDBOX_APP_SECRET.');
  process.exit(1);
}
if (!MASSIVE_API_KEY) {
  console.error('Missing MASSIVE_API_KEY — contract discovery requires real chain data.');
  process.exit(1);
}
if (!ARMED && !DRY) {
  console.error('Refusing to run. Pass --dry-run to inspect (through PREVIEW, no side');
  console.error('effects), or --i-understand-this-places-an-order to actually submit.');
  process.exit(1);
}

// ── Signing — see the source-correction note above for why this stays SHA-1 ─
const enc = (s) =>
  Array.from(Buffer.from(s, 'utf8'))
    .map((b) => {
      const c = String.fromCharCode(b);
      return /[A-Za-z0-9\-._~]/.test(c) ? c : '%' + b.toString(16).toUpperCase().padStart(2, '0');
    })
    .join('');

async function call({ uri, method = 'GET', version = 'v2', query = null, body = null, extraHeaders = null }) {
  const base = sandboxBaseUrl();
  assertSandboxHost(base);
  const host = new URL(base).hostname;

  const sh = {
    'x-app-key': APP_KEY,
    'x-timestamp': new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    'x-signature-version': '1.0',
    'x-signature-algorithm': 'HMAC-SHA1',
    'x-signature-nonce': crypto.randomUUID(),
  };
  const p = {};
  for (const [k, v] of Object.entries(sh)) p[k.toLowerCase()] = v;
  p['host'] = host;
  if (query) for (const [k, v] of Object.entries(query)) p[k] = p[k] != null ? `${p[k]}&${v}` : String(v);

  let sts = uri + '&' + Object.keys(p).sort().map((k) => `${k}=${p[k]}`).join('&');
  if (body) sts += '&' + crypto.createHash('md5').update(JSON.stringify(body), 'utf8').digest('hex').toUpperCase();

  const signature = crypto.createHmac('sha1', Buffer.from(APP_SECRET + '&', 'utf8'))
    .update(Buffer.from(enc(sts), 'utf8')).digest('base64');

  const url = base + uri + (query ? '?' + new URLSearchParams(query).toString() : '');
  assertSandboxHost(url);

  const res = await fetch(url, {
    method,
    headers: {
      ...sh, 'x-version': version, 'x-signature': signature,
      'Content-Type': 'application/json;charset=UTF-8',
      // NOT part of the signature — confirmed from source: sign_params only
      // ever includes sh + host + query, custom headers are added after.
      ...(extraHeaders || {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const t = await res.text();
  let b; try { b = JSON.parse(t); } catch { b = t; }
  return { status: res.status, body: b, url };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Reference risk parameters. No real production caller of affordablePremiumBand
// exists yet server-side (grepped 2026-09-01, execution wiring is still pending
// Gate 1) — these are the same values the module's own test suite treats as a
// representative account, used here only to bound contract discovery, not as a
// claim about this specific account's real risk settings.
const REFERENCE_RISK_PCT = 0.02;
const REFERENCE_MAX_PREMIUM_LOSS_PCT = 0.50;
const REFERENCE_CAPS = {
  maxContractsPerPosition: 50,
  maxPositionPctOfEquity: 0.30,
  minEquityToTrade: 100,
};
// Matches BestContractsCockpit's own spread criterion (src/cockpits/
// BestContractsCockpit.tsx, SPREAD_MAX_PCT) — the only concrete spread
// threshold that exists anywhere in this codebase.
const MAX_SPREAD_PCT_OF_MID = 0.08;
const MIN_DAYS_OUT_DEFAULT = 14; // avoid 0DTE/weekly noise unless --expiry overrides

// ── Test ────────────────────────────────────────────────────────────────────
(async () => {
  const symbol = args.symbol ?? 'SPY';
  const right = (args.right ?? 'CALL').toUpperCase();
  const wantExpiry = typeof args.expiry === 'string' ? args.expiry : null;
  const wantStrike = args.strike != null && args.strike !== true ? Number(args.strike) : null;

  console.log(`endpoint: ${sandboxBaseUrl()}  (PaperTrade — production host is unreachable from this file)`);

  // ── Real account, real equity (Webull) ─────────────────────────────────────
  const accounts = await call({ uri: '/openapi/account/list' });
  if (accounts.status !== 200 || !Array.isArray(accounts.body)) {
    console.error('account/list failed:', accounts.status, accounts.body); process.exit(1);
  }
  const ids = accounts.body.map((a) => a.account_id);
  const acct = accounts.body.find((a) => a.account_class === 'INDIVIDUAL_MARGIN')
            ?? accounts.body.find((a) => a.account_class === 'INDIVIDUAL_CASH');
  console.log(`account : ${acct.account_label} (${acct.account_id})`);

  const balance = await call({ uri: '/openapi/assets/balance', query: { account_id: acct.account_id } });
  const balRow = Array.isArray(balance.body) ? balance.body[0] : balance.body;
  const equity = Number(balRow?.total_net_liquidation_value ?? balRow?.net_liq ?? balRow?.total_equity ?? NaN);
  if (!Number.isFinite(equity) || equity <= 0) {
    console.error('Could not read real equity from assets/balance — cannot compute an affordable premium band.');
    console.error(JSON.stringify(balance.body).slice(0, 500));
    process.exit(1);
  }
  console.log(`equity  : $${equity.toFixed(2)} (real, from assets/balance)`);

  // ── Contract discovery — Massive's real chain, not Webull's instrument list ─
  console.log(`\n--- Massive chain: ${symbol} ${right} ---`);
  const massive = new MassiveRestClient(MASSIVE_REST_BASE_URL, MASSIVE_API_KEY);
  // fetchOptionsSnapshot sorts nearest-expiry-first; a name like QQQ/SPY lists
  // a same-day/weekly expiry for nearly every session, so 2000 (the module's
  // own default) exhausts itself inside the first ~5 expiries and never
  // reaches anything 14+ days out. Confirmed live: QQQ needed ~11,200
  // contracts across 32 expiries to reach a 14-day-out one.
  const snapshot = await massive.fetchOptionsSnapshot(symbol, 20000);
  const wantType = right === 'CALL' ? 'call' : 'put';
  const chain = snapshot.filter((c) => c.details?.contract_type === wantType);
  console.log(`fetched ${snapshot.length} total contracts, ${chain.length} ${wantType}s`);

  if (chain.length === 0) {
    console.error(`\nMassive returned zero ${wantType} contracts for ${symbol} — nothing to select from.`);
    console.error('Nothing was submitted.');
    process.exit(1);
  }

  const underlyingPrice = chain.map((c) => c.underlying_asset?.price ?? c.underlying_asset?.value)
    .find((v) => Number.isFinite(v)) ?? null;
  console.log(`underlying price (Massive): ${underlyingPrice ?? 'unavailable'}`);

  const band = affordablePremiumBand({
    equity,
    riskPct: REFERENCE_RISK_PCT,
    maxPremiumLossPct: REFERENCE_MAX_PREMIUM_LOSS_PCT,
    caps: REFERENCE_CAPS,
  });
  console.log(`affordable premium band: $${band.minPremium.toFixed(2)} - $${band.maxPremium.toFixed(2)} (tradeable=${band.tradeable}, reason=${band.reason})`);
  if (!band.tradeable) {
    console.error('\nAccount cannot afford any contract worth trading under the reference risk parameters.');
    console.error('Nothing was submitted.');
    process.exit(1);
  }

  const now = Date.now();
  let pool = chain;
  if (wantExpiry) {
    pool = pool.filter((c) => c.details.expiration_date === wantExpiry);
  } else {
    pool = pool.filter((c) => (new Date(c.details.expiration_date) - now) / 86_400_000 >= MIN_DAYS_OUT_DEFAULT);
  }
  if (wantStrike != null) pool = pool.filter((c) => c.details.strike_price === wantStrike);

  // Score every candidate through the same quality gate a real trade would
  // clear, and record WHY each one was rejected — never silently drop rows.
  const scored = pool.map((c) => {
    const bid = c.last_quote?.bid;
    const ask = c.last_quote?.ask;
    const volume = c.day?.volume;
    const openInterest = c.open_interest;
    const quality = assessContractQuality(
      { bid, ask, openInterest, volume },
      { maxSpreadPctOfMid: MAX_SPREAD_PCT_OF_MID, minPremium: band.minPremium },
    );
    const mid = quality.mid;
    const withinBand = quality.acceptable && mid <= band.maxPremium;
    const hasRealVolume = Number.isFinite(volume) && volume > 0;
    return { contract: c, quality, mid, withinBand, hasRealVolume, volume, openInterest };
  });

  const accepted = scored.filter((s) => s.withinBand);
  console.log(`\n${pool.length} candidates in window, ${accepted.length} pass contractQuality + affordable band`);

  if (accepted.length === 0) {
    console.error('\nNo contract passed contractQuality/affordablePremiumBand. Rejection reasons seen:');
    const reasonCounts = {};
    for (const s of scored) reasonCounts[s.quality.reason] = (reasonCounts[s.quality.reason] ?? 0) + 1;
    console.error(JSON.stringify(reasonCounts));
    console.error('Nothing was submitted.');
    process.exit(1);
  }

  // Prefer real traded volume first (the exact thing that made the last real
  // run a dead test), then nearest-to-the-money as the tiebreak.
  accepted.sort((a, b) => {
    if (a.hasRealVolume !== b.hasRealVolume) return a.hasRealVolume ? -1 : 1;
    if (b.volume !== a.volume && Number.isFinite(a.volume) && Number.isFinite(b.volume)) return b.volume - a.volume;
    if (underlyingPrice == null) return 0;
    return Math.abs(a.contract.details.strike_price - underlyingPrice) - Math.abs(b.contract.details.strike_price - underlyingPrice);
  });

  for (const s of accepted.slice(0, 5)) {
    const d = s.contract.details;
    console.log(`  candidate: ${d.ticker}  strike ${d.strike_price}  expiry ${d.expiration_date}  `
      + `vol=${s.volume ?? 'n/a'}  OI=${s.openInterest ?? 'n/a'}  mid=${s.mid.toFixed(2)}  spread%=${(s.quality.spreadPctOfMid * 100).toFixed(1)}%`);
  }

  // ── Webull coverage check — execution only, exact match required ──────────
  // Walk the ranked list in order rather than stopping at the first miss.
  // This is NOT substituting a different contract for the top pick — it is
  // trying the next REAL, quality-passing, ranked candidate and logging every
  // attempt, exactly the same as a human operator would if the #1 pick wasn't
  // tradeable. Silent substitution would be picking something off-list or
  // outside the ranking; this stays inside it, in order, visibly.
  const instQuery = { category: 'US_OPTION', underlying_symbols: symbol, option_type: right, status: 'LISTING', page_size: '250' };
  const inst = await call({ uri: '/openapi/instrument/option/contracts', version: 'v2', query: instQuery });
  console.log('\n--- Webull instrument coverage check ---');
  console.log('HTTP', inst.status, ' contracts on this page:', Array.isArray(inst.body) ? inst.body.length : inst.body);
  const webullRows = Array.isArray(inst.body) ? inst.body : [];

  const ATTEMPT_LIMIT = 20;
  let pick = null;
  let contract = null;
  const attempts = [];
  for (const candidate of accepted.slice(0, ATTEMPT_LIMIT)) {
    const d = candidate.contract.details;
    const match = webullRows.find((c) =>
      c.expiration_date === d.expiration_date && Number(c.strike_price) === d.strike_price
    );
    if (!match) {
      attempts.push({ ticker: d.ticker, result: 'not found in Webull instrument list' });
      continue;
    }
    if (match.def_type === 'FLEX') {
      attempts.push({ ticker: d.ticker, result: `only a synthetic FLEX match (${match.symbol}) — fails order preview/place` });
      continue;
    }
    attempts.push({ ticker: d.ticker, result: `MATCHED — ${match.symbol}` });
    pick = candidate;
    contract = match;
    break;
  }

  console.log(`\nWebull coverage attempts (in Massive rank order):`);
  for (const a of attempts) console.log(`  ${a.ticker}: ${a.result}`);

  if (!contract) {
    console.error(`\nWEBULL COVERAGE GAP: none of the top ${attempts.length} ranked ${symbol} ${right} `
      + `candidates from Massive exist as real (non-FLEX) contracts in Webull's sandbox instrument list `
      + `(checked ${webullRows.length} rows). Not substituting a contract outside the ranking.`);
    console.error('Nothing was submitted.');
    process.exit(1);
  }
  const picked = pick.contract.details;
  console.log(`\nselected (Massive, rank #${accepted.indexOf(pick) + 1}): ${picked.ticker}  strike ${picked.strike_price}  expiry ${picked.expiration_date}`);
  console.log(`  bid=${pick.contract.last_quote?.bid}  ask=${pick.contract.last_quote?.ask}  mid=${pick.mid.toFixed(2)}  spread%=${(pick.quality.spreadPctOfMid * 100).toFixed(1)}%`);
  console.log(`  volume=${pick.volume ?? 'n/a'}  openInterest=${pick.openInterest ?? 'n/a'}  hasRealVolume=${pick.hasRealVolume}  delta=${pick.contract.greeks?.delta ?? 'n/a'}`);
  if (!pick.hasRealVolume) {
    console.log('  NOTE: no real session volume on this contract either — reporting this, not hiding it.');
  }
  console.log(`Webull match: ${contract.symbol}  strike ${contract.strike_price}  expiry ${contract.expiration_date}  id ${contract.instrument_id}`);

  const quote = await call({
    uri: '/openapi/market-data/option/snapshot', version: 'v2',
    query: { symbols: contract.symbol, category: 'US_OPTION' },
  });
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

  // Marketable BUY limit: priced at the ask, so it should fill immediately if
  // the sandbox models a real book. Where it actually fills is the answer.
  const limitPrice = ask.toFixed(2);
  const clientOrderId = crypto.randomUUID().replace(/-/g, '');
  const newOrders = [{
    client_order_id: clientOrderId,
    combo_type: 'NORMAL',
    order_type: 'LIMIT',
    quantity: '1',
    limit_price: limitPrice,
    option_strategy: 'SINGLE',
    side: 'BUY',
    time_in_force: 'DAY',
    entrust_type: 'QTY',
    orders: [{
      side: 'BUY',
      quantity: '1',
      symbol: contract.root_symbol,
      strike_price: String(contract.strike_price),
      init_exp_date: contract.expiration_date,
      instrument_type: 'OPTION',
      option_type: right,
      market: 'US',
    }],
  }];
  const orderBody = { new_orders: newOrders, account_id: acct.account_id };
  const extraHeaders = { category: 'US_OPTION' };

  console.log('\n--- order body ---');
  console.log(JSON.stringify(orderBody, null, 2));

  // ── PREVIEW first, always — no side effects, verifies the exact shape ─────
  const preview = await call({
    uri: '/openapi/trade/option/order/preview', method: 'POST', version: 'v2',
    body: orderBody, extraHeaders,
  });
  console.log('\n--- preview (no side effects) ---');
  console.log('HTTP', preview.status, JSON.stringify(preview.body));
  if (preview.status !== 200) {
    console.error('\nPreview rejected the order — nothing was submitted. Fix the body above first.');
    process.exit(1);
  }

  if (DRY) { console.log('\nDRY RUN — preview succeeded, stopping before real submission.'); return; }

  // Re-verify endpoint AND account immediately before the real submission.
  assertSafeToSubmit({ baseUrl: sandboxBaseUrl(), accountId: acct.account_id, sessionAccountIds: ids });

  const placed = await call({
    uri: '/openapi/trade/option/order/place', method: 'POST', version: 'v2',
    body: orderBody, extraHeaders,
  });
  console.log('\n--- submit ---');
  console.log('HTTP', placed.status, JSON.stringify(placed.body));
  if (placed.status !== 200) { console.error('Order was not accepted — stopping.'); process.exit(1); }

  for (let i = 0; i < 20; i++) {
    await sleep(1500);
    const det = await call({
      uri: '/openapi/trade/order/detail', version: 'v2',
      query: { account_id: acct.account_id, client_order_id: clientOrderId },
    });
    // Real verified shape: status is nested at body.orders[0].status, not a
    // top-level array or a flat order_status field. Fall back to the flatter
    // shapes only if `orders` is absent, rather than assuming either one.
    const o = Array.isArray(det.body?.orders) ? det.body.orders[0]
            : Array.isArray(det.body) ? det.body[0]
            : det.body;
    const status = o?.status ?? o?.order_status;
    console.log(`poll ${i + 1}: status=${status} filled=${o?.filled_quantity ?? '?'} avg=${o?.avg_filled_price ?? o?.avg_fill_price ?? '?'}`);
    if (status && /FILLED|CANCEL|REJECT|FAILED/i.test(String(status))) {
      const avg = Number(o?.avg_filled_price ?? o?.avg_fill_price ?? NaN);
      console.log('\n=== RESULT ===');
      console.log(`submitted limit : ${limitPrice} (at ask)`);
      console.log(`filled at       : ${avg}`);
      console.log(`bid/ask/last    : ${bid} / ${ask} / ${last}`);
      if (Number.isFinite(avg)) {
        if (Math.abs(avg - ask) < 1e-6) console.log('-> filled AT THE ASK — consistent with a real marketable buy.');
        else if (Math.abs(avg - (bid + ask) / 2) < 1e-6) console.log('-> filled AT THE MID — simulator, NOT realistic. This is the outcome that invalidates the premise.');
        else if (Math.abs(avg - last) < 1e-6) console.log('-> filled AT LAST PRICE — matches consumer paperTrade rules, not a real book.');
        else console.log('-> filled elsewhere; record and compare against the spread.');
      }
      break;
    }
  }
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
