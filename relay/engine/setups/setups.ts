/**
 * Gate 4 — named setups.
 *
 * One pure detector per setup: a session's bars in, the setup's signals out,
 * each stamped with the bar it was decided on. Every detector is a single
 * causal pass — a signal at bar i reads bars[0..i] and nothing after — so
 * running it on the bars so far each minute (live) and on the whole session
 * (backtest) yields the same signals. The prefix test in
 * __tests__/setups.test.ts checks exactly that on real sessions.
 *
 * Direction is what this gate has to earn. Gate 2 found the trailing
 * window's direction carries no forward information; the exit replay found
 * no exit rule makes a directionless entry pay. So each setup below is
 * judged in relay/backtests/setups.ts on whether ITS direction beats the
 * same entries taken the other way — not just on a win rate.
 *
 * ── Definitions (fixed before the backtest ran; changing one is a re-run) ──
 * Times are CT. OR(n) = high/low of the first n regular-session minutes.
 * "Drive" = the first 15 minutes' range ≥ 1.5× its median over the prior 20
 * sessions, net move ≥ 60% of that range, closing in the outer 25% of it.
 *
 *   orb-5 / orb-15 / orb-30   first close beyond OR(n), before 11:00.
 *                             Thesis: the broken OR edge holds.
 *   opening-drive             a drive, entered with it at 08:45.
 *                             Thesis: price stays beyond the open.
 *   failed-opening-drive      a drive, then a close back through the open
 *                             before 10:00: enter against the drive.
 *   gap-and-go                |gap| ≥ 0.3 ATR; at 08:45 price is beyond the
 *                             open in the gap's direction and never gave back
 *                             half the gap. Enter with the gap.
 *   gap-fill                  |gap| ≥ 0.3 ATR; at 08:45 price is back inside
 *                             the open, still short of the prior close. Enter
 *                             toward the prior close (the target).
 *   red-to-green              gap down, then the first close back above the
 *                             prior close (08:35–11:00) → long; green-to-red
 *                             is the mirror → short. Thesis: the prior close.
 *   vwap-reclaim              ≥15 straight closes on one side of session VWAP,
 *                             then a close on the other (09:00–14:00).
 *   vwap-rejection            ≥15 straight closes on one side, then a bar that
 *                             tags VWAP and closes back on its side, red (for
 *                             a rejection from below) / green (from above).
 *   vwap-first-pullback       after a drive, the first bar to touch VWAP
 *                             (before 10:30) — if VWAP is sloping with the
 *                             drive and the bar closes back on the drive's
 *                             side, enter with the drive. A first touch that
 *                             closes through VWAP voids the setup.
 *   prior-level-break-retest  a close through the prior-day high (low), then
 *                             ≥5 bars later a bar that returns to within 0.1%
 *                             of it and closes back beyond it (08:35–14:00).
 *                             A close back through the level before the retest
 *                             cancels the break.
 *   overnight-range-break     the open is inside the overnight range; the
 *                             first close beyond it before 10:00.
 *   liquidity-sweep           a bar pokes through the prior-day or overnight
 *                             high (low) by at most 0.25 ATR, and within 5
 *                             bars price closes back inside: enter against
 *                             the poke (08:45–14:00). Thesis: the sweep's
 *                             extreme is not taken out.
 *   flag                      an impulse of ≥0.4 ATR in ≤10 bars at ≥60%
 *                             efficiency, 5–20 bars of consolidation keeping
 *                             ≥50% of it within a range ≤50% of it, then a
 *                             close beyond the consolidation (08:45–14:00).
 *   rip-dump                  APPROXIMATION of the engine's LULD-band RIP/DUMP
 *                             (engines/dumpRipDetector.ts), which needs LULD
 *                             events the historical minute data doesn't have:
 *                             a close ≥5% beyond the prior 5 closes' mean
 *                             (10% in 08:30–08:45 and 14:35–15:00, the Tier-1
 *                             doubled-band windows). Enter with the move.
 *
 *   flip-break                NOT DETECTABLE IN HISTORY. Needs the gamma flip
 *                             as it stood intraday, and no historical
 *                             open-interest/IV chain exists here. Forward test
 *                             only, from the engine's /engine/gex history.
 *
 * First signal per setup per session (per direction where both can fire).
 */

