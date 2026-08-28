/**
 * ENGINE_MODE — the shadow-mode gate.
 *
 * `shadow` (default): compute everything, log what WOULD be written, write
 *                     nothing. The browser still writes during migration;
 *                     running both live would guarantee duplicate rows.
 * `live`            : writes execute for real.
 *
 * The default is deliberately `shadow`. An unset or misspelled ENGINE_MODE
 * must never silently produce live writes — the safe failure direction is to
 * write nothing, not to write twice.
 *
 * Enforcement happens at ONE place: the Supabase client (see wrapForEngineMode
 * below, used by lib/supabase.ts). Not at the ~15 individual write call sites.
 * Gating call sites would mean ~15 chances to miss one, and a single missed
 * site writes to production during shadow mode.
 */

export type EngineMode = 'shadow' | 'live';

// Read ONCE at module load. Not per-call, not scattered.
const _rawMode = (process.env.ENGINE_MODE ?? '').trim().toLowerCase();

export const ENGINE_MODE: EngineMode = _rawMode === 'live' ? 'live' : 'shadow';

/** True when writes must be intercepted rather than executed. */
export const IS_SHADOW = ENGINE_MODE === 'shadow';

/**
 * Whether ENGINE_MODE held a value we did not recognise.
 *
 * An empty value is a normal unset. A non-empty value that is neither
 * 'shadow' nor 'live' (a typo, say 'Live ' or 'production') is a configuration
 * mistake, and silently coercing it to shadow would hide that. Surfaced in the
 * boot banner.
 */
export const MODE_INPUT_UNRECOGNISED =
  _rawMode !== '' && _rawMode !== 'live' && _rawMode !== 'shadow';

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
  if (IS_SHADOW) {
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
 * Summarises what a write WOULD have done, without dumping whole payloads.
 * Row count plus one sampled row is enough to diff against browser output
 * while keeping the logs readable at ingestion volumes.
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
  if (!IS_SHADOW) return client;

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
              console.log(
                `[shadow] WOULD ${String(bProp).toUpperCase()} ${table} — ` +
                `${_describePayload(payload)}` +
                (rest.length > 0 && rest[0] !== undefined ? ` opts=${JSON.stringify(rest[0])}` : '')
              );
              return _shadowBuilder(table, String(bProp), payload);
            };
          },
        });
      };
    },
  }) as T;
}
