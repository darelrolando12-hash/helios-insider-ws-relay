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
 * Verified against the live sandbox before this file was updated:
 *   /openapi/assets/balance                 -> 200, real balance
 *   /openapi/instrument/option/contracts    -> 200, real contracts
 *   /openapi/trade/option/order/preview     -> 200, {"estimated_cost":"50",...}
 * The preview call exercised the exact order body and category-header logic
 * used below, with zero side effects, before this file ever submits for real.
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
 * ── Safety ────────────────────────────────────────────────────────────────
 * Every request routes through ../webullEndpoint.ts, so the production host is
 * unreachable: assertSandboxHost() runs on the base URL and again on the final
 * URL, and assertSafeToSubmit() re-checks the endpoint plus the account id
 * immediately before the order goes out. It also refuses to run unless
 * --i-understand-this-places-an-order is passed.
 *
 * ── Usage ─────────────────────────────────────────────────────────────────
 *   WEBULL_SANDBOX_APP_KEY=...  WEBULL_SANDBOX_APP_SECRET=... \
 *   node fillTest.mjs --symbol SPY --right CALL --i-understand-this-places-an-order
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

// ── Test ────────────────────────────────────────────────────────────────────
(async () => {
  const symbol = args.symbol ?? 'SPY';
  const right = (args.right ?? 'CALL').toUpperCase();
  // --expiry/--strike were previously parsed into `args` but never consulted
  // by the contract-selection logic below — silently ignored, not honored.
  const wantExpiry = typeof args.expiry === 'string' ? args.expiry : null;
  const wantStrike = args.strike != null && args.strike !== true ? Number(args.strike) : null;
  const minStrikeDays = 14;   // only applied when no explicit --expiry is given

  console.log(`endpoint: ${sandboxBaseUrl()}  (PaperTrade — production host is unreachable from this file)`);

  const accounts = await call({ uri: '/openapi/account/list' });
  if (accounts.status !== 200 || !Array.isArray(accounts.body)) {
    console.error('account/list failed:', accounts.status, accounts.body); process.exit(1);
  }
  const ids = accounts.body.map((a) => a.account_id);
  const acct = accounts.body.find((a) => a.account_class === 'INDIVIDUAL_MARGIN')
            ?? accounts.body.find((a) => a.account_class === 'INDIVIDUAL_CASH');
  console.log(`account : ${acct.account_label} (${acct.account_id})`);

  // ── Resolve a real, STANDARD (non-FLEX), near-dated contract ──────────────
  // The contract list mixes ordinary listed options with synthetic multi-year
  // FLEX contracts (def_type: "FLEX", symbol prefixed e.g. "2SPY..."). A FLEX
  // pick fails order preview/place with OPENAPI_PARAM_ERR — confirmed live.
  // The un-scoped 250-row page is an unstable sample, not a complete listing
  // — confirmed live: the same query returned different expiry subsets on
  // different calls. Passing expire_date server-side when known avoids
  // relying on client-side filtering over whatever page happened to come back.
  const instQuery = { category: 'US_OPTION', underlying_symbols: symbol, option_type: right, status: 'LISTING', page_size: '250' };
  if (wantExpiry) instQuery.expire_date = wantExpiry;
  const inst = await call({ uri: '/openapi/instrument/option/contracts', version: 'v2', query: instQuery });
  console.log('\n--- instrument lookup ---');
  console.log('HTTP', inst.status, ' contracts:', Array.isArray(inst.body) ? inst.body.length : inst.body);

  const now = Date.now();
  let candidates = Array.isArray(inst.body) ? inst.body.filter((c) => c.def_type !== 'FLEX') : [];
  if (wantExpiry) candidates = candidates.filter((c) => c.expiration_date === wantExpiry);
  if (wantStrike != null) candidates = candidates.filter((c) => Number(c.strike_price) === wantStrike);
  // The minStrikeDays floor only makes sense as a default when the caller
  // didn't name an exact expiry — an explicit --expiry is the caller's
  // decision to make, not something this script should second-guess.
  if (!wantExpiry) candidates = candidates.filter((c) => (new Date(c.expiration_date) - now) / 86_400_000 >= minStrikeDays);
  const contract = candidates.sort((a, b) => new Date(a.expiration_date) - new Date(b.expiration_date))[0] ?? null;
  if (!contract) {
    console.error('\nCould not resolve a standard contract matching the given --symbol/--right' +
      (wantExpiry ? `/--expiry ${wantExpiry}` : '') + (wantStrike != null ? `/--strike ${wantStrike}` : '') + '.');
    console.error('Nothing was submitted. Available (non-FLEX) contracts:');
    console.error(JSON.stringify(
      (Array.isArray(inst.body) ? inst.body : []).filter((c) => c.def_type !== 'FLEX')
        .map((c) => ({ strike: c.strike_price, expiry: c.expiration_date })).slice(0, 40)
    ));
    process.exit(1);
  }
  console.log(`using contract: ${contract.symbol}  strike ${contract.strike_price}  expiry ${contract.expiration_date}  id ${contract.instrument_id}`);

  const quote = await call({
    uri: '/openapi/market-data/option/snapshot', version: 'v2',
    query: { symbols: contract.symbol, category: 'US_OPTION' },
  });
  console.log('\n--- pre-order quote ---');
  console.log(JSON.stringify(quote.body, null, 2).slice(0, 1200));

  const q = Array.isArray(quote.body) ? quote.body[0] : quote.body;
  const bid = Number(q?.bid ?? q?.bid_price ?? q?.bidPrice ?? NaN);
  const ask = Number(q?.ask ?? q?.ask_price ?? q?.askPrice ?? NaN);
  const last = Number(q?.last ?? q?.close ?? q?.latest_price ?? NaN);
  if (!Number.isFinite(bid) || !Number.isFinite(ask)) {
    console.error('\nNo usable bid/ask in the snapshot response — cannot pick a marketable price.');
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