export interface SetupBar {
  open:   number;
  high:   number;
  low:    number;
  close:  number;
  volume: number;
}

export interface SetupSession {
  /** Today's bars, pre-market and regular session only, ascending. */
  bars:      readonly SetupBar[];
  /** CT minute of day of each bar. */
  minutes:   readonly number[];
  /** Session VWAP as of each bar (lib/sessionVwap), aligned with bars. */
  vwap:      readonly number[];
  /** The previous regular session. */
  prior:     { high: number; low: number; close: number } | null;
  /** Previous after-hours + today's pre-market. */
  overnight: { high: number; low: number } | null;
  /** 14-session average true range of prior regular sessions. */
  atr:          number | null;
  /** Median first-15-minute range over the prior 20 sessions. */
  usualRange15: number | null;
}

export type Direction = 'long' | 'short';

export interface SetupSignal {
  setup:     SetupName;
  direction: Direction;
  /** Bar the decision was made on (at its close). */
  index:     number;
  /** Decision time, CT minute of day (the bar's close). */
  minute:    number;
  price:     number;
  thesis:    { holds: 'above' | 'below'; level: number; label: string };
  target:    number | null;
}

export type SetupName =
  | 'orb-5' | 'orb-15' | 'orb-30'
  | 'opening-drive' | 'failed-opening-drive'
  | 'gap-and-go' | 'gap-fill' | 'red-to-green'
  | 'vwap-reclaim' | 'vwap-rejection' | 'vwap-first-pullback'
  | 'prior-level-break-retest' | 'overnight-range-break'
  | 'liquidity-sweep' | 'flag' | 'rip-dump';

export const OPEN_MIN = 8 * 60 + 30;   // NYSE 9:30 AM ET
export const CLOSE_MIN = 15 * 60;      // NYSE 4:00 PM ET
const T = (h: number, m: number) => h * 60 + m;

// ── helpers ──────────────────────────────────────────────────────────────────

/** Index of the 08:30 bar (or the first regular bar by 08:32), else null. */
export function openIndex(s: SetupSession): number | null {
  for (let i = 0; i < s.bars.length; i++) {
    if (s.minutes[i] >= OPEN_MIN) return s.minutes[i] <= OPEN_MIN + 2 ? i : null;
  }
  return null;
}

/** Index of the last bar with minute < `minute`, at or after `from`. */
function lastBefore(s: SetupSession, from: number, minute: number): number | null {
  let k: number | null = null;
  for (let i = from; i < s.bars.length && s.minutes[i] < minute; i++) k = i;
  return k;
}

function signal(s: SetupSession, setup: SetupName, direction: Direction, i: number,
  thesisLevel: number, label: string, target: number | null = null): SetupSignal {
  return {
    setup, direction, index: i, minute: s.minutes[i] + 1, price: s.bars[i].close,
    thesis: { holds: direction === 'long' ? 'above' : 'below', level: thesisLevel, label }, target,
  };
}

function range(s: SetupSession, from: number, to: number) {
  let hi = -Infinity, lo = Infinity;
  for (let i = from; i <= to; i++) { hi = Math.max(hi, s.bars[i].high); lo = Math.min(lo, s.bars[i].low); }
  return { hi, lo };
}

/** The opening drive, as of the 08:44 bar — or null. */
export function openingDrive(s: SetupSession): { direction: Direction; index: number; open: number; hi: number; lo: number } | null {
  const o = openIndex(s);
  if (o === null || !s.usualRange15) return null;
  const e = lastBefore(s, o, OPEN_MIN + 15);
  if (e === null || s.minutes[e] < OPEN_MIN + 13) return null;
  const { hi, lo } = range(s, o, e);
  const R = hi - lo, open = s.bars[o].open, close = s.bars[e].close, net = close - open;
  if (R < 1.5 * s.usualRange15 || Math.abs(net) < 0.6 * R) return null;
  if (net > 0 && close >= hi - 0.25 * R) return { direction: 'long', index: e, open, hi, lo };
  if (net < 0 && close <= lo + 0.25 * R) return { direction: 'short', index: e, open, hi, lo };
  return null;
}

// ── detectors ────────────────────────────────────────────────────────────────

