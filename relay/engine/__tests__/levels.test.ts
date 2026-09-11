import { describe, it, expect } from 'vitest';
import { volumeProfile, roundStep, computeLevels, type LevelBar } from '../levels/levels.ts';

const bar = (low: number, high: number, volume: number, close = (low + high) / 2): LevelBar => ({ low, high, close, volume });

describe('volumeProfile', () => {
  it('finds the busiest bin and grows a 70% value area around it', () => {
    // 100 at 10.0–10.1, 600 at 10.2–10.3, 200 at 10.4, 100 at 10.6
    const vp = volumeProfile([bar(10.0, 10.09, 100), bar(10.2, 10.29, 600), bar(10.4, 10.49, 200), bar(10.6, 10.69, 100)], 0.1)!;
    expect(vp.poc).toBeCloseTo(10.25, 6);
    // POC holds 60%; the heavier neighbour side (10.4, 20%) is reached through an empty 10.3 bin
    expect(vp.valueLow).toBeCloseTo(10.2, 6);
    expect(vp.valueHigh).toBeCloseTo(10.5, 6);
  });

  it('is absent — null — with no volume, never a stand-in price', () => {
    expect(volumeProfile([bar(10, 11, 0)], 0.1)).toBeNull();
    expect(volumeProfile([], 0.1)).toBeNull();
  });
});

describe('levels', () => {
  it('round-number step scales with price', () => {
    expect([roundStep(12), roundStep(95), roundStep(765), roundStep(21_500)]).toEqual([1, 5, 10, 50]);
  });

  it('leaves out every level whose inputs are missing', () => {
    const lv = computeLevels({ priorSession: [], overnight: [], session: [bar(100, 101, 10)], price: 100.5 });
    expect(lv.map((l) => l.kind).sort()).toEqual(['round', 'round', 'session-high', 'session-low']);
    expect(lv.filter((l) => l.kind === 'round').map((l) => l.price)).toEqual([100, 105]);
  });

  it('prior-day levels come from the prior session, overnight from AH + pre-market', () => {
    const lv = computeLevels({
      priorSession: [bar(99, 102, 500, 101), bar(100, 103, 500, 102.5)],
      overnight: [bar(102, 104, 50), bar(101.5, 102.5, 50)],
      session: [], price: 103,
    });
    const get = (k: string) => lv.find((l) => l.kind === k)?.price;
    expect([get('prior-high'), get('prior-low'), get('prior-close')]).toEqual([103, 99, 102.5]);
    expect([get('overnight-high'), get('overnight-low')]).toEqual([104, 101.5]);
    expect(get('poc')).toBeDefined();
  });
});
