/**
 * The funnel as a CONJUNCTION — the one thing the original design asked for
 * and no test here has ever measured.
 *
 *   node relay/backtests/conjunctions.ts      (same env as movementGate.ts)
 *
 * Gate 1 (in-play day) was tested alone. Gate 4 (a setup fires) was tested
 * alone, across all days. "A setup fires ON an in-play day, with the higher
 * timeframes agreeing, on the right side of the prior session's volume
 * profile" — the actual design — was never run.
 *
 * ── PRE-REGISTERED BEFORE THE FIRST RUN ───────────────────────────────────
 * Conjunctions (5, fixed here; adding one later is a new pre-registration):
 *   K1  setup ∧ in-play                    Gate 1 filters, Gate 4 triggers
 *   K2  setup ∧ 15-minute momentum agrees
 *   K3  setup ∧ 15m ∧ 60-minute momentum agree
 *   K4  setup ∧ the prior session's POC is on the setup's side
 *   K5  all of the above — the full funnel
 *
 * Primary test, one per conjunction (5 tests): the POOLED edge over all
 * setups, out of sample, clustered BY DAY (a market-wide move gaps and
 * reverts every ticker at once — CLAUDE.md, "Two ways a backtest lies").
 * Bar: |z| ≥ 2.6 out of sample AND the same sign in sample. That 2.6 is
 * 0.01/5 two-sided — deliberately stricter than the 43.8% win-rate bar,
 * because this is a family of tests, not one.
 *
 * Secondary, reported but NOT accepted on their own: 5 × 16 = 80 per-setup
 * cells. At z ≥ 2 chance alone yields ~1.8 of them; at z ≥ 3.2, ~0.06. Any
 * single cell that clears while its pooled conjunction does not is noise
 * until a pre-registered re-test on new data says otherwise.
 *
 * The honest prior, stated before the numbers: every ingredient measured at
 * ~zero on its own (setups 0/16, in-play predicts magnitude not direction,
 * price momentum 49–51% at every horizon tested, flow +0.2 pts). Combining
 * several weak-but-real signals can make a strong one; combining several
 * zero-information signals cannot. The exception worth the run is
 * interaction — a rule that works only in one state tests as zero
 * unconditionally — which is why gamma regime (forward-only) matters more
 * than anything here.
 *
 * Pricing, spreads, mirror control and the IS/OOS split are the same as
 * every other backtest in this folder.
 *
 * ── ADDED AFTER THE FIRST RUN — a diagnostic, NOT pre-registered ───────────
 * The consensus gradient: edge by how many of the four conditions hold, 0..4.
 * If "maximum consensus reverts" were a mechanism it would strengthen as
 * conditions stack; a cliff at four alone is what one lucky cell looks like.
 * 8 tickers, out of sample: -1.3 -> +2.2 -> -3.0 -> -0.7 -> -11.9 points.
 * 48 tickers, out of sample: -0.3 -> +0.2 -> -1.4 -> -0.4 -> -5.9 points.
 * It fails both times — evidence against K5's mechanism. (This note was meant
 * to land with the gradient code on 2026-09-12; the scripted edit silently
 * matched nothing on a CRLF file, see CLAUDE.md WORKFLOW step 2.)
 */

import { writeFileSync } from 'node:fs';
import { detectAll, OPEN_MIN, CLOSE_MIN, type SetupSession } from '../engine/setups/setups.ts';
import { premarketFingerprint, type PremarketBar } from '../engine/gates/premarket.ts';
import { volumeProfile } from '../engine/levels/levels.ts';
import { buildSetupSession } from './setups.ts';
import { EVAL_FROM, OOS_FROM, SPREAD_PCT, DEFAULT_SPREAD_PCT, loadSessions, bs, tradingYearsToExpiry, type Session } from './common.ts';

const TICKERS = (process.env.TICKERS ?? 'SPY,QQQ,IWM,AAPL,TSLA,NVDA,META,AMD').split(',');
const OUT = process.env.OUT ?? './conjunctions-backtest.json';
const IV_RV = [1.0, 1.3] as const;
const PM_FROM = 180, PM_TO = 505, AH_END = 1140;
const HOLD = 30;

type Key = 'K1' | 'K2' | 'K3' | 'K4' | 'K5';
const KEYS: { key: Key; label: string }[] = [
  { key: 'K1', label: 'setup ∧ in-play' },
  { key: 'K2', label: 'setup ∧ 15m agrees' },
  { key: 'K3', label: 'setup ∧ 15m ∧ 60m agree' },
  { key: 'K4', label: "setup ∧ prior POC on side" },
  { key: 'K5', label: 'full funnel (all four)' },
];

interface Row {
  ticker: string; day: string; oos: boolean; setup: string;
  inPlay: boolean; tf15: boolean; tf60: boolean; poc: boolean;
  minute: number; price: number; direction: string;
  ret: number[]; mirror: number[];
}

