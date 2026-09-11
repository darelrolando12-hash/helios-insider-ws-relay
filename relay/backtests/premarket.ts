/**
 * Five-year backtest of the Gate 1 pre-market fingerprint
 * (engine/gates/premarket.ts).
 *
 *   node relay/backtests/premarket.ts      (same env as movementGate.ts; OUT=…json)
 *
 * For every ticker-session: the fingerprint at 08:25 CT from the module
 * itself, the clean-open label (isCleanOpen) for 08:30–09:00, and an ATM
 * 0DTE bought at the 08:30 open and sold at 09:00 in each candidate
 * direction, priced like every other backtest here (common.ts; M 1.0 / 1.3).
 *
 * Reports, in and out of sample: P(clean open) on all days vs in-play days
 * (magnitude), and the 30-minute win rate / mean of follow-gap vs fade-gap
 * on in-play days (direction). The real-0DTE-print check of the same rule
 * is in the module header — it needs ~1,600 option requests and is not
 * rerun here.
 */

import { writeFileSync } from 'node:fs';
import { premarketFingerprint, isCleanOpen, IN_PLAY, type PremarketBar } from '../engine/gates/premarket.ts';
import { EVAL_FROM, OOS_FROM, SPREAD_PCT, DEFAULT_SPREAD_PCT, loadSessions, bs, tradingYearsToClose, type Session } from './common.ts';

const TICKERS = (process.env.TICKERS ?? 'SPY,QQQ,IWM,AAPL,TSLA,NVDA,META,AMD').split(',');
const OUT = process.env.OUT ?? './premarket-backtest.json';
const OPEN = 510, OR_END = 540, PM_FROM = 180, PM_TO = 505, CLOSE = 900, AH_END = 1140;

