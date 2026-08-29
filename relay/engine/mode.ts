/**
 * ENGINE_MODE — three states.
 *
 *   unset / 'off'  the engine does not start at all. The relay behaves
 *                  exactly as it does today: upstream sockets, REST proxy,
 *                  browser fan-out, nothing else.
 *   'shadow'       the engine runs fully and computes everything, but every
 *                  database write is intercepted and logged instead of
 *                  executed.
 *   'live'         the engine runs and owns writes for real.
 *
 * The point of `off` being the default is deployability: this branch can be
 * merged and shipped with the engine dormant, and turning it on later is a
 * Railway environment-variable change rather than a code deploy — instantly
 * revertible by unsetting the variable. Enabling an engine should not require
 * shipping code, and disabling one in a hurry definitely should not.
 *
 * The safe direction on ambiguity is always "do less": an unset value runs
 * nothing, and an unrecognised value falls back to shadow (runs, writes
 * nothing) rather than to live.
 *
 * Write enforcement happens at ONE place: the Supabase client (see
 * wrapForEngineMode below, used by lib/supabase.ts). Not at the ~15 individual
 * write call sites — gating call sites would mean ~15 chances to miss one, and
 * a single missed site writes to production during shadow mode.
 */

export type EngineMode = 'off' | 'shadow' | 'live';

// Read ONCE at module load. Not per-call, not scattered.
const _rawMode = (process.env.ENGINE_MODE ?? '').trim().toLowerCase();

/**
 * Pure parse of an ENGINE_MODE string. Exported so the resolution rules can be
 * tested directly rather than through module-cache manipulation.
 */
export function parseEngineMode(raw: string): EngineMode {
  return _parseMode((raw ?? '').trim().toLowerCase());
}

function _parseMode(raw: string): EngineMode {
  if (raw === '' || raw === 'off' || raw === 'none') return 'off';
  if (raw === 'live')   return 'live';
  if (raw === 'shadow') return 'shadow';
  // Unrecognised, non-empty: fall back to shadow, never to live or off.
  // Shadow is the informative failure — it runs and logs what it would do,
  // so the misconfiguration is visible rather than presenting as a dead engine.
  return 'shadow';
}

export const ENGINE_MODE: EngineMode = _parseMode(_rawMode);

/** True when the engine should boot at all. */
export const IS_ENABLED = ENGINE_MODE !== 'off';

/** True when writes must be intercepted rather than executed. */
export const IS_SHADOW = ENGINE_MODE === 'shadow';

/**
 * Whether ENGINE_MODE held a value we did not recognise.
 *
 * An empty value is a normal unset ('off'). A non-empty value that is none of
 * off/none/shadow/live (a typo, say 'Live ' or 'production') is a
 * configuration mistake, and silently coercing it would hide that. Surfaced
 * in the boot banner.
 */
export const MODE_INPUT_UNRECOGNISED =
  _rawMode !== '' && !['off', 'none', 'shadow', 'live'].includes(_rawMode);

/** Supabase operations that write. Everything else passes through untouched. */
const MUTATING_OPS = ['insert', 'upsert', 'update', 'delete'] as const;

/**
 * Prints the active mode unmissably at boot.
 *
 * A shadow-mode process that silently believes it is live is the worst
 * available failure here, so this is loud and explicit in both directions.
 */
export function logModeBanner(): void {
  const line = '─'.repeat(68);
  console.log(line);
  if (ENGINE_MODE === 'off') {
    console.log(`  ENGINE_MODE = off — ENGINE NOT STARTED`);
    console.log(`  Relay-only: upstream sockets, REST proxy, browser fan-out.`);
    console.log(`  Set ENGINE_MODE=shadow in Railway to enable (no deploy needed).`);
  } else if (IS_SHADOW) {
    console.log(`  ENGINE_MODE = shadow — NO DATABASE WRITES WILL BE EXECUTED`);
    console.log(`  Mutations are intercepted and logged. Reads run normally.`);
  } else {
    console.log(`  ENGINE_MODE = live — DATABASE WRITES ARE ACTIVE`);
    console.log(`  Browser writes MUST be disabled or rows will be duplicated.`);
  }
  if (MODE_INPUT_UNRECOGNISED) {
    console.error(
      `  WARNING: ENGINE_MODE was set to "${process.env.ENGINE_MODE}", which is ` +
      `not a recognised value. Defaulted to shadow.`
    );
  }
  console.log(line);
}

// ── Shadow interception ──────────────────────────────────────────────────────

