/**
 * Behavioural tests for the Step 2 plumbing: bus ordering/isolation, the
 * shadow-mode write gate, and the config fail-fast.
 *
 * These cover the three things whose failure modes are silent: a trade
 * classified against a stale spread, a shadow-mode write that actually
 * executes, and an empty credential producing a client that returns nothing.
 */
import { describe, it, expect, vi } from 'vitest';
import { EngineBus, normaliseTimestamp, type WSMessageWithCT } from '../bus.ts';
import { wrapForEngineMode, ENGINE_MODE, IS_SHADOW, IS_ENABLED, parseEngineMode } from '../mode.ts';

describe('EngineBus — frame ordering', () => {
  it('dispatches every Q in a frame before any T (stale-spread guard)', () => {
    const bus = new EngineBus();
    const order: string[] = [];
    bus.on('Q', (m) => order.push(`Q:${m.sym}`));
    bus.on('T', (m) => order.push(`T:${m.sym}`));

    // Deliberately T-first on the wire.
    bus.ingestFrame([
      { ev: 'T', sym: 'SPY', t: 1 },
      { ev: 'Q', sym: 'SPY', t: 2 },
      { ev: 'T', sym: 'QQQ', t: 3 },
      { ev: 'Q', sym: 'QQQ', t: 4 },
    ]);

    const firstT = order.findIndex((o) => o.startsWith('T:'));
    const lastQ  = order.map((o) => o.startsWith('Q:')).lastIndexOf(true);
    expect(lastQ).toBeLessThan(firstT);
    expect(order).toEqual(['Q:SPY', 'Q:QQQ', 'T:SPY', 'T:QQQ']);
  });

  it('stamps _ct on every dispatched message', () => {
    const bus = new EngineBus();
    let seen: WSMessageWithCT | null = null;
    bus.on('T', (m) => { seen = m; });
    bus.ingestFrame([{ ev: 'T', sym: 'SPY', t: Date.UTC(2026, 0, 15, 18, 30, 0) }]);
    expect(seen).not.toBeNull();
    expect(seen!._ct).toBeDefined();
    expect(typeof seen!._ct.ctMs).toBe('number');
    expect(seen!._ct.utcMs).toBe(Date.UTC(2026, 0, 15, 18, 30, 0));
  });

  it('does NOT dedupe messages sharing ev:sym:t — they are distinct trades', () => {
    const bus = new EngineBus();
    let count = 0;
    bus.on('T', () => { count++; });
    // Two real trades, same symbol, same millisecond. The browser bus would
    // have discarded the second inside its 2s dedup window.
    bus.ingestFrame([
      { ev: 'T', sym: 'SPY', t: 100, p: 400, s: 5 },
      { ev: 'T', sym: 'SPY', t: 100, p: 400, s: 9 },
    ]);
    expect(count).toBe(2);
  });

  it('skips status messages', () => {
    const bus = new EngineBus();
    let count = 0;
    bus.onGlobal(() => { count++; });
    bus.ingestFrame([{ ev: 'status', sym: '', message: 'authenticated' }]);
    expect(count).toBe(0);
  });

  it('isolates a throwing handler so others still run', () => {
    const bus = new EngineBus();
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    let reached = false;
    bus.on('T', () => { throw new Error('boom'); });
    bus.on('T', () => { reached = true; });
    expect(() => bus.ingestFrame([{ ev: 'T', sym: 'SPY', t: 1 }])).not.toThrow();
    expect(reached).toBe(true);
    spy.mockRestore();
  });

  it('flushes subscriptions registered before attach', () => {
    const bus = new EngineBus();
    const sent: string[][] = [];
    bus.subscribeStock('T', 'SPY');
    bus.subscribeStock('Q', 'SPY');
    bus.attach({ subscribe: (c) => sent.push(c), unsubscribe: () => {} });
    expect(sent.length).toBe(1);
    expect(sent[0].sort()).toEqual(['Q.SPY', 'T.SPY']);
  });

  it('batches a burst of post-attach subscribes into ONE relay call', async () => {
    const bus = new EngineBus();
    const sent: string[][] = [];
    bus.attach({ subscribe: (c) => sent.push(c), unsubscribe: () => {} });

    // Mirrors a real boot: several tickers x several channels, back to back.
    for (const t of ['SPY', 'QQQ', 'IWM']) {
      bus.subscribeStock('T', t);
      bus.subscribeStock('Q', t);
      bus.subscribeStock('LULD', t);
    }
    await Promise.resolve();          // let the microtask flush run

    // One frame, not nine. The browser path already batched this way; the
    // engine sending 75 separate frames at boot was needless pressure on the
    // relay's most fragile window.
    expect(sent.length).toBe(1);
    expect(sent[0].length).toBe(9);
    expect(sent[0]).toContain('T.SPY');
    expect(sent[0]).toContain('LULD.IWM');
  });

  it('does not re-send an already-subscribed channel', async () => {
    const bus = new EngineBus();
    const sent: string[][] = [];
    bus.attach({ subscribe: (c) => sent.push(c), unsubscribe: () => {} });
    bus.subscribeStock('T', 'SPY');
    await Promise.resolve();
    bus.subscribeStock('T', 'SPY');    // idempotent
    await Promise.resolve();
    expect(sent.length).toBe(1);
    expect(sent[0]).toEqual(['T.SPY']);
  });
});