function orb(n: number, name: SetupName) {
  return (s: SetupSession): SetupSignal[] => {
    const o = openIndex(s);
    if (o === null) return [];
    const e = lastBefore(s, o, OPEN_MIN + n);
    if (e === null) return [];
    const { hi, lo } = range(s, o, e);
    for (let i = e + 1; i < s.bars.length && s.minutes[i] < T(11, 0); i++) {
      const c = s.bars[i].close;
      if (c > hi) return [signal(s, name, 'long', i, hi, `OR${n} high`)];
      if (c < lo) return [signal(s, name, 'short', i, lo, `OR${n} low`)];
    }
    return [];
  };
}

function openingDriveSetup(s: SetupSession): SetupSignal[] {
  const d = openingDrive(s);
  return d ? [signal(s, 'opening-drive', d.direction, d.index, d.open, 'the open')] : [];
}

function failedOpeningDrive(s: SetupSession): SetupSignal[] {
  const d = openingDrive(s);
  if (!d) return [];
  for (let i = d.index + 1; i < s.bars.length && s.minutes[i] < T(10, 0); i++) {
    const c = s.bars[i].close;
    if (d.direction === 'long' && c < d.open) return [signal(s, 'failed-opening-drive', 'short', i, d.open, 'the open')];
    if (d.direction === 'short' && c > d.open) return [signal(s, 'failed-opening-drive', 'long', i, d.open, 'the open')];
  }
  return [];
}

function gapSetups(s: SetupSession): SetupSignal[] {
  const o = openIndex(s);
  if (o === null || !s.prior || !s.atr) return [];
  const open = s.bars[o].open, pc = s.prior.close, gap = open - pc;
  if (Math.abs(gap) < 0.3 * s.atr) return [];
  const e = lastBefore(s, o, OPEN_MIN + 15);
  if (e === null || s.minutes[e] < OPEN_MIN + 13) return [];
  const { hi, lo } = range(s, o, e);
  const c = s.bars[e].close;
  if (gap > 0) {
    if (c > open && lo >= pc + 0.5 * gap) return [signal(s, 'gap-and-go', 'long', e, open, 'the open')];
    if (c < open && c > pc) return [signal(s, 'gap-fill', 'short', e, open, 'the open', pc)];
  } else {
    if (c < open && hi <= pc + 0.5 * gap) return [signal(s, 'gap-and-go', 'short', e, open, 'the open')];
    if (c > open && c < pc) return [signal(s, 'gap-fill', 'long', e, open, 'the open', pc)];
  }
  return [];
}

function redToGreen(s: SetupSession): SetupSignal[] {
  const o = openIndex(s);
  if (o === null || !s.prior) return [];
  const pc = s.prior.close, open = s.bars[o].open;
  if (open === pc) return [];
  for (let i = o + 1; i < s.bars.length && s.minutes[i] < T(11, 0); i++) {
    if (s.minutes[i] < OPEN_MIN + 5) continue;
    const prev = s.bars[i - 1].close, c = s.bars[i].close;
    if (open < pc && prev <= pc && c > pc) return [signal(s, 'red-to-green', 'long', i, pc, 'prior close')];
    if (open > pc && prev >= pc && c < pc) return [signal(s, 'red-to-green', 'short', i, pc, 'prior close')];
  }
  return [];
}

function vwapSetups(s: SetupSession): SetupSignal[] {
  const o = openIndex(s);
  if (o === null) return [];
  const out: SetupSignal[] = [];
  let run = 0, side = 0;                 // consecutive closes on `side` of VWAP (−1 below, +1 above)
  let reclaim = false, reject = false;
  for (let i = o; i < s.bars.length && s.minutes[i] < T(14, 0); i++) {
    const b = s.bars[i], v = s.vwap[i];
    const here = b.close > v ? 1 : b.close < v ? -1 : 0;
    const inWindow = s.minutes[i] >= T(9, 0);
    if (inWindow && run >= 15) {
      if (!reclaim && here === -side) {
        out.push(signal(s, 'vwap-reclaim', side < 0 ? 'long' : 'short', i, v, 'VWAP'));
        reclaim = true;
      } else if (!reject && here === side && (side < 0 ? b.high >= v && b.close < b.open : b.low <= v && b.close > b.open)) {
        out.push(signal(s, 'vwap-rejection', side < 0 ? 'short' : 'long', i, v, 'VWAP'));
        reject = true;
      }
    }
    if (here !== 0 && here === side) run++; else { side = here; run = here === 0 ? 0 : 1; }
  }
  return out;
}

