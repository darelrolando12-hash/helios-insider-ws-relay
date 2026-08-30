/**
 * Webull endpoint resolution — sandbox only, by construction.
 *
 * This module is the ONLY place in the engine permitted to produce a Webull
 * base URL. Everything that talks to Webull must obtain its host from
 * `sandboxBaseUrl()`; nothing may build one from a string of its own.
 *
 * ── Why this exists ────────────────────────────────────────────────────────
 *
 * Webull's OpenAPI has no paper/live parameter on place_order. The documented
 * parameters are combo_type, client_order_id, symbol, instrument_type, market,
 * order_type, limit_price, quantity, support_trading_session, side,
 * time_in_force and entrust_type — and none of them selects a trading mode.
 * (https://developer.webull.com/apis/docs/trade-api/getting-started/)
 *
 * Mode is decided ENTIRELY by which hostname the client was constructed
 * against:
 *
 *   api.sandbox.webull.com  → PaperTrade account, simulated money
 *   api.webull.com          → the real brokerage account, REAL MONEY
 *
 * A real, Trading-enabled application also exists on the same Webull account.
 * Its credentials are deliberately NOT in this environment, but they exist, so
 * the hostname is the single thing standing between a paper order and a real
 * one. That makes it worth more than a convention.
 *
 * ── Why a refusal rather than a config value ───────────────────────────────
 *
 * Same principle already applied to ENGINE_MODE: an unrepresentable state
 * cannot be reached by accident. There is no configuration, environment
 * variable, or argument that makes this module emit the production host. The
 * production hostname appears here exactly once, as a value to REFUSE — never
 * as a value to return.
 *
 * If live execution is ever built, it must be a deliberate, reviewed change to
 * this file, not an env var someone can set at 2am.
 */

/** The only host this engine may talk to. */
const SANDBOX_HOST = 'api.sandbox.webull.com';

/** Sandbox gRPC event-push host, for order/fill notifications. */
const SANDBOX_EVENTS_HOST = 'events-api.sandbox.webull.com';

/**
 * Hosts that must never be reached from this codebase.
 * Listed to be rejected, not to be selected.
 */
const FORBIDDEN_HOSTS = [
  'api.webull.com',
  'api.webull.hk',
  'events-api.webull.com',
  'trade-api.webull.com',
];

export class ProductionEndpointRefused extends Error {
  constructor(attempted: string) {
    super(
      `[webullEndpoint] REFUSED: "${attempted}" is a Webull PRODUCTION host. ` +
      `This engine has no live-execution path. Orders may only be submitted to ` +
      `${SANDBOX_HOST} (PaperTrade). If live execution is genuinely intended, it ` +
      `requires a deliberate change to relay/engine/execution/webullEndpoint.ts, ` +
      `not a configuration change.`
    );
    this.name = 'ProductionEndpointRefused';
  }
}

/** The sandbox trading-API base URL. The only host any client may be built on. */
export function sandboxBaseUrl(): string {
  return `https://${SANDBOX_HOST}`;
}

/** The sandbox event-push host, for order status and fills. */
export function sandboxEventsHost(): string {
  return SANDBOX_EVENTS_HOST;
}

/**
 * Assert a URL or hostname is the sandbox, throwing otherwise.
 *
 * Call this immediately before EVERY order submission — not once at client
 * construction. A cached "we checked at startup" answer does not survive a
 * refactor that swaps the endpoint while leaving everything else looking
 * normal, and that is the realistic failure mode.
 *
 * Deliberately fails closed on anything it cannot parse: an unparseable host
 * is not a known-safe host.
 */
export function assertSandboxHost(urlOrHost: string): void {
  if (typeof urlOrHost !== 'string' || urlOrHost.trim() === '') {
    throw new ProductionEndpointRefused('(empty or non-string endpoint)');
  }

  let host: string;
  try {
    host = urlOrHost.includes('://')
      ? new URL(urlOrHost).hostname
      : urlOrHost.split('/')[0].split(':')[0];
  } catch {
    throw new ProductionEndpointRefused(urlOrHost);
  }

  host = host.trim().toLowerCase();

  if (FORBIDDEN_HOSTS.includes(host)) throw new ProductionEndpointRefused(host);

  // Allowlist, not merely "not on the denylist" — an unrecognised Webull host
  // (a new region, a typo that happens to resolve) is refused too.
  if (host !== SANDBOX_HOST && host !== SANDBOX_EVENTS_HOST) {
    throw new ProductionEndpointRefused(host);
  }
}

/**
 * Guard for the moment of submission.
 *
 * Checks the endpoint AND that the account being traded is the one this
 * sandbox session actually returned — so an order cannot be aimed at an
 * account id carried over from somewhere else.
 */
export function assertSafeToSubmit(args: {
  baseUrl: string;
  accountId: string;
  sessionAccountIds: readonly string[];
}): void {
  assertSandboxHost(args.baseUrl);

  if (!args.accountId || !args.sessionAccountIds.includes(args.accountId)) {
    throw new ProductionEndpointRefused(
      `account "${args.accountId}" is not among the accounts returned by this ` +
      `sandbox session (${args.sessionAccountIds.join(', ') || 'none'})`
    );
  }
}
