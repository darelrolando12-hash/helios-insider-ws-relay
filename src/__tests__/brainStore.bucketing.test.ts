import { describe, it, expect } from 'vitest';
import { vixBucket, timeOfDayBucket } from '../ledger/brainStore';
import { toCentralTime } from '../lib/time';

// ── vixBucket ────────────────────────────────────────────────────────────────────
// Real boundaries per brainStore.ts: <15 | 15-20 | 20-25 | 25+ (all lower-inclusive)

describe('vixBucket', () => {
  it('classifies a value clearly under 15 as "<15"', () => {
    expect(vixBucket(10)).toBe('<15');
  });

  it('classifies 14.99 as "<15" (just under the boundary)', () => {
    expect(vixBucket(14.99)).toBe('<15');
  });

  it('classifies exactly 15.0 as "15-20" (lower bound is inclusive to the next bucket)', () => {
    expect(vixBucket(15.0)).toBe('15-20');
  });

  it('classifies 15.01 as "15-20"', () => {
    expect(vixBucket(15.01)).toBe('15-20');
  });

  it('classifies a value clearly inside 15-20 as "15-20"', () => {
    expect(vixBucket(18)).toBe('15-20');
  });

  it('classifies 19.99 as "15-20" (just under the next boundary)', () => {
    expect(vixBucket(19.99)).toBe('15-20');
  });

  it('classifies exactly 20.0 as "20-25"', () => {
    expect(vixBucket(20.0)).toBe('20-25');
  });

  it('classifies 20.01 as "20-25"', () => {
    expect(vixBucket(20.01)).toBe('20-25');
  });

  it('classifies a value clearly inside 20-25 as "20-25"', () => {
    expect(vixBucket(23)).toBe('20-25');
  });

  it('classifies 24.99 as "20-25" (just under the next boundary)', () => {
    expect(vixBucket(24.99)).toBe('20-25');
  });

  it('classifies exactly 25.0 as "25+"', () => {
    expect(vixBucket(25.0)).toBe('25+');
  });

  it('classifies 25.01 as "25+"', () => {
    expect(vixBucket(25.01)).toBe('25+');
  });

  it('classifies a value clearly above 25 as "25+"', () => {
    expect(vixBucket(40)).toBe('25+');
  });

  it('classifies exactly 0 as "<15"', () => {
    expect(vixBucket(0)).toBe('<15');
  });
});

// ── timeOfDayBucket ─────────────────────────────────────────────────────────────
// Real boundaries per brainStore.ts (CT): open <630min, midday <840min, else close
// 9:30=570, 10:30=630, 14:00=840, 16:00=960 (minutes since midnight CT)

function ctMsFor(hour: number, minute: number): number {
  // Build a CT wall-clock time on a fixed known date (2026-08-17, a Monday, CDT in effect)
  // by finding a UTC ms whose toCentralTime() components match the target hour/minute.
  // CDT offset is UTC-5 in August, so UTC hour = CT hour + 5.
  return Date.UTC(2026, 7, 17, hour + 5, minute, 0, 0);
}

describe('timeOfDayBucket', () => {
  it('classifies 9:30 CT (market open) as "open"', () => {
    const ms = ctMsFor(9, 30);
    expect(toCentralTime(ms).hour).toBe(9); // sanity check the fixture is real CT 9:30
    expect(timeOfDayBucket(ms)).toBe('open');
  });

  it('classifies 10:29 CT as "open" (just under the boundary)', () => {
    const ms = ctMsFor(10, 29);
    expect(timeOfDayBucket(ms)).toBe('open');
  });

  it('classifies exactly 10:30 CT as "midday" (boundary is exclusive to open)', () => {
    const ms = ctMsFor(10, 30);
    expect(timeOfDayBucket(ms)).toBe('midday');
  });

  it('classifies 12:00 CT (clearly midday) as "midday"', () => {
    const ms = ctMsFor(12, 0);
    expect(timeOfDayBucket(ms)).toBe('midday');
  });

  it('classifies 13:59 CT as "midday" (just under the close boundary)', () => {
    const ms = ctMsFor(13, 59);
    expect(timeOfDayBucket(ms)).toBe('midday');
  });

  it('classifies exactly 14:00 CT as "close" (boundary is exclusive to midday)', () => {
    const ms = ctMsFor(14, 0);
    expect(timeOfDayBucket(ms)).toBe('close');
  });

  it('classifies 15:59 CT (clearly close) as "close"', () => {
    const ms = ctMsFor(15, 59);
    expect(timeOfDayBucket(ms)).toBe('close');
  });

  it('classifies a pre-market time (8:00 CT) as "open" (falls through the <630 branch)', () => {
    // minutesSinceMidnight for 8:00 = 480, which is < 630 -> 'open' per real code,
    // even though 8:00 is not actually market hours — the function itself has no
    // pre-market gate, it is a pure bucketing function on whatever timestamp it gets.
    const ms = ctMsFor(8, 0);
    expect(timeOfDayBucket(ms)).toBe('open');
  });
});
