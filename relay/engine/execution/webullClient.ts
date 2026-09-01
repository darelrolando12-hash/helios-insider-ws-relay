/**
 * Webull OpenAPI client — the one place this engine signs and calls Webull.
 *
 * Extracted from fillTest.mjs (2026-08-31 through 2026-09-01), where this
 * signing logic and these endpoint calls were built and verified live against
 * the real sandbox one call at a time. Factored out now that a second real
 * caller (paperExecution.ts) needs the same calls — same "one REST module"
 * discipline this project already applies to Massive (see lib/massive/api.ts),
 * applied here to Webull.
 *
 * Every request routes through sandboxBaseUrl()/assertSandboxHost() from
 * webullEndpoint.ts, so the production host stays structurally unreachable
 * regardless of what calls this module.
 *
 * ── Source correction (2026-08-31) ───────────────────────────────────────
 * Paths and body shapes were rebuilt from webull-inc/webull-openapi-python-sdk
 * (the CURRENT, maintained repo) — the original openapi-python-sdk carries an
 * explicit deprecation notice pointing at this one.
 *
 * NOTE: the current repo's signature composer contains a line that
 * unconditionally overrides the signer to SHA-256, ignoring whatever was
 * passed in. Every live call made during this investigation used HMAC-SHA1
 * and returned real 200s against the sandbox, so that source line is not
 * trusted here — the wire wins over docs, and here, over source that
 * contradicts a working live call. If Webull ever enforces that override,
 * every call in this module starts failing signature verification, and the
 * fix is to switch the algorithm/header to SHA-256.
 *
 * Real field names, confirmed live (not from docs):
 *   assets/balance         -> total_net_liquidation_value, day_trades_left
 *   trade/order/detail     -> body.orders[0].status, .filled_price (NOT
 *                              avg_filled_price/avg_fill_price — those names
 *                              were never confirmed and silently read
 *                              undefined on every fill before 2026-09-01)
 */
import crypto from 'crypto';
import { sandboxBaseUrl, assertSandboxHost, assertSafeToSubmit } from './webullEndpoint.ts';

export interface WebullCredentials {
  appKey: string;
  appSecret: string;
}

/** Reads WEBULL_SANDBOX_APP_KEY/SECRET from process.env. Throws if either is missing. */
export function webullCredentialsFromEnv(): WebullCredentials {
  const appKey = process.env.WEBULL_SANDBOX_APP_KEY;
  const appSecret = process.env.WEBULL_SANDBOX_APP_SECRET;
  if (!appKey || !appSecret) {
    throw new Error('Missing WEBULL_SANDBOX_APP_KEY / WEBULL_SANDBOX_APP_SECRET in the environment.');
  }
  return { appKey, appSecret };
}

interface CallArgs {
  uri: string;
  method?: 'GET' | 'POST';
  version?: string;
  query?: Record<string, string> | null;
  body?: unknown;
  extraHeaders?: Record<string, string> | null;
}

interface CallResult<T = unknown> {
  status: number;
  body: T;
  url: string;
}

const enc = (s: string): string =>
  Array.from(Buffer.from(s, 'utf8'))
    .map((b) => {
      const c = String.fromCharCode(b);
      return /[A-Za-z0-9\-._~]/.test(c) ? c : '%' + b.toString(16).toUpperCase().padStart(2, '0');
    })
    .join('');

export class WebullClient {
  private readonly _creds: WebullCredentials;

  constructor(creds: WebullCredentials) {
    this._creds = creds;
  }