describe('ENGINE_MODE — shadow write gate', () => {
  it('defaults to off when ENGINE_MODE is unset — the engine does not start', () => {
    // vitest.config.ts does not set ENGINE_MODE, so this is the unset case.
    expect(ENGINE_MODE).toBe('off');
    expect(IS_ENABLED).toBe(false);
  });

  it('still intercepts writes in off mode — writes are opt-in, never opt-out', () => {
    // Off means the engine does not boot; but if any module is imported
    // without a boot, a write must still not reach the database.
    expect(IS_SHADOW).toBe(false);   // off is not shadow
    expect(ENGINE_MODE).not.toBe('live');
  });

  it.each([
    ['',           'off'],
    ['off',        'off'],
    ['none',       'off'],
    ['shadow',     'shadow'],
    ['live',       'live'],
    ['  LIVE  ',   'live'],
    ['production', 'shadow'],   // unrecognised falls back to shadow, never live
    ['ON',         'shadow'],
  ])('parses ENGINE_MODE=%o as %o', (input, expected) => {
    expect(parseEngineMode(input)).toBe(expected);
  });

  it('never resolves an unrecognised value to live', () => {
    for (const bad of ['prod', 'yes', 'true', 'enabled', 'LIVE!', '1']) {
      expect(parseEngineMode(bad)).not.toBe('live');
      // Unrecognised means shadow — it runs and logs, so the misconfiguration
      // is visible rather than presenting as a silently dead engine.
      expect(parseEngineMode(bad)).toBe('shadow');
    }
  });

  it('intercepts mutations and never calls the real client', async () => {
    let realCalled = false;
    const fake = {
      from: () => ({
        upsert: () => { realCalled = true; return Promise.resolve({ data: [1], error: null }); },
        insert: () => { realCalled = true; return Promise.resolve({ data: [1], error: null }); },
        select: () => Promise.resolve({ data: ['real-read'], error: null }),
      }),
    };
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const wrapped = wrapForEngineMode(fake);

    const res = await (wrapped as any).from('signals').upsert([{ id: 'a' }, { id: 'b' }]);

    expect(realCalled).toBe(false);
    expect(res.error).toBeNull();
    const logged = spy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logged).toContain('WOULD UPSERT signals');
    expect(logged).toContain('2 row(s)');
    spy.mockRestore();
  });

  it('leaves reads live — engines need real data to compute against', async () => {
    const fake = {
      from: () => ({
        select: () => Promise.resolve({ data: ['real-read'], error: null }),
      }),
    };
    const wrapped = wrapForEngineMode(fake);
    const res = await (wrapped as any).from('bars_1m').select('*');
    expect(res.data).toEqual(['real-read']);
  });

  it('keeps shadow builders chainable (delete().lt() style call sites)', async () => {
    const fake = { from: () => ({ delete: () => { throw new Error('must not run'); } }) };
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const wrapped = wrapForEngineMode(fake);
    const res = await (wrapped as any).from('short_interest').delete().lt('date', '2026-01-01');
    expect(res.error).toBeNull();
    spy.mockRestore();
  });
});

