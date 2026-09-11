/**
 * Five-year backtest of Gate 2 (engine/gates/movementGate.ts).
 *
 *   node relay/backtests/movementGate.ts            (Node ≥ 22.18, type stripping)
 *
 * Env:
 *   TICKERS    comma list            default SPY,QQQ,IWM,AAPL,TSLA,NVDA,META,AMD
 *   FROM, TO   YYYY-MM-DD            default 2021-08-02 .. 2026-09-10
 *   CACHE_DIR  where fetched bars are cached (binary, ~25 MB/ticker)
 *   OUT        summary JSON path
 *   REST_BASE  default https://relay.helios-insiders.com/rest
 *
 * ── The question ──────────────────────────────────────────────────────────
 * Every 5 minutes from 09:00 to 14:30 CT, on every session, the gate decides
 * moving / asleep from the trailing 30 minutes only. Then we look 30
 * minutes FORWARD and ask what an option buyer actually cares about: had you
 * bought the at-the-money 0DTE option in the window's direction at that
 * moment, did the underlying move far enough to pay for the option's spread
 * and its 30 minutes of decay?
 *
 *   paid (touch)  the best favourable excursion in the next 30 min reached
 *                 the breakeven move — an optimistic, perfectly-timed exit
 *   paid (close)  the move still held at +30 min — a plain time exit
 *
 * Version 1 of the gate also tested direction (efficiency + VWAP side) and
 * this backtest disproved that half — see the gate module's header. The
 * gate now classifies on magnitude only; the direction metrics remain here
 * (touch vs wrong-side, efficiency buckets) so that result stays reproducible.
 *
 * ── Breakeven, and what is assumed ───────────────────────────────────────
 * Historical option quotes are not available, so the ATM 0DTE option is
 * priced with Black-Scholes (r = q = 0) at each decision: time to expiry is
 * the time left to the 3:00 PM CT close; volatility is the ticker's own
 * 20-day realised vol × an IV/RV multiplier M. The breakeven move is the
 * underlying move that lifts the option, 30 minutes later, by at least its
 * bid-ask spread — spread and decay both paid. M is not knowable from this
 * data, so every result is reported at M = 1.0, 1.3 and 1.6. Spreads are the
 * per-ticker ATM spreads captured from Massive on 2026-09-11 (overnight
 * quotes — wider than intraday, so this errs against the option).
 *
 * This measures the underlying's move against an option's cost. It is not a
 * P&L of real fills; that needs Gate 6 and real contracts.
 */

import { writeFileSync } from 'node:fs';
import {
  measureMovement, classifyMovement, windowRangePct, DEFAULT_PARAMS, WINDOW,
  type MovementParams, type MovementFeatures,
} from '../engine/gates/movementGate.ts';
import { sessionVwapSeries } from '../engine/lib/sessionVwap.ts';
import {
  EVAL_FROM, OOS_FROM, TO, SPREAD_PCT, DEFAULT_SPREAD_PCT, CLOSE_MIN, REGULAR_OPEN_MIN,
  loadSessions, bs, wilson,
} from './common.ts';

const TICKERS = (process.env.TICKERS ?? 'SPY,QQQ,IWM,AAPL,TSLA,NVDA,META,AMD').split(',');
const OUT = process.env.OUT ?? './movementGate-backtest.json';
const IV_RV = [1.0, 1.3, 1.6] as const;

const DECISION_FROM_MIN = 9 * 60;        // 09:00 CT — first full 30-bar RTH window
const DECISION_TO_MIN   = 14 * 60 + 30;  // 14:30 CT — last entry with 30 min to run
const HOLD_MIN          = 30;
/**
 * Underlying move (fraction of S) an ATM option needs, over HOLD_MIN, to
 * clear its spread + decay.
 *
 * Time is TRADING time: one regular session = 390 minutes = 1/252 year, the
 * same basis the 20-day realised vol is annualised on (√252 of close-to-
 * close returns). Calendar time (minutes / 525,600) was the first version
 * and it understated a 0DTE option's remaining variance — and so its premium
 * and decay — by ~2.3× (σ√(3h/8760h) vs σ√(180/98,280)), which made every
 * state look easy to pay for (smoke run: 74–82% "paid" even when asleep).
 */