function vwapFirstPullback(s: SetupSession): SetupSignal[] {
  const d = openingDrive(s);
  if (!d) return [];
  for (let i = d.index + 1; i < s.bars.length && s.minutes[i] < T(10, 30); i++) {
    const b = s.bars[i], v = s.vwap[i], v10 = s.vwap[Math.max(0, i - 10)];
    const touched = d.direction === 'long' ? b.low <= v : b.high >= v;
    if (!touched) continue;
    const held = d.direction === 'long' ? b.close >= v && v > v10 : b.close <= v && v < v10;
    return held ? [signal(s, 'vwap-first-pullback', d.direction, i, v, 'VWAP')] : [];
  }
  return [];
}

function priorLevelBreakRetest(s: SetupSession): SetupSignal[] {
  const o = openIndex(s);
  if (o === null || !s.prior) return [];
  const out: SetupSignal[] = [];
  for (const [level, dir] of [[s.prior.high, 'long'], [s.prior.low, 'short']] as [number, Direction][]) {
    const beyond = (c: number) => dir === 'long' ? c > level : c < level;
    let broke: number | null = null;
    for (let i = o + 1; i < s.bars.length && s.minutes[i] < T(14, 0); i++) {
      const b = s.bars[i];
      if (s.minutes[i] < OPEN_MIN + 5) continue;
      if (broke === null) {
        if (beyond(b.close) && !beyond(s.bars[i - 1].close)) broke = i;
        continue;
      }
      if (!beyond(b.close)) { broke = null; continue; }        // closed back through: the break failed
      const touched = dir === 'long' ? b.low <= level * 1.001 : b.high >= level * 0.999;
      if (i - broke >= 5 && touched) { out.push(signal(s, 'prior-level-break-retest', dir, i, level, dir === 'long' ? 'prior-day high' : 'prior-day low')); break; }
    }
  }
  return out;
}

function overnightRangeBreak(s: SetupSession): SetupSignal[] {
  const o = openIndex(s);
  if (o === null || !s.overnight) return [];
  const { high, low } = s.overnight, open = s.bars[o].open;
  if (open > high || open < low) return [];
  for (let i = o; i < s.bars.length && s.minutes[i] < T(10, 0); i++) {
    const c = s.bars[i].close;
    if (c > high) return [signal(s, 'overnight-range-break', 'long', i, high, 'overnight high')];
    if (c < low) return [signal(s, 'overnight-range-break', 'short', i, low, 'overnight low')];
  }
  return [];
}

function liquiditySweep(s: SetupSession): SetupSignal[] {
  const o = openIndex(s);
  if (o === null || !s.atr) return [];
  const highs = [s.prior?.high, s.overnight?.high].filter((x): x is number => x !== undefined);
  const lows  = [s.prior?.low,  s.overnight?.low ].filter((x): x is number => x !== undefined);
  const out: SetupSignal[] = [];
  let doneShort = false, doneLong = false;
  for (let i = o + 1; i < s.bars.length && s.minutes[i] < T(14, 0); i++) {
    if (s.minutes[i] < OPEN_MIN + 15) continue;
    const b = s.bars[i], prevClose = s.bars[i - 1].close;
    // a poke: this bar trades through a level it opened... below, by a small amount
    for (const L of doneShort ? [] : highs) {
      if (!(prevClose < L && b.high > L && b.high - L <= 0.25 * s.atr)) continue;
      let extreme = b.high;
      for (let j = i; j < Math.min(s.bars.length, i + 5) && s.minutes[j] < T(14, 0); j++) {
        extreme = Math.max(extreme, s.bars[j].high);
        if (extreme - L > 0.25 * s.atr) break;             // not a poke any more: a real break
        if (s.bars[j].close < L && (j > i || b.close < L)) { out.push(signal(s, 'liquidity-sweep', 'short', j, extreme, 'sweep high')); doneShort = true; break; }
      }
      if (doneShort) break;
    }
    for (const L of doneLong ? [] : lows) {
      if (!(prevClose > L && b.low < L && L - b.low <= 0.25 * s.atr)) continue;
      let extreme = b.low;
      for (let j = i; j < Math.min(s.bars.length, i + 5) && s.minutes[j] < T(14, 0); j++) {
        extreme = Math.min(extreme, s.bars[j].low);
        if (L - extreme > 0.25 * s.atr) break;
        if (s.bars[j].close > L && (j > i || b.close > L)) { out.push(signal(s, 'liquidity-sweep', 'long', j, extreme, 'sweep low')); doneLong = true; break; }
      }
      if (doneLong) break;
    }
    if (doneShort && doneLong) break;
  }
  // A sweep is decided when price closes back inside — not when the poke
  // happens — so signals can be found out of bar order; return in time order.
  return out.sort((a, b) => a.index - b.index);
}

