/**
 * Five-year backtest of the Gate 4 setup detectors (engine/setups/setups.ts).
 *
 *   node relay/backtests/setups.ts        (same env as movementGate.ts; OUT=…json)
 *
 * ── The question ──────────────────────────────────────────────────────────
 * Does a named setup predict DIRECTION? Every signal is traded as an ATM
 * 0DTE option in the setup's direction at the decision bar's close, and
 * replayed through the same exit rules as relay/backtests/exitRules.ts, with
 * the setup's own thesis level as the lost-thesis exit and its own target (or
 * the prior-day high/low) as the target.
 *
 * The control is the same entry taken the OTHER way, at the same moment,
 * under the same pricing. A pricing error (the IV multiplier M is unknowable
 * here) lifts or sinks both sides alike; only direction separates them. So a
 * setup is read on three numbers, all out of sample (after 2024-09-10):
 *
 *   bar        30-minute-exit win rate ≥ 43.8% at M 1.0 — the break-even the
 *              exit replay measured for mid-session entries (47.1% at M 1.3)
 *   direction  win rate minus the mirror's, as a paired z-score (≥ 2)
 *   expectancy mean return at M 1.3
 *
 * Pricing, spreads and trading-time Black-Scholes are exactly the exit
 * replay's (common.ts). Real 0DTE prints (2024-09 → 2026-09) put the open's
 * implied vol at ~0.74× 20-day realised on ordinary SPY/QQQ days and ~1.0×
 * on in-play days — M 1.0/1.3 errs against the buyer at the open.
 */

import { writeFileSync } from 'node:fs';
import { evaluateExit, SESSION_CUTOFF_CT_MIN, type ExitParams, type OpenPosition } from '../engine/exits/exitRules.ts';
import { sessionVwapSeries } from '../engine/lib/sessionVwap.ts';
import { detectAll, OPEN_MIN, CLOSE_MIN, type SetupSession, type SetupSignal } from '../engine/setups/setups.ts';
import { EVAL_FROM, OOS_FROM, SPREAD_PCT, DEFAULT_SPREAD_PCT, loadSessions, bs, tradingYearsToClose, type Session } from './common.ts';

const TICKERS = (process.env.TICKERS ?? 'SPY,QQQ,IWM,AAPL,TSLA,NVDA,META,AMD').split(',');
const OUT = process.env.OUT ?? './setups-backtest.json';
const IV_RV = [1.0, 1.3] as const;
const CUT = SESSION_CUTOFF_CT_MIN;

type Rule = 'R0' | 'R1' | 'R2' | 'R4' | 'R6' | 'R7';
const OFF: ExitParams = { sessionCutoffMin: null, maxLossPct: null, useThesis: false, useTarget: false, timeStopMin: null, maxHoldMin: null };
const RULES: { name: Rule; label: string; params: ExitParams }[] = [
  { name: 'R0', label: 'fixed 30 min',          params: { ...OFF, maxHoldMin: 30 } },
  { name: 'R1', label: 'hold to cutoff',        params: { ...OFF, sessionCutoffMin: CUT } },
  { name: 'R2', label: 'time stop 30 if red',   params: { ...OFF, sessionCutoffMin: CUT, timeStopMin: 30 } },
  { name: 'R4', label: "lost thesis (setup's)", params: { ...OFF, sessionCutoffMin: CUT, useThesis: true } },
  { name: 'R6', label: 'target',                params: { ...OFF, sessionCutoffMin: CUT, useTarget: true } },
  { name: 'R7', label: 'all deterministic',     params: { sessionCutoffMin: CUT, maxLossPct: 0.5, useThesis: true, useTarget: true, timeStopMin: 30, maxHoldMin: null } },
];

export interface SetupTrade {
  ticker: string; day: string; oos: boolean; setup: string; direction: 'long' | 'short'; minute: number;
  ret: Record<Rule | 'ORACLE', number[]>;   // per IV_RV
  mirrorR0: number[];                        // the opposite direction, fixed 30-minute exit
}