  private async _call<T = unknown>({
    uri, method = 'GET', version = 'v2', query = null, body = null, extraHeaders = null,
  }: CallArgs): Promise<CallResult<T>> {
    const base = sandboxBaseUrl();
    assertSandboxHost(base);
    const host = new URL(base).hostname;

    const sh: Record<string, string> = {
      'x-app-key': this._creds.appKey,
      'x-timestamp': new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
      'x-signature-version': '1.0',
      'x-signature-algorithm': 'HMAC-SHA1',
      'x-signature-nonce': crypto.randomUUID(),
    };
    const p: Record<string, string> = {};
    for (const [k, v] of Object.entries(sh)) p[k.toLowerCase()] = v;
    p['host'] = host;
    if (query) for (const [k, v] of Object.entries(query)) p[k] = p[k] != null ? `${p[k]}&${v}` : String(v);

    let sts = uri + '&' + Object.keys(p).sort().map((k) => `${k}=${p[k]}`).join('&');
    if (body) sts += '&' + crypto.createHash('md5').update(JSON.stringify(body), 'utf8').digest('hex').toUpperCase();

    const signature = crypto.createHmac('sha1', Buffer.from(this._creds.appSecret + '&', 'utf8'))
      .update(Buffer.from(enc(sts), 'utf8')).digest('base64');

    const url = base + uri + (query ? '?' + new URLSearchParams(query).toString() : '');
    assertSandboxHost(url);

    const res = await fetch(url, {
      method,
      headers: {
        ...sh, 'x-version': version, 'x-signature': signature,
        'Content-Type': 'application/json;charset=UTF-8',
        ...(extraHeaders || {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const t = await res.text();
    let b: T;
    try { b = JSON.parse(t) as T; } catch { b = t as unknown as T; }
    return { status: res.status, body: b, url };
  }

  async listAccounts(): Promise<CallResult<{ account_id: string; account_class: string; account_label: string }[]>> {
    return this._call({ uri: '/openapi/account/list' });
  }

  async getBalance(accountId: string): Promise<CallResult<Record<string, unknown>>> {
    return this._call({ uri: '/openapi/assets/balance', query: { account_id: accountId } });
  }

  async getPositions(accountId: string): Promise<CallResult<Record<string, unknown>[]>> {
    return this._call({ uri: '/openapi/assets/positions', query: { account_id: accountId } });
  }

  async instrumentOptionContracts(query: Record<string, string>): Promise<CallResult<Record<string, unknown>[]>> {
    return this._call({ uri: '/openapi/instrument/option/contracts', version: 'v2', query });
  }

  async optionSnapshot(symbols: string): Promise<CallResult<Record<string, unknown> | Record<string, unknown>[]>> {
    return this._call({
      uri: '/openapi/market-data/option/snapshot', version: 'v2',
      query: { symbols, category: 'US_OPTION' },
    });
  }

  async previewOptionOrder(orderBody: unknown): Promise<CallResult<Record<string, unknown>>> {
    return this._call({
      uri: '/openapi/trade/option/order/preview', method: 'POST', version: 'v2',
      body: orderBody, extraHeaders: { category: 'US_OPTION' },
    });
  }

  async placeOptionOrder(orderBody: unknown): Promise<CallResult<Record<string, unknown>>> {
    return this._call({
      uri: '/openapi/trade/option/order/place', method: 'POST', version: 'v2',
      body: orderBody, extraHeaders: { category: 'US_OPTION' },
    });
  }

  async cancelOptionOrder(accountId: string, clientOrderId: string): Promise<CallResult<Record<string, unknown>>> {
    return this._call({
      uri: '/openapi/trade/option/order/cancel', method: 'POST', version: 'v2',
      body: { account_id: accountId, client_order_id: clientOrderId },
      extraHeaders: { category: 'US_OPTION' },
    });
  }

  async orderDetail(accountId: string, clientOrderId: string): Promise<CallResult<{
    orders?: Array<{
      status?: string;
      filled_quantity?: string;
      filled_price?: string;
      place_time?: string;
      filled_time?: string;
    }>;
  }>> {
    return this._call({
      uri: '/openapi/trade/order/detail', version: 'v2',
      query: { account_id: accountId, client_order_id: clientOrderId },
    });
  }

  /** Re-checked immediately before every real submission — see webullEndpoint.ts. */
  assertSafeToSubmit(accountId: string, sessionAccountIds: readonly string[]): void {
    assertSafeToSubmit({ baseUrl: sandboxBaseUrl(), accountId, sessionAccountIds });
  }
}

/** Real balance field is total_net_liquidation_value — confirmed live 2026-09-01. */
export function equityFromBalance(balance: Record<string, unknown>): number {
  return Number(
    (balance as { total_net_liquidation_value?: unknown }).total_net_liquidation_value
    ?? (balance as { net_liq?: unknown }).net_liq
    ?? (balance as { total_equity?: unknown }).total_equity
    ?? NaN
  );
}

/** Real day P&L field, for evaluateDailyLimits. Absent value is NaN, never 0. */
export function dayPnlFromBalance(balance: Record<string, unknown>): number {
  return Number((balance as { total_day_profit_loss?: unknown }).total_day_profit_loss ?? NaN);
}
