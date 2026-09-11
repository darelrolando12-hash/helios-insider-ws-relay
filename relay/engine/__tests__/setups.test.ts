/**
 * Gate 4 detectors on real sessions (fixtures cut from Massive minute bars;
 * see each file's `why`), plus the property the backtest's honesty rests on:
 * causality. A detector run on the bars so far must produce exactly the
 * signals the full-session run produced up to that bar — no signal may
 * depend on a bar after the one it was decided on.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { detectAll, DETECTORS, type SetupSession } from '../setups/setups.ts';

const here = dirname(fileURLToPath(import.meta.url));
function fixture(name: string): { ticker: string; day: string; s: SetupSession } {
  const f = JSON.parse(readFileSync(join(here, 'fixtures', `setups-${name}.json`), 'utf8'));
  const bars = f.session.bars.map(([open, high, low, close, volume]: number[]) => ({ open, high, low, close, volume }));
  return { ticker: f.ticker, day: f.day, s: { ...f.session, bars } };
}
const hm = (m: number) => `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`;
const fired = (s: SetupSession) => detectAll(s).map((x) => `${x.setup}:${x.direction}@${hm(x.minute)}`);

describe('Gate 4 detectors on real sessions', () => {
  it('AAPL 2026-09-11 — the opening drive fires long at 08:45; nothing fades it', () => {
    const { s } = fixture('aapl-2026-09-11');
    const f = fired(s);
    expect(f).toContain('opening-drive:long@8:45');
    expect(f).toContain('orb-5:long@8:36');
    expect(f).toContain('vwap-first-pullback:long@8:49');
    expect(f.some((x) => x.startsWith('failed-opening-drive'))).toBe(false);
    expect(f.some((x) => x.startsWith('gap-'))).toBe(false);          // the gap was −0.2%
  });

  it('SPY coil day — no drive, no failed drive, no flag, no first pullback', () => {
    const f = fired(fixture('spy-coil').s);
    for (const name of ['opening-drive', 'failed-opening-drive', 'flag', 'vwap-first-pullback']) {
      expect(f.some((x) => x.startsWith(name + ':'))).toBe(false);
    }
  });

  it('SPY gap-fill day — gap-fill short at 08:45 targeting the prior close; not gap-and-go', () => {
    const { s } = fixture('spy-gap-fill');
    const sig = detectAll(s).find((x) => x.setup === 'gap-fill');
    expect(sig).toMatchObject({ direction: 'short', minute: 8 * 60 + 45, target: s.prior!.close });
    expect(fired(s).some((x) => x.startsWith('gap-and-go'))).toBe(false);
  });

  it('SPY gap-and-go day — gap-and-go long at 08:45; not gap-fill', () => {
    const f = fired(fixture('spy-gap-and-go').s);
    expect(f).toContain('gap-and-go:long@8:45');
    expect(f.some((x) => x.startsWith('gap-fill'))).toBe(false);
  });
});

describe('Gate 4 detectors are causal', () => {
  for (const name of ['aapl-2026-09-11', 'spy-coil', 'spy-gap-fill', 'spy-gap-and-go']) {
    it(`${name}: every prefix yields exactly the full run's signals up to that bar`, () => {
      const { s } = fixture(name);
      for (const [dname, detect] of Object.entries(DETECTORS)) {
        const full = detect(s);
        for (let k = 0; k < s.bars.length; k += 3) {
          const prefix: SetupSession = { ...s, bars: s.bars.slice(0, k + 1), minutes: s.minutes.slice(0, k + 1), vwap: s.vwap.slice(0, k + 1) };
          const got = detect(prefix).map((x) => `${x.setup}@${x.index}`);
          const want = full.filter((x) => x.index <= k).map((x) => `${x.setup}@${x.index}`);
          expect(got, `${dname} at bar ${k}`).toEqual(want);
        }
      }
    });
  }
});
