/**
 * The entry-timing curve: how much edge is left, minute by minute, after the
 * open — and whether flow confirms faster than price.
 *
 *   node relay/backtests/entryTiming.ts     (DELTA_FILE=… for the flow variants)
 *
 * ── The question none of the other tests asked ────────────────────────────
 * Entering at the open is cheapest but blind (tested: the straddle loses).
 * Entering after price confirms is informed but late (tested: the 16 setups,
 * and AAPL's own day — confirmation at 08:45 when the money was made by
 * 08:35). The middle was never measured. Two curves move against each other:
 *
 *   reliability     how often the move continues, given a confirmation at
 *                   minute m — rises with confirmation
 *   remaining pay   what an ATM option bought at m returns at a 30-minute
 *                   exit, and what was still on the table to the session's
 *                   best bid — falls with confirmation
 *
 * If they cross with positive expectancy, that crossing is the trade. If the
 * payoff decays faster than reliability builds at every minute, the whole
 * "confirm, then buy 0DTE" line is closed, honestly.
 *
 * ── Variants at each minute ───────────────────────────────────────────────
 *   price   sign of (close − open), optionally past a 0.15 ATR threshold
 *   flow    sign of classified delta since the open, past a 10% imbalance
 *   both    they agree (else no trade)
 *
 * Flow needs per-minute delta, which exists only from 2026-09-11 live — so
 * history is rebuilt from /v3/trades the same way engine/session/cvdRebuild
 * does it (uptick rule, exact cursor paging), for a systematic sample of
 * sessions. DELTA_FILE points at that sample; without it only `price` runs.
 *
 * Every number carries the mirror control (the same entry the other way) and
 * the in-sample / out-of-sample split. Pricing is the same trading-time
 * Black-Scholes as every other backtest here (M 1.0 and 1.3).
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { priceConfirmation, flowConfirmation, agreement, type Dir } from '../engine/setups/confirmation.ts';
import { EVAL_FROM, OOS_FROM, SPREAD_PCT, DEFAULT_SPREAD_PCT, loadSessions, bs, tradingYearsToClose, type Session } from './common.ts';

const TICKERS = (process.env.TICKERS ?? 'SPY,QQQ,IWM,AAPL,TSLA,NVDA,META,AMD').split(',');
const DELTA_FILE = process.env.DELTA_FILE ?? '';
const OUT = process.env.OUT ?? './entryTiming-backtest.json';
const OPEN = 510, LAST_ENTRY = 530, HOLD = 30, CUT = 14 * 60 + 30;
const IV_RV = [1.0, 1.3] as const;

type Variant = 'price' | 'price+thr' | 'flow' | 'flow+thr' | 'both' | 'both+thr' | 'hindsight';
/** `hindsight` is not a rule: the day's realised 30-minute direction, on clean-open days only — the ceiling curve. */
const VARIANTS: Variant[] = ['price', 'price+thr', 'flow', 'flow+thr', 'both', 'both+thr', 'hindsight'];

interface DeltaRow { ticker: string; day: string; buy: number[]; sell: number[]; delta: number[] }
const deltas: Record<string, DeltaRow> = DELTA_FILE && existsSync(DELTA_FILE) ? JSON.parse(readFileSync(DELTA_FILE, 'utf8')) : {};

interface Entry {
  ticker: string; day: string; oos: boolean; minute: number; variant: Variant; dir: Dir;
  /** Underlying continued in `dir` over the next 30 minutes. */
  continued: boolean;
  ret: number[]; mirror: number[]; oracle: number[];
  /** |price − open| in ATRs at entry, and net delta as a share of volume (0 without flow data). */
  ext: number; imbalance: number;
  /** Clean-open day (hindsight) — for the "how fast does the money go" curve. */
  clean: boolean;
}

function summary(s: Session) {
  let hi = -Infinity, lo = Infinity, close = NaN, open = NaN;
  for (let k = 0; k < s.bars.length; k++) {
    const m = s.minutes[k];
    if (m < OPEN || m >= 15 * 60) continue;
    if (Number.isNaN(open)) open = s.bars[k].open;
    hi = Math.max(hi, s.bars[k].high); lo = Math.min(lo, s.bars[k].low); close = s.bars[k].close;
  }
  return { hi, lo, close, open, ok: Number.isFinite(hi) && !Number.isNaN(close) };
}

