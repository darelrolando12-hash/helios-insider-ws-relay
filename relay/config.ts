/**
 * Server-side endpoint + credential configuration for the engine.
 *
 * This replaces the browser's `src/config.ts`, which exported RELAY_WS_URL /
 * RELAY_REST_URL pointing at `relay.helios-insiders.com`. Those values are
 * correct for a browser talking TO the relay. They are wrong here: this code
 * runs INSIDE the relay.
 *
 *   - There is no RELAY_WS_URL equivalent. The engine subscribes to the
 *     relay's broadcast() in-process (see engine/bus.ts). No socket, no hop.
 *   - REST goes DIRECT to api.massive.com. Routing through the relay's own
 *     /rest/ proxy would be a loopback to itself.
 *
 * Secrets come from process.env and are never hardcoded here.
 */

// ── Massive REST ─────────────────────────────────────────────────────────────

/**
 * Direct Massive REST origin. NOT the relay's /rest/ proxy.
 *
 * MassiveRestClient's constructor takes a baseUrl; this is what gets passed.
 * Its internal default (`${RELAY_REST_URL}/rest`) is browser-shaped and must
 * never be used server-side — see engine/index.ts for the explicit wiring.
 */
export const MASSIVE_REST_BASE_URL = 'https://api.massive.com';

/** Massive API key. Required for every REST call the engine makes. */
export const MASSIVE_API_KEY = process.env.MASSIVE_API_KEY ?? '';

// ── Supabase ─────────────────────────────────────────────────────────────────

/**
 * Supabase project URL and anon key.
 *
 * This is the ANON key, deliberately and permanently. The Supabase instance is
 * Wegic-managed (hosted at cloud.wegic.net, not supabase.co) — there is no
 * account we control and therefore no service-role key available.
 *
 * That is safe: the browser already performs every read and write the engine
 * needs using this same key, so the RLS policies already permit exactly these
 * operations. Supabase cannot distinguish a browser from a Node process.
 *
 * The known risk: if an RLS policy ever blocks a write, it fails silently.
 * That risk exists today with the browser, so this adds nothing new — but any
 * unexpected empty result must be treated as suspect, never as a genuine zero.
 */
export const SUPABASE_URL      = process.env.SUPABASE_URL ?? '';
export const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY ?? '';

// ── Fail-fast validation ─────────────────────────────────────────────────────

/**
 * Throws unless every credential the engine needs is present and non-empty.
 *
 * Called explicitly at boot, before any client is constructed. This exists
 * because the failure mode it prevents is invisible: createClient('', '')
 * succeeds, returns a usable-looking object, and every query against it fails
 * or returns nothing. Thirteen modules import that client. A missing env var
 * would surface as "no filings", "no signals", "no bars" — indistinguishable
 * from a quiet market.
 *
 * Collects ALL missing names before throwing so one boot reports every
 * problem, rather than revealing them one restart at a time.
 */
export function assertConfig(): void {
  const missing: string[] = [];

  if (!MASSIVE_API_KEY)    missing.push('MASSIVE_API_KEY');
  if (!SUPABASE_URL)       missing.push('SUPABASE_URL');
  if (!SUPABASE_ANON_KEY)  missing.push('SUPABASE_ANON_KEY');

  if (missing.length > 0) {
    throw new Error(
      `[config] Missing required environment variable(s): ${missing.join(', ')}. ` +
      `The engine cannot start without these — an empty credential produces a ` +
      `client that silently returns nothing rather than failing loudly.`
    );
  }
}