/**
 * Tables whose shadow log line must NOT be truncated.
 *
 * The 300-char sample below exists so a bars_1m upsert (hundreds of rows per
 * call, none of them individually interesting) doesn't flood the log. That
 * same truncation silently cuts off exactly the fields the shadow-mode diff
 * needs to compare: a `signals` row's `factors` blob (catalyst tags, luld
 * sub-object, gexRegime, vixBucket, tradeType) runs well past 300 characters
 * on its own. Add a table here only when something reads its shadow log
 * programmatically — it is not a general "important table" list.
 */
const UNTRUNCATED_TABLES = new Set(['signals']);

/**
 * Emits the complete row(s) as a single-line JSON object under a stable,
 * grep-able marker, so `railway logs --json` yields one parseable record per
 * write with nothing clipped. Used only for UNTRUNCATED_TABLES.
 */
function _logUntruncated(table: string, op: string, payload: unknown): void {
  const rows = Array.isArray(payload) ? payload : payload === undefined || payload === null ? [] : [payload];
  console.log(JSON.stringify({
    marker: 'shadow-signal',
    table,
    op,
    rowCount: rows.length,
    rows,
    loggedAt: new Date().toISOString(),
  }));
}

/**
 * Summarises what a write WOULD have done, without dumping whole payloads.
 * Row count plus one sampled row is enough to diff against browser output
 * while keeping the logs readable at ingestion volumes. NOT used for
 * UNTRUNCATED_TABLES — see _logUntruncated.
 */
function _describePayload(payload: unknown): string {
  if (payload === undefined || payload === null) return 'no payload';
  if (Array.isArray(payload)) {
    const sample = payload.length > 0 ? JSON.stringify(payload[0]) : '(empty)';
    const clipped = sample.length > 300 ? sample.slice(0, 300) + '…' : sample;
    return `${payload.length} row(s), first=${clipped}`;
  }
  const single = JSON.stringify(payload);
  return `1 row, ${single.length > 300 ? single.slice(0, 300) + '…' : single}`;
}

/**
 * A stand-in for a PostgrestFilterBuilder that never touches the network.
 *
 * Supabase query builders are thenable and chainable — call sites do things
 * like `.upsert(rows, opts)`, `.delete().lt('date', x)`, and
 * `await` the result, sometimes destructuring `{ error }` or `{ data, count }`.
 * This object answers all of those shapes: every unknown method returns itself
 * so chains keep working, and awaiting resolves to a success-shaped result so
 * no caller mistakes shadow mode for a write failure.
 */
function _shadowBuilder(table: string, op: string, payload: unknown): unknown {
  const result = { data: null, error: null, count: null, status: 200, statusText: 'OK (shadow)' };

  const target = {
    then: (resolve: (v: unknown) => unknown) => Promise.resolve(result).then(resolve),
    catch: () => target,
    finally: (fn: () => void) => { fn(); return target; },
  };

  return new Proxy(target, {
    get(obj, prop) {
      if (prop in obj) return (obj as Record<string | symbol, unknown>)[prop];
      // Any other builder method (.eq, .lt, .select, .single, …) — stay chainable.
      return () => _shadowBuilder(table, op, payload);
    },
  });
}

/**
 * Wraps a Supabase client so mutations are intercepted in shadow mode.
 *
 * In live mode the client is returned untouched — zero overhead, zero
 * behaviour change, so `live` is exactly today's semantics.
 */
export function wrapForEngineMode<T extends object>(client: T): T {
  // Pass through ONLY in live mode. Anything else — shadow, or off if some
  // module is imported without the engine booting — gets the interceptor.
  // Writes are opt-in, never opt-out.
  if (ENGINE_MODE === 'live') return client;

  return new Proxy(client, {
    get(target, prop, receiver) {
      if (prop !== 'from') return Reflect.get(target, prop, receiver);

      return (table: string) => {
        const realBuilder = (target as unknown as { from: (t: string) => object }).from(table);

        return new Proxy(realBuilder, {
          get(bTarget, bProp, bReceiver) {
            if (!MUTATING_OPS.includes(bProp as typeof MUTATING_OPS[number])) {
              return Reflect.get(bTarget, bProp, bReceiver);
            }
            return (payload: unknown, ...rest: unknown[]) => {
              if (UNTRUNCATED_TABLES.has(table)) {
                _logUntruncated(table, String(bProp), payload);
              } else {
                console.log(
                  `[shadow] WOULD ${String(bProp).toUpperCase()} ${table} — ` +
                  `${_describePayload(payload)}` +
                  (rest.length > 0 && rest[0] !== undefined ? ` opts=${JSON.stringify(rest[0])}` : '')
                );
              }
              return _shadowBuilder(table, String(bProp), payload);
            };
          },
        });
      };
    },
  }) as T;
}