const median = (a: number[]) => { const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const part = (s: Session, from: number, to: number): PremarketBar[] =>
  s.bars.filter((_, k) => s.minutes[k] >= from && s.minutes[k] < to).map((b) => ({ open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume }));

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

async function runTicker(ticker: string): Promise<Row[]> {
  const sessions = (await loadSessions(ticker)).filter((s) => summary(s).ok);
  const sums = sessions.map(summary);
  const spread = SPREAD_PCT[ticker] ?? DEFAULT_SPREAD_PCT;
  const reg = sessions.map((s) => part(s, OPEN_MIN, CLOSE_MIN));
  const pmVol = sessions.map((s) => part(s, PM_FROM, PM_TO).reduce((a, b) => a + b.volume, 0));
  const tr = reg.map((r, i) => {
    if (r.length === 0) return 0;
    const h = Math.max(...r.map((b) => b.high)), l = Math.min(...r.map((b) => b.low));
    const pc = i > 0 && reg[i - 1].length ? reg[i - 1][reg[i - 1].length - 1].close : r[0].open;
    return Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
  });
  const out: Row[] = [];

  for (let i = 21; i < sessions.length; i++) {
    const s = sessions[i];
    if (s.day < EVAL_FROM || s.rv === undefined) continue;
    const ss: SetupSession | null = buildSetupSession(sessions, sums, i);
    if (!ss) continue;

    const fp = premarketFingerprint({
      priorSession: reg[i - 1], afterHours: part(sessions[i - 1], CLOSE_MIN, AH_END), premarket: part(s, PM_FROM, PM_TO),
      atr: tr.slice(i - 14, i).reduce((a, x) => a + x, 0) / 14,
      premarketVolumeAvg20: pmVol.slice(i - 20, i).reduce((a, x) => a + x, 0) / 20,
    });
    const inPlay = fp.dataQuality === 'real' && fp.inPlay;
    const prof = volumeProfile(reg[i - 1], (sums[i - 1].close || 1) * 0.0005);

    // minute → index, for the higher-timeframe look-backs
    const idx = new Map<number, number>();
    ss.minutes.forEach((m, k) => { if (!idx.has(m)) idx.set(m, k); });
    const closeAt = (minute: number) => { const k = idx.get(minute); return k === undefined ? null : ss.bars[k].close; };

    for (const sig of detectAll(ss)) {
      const dir = sig.direction === 'long' ? 1 : -1;
      const price = sig.price, m0 = sig.minute;
      const c15 = closeAt(m0 - 1 - 15), c60 = closeAt(m0 - 1 - 60);
      const tf15 = c15 !== null && Math.sign(price - c15) === dir;
      const tf60 = c60 !== null && Math.sign(price - c60) === dir;
      const poc = prof !== null && Math.sign(price - prof.poc) === dir;

      const ret: number[] = [], mirror: number[] = [];
      IV_RV.forEach((mult, k) => {
        const iv = s.rv! * mult;
        for (const [side, arr] of [[dir, ret], [-dir, mirror]] as [number, number[]][]) {
          const call = side > 0;
          const ask = bs(price, price, tradingYearsToExpiry(m0, 1), iv, call) * (1 + spread / 2);
          let exitBid = ask * (1 - spread / 2) / (1 + spread / 2);
          for (let j = sig.index + 1; j < ss.bars.length; j++) {
            const minute = ss.minutes[j] + 1;
            if (minute > m0 + HOLD || minute > CLOSE_MIN) break;
            exitBid = bs(ss.bars[j].close, price, tradingYearsToExpiry(minute, 1), iv, call) * (1 - spread / 2);
          }
          arr[k] = exitBid / ask - 1;
        }
      });
      out.push({ ticker, day: s.day, oos: s.day >= OOS_FROM, setup: sig.setup, inPlay, tf15, tf60, poc, ret, mirror, minute: m0, price, direction: sig.direction });
    }
  }
  console.log(`${ticker}: ${out.length} signals`);
  return out;
}

const passes = (r: Row, key: Key) =>
  key === 'K1' ? r.inPlay :
  key === 'K2' ? r.tf15 :
  key === 'K3' ? r.tf15 && r.tf60 :
  key === 'K4' ? r.poc :
  r.inPlay && r.tf15 && r.tf60 && r.poc;

/** Edge over the mirror, clustered by DAY — the unit a market-wide shock arrives in. */
function dayClustered(rows: Row[], k: number) {
  if (rows.length < 30) return null;
  const byDay = new Map<string, Row[]>();
  for (const r of rows) { const d = byDay.get(r.day) ?? []; d.push(r); byDay.set(r.day, d); }
  const per = [...byDay.values()].map((ds) => ({
    edge: ds.filter((r) => r.ret[k] > 0).length / ds.length - ds.filter((r) => r.mirror[k] > 0).length / ds.length,
    win: ds.filter((r) => r.ret[k] > 0).length / ds.length,
    mean: ds.reduce((a, r) => a + r.ret[k], 0) / ds.length,
  }));
  const mean = (f: (x: typeof per[number]) => number) => per.reduce((a, x) => a + f(x), 0) / per.length;
  const z = (f: (x: typeof per[number]) => number) => {
    const mu = mean(f), sd = Math.sqrt(per.reduce((a, x) => a + (f(x) - mu) ** 2, 0) / Math.max(1, per.length - 1));
    return sd > 0 ? mu / (sd / Math.sqrt(per.length)) : 0;
  };
  return { n: rows.length, days: per.length, win: mean((x) => x.win), edge: mean((x) => x.edge), z: z((x) => x.edge), mean: mean((x) => x.mean) };
}

async function main() {
  const all: Row[] = [];
  for (const t of TICKERS) for (const r of await runTicker(t)) all.push(r);
  const result: any = { generated: new Date().toISOString(), preRegistered: KEYS, bar: '|z| >= 2.6 out of sample AND same sign in sample, pooled, day-clustered', pooled: {}, perSetup: {} };
  const pc = (x: number | null | undefined) => x === null || x === undefined ? '   —  ' : `${(x * 100).toFixed(1)}%`.padStart(6);

  console.log('\nPRIMARY — pooled over all setups, day-clustered, M 1.0');
  console.log('conjunction                    IS: n      edge     z   |  OOS: n      edge     z    win    mean');
  for (const { key, label } of KEYS) {
    const is = dayClustered(all.filter((r) => !r.oos && passes(r, key)), 0);
    const oos = dayClustered(all.filter((r) => r.oos && passes(r, key)), 0);
    result.pooled[key] = { label, is, oos, verdict: !!(oos && is && Math.abs(oos.z) >= 2.6 && Math.sign(oos.edge) === Math.sign(is.edge)) };
    console.log(`${(key + ' ' + label).padEnd(30)} ${String(is?.n ?? 0).padStart(6)} ${pc(is?.edge)} ${(is?.z ?? 0).toFixed(2).padStart(6)}   | ${String(oos?.n ?? 0).padStart(6)} ${pc(oos?.edge)} ${(oos?.z ?? 0).toFixed(2).padStart(6)} ${pc(oos?.win)} ${pc(oos?.mean)}`);
  }

  const setups = [...new Set(all.map((r) => r.setup))].sort();
  let cells = 0, hits2 = 0, hits32 = 0;
  console.log('\nSECONDARY — 5 × per-setup cells, out of sample (reported, not accepted alone)');
  for (const { key } of KEYS) {
    for (const setup of setups) {
      const oos = dayClustered(all.filter((r) => r.oos && r.setup === setup && passes(r, key)), 0);
      const is = dayClustered(all.filter((r) => !r.oos && r.setup === setup && passes(r, key)), 0);
      if (!oos || !is) continue;
      cells++;
      if (Math.abs(oos.z) >= 2) hits2++;
      if (Math.abs(oos.z) >= 3.2) hits32++;
      result.perSetup[`${key} · ${setup}`] = { is, oos };
      if (Math.abs(oos.z) >= 2) console.log(`  ${key} ${setup.padEnd(26)} OOS n=${String(oos.n).padStart(5)} edge ${pc(oos.edge)} z ${oos.z.toFixed(2).padStart(6)} | IS edge ${pc(is.edge)} z ${is.z.toFixed(2)}`);
    }
  }
  // Consensus gradient (post-hoc diagnostic — see header)
  const conditions = (r: Row) => (r.inPlay ? 1 : 0) + (r.tf15 ? 1 : 0) + (r.tf60 ? 1 : 0) + (r.poc ? 1 : 0);
  console.log('\nCONSENSUS GRADIENT — edge by number of conditions met (post-hoc diagnostic)');
  result.gradient = {};
  for (const [slice, pick] of [['in-sample', (r: Row) => !r.oos], ['out-of-sample', (r: Row) => r.oos]] as [string, (r: Row) => boolean][]) {
    const line: string[] = [];
    result.gradient[slice] = [];
    for (let c = 0; c <= 4; c++) {
      const d = dayClustered(all.filter((r) => pick(r) && conditions(r) === c), 0);
      result.gradient[slice].push({ conditions: c, ...(d ?? {}) });
      line.push(d ? `${c}: ${(d.edge * 100).toFixed(1)}pts (z ${d.z.toFixed(2)}, n ${d.n})` : `${c}: —`);
    }
    console.log(`  ${slice.padEnd(14)} ${line.join(' · ')}`);
  }

  console.log(`  cells tested: ${cells} · |z| ≥ 2: ${hits2} (chance ≈ ${(cells * 0.046).toFixed(1)}) · |z| ≥ 3.2: ${hits32} (chance ≈ ${(cells * 0.0014).toFixed(2)})`);
  result.cellCount = { cells, hits2, hits32 };
  writeFileSync(OUT, JSON.stringify(result, null, 1));
  if (process.env.ROWS_OUT) writeFileSync(process.env.ROWS_OUT, JSON.stringify(all));
  console.log(`\nwrote ${OUT}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
