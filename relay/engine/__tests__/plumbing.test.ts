/**
 * Behavioural tests for the Step 2 plumbing: bus ordering/isolation, the
 * shadow-mode write gate, and the config fail-fast.
 *
 * These cover the three things whose failure modes are silent: a trade
 * classified against a stale spread, a shadow-mode write that actually
 * executes, and an empty credential producing a client that returns nothing.
 */
import { describe, it, expect, vi } from 'vitest';
import { EngineBus, type WSMessageWithCT } from '../bus.ts';
import { wrapForEngineMode, ENGINE_MODE, IS_SHADOW } from '../mode.ts';

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
});

describe('ENGINE_MODE — shadow write gate', () => {
  it('defaults to shadow when ENGINE_MODE is unset', () => {
    // vitest.config.ts does not set ENGINE_MODE.
    expect(ENGINE_MODE).toBe('shadow');
    expect(IS_SHADOW).toBe(true);
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
