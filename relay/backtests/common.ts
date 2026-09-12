/**
 * Shared by every backtest in this folder: data loading (Massive via the
 * relay's REST proxy, cached), CT session splitting, realised vol, and the
 * Black-Scholes pricing the option-cost yardstick uses. One copy, so two
 * backtests can never disagree about what a session or a premium is.
 *
 * Env: REST_BASE, FROM, TO, CACHE_DIR — see movementGate.ts's header.
 */

import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { MovementBar } from '../engine/gates/movementGate.ts';
import { toCentralTime } from '../engine/lib/time.ts';

export const REST      = process.env.REST_BASE ?? 'https://relay.helios-insiders.com/rest';
export const FROM      = process.env.FROM ?? '2021-08-02';   // ~1.5 months of warm-up for 20-session baselines
export const TO        = process.env.TO   ?? '2026-09-10';
export const EVAL_FROM = process.env.EVAL_FROM ?? '2021-09-10';  // exactly five years of decisions
export const OOS_FROM  = process.env.OOS_FROM  ?? '2024-09-10';  // last two years: out of sample
export const CACHE_DIR = process.env.CACHE_DIR ?? './.backtest-cache';

/** ATM 0DTE spread as a fraction of mid, captured from Massive 2026-09-11 (overnight quotes — wider than intraday). */
export const SPREAD_PCT: Record<string, number> = {
  SPY: 0.004, QQQ: 0.015, IWM: 0.025, AAPL: 0.030, TSLA: 0.027, NVDA: 0.011, META: 0.031, AMD: 0.055,
};
export const DEFAULT_SPREAD_PCT = 0.03;

export const REGULAR_OPEN_MIN = 8 * 60 + 30;  // NYSE 9:30 AM ET = 8:30 AM CT
export const CLOSE_MIN        = 15 * 60;      // NYSE 4:00 PM ET = 3:00 PM CT
export const DAY_MS = 86_400_000;

// ── Data ─────────────────────────────────────────────────────────────────────

export interface Raw { t: number; o: number; h: number; l: number; c: number; v: number }

async function getJson(url: string, tries = 4): Promise<any> {
  for (let a = 1; ; a++) {
    try {
      const r = await fetch(url);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.json();
    } catch (e) {
      if (a >= tries) throw e;
      await new Promise((res) => setTimeout(res, 1500 * a));
    }
  }
}

export async function fetchAggs(ticker: string, span: 'minute' | 'day', from: string, to: string): Promise<Raw[]> {
  const out: Raw[] = [];
  let url: string | null = `${REST}/v2/aggs/ticker/${ticker}/range/1/${span}/${from}/${to}?adjusted=true&sort=asc&limit=50000`;
  while (url) {
    const j = await getJson(url);
    for (const r of j.results ?? []) out.push({ t: r.t, o: r.o, h: r.h, l: r.l, c: r.c, v: r.v });
    url = j.next_url ? j.next_url.replace(/^https:\/\/api\.[a-z]+\.com/, REST).replace(/[?&]apiKey=[^&]*/, '') : null;
  }
  return out;
}

/** 1-minute bars, one request per calendar year, cached as packed floats. */
export async function loadMinutes(ticker: string): Promise<Raw[]> {
  mkdirSync(CACHE_DIR, { recursive: true });
  const file = join(CACHE_DIR, `${ticker}_${FROM}_${TO}.bin`);
  if (existsSync(file)) {
    const buf = readFileSync(file);
    const f = new Float64Array(buf.buffer, buf.byteOffset, buf.byteLength / 8);
    const out: Raw[] = new Array(f.length / 6);
    for (let i = 0; i < out.length; i++) {
      const k = i * 6;
      out[i] = { t: f[k], o: f[k + 1], h: f[k + 2], l: f[k + 3], c: f[k + 4], v: f[k + 5] };
    }
    return out;
  }
  const all: Raw[] = [];
  const y0 = Number(FROM.slice(0, 4)), y1 = Number(TO.slice(0, 4));
  for (let y = y0; y <= y1; y++) {
    const from = y === y0 ? FROM : `${y}-01-01`;
    const to   = y === y1 ? TO   : `${y}-12-31`;
    const part = await fetchAggs(ticker, 'minute', from, to);
    for (const b of part) all.push(b);   // not push(...part): a year of minutes overflows the call stack
    console.log(`  ${ticker} ${y}: ${part.length} minute bars`);
  }
  const f = new Float64Array(all.length * 6);
  all.forEach((b, i) => { f.set([b.t, b.o, b.h, b.l, b.c, b.v], i * 6); });
  writeFileSync(file, Buffer.from(f.buffer));
  return all;
}

// ── Sessions, realised vol, prior-day levels ─────────────────────────────────

