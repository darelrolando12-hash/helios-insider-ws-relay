/**
 * The pre-registered red-to-green holdout test — the analysis only.
 *
 *   ROWS=<conjunctions ROWS_OUT json from the holdout run> node relay/backtests/r2gHoldout.ts
 *
 * Pre-registration: relay/backtests/preregistered/2026-09-13-red-to-green-holdout.md,
 * committed before the holdout rows existed. The bars are hard-coded here on
 * purpose: nothing about the verdict can be tuned from the command line.
 */

import { readFileSync } from 'node:fs';

/** The 48 tickers whose data generated the hypothesis. Any overlap is contamination. */
const DISCOVERY = new Set([
  'SPY', 'QQQ', 'IWM', 'AAPL', 'TSLA', 'NVDA', 'META', 'AMD',
  'MU', 'IVV', 'VOO', 'INTC', 'ORCL', 'AVGO', 'MSFT', 'GOOGL', 'AMZN', 'SOXL', 'GOOG', 'TLT',
  'GLD', 'TQQQ', 'MRVL', 'SMH', 'TSM', 'PLTR', 'SOXX', 'LRCX', 'DELL', 'NBIS', 'BE', 'QCOM',
  'XOM', 'EWY', 'SOXS', 'CRM', 'ADBE', 'UBER', 'VRT', 'DIA', 'XLE', 'LLY', 'AMAT', 'GDX',
  'WDC', 'SGOV', 'CVX', 'GS',
]);
const SETUP = 'red-to-green';
const PRIMARY_Z = -2.33;     // one-sided p < 0.01

interface Row {
  ticker: string; day: string; oos: boolean; setup: string;
  inPlay: boolean; tf15: boolean; tf60: boolean; poc: boolean;
  ret: number[]; mirror: number[];
}

function dayClustered(rows: Row[], k: number) {
  if (rows.length < 30) return null;
  const byDay = new Map<string, Row[]>();
  for (const r of rows) { const d = byDay.get(r.day) ?? []; d.push(r); byDay.set(r.day, d); }
  const per = [...byDay.values()].map((ds) => ({
    edge: ds.filter((r) => r.ret[k] > 0).length / ds.length - ds.filter((r) => r.mirror[k] > 0).length / ds.length,
    win: ds.filter((r) => r.ret[k] > 0).length / ds.length,
    mirrorWin: ds.filter((r) => r.mirror[k] > 0).length / ds.length,
  }));
  const mean = (f: (x: typeof per[number]) => number) => per.reduce((a, x) => a + f(x), 0) / per.length;
  const mu = mean((x) => x.edge);
  const sd = Math.sqrt(per.reduce((a, x) => a + (x.edge - mu) ** 2, 0) / Math.max(1, per.length - 1));
  return { n: rows.length, days: per.length, win: mean((x) => x.win), mirrorWin: mean((x) => x.mirrorWin), edge: mu, z: sd > 0 ? mu / (sd / Math.sqrt(per.length)) : 0 };
}

const path = process.env.ROWS;
if (!path) { console.error('ROWS=<holdout rows json> is required'); process.exit(2); }
const all: Row[] = JSON.parse(readFileSync(path, 'utf8'));

const leaked = [...new Set(all.map((r) => r.ticker))].filter((t) => DISCOVERY.has(t));
if (leaked.length > 0) {
  console.error(`CONTAMINATED: discovery tickers in the holdout rows — ${leaked.join(', ')}. The test is void.`);
  process.exit(1);
}

const r2g = all.filter((r) => r.setup === SETUP);
const tickers = new Set(r2g.map((r) => r.ticker));
const pc = (x: number) => `${(x * 100).toFixed(1)}%`;
const fmt = (s: ReturnType<typeof dayClustered>) =>
  s ? `n=${s.n} days=${s.days} win ${pc(s.win)} mirror ${pc(s.mirrorWin)} edge ${(s.edge * 100).toFixed(1)} pts z ${s.z.toFixed(2)}` : 'too few';

console.log(`Red-to-green holdout — ${r2g.length} signals on ${tickers.size} tickers (none in the discovery set)\n`);

const oos = dayClustered(r2g.filter((r) => r.oos), 0);
const is = dayClustered(r2g.filter((r) => !r.oos), 0);
console.log('PRIMARY — all red-to-green, day-clustered, M 1.0');
console.log(`  in sample      ${fmt(is)}`);
console.log(`  out of sample  ${fmt(oos)}`);
const c1 = !!oos && oos.z <= PRIMARY_Z;
const c2 = !!is && is.edge < 0;
console.log(`  bar 1  OOS one-sided z <= ${PRIMARY_Z}: ${c1 ? 'met' : 'NOT met'}`);
console.log(`  bar 2  in-sample edge negative:      ${c2 ? 'met' : 'NOT met'}`);
console.log(`  bar 3  no discovery tickers:          met`);
console.log(`  VERDICT: ${c1 && c2 ? 'PASS — following red-to-green loses on names that never generated the hypothesis. Next and only step: the mirror on real 0DTE prints.' : 'FAIL — hypothesis closed.'}`);

const m13 = dayClustered(r2g.filter((r) => r.oos), 1);
console.log(`\n  robustness (not part of the bar) M 1.3 out of sample: ${fmt(m13)}`);

console.log('\nSECONDARY — reported, never accepted on their own (4 cells)');
const K: [string, (r: Row) => boolean][] = [
  ['K1 in-play', (r) => r.inPlay],
  ['K2 15m agrees', (r) => r.tf15],
  ['K3 15m and 60m', (r) => r.tf15 && r.tf60],
  ['K4 prior POC side', (r) => r.poc],
];
for (const [label, pick] of K) console.log(`  ${label.padEnd(18)} ${fmt(dayClustered(r2g.filter((r) => r.oos && pick(r)), 0))}`);
