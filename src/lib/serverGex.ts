/**
 * serverGex — the gamma flip level, read from the relay engine instead of
 * computed in the browser.
 *
 * The flip needs the WHOLE option chain (SPY: 12,966 contracts, 52 pages),
 * and it is the same number for every viewer. Computing it here meant each
 * open browser fetched every chain on the watchlist — ~700 REST requests an
 * hour per browser, the request-load failure class behind Track B. So it is
 * computed once, in the relay engine (engine/index.ts gexSnapshot), and
 * every browser makes ONE request a minute for all tickers:
 *
 *   GET {RELAY}/engine/gex  →  { generatedAt, tickers: [{ ticker, flipLevel,
 *                                flipAbsentReason, gexRegime, asOf }] }
 *
 * Every failure mode is an explicit absent reason, never a number:
 *   - relay unreachable / HTTP error      "server flip unavailable (…)"
 *   - 503 — engine not running            "relay engine not running"
 *   - ticker missing from the snapshot    "no server flip for this ticker yet"
 *   - snapshot row older than STALE_MS    "server flip is N min old"
 *   - the engine's own absent             its reason, passed through
 */

import { RELAY_REST_URL } from '../config';
import type { ExternalFlip } from '../engines/gexEngine';

const POLL_MS  = 60_000;
/** The engine recomputes on every 30-second chain poll; 10 minutes old means it has stopped. */
const STALE_MS = 10 * 60_000;

interface Row { ticker: string; flipLevel: number | null; flipAbsentReason: string | null; asOf: number }

let _rows = new Map<string, Row>();
let _failure: string | null = 'server flip not fetched yet';
let _timer: ReturnType<typeof setInterval> | null = null;

async function _poll(): Promise<void> {
  try {
    const r = await fetch(`${RELAY_REST_URL}/engine/gex`, { cache: 'no-store' });
    if (r.status === 503) { _failure = 'relay engine not running'; return; }
    if (!r.ok) { _failure = `server flip unavailable (HTTP ${r.status})`; return; }
    const body = await r.json() as { tickers?: Row[] };
    _rows = new Map((body.tickers ?? []).map((row) => [row.ticker, row]));
    _failure = null;
  } catch (e) {
    _failure = `server flip unavailable (${e instanceof Error ? e.message : String(e)})`;
  }
}

/** Start polling. Idempotent. */
export function startServerGex(): void {
  if (_timer) return;
  void _poll();
  _timer = setInterval(() => { void _poll(); }, POLL_MS);
}

/** The flip for `ticker` as the relay engine computed it — or why there is none. */
export function getServerFlip(ticker: string, nowMs: number = Date.now()): ExternalFlip {
  if (_failure) return { level: null, reason: _failure };
  const row = _rows.get(ticker);
  if (!row) return { level: null, reason: 'no server flip for this ticker yet' };
  const ageMs = nowMs - row.asOf;
  if (ageMs > STALE_MS) return { level: null, reason: `server flip is ${Math.round(ageMs / 60_000)} min old` };
  return row.flipLevel === null
    ? { level: null, reason: row.flipAbsentReason ?? 'absent on the server' }
    : { level: row.flipLevel, reason: null };
}

/** Test hook: replace the snapshot and failure state directly. */
export function __setServerGexForTest(rows: Row[], failure: string | null = null): void {
  _rows = new Map(rows.map((r) => [r.ticker, r]));
  _failure = failure;
}
