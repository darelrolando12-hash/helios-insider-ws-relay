/**
 * luldStore against the REAL Massive LULD wire format.
 *
 * Every payload below is verbatim from a captured live session (2026-08-28).
 * The store previously read `msg.sym`, which no LULD message carries, so
 * `_state.get(undefined)` missed and the handler returned before storing
 * anything — every LULD event was silently discarded, presenting as
 * "no halts today". These tests exist so that regression cannot come back
 * unnoticed.
 *
 * They drive the real path: subscribeTicker registers _handleLuld on the
 * shared massiveBus, so feeding that bus exercises ns-timestamp normalisation,
 * dispatch, and the store together — no test-only hooks.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { massiveBus } from '../bus.ts';
import * as luldStore from '../stores/luldStore.ts';

/** Verbatim captured frames — note: `T` is the ticker, and there is no `sym`. */
const IWM  = { ev: 'LULD', h: 314.7,  l: 284.72, i: [22], z: 1, T: 'IWM',  t: 1787924309993088500, q: 39563 };
const GLD  = { ev: 'LULD', h: 443.35, l: 401.13, i: [22], z: 1, T: 'GLD',  t: 1787924309996283100, q: 99955 };
const MSFT = { ev: 'LULD', h: 530.31, l: 479.81, i: [16], z: 3, T: 'MSFT', t: 1787924310085673200, q: 1230861 };

let logSpy: ReturnType<typeof vi.spyOn>;
let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  for (const t of ['IWM', 'GLD', 'MSFT']) luldStore.unsubscribeTicker(t);
  logSpy  = vi.spyOn(console, 'log').mockImplementation(() => {});
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('luldStore — real LULD wire format', () => {
  it('the captured payload has no sym field — T carries the ticker', () => {
    expect('sym' in IWM).toBe(false);
    expect(IWM.T).toBe('IWM');
  });

  it('ingests a real frame end-to-end and stores it under the right ticker', () => {
    luldStore.subscribeTicker('IWM');
    expect(luldStore.isDataReady('IWM')).toBe(false);      // nothing yet

    massiveBus.ingestFrame([IWM as never]);

    expect(luldStore.isDataReady('IWM')).toBe(true);
    const res = luldStore.getResult('IWM');
    expect(res.status).toBe('ready');
    if (res.status === 'ready') {
      expect(res.data.events.length).toBe(1);
      expect(res.data.events[0].ticker).toBe('IWM');
      expect(res.data.events[0].upperBand).toBe(314.7);
      expect(res.data.events[0].lowerBand).toBe(284.72);
      expect(res.data.events[0].type).toBe('luld_band');
    }
  });

  it('normalises the nanosecond timestamp to a real instant', () => {
    luldStore.subscribeTicker('GLD');
    massiveBus.ingestFrame([GLD as never]);
    const res = luldStore.getResult('GLD');
    expect(res.status).toBe('ready');
    if (res.status === 'ready') {
      const utc = res.data.events[0].tUtc;
      expect(new Date(utc).toISOString()).toBe('2026-08-28T13:38:29.996Z');
    }
  });

  it('does NOT report a halt for a band publication', () => {
    luldStore.subscribeTicker('MSFT');
    massiveBus.ingestFrame([MSFT as never]);
    // A fabricated halt silently suppresses every signal for the ticker.
    expect(luldStore.isHalted('MSFT')).toBe(false);
  });

  it('isHalted: null before any event (absent), false after a real one', () => {
    luldStore.subscribeTicker('GLD');
    expect(luldStore.isHalted('GLD')).toBeNull();   // unknown, not "not halted"
    massiveBus.ingestFrame([GLD as never]);
    expect(luldStore.isHalted('GLD')).toBe(false);  // real observed data
  });

  it('warns on an unrecognised indicator code without inventing a halt', () => {
    luldStore.subscribeTicker('IWM');
    massiveBus.ingestFrame([{ ...IWM, i: [99] } as never]);
    expect(warnSpy.mock.calls.map((c) => String(c[0])).join(''))
      .toMatch(/Unrecognised LULD indicator/);
    expect(luldStore.isHalted('IWM')).toBe(false);
  });

  it('a LULD message no longer aborts the rest of its frame', () => {
    luldStore.subscribeTicker('IWM');
    const seen: string[] = [];
    const h = (m: { sym?: string }) => seen.push('T:' + m.sym);
    massiveBus.on('T', h as never);

    massiveBus.ingestFrame([
      { ev: 'T', sym: 'SPY', t: 1787924309993 } as never,
      IWM as never,
      { ev: 'T', sym: 'QQQ', t: 1787924309994 } as never,
    ]);

    expect(seen).toContain('T:SPY');
    expect(seen).toContain('T:QQQ');          // used to be dropped
    expect(luldStore.isDataReady('IWM')).toBe(true);
    massiveBus.off('T', h as never);
  });
});