const median = (a: number[]) => { const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const part = (s: Session, from: number, to: number): PremarketBar[] =>
  s.bars.filter((_, k) => s.minutes[k] >= from && s.minutes[k] < to).map((b) => ({ open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume }));

interface Row {
  ticker: string; day: string; oos: boolean; inPlay: boolean; reasons: string[];
  clean: boolean; gapSign: number; volumeRatio: number | null; pmRangeAtr: number; gapAtr: number;
  up: number[]; down: number[];
}

async function runTicker(ticker: string): Promise<Row[]> {
  const sessions = (await loadSessions(ticker)).filter((s) => part(s, OPEN, CLOSE).length >= 300);
  const reg = sessions.map((s) => part(s, OPEN, CLOSE));
  const or30 = reg.map((r) => { const w = r.slice(0, OR_END - OPEN); return Math.max(...w.map((b) => b.high)) - Math.min(...w.map((b) => b.low)); });
  const pmVol = sessions.map((s) => part(s, PM_FROM, PM_TO).reduce((a, b) => a + b.volume, 0));
  const tr = reg.map((r, i) => {
    const h = Math.max(...r.map((b) => b.high)), l = Math.min(...r.map((b) => b.low));
    const pc = i > 0 ? reg[i - 1][reg[i - 1].length - 1].close : r[0].open;
    return Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
  });
  const spread = SPREAD_PCT[ticker] ?? DEFAULT_SPREAD_PCT;
  const rows: Row[] = [];
  for (let i = 21; i < sessions.length; i++) {
    const s = sessions[i];
    if (s.day < EVAL_FROM || s.rv === undefined) continue;
    const fp = premarketFingerprint({
      priorSession: reg[i - 1], afterHours: part(sessions[i - 1], CLOSE, AH_END), premarket: part(s, PM_FROM, PM_TO),
      atr: tr.slice(i - 14, i).reduce((a, x) => a + x, 0) / 14,
      premarketVolumeAvg20: pmVol.slice(i - 20, i).reduce((a, x) => a + x, 0) / 20,
    });
    if (fp.dataQuality !== 'real') continue;
    const first30 = reg[i].filter((_, k) => k < OR_END - OPEN);
    const label = isCleanOpen(first30, median(or30.slice(i - 20, i)));
    const o = first30[0].open, c30 = first30[first30.length - 1].close;
    const opt = (call: boolean, M: number) => {
      const iv = s.rv! * M;
      return bs(c30, o, tradingYearsToClose(OR_END), iv, call) * (1 - spread / 2) / (bs(o, o, tradingYearsToClose(OPEN), iv, call) * (1 + spread / 2)) - 1;
    };
    rows.push({
      ticker, day: s.day, oos: s.day >= OOS_FROM, inPlay: fp.inPlay, reasons: fp.inPlayReasons, clean: label.clean,
      gapSign: Math.sign(fp.gapAtr), volumeRatio: fp.premarketVolumeRatio, pmRangeAtr: fp.premarketRangeAtr, gapAtr: fp.gapAtr,
      up: [opt(true, 1.0), opt(true, 1.3)], down: [opt(false, 1.0), opt(false, 1.3)],
    });
  }
  console.log(`${ticker}: ${rows.length} sessions`);
  return rows;
}

function directionTable(rows: Row[]) {
  const xs = rows.filter((r) => r.gapSign !== 0);
  const cell = (pick: (r: Row) => number, k: number) => {
    const ret = xs.map((r) => (pick(r) > 0 ? r.up : r.down)[k]);
    return { win: ret.filter((x) => x > 0).length / ret.length, mean: ret.reduce((a, x) => a + x, 0) / ret.length };
  };
  const d = xs.map((r) => ((-r.gapSign > 0 ? r.up : r.down)[0] > 0 ? 1 : 0) - ((r.gapSign > 0 ? r.up : r.down)[0] > 0 ? 1 : 0));
  const m = d.reduce((a, x) => a + x, 0) / d.length, sd = Math.sqrt(d.reduce((a, x) => a + (x - m) ** 2, 0) / (d.length - 1));
  return { n: xs.length, follow: [0, 1].map((k) => cell((r) => r.gapSign, k)), fade: [0, 1].map((k) => cell((r) => -r.gapSign, k)), fadeMinusFollowZ: m / (sd / Math.sqrt(d.length)) };
}

async function main() {
  const all: Row[] = [];
  for (const t of TICKERS) for (const r of await runTicker(t)) all.push(r);
  const out: Record<string, unknown> = { generated: new Date().toISOString(), thresholds: IN_PLAY };
  const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
  for (const [name, rows] of [['in-sample', all.filter((r) => !r.oos)], ['out-of-sample', all.filter((r) => r.oos)]] as const) {
    const p = (xs: Row[]) => xs.filter((r) => r.clean).length / xs.length;
    const filters: Record<string, (r: Row) => boolean> = {
      'all days': () => true,
      'in play (any reason)': (r) => r.inPlay,
      'pre-market volume ≥ 1.388×': (r) => r.volumeRatio !== null && r.volumeRatio >= IN_PLAY.PM_VOLUME_RATIO,
      'pre-market range ≥ 0.646 ATR': (r) => r.pmRangeAtr >= IN_PLAY.PM_RANGE_ATR,
      '|gap| ≥ 0.455 ATR': (r) => Math.abs(r.gapAtr) >= IN_PLAY.GAP_ATR,
    };
    const res: Record<string, unknown> = {};
    console.log(`\n${name.toUpperCase()}`);
    for (const [fname, f] of Object.entries(filters)) {
      const xs = rows.filter(f), dt = directionTable(xs);
      res[fname] = { n: xs.length, pClean: p(xs), direction: dt };
      console.log(`  ${fname.padEnd(30)} n=${String(xs.length).padStart(5)}  P(clean) ${pct(p(xs)).padStart(6)}  | follow gap ${pct(dt.follow[0].win)} / ${pct(dt.follow[1].mean)}@1.3  fade gap ${pct(dt.fade[0].win)} / ${pct(dt.fade[1].mean)}@1.3  fade−follow z ${dt.fadeMinusFollowZ.toFixed(2)}`);
    }
    out[name] = res;
  }
  writeFileSync(OUT, JSON.stringify(out, null, 1));
  console.log(`\nwrote ${OUT}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
