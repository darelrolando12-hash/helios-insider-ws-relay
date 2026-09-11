/**
 * Five-year replay of the deterministic exit rules (engine/exits/exitRules.ts).
 *
 *   node relay/backtests/exitRules.ts        (same env as movementGate.ts)
 *
 * ── The question ──────────────────────────────────────────────────────────
 * Gate 2's backtest found that even its best entries paid at a plain 30-
 * minute exit only ~36% of the time. Is the exit where the edge is? Replay
 * the same decisions under each exit rule and compare what an ATM 0DTE
 * option actually returned on the premium paid — expectancy, not a hit rate.
 *
 * ── Entries ───────────────────────────────────────────────────────────────
 * Every 15 minutes from 09:00 to 14:00 CT, the Gate 2 measurement from the
 * trailing 30 minutes (engine/gates/movementGate.ts). Direction is the
 * window's direction — which Gate 2's backtest showed carries NO forward
 * information (64.5% vs 65.1%). That matters for reading the result: with
 * no directional edge and a fairly priced option, NO exit rule can create
 * positive expectancy; an exit can only change the shape of the P&L (how
 * often you win versus how much). A rule that beats the others consistently,
 * in and out of sample, would therefore be picking up real structure in how
 * prices move after entry (momentum or reversion), not "better timing".
 *
 * ── Pricing ───────────────────────────────────────────────────────────────
 * The ATM option (strike = entry price) is marked every minute with Black-
 * Scholes in trading time, vol = the ticker's 20-day realised vol × M, held
 * constant through the day. Bought at the ask, sold at the bid (per-ticker
 * spread, captured 2026-09-11). Constant IV is a real simplification: live
 * 0DTE IV moves intraday. Results are reported at M = 1.0 and 1.3.
 *
 * ── Rules (each switches on only what it names; all close at the 14:30 CT
 *    cutoff at the latest except R0) ────────────────────────────────────────
 *   R0  fixed 30 min           plain time exit — Gate 2's "close" yardstick
 *   R1  cutoff only            hold to 14:30 CT
 *   R2  time stop              exit at 30 min if not in profit, else hold
 *   R3  max loss 50%
 *   R4  lost thesis — VWAP     close back through session VWAP
 *   R5  lost thesis — origin   close back through the entry window's far end
 *   R6  target                 prior-day high (calls) / low (puts)
 *   R7  all deterministic      cutoff + max loss + VWAP thesis + target + time stop
 *   ORACLE  best bid on the path (hindsight — a ceiling, not a rule)
 */

import { writeFileSync } from 'node:fs';
import { measureMovement, classifyMovement, windowRangePct, WINDOW } from '../engine/gates/movementGate.ts';
import { evaluateExit, SESSION_CUTOFF_CT_MIN, type ExitParams, type OpenPosition, type ExitReason } from '../engine/exits/exitRules.ts';
import { sessionVwapSeries } from '../engine/lib/sessionVwap.ts';
import {
  EVAL_FROM, OOS_FROM, SPREAD_PCT, DEFAULT_SPREAD_PCT, REGULAR_OPEN_MIN,
  loadSessions, bs, tradingYearsToClose,
} from './common.ts';

const TICKERS = (process.env.TICKERS ?? 'SPY,QQQ,IWM,AAPL,TSLA,NVDA,META,AMD').split(',');
const OUT = process.env.OUT ?? './exitRules-backtest.json';
const IV_RV = [1.0, 1.3] as const;
const ENTRY_FROM_MIN = 9 * 60;
const ENTRY_TO_MIN   = 14 * 60;
const ENTRY_STEP     = 15;
const GATE_STEP      = 5;   // baseline history is kept at 5-minute resolution, as in Gate 2's backtest

type RuleName = 'R0' | 'R1' | 'R2' | 'R3' | 'R4' | 'R5' | 'R6' | 'R7';
const OFF: ExitParams = { sessionCutoffMin: null, maxLossPct: null, useThesis: false, useTarget: false, timeStopMin: null, maxHoldMin: null };
const CUT = SESSION_CUTOFF_CT_MIN;
const RULES: { name: RuleName; label: string; params: ExitParams; thesis: 'vwap' | 'origin' | null }[] = [
  { name: 'R0', label: 'fixed 30 min',         params: { ...OFF, maxHoldMin: 30 },                                   thesis: null },
  { name: 'R1', label: 'hold to cutoff',       params: { ...OFF, sessionCutoffMin: CUT },                            thesis: null },
  { name: 'R2', label: 'time stop 30 if red',  params: { ...OFF, sessionCutoffMin: CUT, timeStopMin: 30 },           thesis: null },
  { name: 'R3', label: 'max loss 50%',         params: { ...OFF, sessionCutoffMin: CUT, maxLossPct: 0.5 },           thesis: null },
  { name: 'R4', label: 'lost thesis: VWAP',    params: { ...OFF, sessionCutoffMin: CUT, useThesis: true },           thesis: 'vwap' },
  { name: 'R5', label: 'lost thesis: origin',  params: { ...OFF, sessionCutoffMin: CUT, useThesis: true },           thesis: 'origin' },
  { name: 'R6', label: 'target: prior H/L',    params: { ...OFF, sessionCutoffMin: CUT, useTarget: true },           thesis: null },
  { name: 'R7', label: 'all deterministic',    params: { sessionCutoffMin: CUT, maxLossPct: 0.5, useThesis: true, useTarget: true, timeStopMin: 30, maxHoldMin: null }, thesis: 'vwap' },
];