export function breakevenPct(S: number, minutesToClose: number, iv: number, spreadPct: number, call: boolean): number {
  const T0 = minutesToClose / (390 * 252);
  const T1 = (minutesToClose - HOLD_MIN) / (390 * 252);
  const c0 = bs(S, S, T0, iv, call);
  const spread = Math.max(0.01, spreadPct * c0);
  const gain = (dS: number) => bs(call ? S + dS : S - dS, S, T1, iv, call) - c0 - spread;
  let lo = 0, hi = 0.25 * S;
  if (gain(hi) < 0) return hi / S;
  for (let k = 0; k < 50; k++) { const mid = (lo + hi) / 2; if (gain(mid) >= 0) hi = mid; else lo = mid; }
  return hi / S;
}

// ── Backtest ─────────────────────────────────────────────────────────────────

interface Row {
  ticker: string; day: string; minute: number; oos: boolean;
  f: MovementFeatures;
  fav: number; net: number;          // fractions of price, in the window's direction
  adv: number;                       // best move AGAINST the window's direction
  be: number[];                      // breakeven fraction per IV_RV
}

async function runTicker(ticker: string): Promise<{ rows: Row[]; absent: number; sessions: number }> {
  console.log(`${ticker}: loading…`);
  const sessions = await loadSessions(ticker);

  const spreadPct = SPREAD_PCT[ticker] ?? DEFAULT_SPREAD_PCT;
  const history = new Map<number, number[]>();
  const rows: Row[] = [];
  let absent = 0;
  for (const s of sessions) {
    const idxAt = new Map<number, number>();
    s.minutes.forEach((m, i) => idxAt.set(m, i));
    if (!idxAt.has(REGULAR_OPEN_MIN)) continue;            // no regular session (holiday / half-feed)
    const vwap = sessionVwapSeries(s.bars).map((p) => p.value);
    const rv = s.rv;
    const evaluate = s.day >= EVAL_FROM;
    const ranges: [number, number][] = [];
    for (let m = DECISION_FROM_MIN; m <= DECISION_TO_MIN; m += 5) {
      const end = idxAt.get(m);
      if (end === undefined) continue;
      // Window must be the last 30 REGULAR-session minutes, contiguous enough.
      if (s.minutes[end - WINDOW] === undefined || s.minutes[end - WINDOW] < REGULAR_OPEN_MIN - 1) continue;
      const hist = history.get(m) ?? [];
      const f = measureMovement(s.bars, end, hist, vwap);
      const rp = windowRangePct(s.bars, end);
      if (rp !== null) ranges.push([m, rp]);
      if (!evaluate) continue;
      if ('absent' in f) { absent++; continue; }
      if (f.direction === null || rv === undefined) continue;
      // Forward 30 minutes, inside the regular session.
      const S = s.bars[end].close;
      let best = 0, worst = 0, last: number | null = null, count = 0;
      for (let j = end + 1; j < s.bars.length && s.minutes[j] <= m + HOLD_MIN && s.minutes[j] <= CLOSE_MIN; j++) {
        const b = s.bars[j];
        const fav = f.direction === 'up' ? (b.high - S) / S : (S - b.low) / S;
        if (fav > best) best = fav;
        const adv = f.direction === 'up' ? (S - b.low) / S : (b.high - S) / S;
        if (adv > worst) worst = adv;
        last = f.direction === 'up' ? (b.close - S) / S : (S - b.close) / S;
        count++;
      }
      if (count < 25 || last === null) continue;       // too few forward bars to judge
      const be = IV_RV.map((mult) => breakevenPct(S, CLOSE_MIN - m, rv * mult, spreadPct, f.direction === 'up'));
      rows.push({ ticker, day: s.day, minute: m, oos: s.day >= OOS_FROM, f, fav: best, net: last, adv: worst, be });
    }
    // Only now does this session join the baseline — never its own.
    for (const [m, rp] of ranges) { const h = history.get(m) ?? []; h.push(rp); history.set(m, h); }
  }
  console.log(`${ticker}: ${sessions.length} sessions, ${rows.length} decisions, ${absent} absent`);
  return { rows, absent, sessions: sessions.length };
}