async function runTicker(ticker: string): Promise<Entry[]> {
  const sessions = (await loadSessions(ticker)).filter((s) => summary(s).ok);
  const sums = sessions.map(summary);
  const spread = SPREAD_PCT[ticker] ?? DEFAULT_SPREAD_PCT;
  const out: Entry[] = [];
  const or30 = sessions.map((s) => {
    let hi = -Infinity, lo = Infinity;
    for (let k = 0; k < s.bars.length; k++) if (s.minutes[k] >= OPEN && s.minutes[k] < OPEN + 30) { hi = Math.max(hi, s.bars[k].high); lo = Math.min(lo, s.bars[k].low); }
    return hi - lo;
  });
  const median = (a: number[]) => { const x = [...a].sort((p, q) => p - q); const m = x.length >> 1; return x.length % 2 ? x[m] : (x[m - 1] + x[m]) / 2; };

  for (let i = 21; i < sessions.length; i++) {
    const s = sessions[i];
    if (s.day < EVAL_FROM || s.rv === undefined) continue;
    const d = deltas[`${ticker}|${s.day}`];
    const idx = new Map<number, number>();
    s.minutes.forEach((m, k) => { if (!idx.has(m)) idx.set(m, k); });
    const o = idx.get(OPEN);
    if (o === undefined) continue;
    const openPrice = s.bars[o].open;
    let trSum = 0;
    for (let k = i - 14; k < i; k++) { const a = sums[k], pc = sums[k - 1].close; trSum += Math.max(a.hi - a.lo, Math.abs(a.hi - pc), Math.abs(a.lo - pc)); }
    const atr = trSum / 14;
    // clean open (hindsight) — same label as gates/premarket.ts
    const w: number[] = [];
    for (let k = o; k < s.bars.length && s.minutes[k] < OPEN + 30; k++) w.push(k);
    const hi30 = Math.max(...w.map((k) => s.bars[k].high)), lo30 = Math.min(...w.map((k) => s.bars[k].low));
    const net30 = s.bars[w[w.length - 1]].close - openPrice, R30 = hi30 - lo30;
    const dirL = Math.sign(net30);
    const fav = dirL > 0 ? hi30 - openPrice : openPrice - lo30, adv = dirL > 0 ? openPrice - lo30 : hi30 - openPrice;
    const usual = median(or30.slice(i - 20, i));
    const clean = R30 >= 1.5 * usual && Math.abs(net30) >= 0.5 * R30 && adv <= 0.25 * R30 && (fav > 0 ? (fav - Math.abs(net30)) / fav : 1) <= 0.5;

    // index 0 of the delta arrays is the 08:30 bar itself; seed with it so the
    // decision at minute m includes every minute up to and including m.
    let cumBuy = d ? (d.buy[0] ?? 0) : 0, cumSell = d ? (d.sell[0] ?? 0) : 0;
    for (let m = OPEN + 1; m <= LAST_ENTRY; m++) {
      const k = idx.get(m);
      if (k === undefined) continue;
      if (d) { const j = m - OPEN; cumBuy += d.buy[j] ?? 0; cumSell += d.sell[j] ?? 0; }
      const price = s.bars[k].close;
      const pDir = priceConfirmation(openPrice, price, atr, 0);
      const pDirT = priceConfirmation(openPrice, price, atr);
      const flowOk = !!d && (m - OPEN) < d.buy.length;   // the flow window can be shorter than the sweep
      const fDir = flowOk ? flowConfirmation(cumBuy - cumSell, cumBuy + cumSell, 0) : 0;
      const fDirT = flowOk ? flowConfirmation(cumBuy - cumSell, cumBuy + cumSell) : 0;
      const dirs: Record<Variant, Dir> = {
        price: pDir, 'price+thr': pDirT, flow: fDir, 'flow+thr': fDirT,
        both: agreement(pDir, fDir), 'both+thr': agreement(pDirT, fDirT),
        hindsight: clean ? (dirL as Dir) : 0,
      };
      // the underlying's own continuation, independent of option pricing
      const exitK = idx.get(m + HOLD);
      const after = exitK === undefined ? null : s.bars[exitK].close - price;

      for (const v of VARIANTS) {
        const dir = dirs[v];
        if (dir === 0) continue;
        if (!flowOk && (v.startsWith('flow') || v.startsWith('both'))) continue;
        const ret: number[] = [], mirror: number[] = [], oracle: number[] = [];
        IV_RV.forEach((mult, ki) => {
          const iv = s.rv! * mult;
          for (const [side, arr] of [[dir, ret], [dir > 0 ? -1 : 1, mirror]] as [Dir, number[]][]) {
            const call = side > 0;
            const ask = bs(price, price, tradingYearsToClose(m), iv, call) * (1 + spread / 2);
            let exitBid = ask * (1 - spread / 2) / (1 + spread / 2), best = -Infinity;
            for (let j = k + 1; j < s.bars.length && s.minutes[j] <= CUT; j++) {
              const bid = bs(s.bars[j].close, price, tradingYearsToClose(s.minutes[j] + 1), iv, call) * (1 - spread / 2);
              if (bid > best) best = bid;                      // the oracle keeps scanning to the cutoff
              if (s.minutes[j] <= m + HOLD) exitBid = bid;     // the rule exits at m + 30
            }
            arr[ki] = exitBid / ask - 1;
            if (side === dir) oracle[ki] = Math.max(best, exitBid) / ask - 1;
          }
        });
        out.push({ ticker, day: s.day, oos: s.day >= OOS_FROM, minute: m, variant: v, dir, continued: after !== null && Math.sign(after) === dir, ret, mirror, oracle, clean,
          ext: atr > 0 ? Math.abs(price - openPrice) / atr : 0, imbalance: d && cumBuy + cumSell > 0 ? (cumBuy - cumSell) / (cumBuy + cumSell) : 0 });
      }
    }
  }
  console.log(`${ticker}: ${out.length} sweep entries`);
  return out;
}