interface Trade {
  ticker: string; day: string; oos: boolean; moving: boolean;
  /** Return on premium paid, per rule, per IV_RV. */
  ret: Record<RuleName | 'ORACLE', number[]>;
  held: Record<RuleName, number>;
  reason: Record<RuleName, ExitReason | 'end'>;
}

async function runTicker(ticker: string): Promise<Trade[]> {
  console.log(`${ticker}: loading…`);
  const sessions = await loadSessions(ticker);
  const spread = SPREAD_PCT[ticker] ?? DEFAULT_SPREAD_PCT;
  const history = new Map<number, number[]>();
  const trades: Trade[] = [];

  for (const s of sessions) {
    const idxAt = new Map<number, number>();
    s.minutes.forEach((m, i) => idxAt.set(m, i));
    if (!idxAt.has(REGULAR_OPEN_MIN)) continue;
    const vwap = sessionVwapSeries(s.bars).map((p) => p.value);
    const ranges: [number, number][] = [];
    for (let m = ENTRY_FROM_MIN; m <= 14 * 60 + 30; m += GATE_STEP) {
      const end = idxAt.get(m);
      if (end === undefined || s.minutes[end - WINDOW] === undefined || s.minutes[end - WINDOW] < REGULAR_OPEN_MIN - 1) continue;
      const f = measureMovement(s.bars, end, history.get(m) ?? [], vwap);
      const rp = windowRangePct(s.bars, end);
      if (rp !== null) ranges.push([m, rp]);
      if (s.day < EVAL_FROM || m > ENTRY_TO_MIN || (m - ENTRY_FROM_MIN) % ENTRY_STEP !== 0) continue;
      if ('absent' in f || f.direction === null || s.rv === undefined) continue;

      const call = f.direction === 'up';
      const S0 = s.bars[end].close;
      // The window's far end: where the move started.
      let lo = Infinity, hi = -Infinity;
      for (let i = end - WINDOW + 1; i <= end; i++) { lo = Math.min(lo, s.bars[i].low); hi = Math.max(hi, s.bars[i].high); }
      const target = s.prior ? (call ? (s.prior.high > S0 ? s.prior.high : null) : (s.prior.low < S0 ? s.prior.low : null)) : null;

      const ret = { R0: [], R1: [], R2: [], R3: [], R4: [], R5: [], R6: [], R7: [], ORACLE: [] } as unknown as Trade['ret'];
      const held = {} as Trade['held'];
      const reason = {} as Trade['reason'];

      IV_RV.forEach((mult, k) => {
        const iv = s.rv! * mult;
        const mid0 = bs(S0, S0, tradingYearsToClose(m), iv, call);
        const ask = mid0 * (1 + spread / 2);
        const exited = new Map<RuleName, number>();   // rule → exit bid
        let best = -Infinity;
        let lastBid = mid0 * (1 - spread / 2);
        for (let j = end + 1; j < s.bars.length && s.minutes[j] <= CUT; j++) {
          const b = s.bars[j];
          const minute = s.minutes[j];
          const bid = bs(b.close, S0, tradingYearsToClose(minute), iv, call) * (1 - spread / 2);
          lastBid = bid;
          if (bid > best) best = bid;
          for (const r of RULES) {
            if (exited.has(r.name)) continue;
            const thesis = r.thesis === 'vwap'
              ? { holds: call ? 'above' as const : 'below' as const, level: vwap[j], label: 'VWAP' }
              : r.thesis === 'origin'
                ? { holds: call ? 'above' as const : 'below' as const, level: call ? lo : hi, label: 'window origin' }
                : null;
            const pos: OpenPosition = { direction: call ? 'call' : 'put', entryMinute: m, entryPremium: ask, thesis, target };
            const why = evaluateExit(pos, { minute, high: b.high, low: b.low, close: b.close }, bid, r.params);
            if (why) {
              exited.set(r.name, bid);
              if (k === 1) { held[r.name] = minute - m; reason[r.name] = why; }
            }
          }
          if (exited.size === RULES.length) break;
        }
        for (const r of RULES) {
          const exitBid = exited.get(r.name) ?? lastBid;   // path ended (cutoff/close) without a signal
          ret[r.name][k] = exitBid / ask - 1;
          if (k === 1 && !exited.has(r.name)) { held[r.name] = CUT - m; reason[r.name] = 'end'; }
        }
        ret.ORACLE[k] = Math.max(best, lastBid) / ask - 1;
      });

      trades.push({ ticker, day: s.day, oos: s.day >= OOS_FROM, moving: classifyMovement(f).state === 'moving', ret, held, reason });
    }
    for (const [m, rp] of ranges) { const h = history.get(m) ?? []; h.push(rp); history.set(m, h); }
  }
  console.log(`${ticker}: ${trades.length} entries`);
  return trades;
}

