/**
 * The same Gate 4 signals, held for days instead of minutes.
 *
 *   node relay/backtests/setupsSwing.ts     (same env as movementGate.ts)
 *
 * Why: the 0DTE test asks whether a directional signal clears same-day decay
 * inside 30 minutes. A smaller but real edge could be invisible there and
 * still pay in a 1–2 week option held for days — which is also the Swing
 * cockpit's instrument, and it has never been tested at all.
 *
 * For every signal: buy the ATM option with an N-session expiry at the
 * decision bar's close, and sell it at the close of the H-th session after.
 * Same trading-time Black-Scholes, same per-ticker spreads, same 20-day
 * realised vol × M — and the same mirror control (the identical entry taken
 * the other way), because only direction can separate a rule from its
 * mirror. Volatility is held at entry's estimate for the life of the trade,
 * which is a real simplification: a multi-day IV path is not reconstructable
 * from this data.
 */

import { writeFileSync } from 'node:fs';
import { sessionVwapSeries } from '../engine/lib/sessionVwap.ts';
import { detectAll, OPEN_MIN, CLOSE_MIN, type SetupSession } from '../engine/setups/setups.ts';
import { buildSetupSession } from './setups.ts';
import { EVAL_FROM, OOS_FROM, SPREAD_PCT, DEFAULT_SPREAD_PCT, loadSessions, bs, tradingYearsToExpiry, type Session } from './common.ts';

const TICKERS = (process.env.TICKERS ?? 'SPY,QQQ,IWM,AAPL,TSLA,NVDA,META,AMD').split(',');
const OUT = process.env.OUT ?? './setupsSwing-backtest.json';
const IV_RV = [1.0, 1.3] as const;
/** (expiry sessions, hold sessions) pairs — fixed before the run. */
const PLANS: [number, number][] = [[5, 1], [5, 3], [10, 5]];

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

interface Trade { setup: string; oos: boolean; ret: Record<string, number[]>; mirror: Record<string, number[]> }

async function runTicker(ticker: string): Promise<Trade[]> {
  const sessions = (await loadSessions(ticker)).filter((s) => summary(s).ok);
  const sums = sessions.map(summary);
  const spread = SPREAD_PCT[ticker] ?? DEFAULT_SPREAD_PCT;
  const out: Trade[] = [];
  for (let i = 21; i < sessions.length - 11; i++) {
    const s = sessions[i];
    if (s.day < EVAL_FROM || s.rv === undefined) continue;
    const ss: SetupSession | null = buildSetupSession(sessions, sums, i);
    if (!ss) continue;
    for (const sig of detectAll(ss)) {
      const S0 = sig.price, m0 = sig.minute;
      const ret: Record<string, number[]> = {}, mirror: Record<string, number[]> = {};
      for (const [expiry, hold] of PLANS) {
        const key = `${expiry}d/${hold}h`;
        ret[key] = []; mirror[key] = [];
        IV_RV.forEach((mult, k) => {
          const iv = s.rv! * mult;
          for (const [isMine, arr] of [[true, ret[key]], [false, mirror[key]]] as [boolean, number[]][]) {
            const call = isMine ? sig.direction === 'long' : sig.direction !== 'long';
            const ask  = bs(S0, S0, tradingYearsToExpiry(m0, expiry), iv, call) * (1 + spread / 2);
            const exitPrice = sums[i + hold].close;
            const bid  = bs(exitPrice, S0, tradingYearsToExpiry(CLOSE_MIN, expiry - hold), iv, call) * (1 - spread / 2);
            arr[k] = bid / ask - 1;
          }
        });
      }
      out.push({ setup: sig.setup, oos: s.day >= OOS_FROM, ret, mirror });
    }
  }
  console.log(`${ticker}: ${out.length} signals`);
  return out;
}

function cell(ts: Trade[], key: string, k: number) {
  if (ts.length === 0) return null;
  const mine = ts.map((t) => t.ret[key][k]), mir = ts.map((t) => t.mirror[key][k]);
  const mean = mine.reduce((a, x) => a + x, 0) / mine.length;
  const d = mine.map((x, i) => (x > 0 ? 1 : 0) - (mir[i] > 0 ? 1 : 0));
  const dm = d.reduce((a, x) => a + x, 0) / d.length;
  const dsd = Math.sqrt(d.reduce((a, x) => a + (x - dm) ** 2, 0) / Math.max(1, d.length - 1));
  return { n: ts.length, win: mine.filter((x) => x > 0).length / mine.length, mirrorWin: mir.filter((x) => x > 0).length / mir.length, edge: dm, z: dsd > 0 ? dm / (dsd / Math.sqrt(d.length)) : 0, mean };
}

async function main() {
  const all: Trade[] = [];
  for (const t of TICKERS) for (const x of await runTicker(t)) all.push(x);
  const setups = [...new Set(all.map((t) => t.setup))].sort();
  const result: any = { generated: new Date().toISOString(), ivRv: IV_RV, plans: PLANS, rows: {} };
  const pc = (x: number | undefined | null) => x === undefined || x === null ? '   —  ' : `${(x * 100).toFixed(1)}%`.padStart(6);
  for (const [expiry, hold] of PLANS) {
    const key = `${expiry}d/${hold}h`;
    console.log(`\nATM ${expiry}-session expiry, held ${hold} session(s), M 1.0 — out of sample | in-sample`);
    console.log('setup                      n     win   mirror   edge    z     mean  |  IS win   IS z');
    for (const setup of setups) {
      const o = cell(all.filter((t) => t.setup === setup && t.oos), key, 0);
      const is = cell(all.filter((t) => t.setup === setup && !t.oos), key, 0);
      result.rows[`${key} · ${setup}`] = { oos: o, is };
      if (!o || !is) continue;
      console.log(`${setup.padEnd(25)} ${String(o.n).padStart(5)} ${pc(o.win)} ${pc(o.mirrorWin)} ${pc(o.edge)} ${o.z.toFixed(1).padStart(5)} ${pc(o.mean)}  | ${pc(is.win)} ${is.z.toFixed(1).padStart(5)}`);
    }
  }
  writeFileSync(OUT, JSON.stringify(result, null, 1));
  console.log(`\nwrote ${OUT}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