const median = (a: number[]) => { const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

/** Regular-session summary of one session. */
function summary(s: Session) {
  let hi = -Infinity, lo = Infinity, close = NaN, open = NaN, hi15 = -Infinity, lo15 = Infinity;
  for (let k = 0; k < s.bars.length; k++) {
    const m = s.minutes[k], b = s.bars[k];
    if (m < OPEN_MIN || m >= CLOSE_MIN) continue;
    if (Number.isNaN(open)) open = b.open;
    hi = Math.max(hi, b.high); lo = Math.min(lo, b.low); close = b.close;
    if (m < OPEN_MIN + 15) { hi15 = Math.max(hi15, b.high); lo15 = Math.min(lo15, b.low); }
  }
  return { hi, lo, close, open, r15: hi15 - lo15, ok: Number.isFinite(hi) && !Number.isNaN(close) };
}

/** Build the detector input for sessions[i] from what was knowable that morning. */
export function buildSetupSession(sessions: Session[], sums: ReturnType<typeof summary>[], i: number): SetupSession | null {
  const s = sessions[i], p = sessions[i - 1];
  const bars: SetupSession['bars'][number][] = [], minutes: number[] = [], vbars: { high: number; low: number; close: number; volume: number; tUtc: number; tCT: number }[] = [];
  for (let k = 0; k < s.bars.length; k++) {
    if (s.minutes[k] >= CLOSE_MIN) break;
    const b = s.bars[k];
    bars.push({ open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume });
    minutes.push(s.minutes[k]);
    vbars.push(b);
  }
  if (bars.length === 0) return null;
  let onHi = -Infinity, onLo = Infinity;
  for (let k = 0; k < p.bars.length; k++) if (p.minutes[k] >= CLOSE_MIN) { onHi = Math.max(onHi, p.bars[k].high); onLo = Math.min(onLo, p.bars[k].low); }
  for (let k = 0; k < s.bars.length && s.minutes[k] < OPEN_MIN; k++) { onHi = Math.max(onHi, s.bars[k].high); onLo = Math.min(onLo, s.bars[k].low); }
  const prev = sums[i - 1];
  let trSum = 0;
  for (let k = i - 14; k < i; k++) {
    const a = sums[k], pc = sums[k - 1].close;
    trSum += Math.max(a.hi - a.lo, Math.abs(a.hi - pc), Math.abs(a.lo - pc));
  }
  return {
    bars, minutes, vwap: sessionVwapSeries(vbars).map((v) => v.value),
    prior: prev.ok ? { high: prev.hi, low: prev.lo, close: prev.close } : null,
    overnight: Number.isFinite(onHi) ? { high: onHi, low: onLo } : null,
    atr: trSum / 14,
    usualRange15: median(sums.slice(i - 20, i).map((x) => x.r15)),
  };
}

function simulate(ss: SetupSession, sig: SetupSignal, direction: 'long' | 'short', rv: number, spread: number, withRules: boolean) {
  const call = direction === 'long';
  const S0 = sig.price, m0 = sig.minute;
  const thesis = direction === sig.direction ? sig.thesis : null;
  const target = direction !== sig.direction ? null
    : sig.target ?? (ss.prior ? (call ? (ss.prior.high > S0 ? ss.prior.high : null) : (ss.prior.low < S0 ? ss.prior.low : null)) : null);
  const ret = {} as Record<Rule | 'ORACLE', number[]>;
  for (const r of [...RULES.map((x) => x.name), 'ORACLE'] as (Rule | 'ORACLE')[]) ret[r] = [];
  IV_RV.forEach((mult, k) => {
    const iv = rv * mult;
    const ask = bs(S0, S0, tradingYearsToClose(m0), iv, call) * (1 + spread / 2);
    const pos: OpenPosition = { direction: call ? 'call' : 'put', entryMinute: m0, entryPremium: ask, thesis, target };
    const exited = new Map<Rule, number>();
    let best = -Infinity, lastBid = ask * (1 - spread / 2) / (1 + spread / 2);
    for (let j = sig.index + 1; j < ss.bars.length; j++) {
      const minute = ss.minutes[j] + 1;               // this bar's close
      if (minute > CLOSE_MIN) break;
      const b = ss.bars[j];
      const bid = bs(b.close, S0, tradingYearsToClose(minute), iv, call) * (1 - spread / 2);
      lastBid = bid; if (bid > best) best = bid;
      for (const r of RULES) {
        if (exited.has(r.name) || (!withRules && r.name !== 'R0')) continue;
        if (evaluateExit(pos, { minute, high: b.high, low: b.low, close: b.close }, bid, r.params)) exited.set(r.name, bid);
      }
      if (exited.size === (withRules ? RULES.length : 1)) break;
    }
    for (const r of RULES) ret[r.name][k] = (exited.get(r.name) ?? lastBid) / ask - 1;
    ret.ORACLE[k] = Math.max(best, lastBid) / ask - 1;
  });
  return ret;
}

export async function runTicker(ticker: string): Promise<SetupTrade[]> {
  const sessions = (await loadSessions(ticker)).filter((s) => summary(s).ok);
  const sums = sessions.map(summary);
  const spread = SPREAD_PCT[ticker] ?? DEFAULT_SPREAD_PCT;
  const trades: SetupTrade[] = [];
  for (let i = 21; i < sessions.length; i++) {
    const s = sessions[i];
    if (s.day < EVAL_FROM || s.rv === undefined) continue;
    const ss = buildSetupSession(sessions, sums, i);
    if (!ss) continue;
    for (const sig of detectAll(ss)) {
      if (sig.minute >= CUT) continue;
      const mine = simulate(ss, sig, sig.direction, s.rv, spread, true);
      const mirror = simulate(ss, sig, sig.direction === 'long' ? 'short' : 'long', s.rv, spread, false);
      trades.push({ ticker, day: s.day, oos: s.day >= OOS_FROM, setup: sig.setup, direction: sig.direction, minute: sig.minute, ret: mine, mirrorR0: mirror.R0 });
    }
  }
  console.log(`${ticker}: ${trades.length} signals`);
  return trades;
}

function stats(xs: number[]) {
  const n = xs.length;
  if (n === 0) return null;
  const mean = xs.reduce((a, x) => a + x, 0) / n;
  const sd = Math.sqrt(xs.reduce((a, x) => a + (x - mean) ** 2, 0) / Math.max(1, n - 1));
  const wins = xs.filter((x) => x > 0), losses = xs.filter((x) => x <= 0);
  const avgWin = wins.length ? wins.reduce((a, x) => a + x, 0) / wins.length : 0;
  const avgLoss = losses.length ? losses.reduce((a, x) => a + x, 0) / losses.length : 0;
  return { n, mean, se: sd / Math.sqrt(n), win: wins.length / n, breakeven: avgWin - avgLoss > 0 ? -avgLoss / (avgWin - avgLoss) : null };
}

/** Paired test of a setup's direction against its mirror: +1 when only it wins, −1 when only the mirror does. */
function directionZ(ts: SetupTrade[], k: number) {
  const d = ts.map((t) => (t.ret.R0[k] > 0 ? 1 : 0) - (t.mirrorR0[k] > 0 ? 1 : 0));
  const n = d.length; if (n < 2) return null;
  const m = d.reduce((a, x) => a + x, 0) / n, sd = Math.sqrt(d.reduce((a, x) => a + (x - m) ** 2, 0) / (n - 1));
  return { edge: m, z: sd > 0 ? m / (sd / Math.sqrt(n)) : 0 };
}

export function report(trades: SetupTrade[]) {
  const setups = [...new Set(trades.map((t) => t.setup))].sort();
  const rows = setups.map((setup) => {
    const out: any = { setup };
    for (const [slice, pick] of [['is', (t: SetupTrade) => !t.oos], ['oos', (t: SetupTrade) => t.oos]] as const) {
      const ts = trades.filter((t) => t.setup === setup && pick(t));
      out[slice] = {
        n: ts.length,
        R0: IV_RV.map((_, k) => stats(ts.map((t) => t.ret.R0[k]))),
        mirrorR0: IV_RV.map((_, k) => stats(ts.map((t) => t.mirrorR0[k]))),
        direction: IV_RV.map((_, k) => directionZ(ts, k)),
        R7: IV_RV.map((_, k) => stats(ts.map((t) => t.ret.R7[k]))),
        R4: IV_RV.map((_, k) => stats(ts.map((t) => t.ret.R4[k]))),
        R1: IV_RV.map((_, k) => stats(ts.map((t) => t.ret.R1[k]))),
        ORACLE: IV_RV.map((_, k) => stats(ts.map((t) => t.ret.ORACLE[k]))),
      };
    }
    const o = out.oos;
    out.verdict = {
      clearsBar: !!o.R0[0] && o.R0[0].win >= 0.438,
      clearsBarAtM13: !!o.R0[1] && o.R0[1].win >= 0.471,
      beatsMirror: !!o.direction[0] && o.direction[0].z >= 2,
      positiveAtM13: !!o.R0[1] && o.R0[1].mean > 0,
    };
    return out;
  });
  return rows;
}

async function main() {
  const all: SetupTrade[] = [];
  for (const t of TICKERS) for (const x of await runTicker(t)) all.push(x);
  const rows = report(all);
  writeFileSync(OUT, JSON.stringify({ generated: new Date().toISOString(), ivRv: IV_RV, rows }, null, 1));
  const p = (x: number | undefined | null) => x === undefined || x === null ? '   —  ' : `${(x * 100).toFixed(1)}%`.padStart(6);
  console.log('\nOUT OF SAMPLE (after 2024-09-10) — ATM 0DTE, 30-minute exit unless stated');
  console.log('setup                      n    win@1.0 mirror  edge   z   | win@1.3 mean@1.3 | R7 mean@1.3  R4 mean@1.3 | IS: n  win@1.0  z');
  for (const r of rows) {
    const o = r.oos, i = r.is;
    console.log(`${r.setup.padEnd(25)} ${String(o.n).padStart(5)}  ${p(o.R0[0]?.win)} ${p(o.mirrorR0[0]?.win)} ${p(o.direction[0]?.edge)} ${(o.direction[0]?.z ?? 0).toFixed(1).padStart(4)} | ${p(o.R0[1]?.win)} ${p(o.R0[1]?.mean)}  | ${p(o.R7[1]?.mean)}      ${p(o.R4[1]?.mean)}    | ${String(i.n).padStart(5)} ${p(i.R0[0]?.win)} ${(i.direction[0]?.z ?? 0).toFixed(1).padStart(4)}`);
  }
  console.log(`\nwrote ${OUT}`);
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}` || process.argv[1]?.endsWith('setups.ts')) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