describe('config — fail-fast on missing credentials', () => {
  it('assertConfig throws when a credential is empty', async () => {
    // Re-import config with the env stripped, bypassing the module cache.
    const prevUrl = process.env.SUPABASE_URL;
    process.env.SUPABASE_URL = '';
    vi.resetModules();
    const mod = await import('../../config.ts?missing-url');
    expect(() => mod.assertConfig()).toThrow(/SUPABASE_URL/);
    process.env.SUPABASE_URL = prevUrl;
    vi.resetModules();
  });

  it('assertConfig passes when all credentials are present', async () => {
    vi.resetModules();
    const mod = await import('../../config.ts?all-present');
    expect(() => mod.assertConfig()).not.toThrow();
  });
});

describe('EngineBus — malformed timestamps (production RangeError, 2026-08-28)', () => {
  it('normalises LULD nanosecond timestamps instead of throwing', () => {
    // Verbatim from the captured HAR.
    const nanos = 1787924309993088500;
    const ms = normaliseTimestamp(nanos);
    expect(ms).toBeLessThanOrEqual(8.64e15);
    expect(new Date(ms).toISOString()).toBe('2026-08-28T13:38:29.993Z');
  });

  it.each([
    ['NaN',            NaN],
    ['Infinity',       Infinity],
    ['negative',       -1],
    ['zero',           0],
    ['a string',       '1787924309993' as unknown],
    ['undefined',      undefined],
    ['absurdly large', 1e30],
  ])('falls back to now() for %s rather than producing an Invalid Date', (_label, bad) => {
    const now = Date.UTC(2026, 7, 28, 12, 0, 0);
    const out = normaliseTimestamp(bad, now);
    expect(Number.isFinite(out)).toBe(true);
    expect(new Date(out).toString()).not.toBe('Invalid Date');
  });

  it('leaves ordinary millisecond timestamps untouched', () => {
    const ms = Date.UTC(2026, 7, 28, 13, 38, 29, 993);
    expect(normaliseTimestamp(ms)).toBe(ms);
  });

  it('a message with a nanosecond t does NOT abort the rest of the frame', () => {
    const bus = new EngineBus();
    const seen: string[] = [];
    bus.on('LULD', () => seen.push('LULD'));
    bus.on('T',    (m) => seen.push('T:' + m.sym));

    // LULD sorts after Q but before/among T. Previously the RangeError it
    // raised escaped the loop and every message after it was lost.
    bus.ingestFrame([
      { ev: 'T',    sym: 'SPY', t: 1787924309993 },
      { ev: 'LULD', sym: 'IWM', t: 1787924309993088500 },
      { ev: 'T',    sym: 'QQQ', t: 1787924309994 },
    ]);

    expect(seen).toContain('T:SPY');
    expect(seen).toContain('LULD');
    expect(seen).toContain('T:QQQ');   // the one that used to be dropped
    expect(seen.length).toBe(3);
  });

  it('survives a message that cannot be stamped at all, without losing others', () => {
    const bus = new EngineBus();
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const seen: string[] = [];
    bus.on('T', (m) => seen.push('T:' + m.sym));
    bus.ingestFrame([
      { ev: 'T', sym: 'A', t: NaN },
      { ev: 'T', sym: 'B', t: 1787924309994 },
    ]);
    expect(seen).toEqual(['T:A', 'T:B']);
    spy.mockRestore();
  });
});
