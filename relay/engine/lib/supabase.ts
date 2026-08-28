/**
 * Supabase client — server-side.
 *
 * Previously read `import.meta.env.VITE_SUPABASE_URL` / `_ANON_KEY`, which are
 * Vite build-time substitutions. Under Node both are `undefined`, so this
 * module constructed `createClient('', '')` — an object that looks entirely
 * healthy and fails every query. Thirteen modules import this client; the
 * symptom would have been "no filings", "no signals", "no bars", identical to
 * a quiet market. That is the exact silent-zero shape this codebase keeps
 * getting bitten by, so it is now impossible rather than merely unlikely:
 * assertConfig() throws at boot if either value is missing.
 *
 * On the key: this is the ANON key, deliberately and permanently. The Supabase
 * instance is Wegic-managed (cloud.wegic.net, not supabase.co) — there is no
 * account we control, so no service-role key exists to use. That is safe: the
 * browser already performs every read and write the engine needs with this
 * same key, so RLS already permits exactly these operations, and Supabase
 * cannot distinguish a browser from a Node process.
 *
 * The residual risk: if an RLS policy ever blocks a write, it fails silently.
 * That risk is unchanged from the browser's — but any unexpected empty result
 * must be treated as suspect, never reported as a genuine zero.
 */

import { createClient } from '@supabase/supabase-js';
import { SUPABASE_URL, SUPABASE_ANON_KEY, assertConfig } from '../../config';
import { wrapForEngineMode } from '../mode';

// Fail loudly at import time rather than constructing an empty client.
assertConfig();

const _rawClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

/**
 * The client every engine module imports.
 *
 * In ENGINE_MODE=shadow this is a proxy that intercepts mutating operations
 * (insert/upsert/update/delete) and logs them instead of executing them.
 * Reads pass straight through — engines need real data to compute against.
 *
 * The gate lives here, at the single client, rather than at the ~15 individual
 * write call sites. Gating call sites would mean ~15 chances to miss one, and
 * one missed site writes to production during shadow mode — precisely the
 * duplicate-write scenario shadow mode exists to prevent.
 */
export const supabase = wrapForEngineMode(_rawClient);

export type { SupabaseClient } from '@supabase/supabase-js';
