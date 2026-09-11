/**
 * serverDelta — the per-minute delta series (classified buy − sell volume),
 * read from the relay engine: GET {RELAY}/engine/delta?ticker=SPY.
 *
 * Computed only in the engine, which holds the trade stream from the session
 * open (see relay/engine/stores/cvdStore.ts getDeltaBars). It replaces the
 * chart's CVD "projection" — a straight ramp from 0 to the current call/put
 * skew drawn across every bar, which read as order-flow history and wasn't.
 *
 * Result<T> throughout: a relay without the engine (503), an old relay
 * without the endpoint, and a network failure are all errors with reasons —
 * never an empty series that looks like "no flow".
 */

import { RELAY_REST_URL } from '../config';
import { ready, error, type Result } from '../stores/types';

export interface DeltaBar {
  /** Minute start, CT pseudo-epoch ms. */
  tCT:      number;
  buy:      number;
  sell:     number;
  delta:    number;
  cumDelta: number;
}

export interface DeltaSeries {
  bars:     DeltaBar[];
  /** UTC ms the engine booted: minutes before it were rebuilt (uptick rule), after it classified live. */
  bootedAt: number | null;
}

export async function fetchDeltaSeries(ticker: string): Promise<Result<DeltaSeries>> {
  try {
    const r = await fetch(`${RELAY_REST_URL}/engine/delta?ticker=${encodeURIComponent(ticker)}`, { cache: 'no-store' });
    if (r.status === 503) return error('relay engine not running');
    if (!r.ok) return error(`delta series unavailable (HTTP ${r.status})`);
    const body = await r.json() as { bars?: DeltaBar[]; bootedAt?: number | null };
    return ready({ bars: body.bars ?? [], bootedAt: body.bootedAt ?? null }, Date.now());
  } catch (e) {
    return error(`delta series unavailable (${e instanceof Error ? e.message : String(e)})`);
  }
}

/**
 * Roll minute delta bars into display buckets: per bucket, the summed delta
 * and the session's running total as of the bucket's last minute. A bucket
 * with no classified minute emits nothing — absent, never zero.
 */
export function bucketDelta(bars: readonly DeltaBar[], bucketMs: number): { tCT: number; delta: number; cumDelta: number }[] {
  const out: { tCT: number; delta: number; cumDelta: number }[] = [];
  for (const b of bars) {
    const start = Math.floor(b.tCT / bucketMs) * bucketMs;
    const last = out[out.length - 1];
    if (last && last.tCT === start) {
      last.delta += b.delta;
      last.cumDelta = b.cumDelta;
    } else {
      out.push({ tCT: start, delta: b.delta, cumDelta: b.cumDelta });
    }
  }
  return out;
}