// ── Aggregation ──────────────────────────────────────────────────────────────


interface Cell { n: number; touch: number[]; close: number[]; either: number[]; wrong: number[] }
function summarise(rows: Row[], p: MovementParams) {
  const cells: Record<string, Cell> = {};
  for (const r of rows) {
    const st = classifyMovement(r.f, p).state;
    const c = cells[st] ??= { n: 0, touch: IV_RV.map(() => 0), close: IV_RV.map(() => 0), either: IV_RV.map(() => 0), wrong: IV_RV.map(() => 0) };
    c.n++;
    r.be.forEach((be, k) => {
      if (r.fav >= be) c.touch[k]++;
      if (r.net >= be) c.close[k]++;
      if (Math.max(r.fav, r.adv) >= be) c.either[k]++;   // enough movement, had you picked the side
      if (r.adv >= be) c.wrong[k]++;                      // the OTHER side would have paid
    });
  }
  const out: Record<string, unknown> = {};
  for (const [st, c] of Object.entries(cells)) {
    out[st] = {
      n: c.n,
      touch: c.touch.map((k, i) => ({ ivrv: IV_RV[i], p: k / c.n, ci: wilson(k, c.n) })),
      close: c.close.map((k, i) => ({ ivrv: IV_RV[i], p: k / c.n, ci: wilson(k, c.n) })),
      either: c.either.map((k, i) => ({ ivrv: IV_RV[i], p: k / c.n, ci: wilson(k, c.n) })),
      wrong: c.wrong.map((k, i) => ({ ivrv: IV_RV[i], p: k / c.n, ci: wilson(k, c.n) })),
    };
  }
  return out;
}

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
function line(label: string, s: any, k = 1) {
  const st = (name: string) => s[name] ? `${name} ${pct(s[name].touch[k].p)}/${pct(s[name].close[k].p)} either ${pct(s[name].either[k].p)} wrong ${pct(s[name].wrong[k].p)} (n=${s[name].n})` : `${name} —`;
  console.log(`${label.padEnd(18)} ${st('moving')}   ${st('chop')}   ${st('asleep')}`);
}