function agg(es: Entry[], k: number) {
  if (es.length === 0) return null;
  const win = es.filter((e) => e.ret[k] > 0).length / es.length;
  const mw = es.filter((e) => e.mirror[k] > 0).length / es.length;
  const mean = es.reduce((a, e) => a + e.ret[k], 0) / es.length;
  const sd = Math.sqrt(es.reduce((a, e) => a + (e.ret[k] - mean) ** 2, 0) / Math.max(1, es.length - 1));
  const d = es.map((e) => (e.ret[k] > 0 ? 1 : 0) - (e.mirror[k] > 0 ? 1 : 0));
  const dm = d.reduce((a, x) => a + x, 0) / d.length;
  const dsd = Math.sqrt(d.reduce((a, x) => a + (x - dm) ** 2, 0) / Math.max(1, d.length - 1));
  return {
    n: es.length, reliability: es.filter((e) => e.continued).length / es.length,
    win, mirrorWin: mw, edge: dm, z: dsd > 0 ? dm / (dsd / Math.sqrt(d.length)) : 0,
    mean, se: sd / Math.sqrt(es.length), oracle: es.reduce((a, e) => a + e.oracle[k], 0) / es.length,
  };
}

async function main() {
  const all: Entry[] = [];
  for (const t of TICKERS) for (const e of await runTicker(t)) all.push(e);
  const result: any = { generated: new Date().toISOString(), ivRv: IV_RV, hold: HOLD, curves: {} };
  for (const v of VARIANTS) {
    for (const [slice, pick] of [['in-sample', (e: Entry) => !e.oos], ['out-of-sample', (e: Entry) => e.oos]] as const) {
      const rows: any[] = [];
      for (let m = OPEN + 1; m <= LAST_ENTRY; m++) rows.push({ minute: m, ...agg(all.filter((e) => e.variant === v && e.minute === m && pick(e)), 0) });
      result.curves[`${v} · ${slice}`] = rows;
    }
  }
  // How fast the money goes on the days that did move: hindsight direction.
  const cleanRows: any[] = [];
  for (let m = OPEN + 1; m <= LAST_ENTRY; m++) {
    cleanRows.push({ minute: m, ...agg(all.filter((e) => e.variant === 'hindsight' && e.minute === m), 0) });
  }
  result.cleanDayPayoff = cleanRows;
  // Reliability against extension: the other axis of the same trade-off.
  const EXT = [[0, 0.1], [0.1, 0.25], [0.25, 0.5], [0.5, 99]];
  result.byExtension = {};
  result.byImbalance = {};
  for (const v of ['price', 'flow', 'both']) {
    for (const [slice, pick] of [['in-sample', (e) => !e.oos], ['out-of-sample', (e) => e.oos]]) {
      result.byExtension[v + ' · ' + slice] = EXT.map(([lo, hi]) => ({ lo, hi, ...agg(all.filter((e) => e.variant === v && e.ext >= lo && e.ext < hi && pick(e)), 0) }));
      result.byImbalance[v + ' · ' + slice] = [[0, 0.05], [0.05, 0.15], [0.15, 0.3], [0.3, 9]].map(([lo, hi]) => ({ lo, hi, ...agg(all.filter((e) => e.variant === v && Math.abs(e.imbalance) >= lo && Math.abs(e.imbalance) < hi && pick(e)), 0) }));
    }
  }
  writeFileSync(OUT, JSON.stringify(result, null, 1));
  // Per-entry rows: entries inside one session are not independent, so the
  // honest test clusters by ticker-session. Dump them and let the caller do it.
  if (process.env.ENTRIES_OUT) writeFileSync(process.env.ENTRIES_OUT, JSON.stringify(all));

  const pc = (x: number | undefined | null) => x === undefined || x === null ? '  —  ' : `${(x * 100).toFixed(1)}%`.padStart(6);
  for (const v of VARIANTS) {
    for (const slice of ['in-sample', 'out-of-sample']) {
      const rows = result.curves[`${v} · ${slice}`].filter((r: any) => r.n);
      if (rows.length === 0) continue;
      console.log(`\n${v} · ${slice} — entry minute (CT), M 1.0, ${HOLD}-minute exit`);
      console.log('  time     n   continued   win  mirror   edge     z    mean   oracle');
      for (const r of rows) {
        const hh = Math.floor(r.minute / 60), mm = String(r.minute % 60).padStart(2, '0');
        console.log(`  ${hh}:${mm} ${String(r.n).padStart(6)}  ${pc(r.reliability)}  ${pc(r.win)} ${pc(r.mirrorWin)} ${pc(r.edge)} ${r.z.toFixed(1).padStart(5)} ${pc(r.mean)} ${pc(r.oracle)}`);
      }
    }
  }
  console.log(`\nwrote ${OUT}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