function flag(s: SetupSession): SetupSignal[] {
  const o = openIndex(s);
  if (o === null || !s.atr) return [];
  const atr = s.atr;
  for (let i = o + 16; i < s.bars.length && s.minutes[i] < T(14, 0); i++) {
    if (s.minutes[i] < OPEN_MIN + 15) continue;
    for (let len = 5; len <= 20; len++) {           // consolidation = bars[i-len .. i-1]
      const p = i - len - 1;                         // pole ends at p
      if (p - 1 < o) break;
      const cons = range(s, i - len, i - 1);
      for (let k = 1; k <= 10 && p - k >= o; k++) {
        const start = p - k;
        const move = s.bars[p].close - s.bars[start].open;
        if (Math.abs(move) < 0.4 * atr) continue;
        let path = 0;
        for (let q = start; q <= p; q++) path += Math.abs(s.bars[q].close - s.bars[q].open);
        if (path === 0 || Math.abs(move) / path < 0.6) continue;
        const h = Math.abs(move);
        if (cons.hi - cons.lo > 0.5 * h) continue;
        const c = s.bars[i].close;
        if (move > 0 && cons.lo >= s.bars[p].close - 0.5 * h && c > cons.hi) return [signal(s, 'flag', 'long', i, cons.lo, 'flag low')];
        if (move < 0 && cons.hi <= s.bars[p].close + 0.5 * h && c < cons.lo) return [signal(s, 'flag', 'short', i, cons.hi, 'flag high')];
      }
    }
  }
  return [];
}

function ripDump(s: SetupSession): SetupSignal[] {
  const o = openIndex(s);
  if (o === null) return [];
  for (let i = o + 5; i < s.bars.length && s.minutes[i] < CLOSE_MIN; i++) {
    let ref = 0;
    for (let k = i - 5; k < i; k++) ref += s.bars[k].close;
    ref /= 5;
    const m = s.minutes[i];
    const band = m < OPEN_MIN + 15 || m >= T(14, 35) ? 0.10 : 0.05;
    const c = s.bars[i].close;
    if (c >= ref * (1 + band)) return [signal(s, 'rip-dump', 'long', i, ref, 'band reference')];
    if (c <= ref * (1 - band)) return [signal(s, 'rip-dump', 'short', i, ref, 'band reference')];
  }
  return [];
}

export const DETECTORS: Record<string, (s: SetupSession) => SetupSignal[]> = {
  'orb-5':                    orb(5, 'orb-5'),
  'orb-15':                   orb(15, 'orb-15'),
  'orb-30':                   orb(30, 'orb-30'),
  'opening-drive':            openingDriveSetup,
  'failed-opening-drive':     failedOpeningDrive,
  'gap':                      gapSetups,            // emits gap-and-go or gap-fill
  'red-to-green':             redToGreen,
  'vwap':                     vwapSetups,           // emits vwap-reclaim and/or vwap-rejection
  'vwap-first-pullback':      vwapFirstPullback,
  'prior-level-break-retest': priorLevelBreakRetest,
  'overnight-range-break':    overnightRangeBreak,
  'liquidity-sweep':          liquiditySweep,
  'flag':                     flag,
  'rip-dump':                 ripDump,
};

/** Every setup's signals for a session, in time order. */
export function detectAll(s: SetupSession): SetupSignal[] {
  return Object.values(DETECTORS).flatMap((d) => d(s)).sort((a, b) => a.index - b.index);
}