async function main() {
  const all: Row[] = [];
  const meta: Record<string, unknown> = {};
  for (const t of TICKERS) {
    const { rows, absent, sessions } = await runTicker(t);
    all.push(...rows);
    meta[t] = { sessions, decisions: rows.length, absent };
  }
  const years = [...new Set(all.map((r) => r.day.slice(0, 4)))].sort();
  const result: Record<string, unknown> = {
    generated: new Date().toISOString(), from: EVAL_FROM, to: TO, oosFrom: OOS_FROM,
    params: DEFAULT_PARAMS, ivRv: IV_RV, spreadPct: SPREAD_PCT, meta,
    overall:       summarise(all, DEFAULT_PARAMS),
    inSample:      summarise(all.filter((r) => !r.oos), DEFAULT_PARAMS),
    outOfSample:   summarise(all.filter((r) => r.oos), DEFAULT_PARAMS),
    byTicker:      Object.fromEntries(TICKERS.map((t) => [t, summarise(all.filter((r) => r.ticker === t), DEFAULT_PARAMS)])),
    byYear:        Object.fromEntries(years.map((y) => [y, summarise(all.filter((r) => r.day.startsWith(y)), DEFAULT_PARAMS)])),
    grid: [] as unknown[],
  };
  for (const rangeMin of [0.8, 1.0, 1.2, 1.5]) {
    const p = { ...DEFAULT_PARAMS, rangeMin };
    (result.grid as unknown[]).push({ params: p, inSample: summarise(all.filter((r) => !r.oos), p), outOfSample: summarise(all.filter((r) => r.oos), p) });
  }
  // Dose-response: does the paid rate climb steadily with relative range
  // (magnitude), and with efficiency among already-wide windows (direction)?
  // A real effect is monotone and holds out of sample; a fitted one isn't.
  const bucket = (rows: Row[], key: (r: Row) => number, edges: number[]) => edges.slice(0, -1).map((lo, i) => {
    const hi = edges[i + 1];
    const sel = rows.filter((r) => key(r) >= lo && key(r) < hi);
    const k = 1; // IV/RV 1.3
    const cnt = (pred: (r: Row) => boolean) => sel.filter(pred).length;
    const n = sel.length;
    return {
      range: `${lo}–${hi === Infinity ? '∞' : hi}`, n,
      touch: n ? cnt((r) => r.fav >= r.be[k]) / n : 0,
      close: n ? cnt((r) => r.net >= r.be[k]) / n : 0,
      either: n ? cnt((r) => Math.max(r.fav, r.adv) >= r.be[k]) / n : 0,
      wrong: n ? cnt((r) => r.adv >= r.be[k]) / n : 0,
    };
  });
  const RR_EDGES = [0, 0.6, 0.8, 1.0, 1.25, 1.5, 2, Infinity];
  const ER_EDGES = [0, 0.15, 0.25, 0.35, 0.5, 0.65, 1.01];
  const wide = (rows: Row[]) => rows.filter((r) => r.f.relativeRange >= 1.0);
  result.byRelativeRange = {
    inSample:    bucket(all.filter((r) => !r.oos), (r) => r.f.relativeRange, RR_EDGES),
    outOfSample: bucket(all.filter((r) => r.oos),  (r) => r.f.relativeRange, RR_EDGES),
  };
  result.byEfficiencyWhenWide = {
    inSample:    bucket(wide(all.filter((r) => !r.oos)), (r) => r.f.efficiency, ER_EDGES),
    outOfSample: bucket(wide(all.filter((r) => r.oos)),  (r) => r.f.efficiency, ER_EDGES),
  };
  writeFileSync(OUT, JSON.stringify(result, null, 1));
  const show = (title: string, rowsB: any[]) => {
    console.log(`\n${title}`);
    for (const b of rowsB) console.log(`  ${b.range.padEnd(10)} n=${String(b.n).padEnd(7)} touch ${pct(b.touch)}  close ${pct(b.close)}  either ${pct(b.either)}  wrong-side ${pct(b.wrong)}`);
  };
  show('Relative range — IN SAMPLE (IV/RV 1.3)', (result.byRelativeRange as any).inSample);
  show('Relative range — OUT OF SAMPLE', (result.byRelativeRange as any).outOfSample);
  show('Efficiency, windows with range ≥ 1.0× — IN SAMPLE', (result.byEfficiencyWhenWide as any).inSample);
  show('Efficiency, windows with range ≥ 1.0× — OUT OF SAMPLE', (result.byEfficiencyWhenWide as any).outOfSample);

  console.log(`\nPaid (touch / close) at IV/RV = ${IV_RV[1]}   — share of decisions whose next 30 min cleared the ATM 0DTE breakeven`);
  line('OVERALL', result.overall);
  line('in-sample', result.inSample);
  line('out-of-sample', result.outOfSample);
  for (const t of TICKERS) line(t, (result.byTicker as any)[t]);
  for (const y of years) line(y, (result.byYear as any)[y]);
  console.log(`\nwrote ${OUT}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
