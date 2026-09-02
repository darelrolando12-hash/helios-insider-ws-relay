/**
 * Pure-function tests for earningsCalendarIngestion.ts's parsing helpers.
 *
 * parseMoney in particular is tested against the REAL format confirmed live
 * against Nasdaq's public calendar 2026-09-02 — SNOW's forecast came back
 * as the literal string "($0.51)" (accounting-negative), not "-0.51".
 */
import { describe, it, expect } from 'vitest';
import { parseMoney, normaliseTiming, toDateStr } from '../ingestion/earningsCalendarIngestion.ts';

describe('parseMoney', () => {
  it('parses a plain dollar amount', () => {
    expect(parseMoney('$2.83')).toBeCloseTo(2.83);
  });

  it('parses accounting-negative parentheses format — the real SNOW case, 2026-09-02', () => {
    expect(parseMoney('($0.51)')).toBeCloseTo(-0.51);
  });

  it('parses a value with thousands separators', () => {
    expect(parseMoney('$1,234.56')).toBeCloseTo(1234.56);
  });

  it('returns null for missing/empty input, never 0', () => {
    expect(parseMoney(undefined)).toBeNull();
    expect(parseMoney(null)).toBeNull();
    expect(parseMoney('')).toBeNull();
  });

  it('returns null for unparseable garbage rather than NaN', () => {
    expect(parseMoney('N/A')).toBeNull();
  });
});

describe('normaliseTiming', () => {
  it('maps the real Nasdaq time values', () => {
    expect(normaliseTiming('time-pre-market')).toBe('bmo');
    expect(normaliseTiming('time-after-hours')).toBe('amc');
  });

  it('falls back to unknown for time-not-supplied and anything unrecognised', () => {
    expect(normaliseTiming('time-not-supplied')).toBe('unknown');
    expect(normaliseTiming(undefined)).toBe('unknown');
    expect(normaliseTiming('garbage')).toBe('unknown');
  });
});

describe('toDateStr', () => {
  it('formats as YYYY-MM-DD in UTC', () => {
    expect(toDateStr(new Date('2026-10-13T00:00:00Z'))).toBe('2026-10-13');
  });
});
