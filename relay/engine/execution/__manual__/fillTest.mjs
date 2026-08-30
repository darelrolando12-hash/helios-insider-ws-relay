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
 * ── Safety ────────────────────────────────────────────────────────────────
 * Every request routes through ../webullEndpoint.ts, so the production host is
 * unreachable: assertSandboxHost() runs on the base URL and again on the final
 * URL, and assertSafeToSubmit() re-checks the endpoint plus the account id
 * immediately before the order goes out. It also refuses to run unless
 * --i-understand-this-places-an-order is passed.
 *
 * ── Usage ─────────────────────────────────────────────────────────────────
 *   WEBULL_SANDBOX_APP_KEY=...  WEBULL_SANDBOX_APP_SECRET=... \
 *   node fillTest.mjs --symbol SPY --expiry 2026-09-19 --strike 650 --right CALL \
 *        --i-understand-this-places-an-order
 *
 * Add --dry-run to do everything EXCEPT submit: it resolves the contract,
 * prints the quote and the exact order body, and stops. Run that first.
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
  console.error('Refusing to run. Pass --dry-run to inspect, or');
  console.error('--i-understand-this-places-an-order to actually submit.');
  process.exit(1);
}

// ── Signing (from webull-inc/openapi-python-sdk) ────────────────────────────
const enc = (s) =>
  Array.from(Buffer.from(s, 'utf8'))
    .map((b) => {
      const c = String.fromCharCode(b);
      return /[A-Za-z0-9\-._~]/.test(c) ? c : '%' + b.toString(16).toUpperCase().padStart(2, '0');
    })
    .join('');

async function call({ uri, method = 'GET', version = 'v1', query = null, body = null }) {
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
    headers: { ...sh, 'x-version': version, 'x-signature': signature, 'Content-Type': 'application/json;charset=UTF-8' },
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
  const expiry = args.expiry;
  const strike = args.strike;
  const right = (args.right ?? 'CALL').toUpperCase();

  console.log(`endpoint: ${sandboxBaseUrl()}  (PaperTrade — production host is unreachable from this file)`);

  const accounts = await call({ uri: '/openapi/account/list' });
  if (accounts.status !== 200 || !Array.isArray(accounts.body)) {
    console.error('account/list failed:', accounts.status, accounts.body); process.exit(1);
  }
  const ids = accounts.body.map((a) => a.account_id);
  const acct = accounts.body.find((a) => a.account_class === 'INDIVIDUAL_MARGIN')
            ?? accounts.body.find((a) => a.account_class === 'INDIVIDUAL_CASH');
  console.log(`account : ${acct.account_label} (${acct.account_id})`);

  // Resolve the contract. Endpoint/params may need adjusting to the docs —
  // this is the part most likely to need a tweak on first run.
  const inst = await call({
    uri: '/openapi/instrument/list',
    query: { symbol, category: 'US_OPTION', ...(expiry ? { expire_date: expiry } : {}), ...(strike ? { strike_price: String(strike) } : {}) },
  });
  console.log('\n--- instrument lookup ---');
  console.log('HTTP', inst.status);
  console.log(JSON.stringify(inst.body, null, 2).slice(0, 1500));

  const contract = Array.isArray(inst.body)
    ? inst.body.find((c) => String(c.option_type ?? c.right ?? '').toUpperCase().startsWith(right[0]))
    : null;
  if (!contract) {
    console.error('\nCould not resolve a contract — adjust --symbol/--expiry/--strike, or the');
    console.error('instrument endpoint/params above, against the docs. Nothing was submitted.');
    process.exit(1);
  }

  const instrumentId = contract.instrument_id;
  const quote = await call({ uri: '/openapi/market-data/quotes', query: { instrument_id: instrumentId, category: 'US_OPTION' } });
  console.log('\n--- pre-order quote ---');
  console.log(JSON.stringify(quote.body, null, 2).slice(0, 1200));

  const q = Array.isArray(quote.body) ? quote.body[0] : quote.body;
  const bid = Number(q?.bid ?? q?.bid_price ?? NaN);
  const ask = Number(q?.ask ?? q?.ask_price ?? NaN);
  const last = Number(q?.last ?? q?.close ?? NaN);
  const spread = ask - bid;
  console.log(`\nbid=${bid}  ask=${ask}  last=${last}  spread=${spread.toFixed(4)} (${((spread / ask) * 100).toFixed(1)}% of ask)`);

  // Marketable BUY limit: priced at the ask, so it should fill immediately if
  // the sandbox models a real book. Where it actually fills is the answer.
  const limitPrice = ask.toFixed(2);
  const orderBody = {
    account_id: acct.account_id,
    client_order_id: crypto.randomUUID().replace(/-/g, ''),
    combo_type: 'NORMAL',
    order_type: 'LIMIT',
    instrument_id: instrumentId,
    side: 'BUY',
    quantity: '1',
    limit_price: limitPrice,
    time_in_force: 'DAY',
    entrust_type: 'QTY',
    support_trading_session: 'CORE',
  };

  console.log('\n--- order to submit ---');
  console.log(JSON.stringify(orderBody, null, 2));

  if (DRY) { console.log('\nDRY RUN — nothing submitted.'); return; }

  // Re-verify endpoint AND account immediately before submission.
  assertSafeToSubmit({ baseUrl: sandboxBaseUrl(), accountId: acct.account_id, sessionAccountIds: ids });

  const placed = await call({ uri: '/openapi/account/orders/place', method: 'POST', body: orderBody });
  console.log('\n--- submit ---');
  console.log('HTTP', placed.status, JSON.stringify(placed.body));

  for (let i = 0; i < 20; i++) {
    await sleep(1500);
    const det = await call({ uri: '/openapi/account/orders/detail', query: { account_id: acct.account_id, client_order_id: orderBody.client_order_id } });
    const o = Array.isArray(det.body) ? det.body[0] : det.body;
    const status = o?.order_status ?? o?.status;
    console.log(`poll ${i + 1}: status=${status} filled=${o?.filled_quantity ?? '?'} avg=${o?.avg_filled_price ?? '?'}`);
    if (status && /FILLED|CANCEL|REJECT/i.test(String(status))) {
      const avg = Number(o?.avg_filled_price ?? NaN);
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
