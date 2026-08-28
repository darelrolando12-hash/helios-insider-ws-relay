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
 * Returns a CT midnight epoch (as pseudo-UTC ms, same convention as ctMs)
 * for a given UTC timestamp. Used for expiry boundary comparisons.
 */
export function toCTMidnight(unixMs: number): number {
  const { year, month, day } = toCentralTime(unixMs);
  return Date.UTC(year, month - 1, day, 0, 0, 0, 0);
}

/**
 * Returns true if the Massive data feed is expected to be active right now.
 *
 * Feed schedule (Central Time, DST-correct):
 *   Active:  ~3:00 AM CT  to  ~7:00 PM CT  (Mon–Fri)
 *   Offline: ~7:00 PM CT  to  ~3:00 AM CT  (every day)
 *
 * This is used to distinguish "feed dead because market closed" from
 * "feed dead because of a real connection problem". These need different
 * banner messages and different UX behaviour.
 *
 * Note: weekend check is intentionally omitted — the feed is technically
 * offline all weekend, but returning false Mon–Fri night is sufficient
 * for the current UX need (suppress misleading RECONNECTING banner).
 */
export function isFeedScheduleActive(unixMs: number = Date.now()): boolean {
  const ct = toCentralTime(unixMs);
  const minuteOfDay = ct.hour * 60 + ct.minute;
  // Active window: 3:00 AM (180) to 7:00 PM (19:00 = 1140)
  return minuteOfDay >= 180 && minuteOfDay < 1140;
}

// Regular trading session, Central Time: 8:00 AM (480 min) to 3:30 PM (930 min).
// Heavy, non-time-sensitive backfill jobs (e.g. the ~5,300-ticker 52-week
// high/low backfill) should stay out of this window so they don't compete
// with live chain polling for the same network path during the session.
const BUSY_WINDOW_START_MIN = 480; // 8:00 AM CT
const BUSY_WINDOW_END_MIN   = 930; // 3:30 PM CT

/**
 * Milliseconds to wait before it's safe to run a heavy, non-urgent backfill
 * job without competing with live trading-session traffic.
 *
 * Returns 0 if the current CT time is already outside the 8:00 AM–3:30 PM
 * busy window (job can run immediately). Otherwise returns the exact
 * remaining time until 3:30 PM CT today.
 */
export function msUntilQuietWindow(unixMs: number = Date.now()): number {
  const ct = toCentralTime(unixMs);
  const minuteOfDay = ct.hour * 60 + ct.minute;

  if (minuteOfDay < BUSY_WINDOW_START_MIN || minuteOfDay >= BUSY_WINDOW_END_MIN) {
    return 0;
  }

  const minutesRemaining = BUSY_WINDOW_END_MIN - minuteOfDay;
  return minutesRemaining * 60_000 - (ct.second * 1_000 + ct.millisecond);
}

/**
 * Returns the next feed-open time as a human-readable CT string.
 * Used in the closed-state banner.
 */
export function nextFeedOpenCT(unixMs: number = Date.now()): string {
  const ct = toCentralTime(unixMs);
  const minuteOfDay = ct.hour * 60 + ct.minute;
  if (minuteOfDay < 180) {
    // Before 3 AM today — opens at 3:00 AM today
    return '3:00 AM CT';
  }
  // After 7 PM — opens at 3:00 AM tomorrow
  return '3:00 AM CT';
}


