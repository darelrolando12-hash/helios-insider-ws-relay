import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ANTI_SIGNALS, antiSignalBlock } from '../setups/antiSignals.ts';

describe('antiSignalBlock', () => {
  it('blocks red-to-green on a holdout ticker, scoped as confirmed', () => {
    expect(antiSignalBlock('red-to-green', 'jpm')).toMatchObject({ blocked: true, scope: 'confirmed' });
  });

  it('blocks it on SPY too, but says the evidence there is discovery, not confirmation', () => {
    const b = antiSignalBlock('red-to-green', 'SPY');
    expect(b).toMatchObject({ blocked: true, scope: 'discovered' });
    if (b.blocked) expect(b.reason).toMatch(/not independently confirmed/);
  });

  it('blocks a never-tested ticker and calls the block an extrapolation', () => {
    const b = antiSignalBlock('red-to-green', 'ZZZZ');
    expect(b).toMatchObject({ blocked: true, scope: 'untested' });
    if (b.blocked) expect(b.reason).toMatch(/extrapolation/);
  });

  it('does not block setups that were never confirmed as anti-signals', () => {
    expect(antiSignalBlock('orb-15', 'SPY')).toEqual({ blocked: false });
  });

  it('keeps the confirmation set disjoint from the discovery set — confirmation must be on unseen names', () => {
    for (const a of ANTI_SIGNALS) {
      expect(a.confirmedOn.filter((t) => a.discoveredOn.includes(t))).toEqual([]);
      expect(a.confirmedOn.length).toBe(53);
      expect(a.discoveredOn.length).toBe(48);
    }
  });

  it('names setups the detector registry actually contains — a block for a name no detector emits could never fire', () => {
    const src = readFileSync(fileURLToPath(new URL('../setups/setups.ts', import.meta.url)), 'utf8');
    for (const a of ANTI_SIGNALS) expect(src).toContain(`'${a.setup}':`);
  });
});