function stats(xs: number[]) {
  const n = xs.length;
  if (n === 0) return { n: 0 };
  const sorted = [...xs].sort((a, b) => a - b);
  const mean = xs.reduce((s, x) => s + x, 0) / n;
  const sd = Math.sqrt(xs.reduce((s, x) => s + (x - mean) ** 2, 0) / Math.max(1, n - 1));
  const wins = xs.filter((x) => x > 0), losses = xs.filter((x) => x <= 0);
  return {
    n, mean, se: sd / Math.sqrt(n), median: sorted[n >> 1],
    winRate: wins.length / n,
    avgWin: wins.length ? wins.reduce((s, x) => s + x, 0) / wins.length : 0,
    avgLoss: losses.length ? losses.reduce((s, x) => s + x, 0) / losses.length : 0,
  };
}

function table(trades: Trade[], k: number) {
  const out: Record<string, unknown> = {};
  for (const name of [...RULES.map((r) => r.name), 'ORACLE'] as (RuleName | 'ORACLE')[]) {
    const st = stats(trades.map((t) => t.ret[name][k]));
    const extra = name === 'ORACLE' ? {} : {
      avgHeld: trades.reduce((s, t) => s + t.held[name as RuleName], 0) / Math.max(1, trades.length),
      reasons: trades.reduce((acc, t) => { const r = t.reason[name as RuleName]; acc[r] = (acc[r] ?? 0) + 1; return acc; }, {} as Record<string, number>),
    };
    out[name] = { ...st, ...extra };
  }
  return out;
}

async function main() {
  const all: Trade[] = [];
  for (const t of TICKERS) all.push(...await runTicker(t));
  const slices: Record<string, Trade[]> = {
    'moving · in-sample':      all.filter((t) => t.moving && !t.oos),
    'moving · out-of-sample':  all.filter((t) => t.moving && t.oos),
    'asleep · out-of-sample':  all.filter((t) => !t.moving && t.oos),
  };
  const result: Record<string, unknown> = { generated: new Date().toISOString(), ivRv: IV_RV, rules: RULES.map((r) => ({ name: r.name, label: r.label })), slices: {} };
  for (const [name, ts] of Object.entries(slices)) {
    (result.slices as any)[name] = Object.fromEntries(IV_RV.map((m, k) => [`IV/RV ${m}`, table(ts, k)]));
  }
  (result as any).byTickerMovingOOS = Object.fromEntries(TICKERS.map((t) => [t, table(all.filter((x) => x.moving && x.oos && x.ticker === t), 1)]));
  writeFileSync(OUT, JSON.stringify(result, null, 1));

  const pct = (x: number) => `${(x * 100).toFixed(1)}%`.padStart(7);
  for (const [name, ts] of Object.entries(slices)) {
    for (const k of [0, 1]) {
      console.log(`\n${name} — IV/RV ${IV_RV[k]} — return on premium (n=${ts.length})`);
      console.log('  rule                      mean    ±se   median   win%   avgWin  avgLoss  held');
      const tb = table(ts, k) as any;
      for (const r of [...RULES, { name: 'ORACLE', label: 'oracle (hindsight)' }] as any[]) {
        const s = tb[r.name];
        console.log(`  ${(r.name + ' ' + r.label).padEnd(24)} ${pct(s.mean)} ${pct(1.96 * s.se)} ${pct(s.median)} ${pct(s.winRate)} ${pct(s.avgWin)} ${pct(s.avgLoss)}  ${s.avgHeld !== undefined ? s.avgHeld.toFixed(0).padStart(4) + 'm' : ''}`);
      }
    }
  }
  console.log(`\nwrote ${OUT}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
