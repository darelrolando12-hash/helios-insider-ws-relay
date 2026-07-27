/**
 * Central Time (America/Chicago) conversion utility.
 *
 * Single source of truth for all UTC → CT translation in the app.
 * Used at the Layer 0 ingestion boundary — every bar, tick, and event gets
 * stamped in CT the instant it enters the system. No other file does UTC math.
 *
 * DST-correct: uses Intl.DateTimeFormat with timeZone 'America/Chicago'.
 * No fixed millisecond offsets anywhere in this file.
 */

export interface CentralTimeComponents {
  year: number;
  month: number;   // 1–12
  day: number;
  hour: number;    // 0–23
  minute: number;
  second: number;
  millisecond: number;
}

export interface CentralTimeInfo extends CentralTimeComponents {
  /** Original UTC Unix epoch milliseconds — never mutated */
  utcMs: number;

  /**
   * CT wall-clock value expressed as a pseudo-UTC epoch.
   * Constructed from the Intl-parsed CT components via Date.UTC(),
   * so it correctly reflects DST transitions without any arithmetic offset.
   *
   * Use this for chart libraries that expect a local-time epoch
   * (e.g. Lightweight Charts' time axis in local mode).
   * Never pass utcMs to those libraries — that's the v4.0 chart-shift bug.
   */
  ctMs: number;

  /** YYYY-MM-DD HH:mm:ss.SSS in America/Chicago */
  formatted: string;

  /** True when America/Chicago is on CDT (UTC-5), false on CST (UTC-6) */
  isDST: boolean;
}

// One formatter instance — Intl construction is expensive, reuse it.
// fractionalSecondDigits is ES2023+; we recover milliseconds via a separate
// numeric operation on the raw timestamp instead (see toCentralTime body).
const _formatter = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Chicago',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});

/**
 * Converts a UTC Unix millisecond timestamp to Central Time (America/Chicago).
 *
 * DST transitions (second Sunday of March, first Sunday of November) are handled
 * entirely by the IANA timezone database inside Intl — this function contains
 * zero manual UTC offset arithmetic.
 */
export function toCentralTime(unixMs: number): CentralTimeInfo {
  const date = new Date(unixMs);
  const parts = _formatter.formatToParts(date);

  let year = 0, month = 0, day = 0;
  let hour = 0, minute = 0, second = 0;

  for (const part of parts) {
    switch (part.type) {
      case 'year':   year   = parseInt(part.value, 10); break;
      case 'month':  month  = parseInt(part.value, 10); break;
      case 'day':    day    = parseInt(part.value, 10); break;
      case 'hour':   hour   = parseInt(part.value, 10); break;
      case 'minute': minute = parseInt(part.value, 10); break;
      case 'second': second = parseInt(part.value, 10); break;
    }
  }

  // Milliseconds are not available from _formatter (ES2020 lib constraint).
  // Recover them directly from the raw UTC timestamp: the sub-second part is
  // timezone-independent, so unixMs % 1000 is always correct.
  const millisecond = unixMs % 1000;

  const pad = (n: number, size = 2) => String(n).padStart(size, '0');
  const formatted =
    `${year}-${pad(month)}-${pad(day)} ` +
    `${pad(hour)}:${pad(minute)}:${pad(second)}.${pad(millisecond, 3)}`;

  /**
   * ctMs: reconstruct from Intl-parsed components using Date.UTC.
   * This is NOT arithmetic (unixMs ± offset). The Intl parse already did
   * the DST-correct decomposition; we are just re-encoding the result as
   * a millisecond number for consumers that need one.
   */
  const ctMs = Date.UTC(year, month - 1, day, hour, minute, second, millisecond);

  /**
   * DST detection: derive the actual offset the Intl formatter applied,
   * then compare to the CDT offset (-5h). This is derived from the already-
   * parsed components, not from a lookup table or fixed constant.
   */
  const actualOffsetMs = ctMs - unixMs; // e.g. -18000000 (CST) or -14400000 (CDT)
  const isDST = actualOffsetMs === -5 * 60 * 60 * 1000; // CDT = UTC-5

  return {
    utcMs:       unixMs,
    ctMs,
    formatted,
    year,
    month,
    day,
    hour,
    minute,
    second,
    millisecond,
    isDST,
  };
}

/**
 * Returns the CT components for a given UTC timestamp without the full CentralTimeInfo.
 * Lightweight helper for stores that only need date components for bucketing/comparison.
 */
export function toCTComponents(unixMs: number): CentralTimeComponents {
  const { year, month, day, hour, minute, second, millisecond } = toCentralTime(unixMs);
  return { year, month, day, hour, minute, second, millisecond };
}

/**
 * Returns a CT date-only string (YYYY-MM-DD) for a UTC timestamp.
 * Used for daily bucketing in bar stores and expiry comparison.
 */
export function toCTDateString(unixMs: number): string {
  const { year, month, day } = toCentralTime(unixMs);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${year}-${pad(month)}-${pad(day)}`;
}

/**
 * Returns a CT midnight epoch (as pseudo-UTC ms, same convention as ctMs)
 * for a given UTC timestamp. Used for expiry boundary comparisons.
 */
export function toCTMidnight(unixMs: number): number {
  const { year, month, day } = toCentralTime(unixMs);
  return Date.UTC(year, month - 1, day, 0, 0, 0, 0);
}