export interface Session {
  day: string;                 // CT calendar date, YYYY-MM-DD
  bars: MovementBar[];
  minutes: number[];           // CT minute of day per bar
  /** 20-day realised vol from daily closes BEFORE this session (no look-ahead). */
  rv: number | undefined;
  /** The previous session's regular-session high / low / close (daily bar). */
  prior: { high: number; low: number; close: number } | undefined;
}

function ctOffsetMs(utcMs: number, cache: Map<number, number>): number {
  const d = Math.floor(utcMs / DAY_MS);
  let o = cache.get(d);
  if (o === undefined) { o = toCentralTime(d * DAY_MS + 12 * 3_600_000).isDST ? -5 * 3_600_000 : -6 * 3_600_000; cache.set(d, o); }
  return o;
}

export async function loadSessions(ticker: string): Promise<Session[]> {
  const raw = await loadMinutes(ticker);
  const daily = await fetchAggs(ticker, 'day', '2021-06-01', TO);
  const d = daily.map((x) => ({ date: new Date(x.t).toISOString().slice(0, 10), h: x.h, l: x.l, c: x.c }));
  const rvBefore = new Map<string, number>();
  const priorOf = new Map<string, { high: number; low: number; close: number }>();
  for (let i = 1; i < d.length; i++) priorOf.set(d[i].date, { high: d[i - 1].h, low: d[i - 1].l, close: d[i - 1].c });
  for (let i = 21; i < d.length; i++) {
    const rets: number[] = [];
    for (let k = i - 20; k < i; k++) rets.push(Math.log(d[k].c / d[k - 1].c));
    const m = rets.reduce((s, x) => s + x, 0) / rets.length;
    rvBefore.set(d[i].date, Math.sqrt(rets.reduce((s, x) => s + (x - m) ** 2, 0) / (rets.length - 1) * 252));
  }

  const offs = new Map<number, number>();
  const sessions: Session[] = [];
  let cur: Session | null = null;
  for (const r of raw) {
    const tCT = r.t + ctOffsetMs(r.t, offs);
    const dayKey = Math.floor(tCT / DAY_MS);
    const day = new Date(dayKey * DAY_MS).toISOString().slice(0, 10);
    if (!cur || cur.day !== day) {
      cur = { day, bars: [], minutes: [], rv: rvBefore.get(day), prior: priorOf.get(day) };
      sessions.push(cur);
    }
    cur.bars.push({ tUtc: r.t, tCT, open: r.o, high: r.h, low: r.l, close: r.c, volume: r.v });
    cur.minutes.push(Math.floor((tCT - dayKey * DAY_MS) / 60_000));
  }
  return sessions;
}

// ── Black-Scholes (r = q = 0), trading-time ──────────────────────────────────

export function ncdf(x: number): number {
  // Abramowitz & Stegun 7.1.26, |error| < 1.5e-7
  const t = 1 / (1 + 0.3275911 * Math.abs(x) / Math.SQRT2);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x / 2);
  return x >= 0 ? 0.5 * (1 + y) : 0.5 * (1 - y);
}

export function bs(S: number, K: number, T: number, iv: number, call: boolean): number {
  if (T <= 0) return Math.max(0, call ? S - K : K - S);
  const sd = iv * Math.sqrt(T);
  const d1 = (Math.log(S / K) + 0.5 * iv * iv * T) / sd;
  const d2 = d1 - sd;
  return call ? S * ncdf(d1) - K * ncdf(d2) : K * ncdf(-d2) - S * ncdf(-d1);
}

/**
 * Years of TRADING time left until the close. One regular session = 390
 * minutes = 1/252 year — the basis 20-day realised vol is annualised on.
 * (Calendar time understated a 0DTE option's premium and decay ~2.3×; see
 * movementGate.ts's breakevenPct.)
 */
export function tradingYearsToClose(minuteOfDay: number): number {
  return Math.max(0, CLOSE_MIN - minuteOfDay) / (390 * 252);
}

/**
 * Trading years to an expiry `expiryDays` sessions out: today's remaining
 * minutes plus whole sessions after it. expiryDays = 1 is 0DTE and equals
 * tradingYearsToClose. Used to ask whether a directional signal too small to
 * clear 0DTE decay survives in a 1–2 week option.
 */
export function tradingYearsToExpiry(minuteOfDay: number, expiryDays: number): number {
  return (Math.max(0, CLOSE_MIN - minuteOfDay) + Math.max(0, expiryDays - 1) * 390) / (390 * 252);
}

export function wilson(k: number, n: number): [number, number] {
  if (n === 0) return [0, 0];
  const z = 1.96, p = k / n, d = 1 + z * z / n;
  const c = (p + z * z / (2 * n)) / d, h = (z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))) / d;
  return [c - h, c + h];
}
