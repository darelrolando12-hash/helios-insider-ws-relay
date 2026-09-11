/**
 * Gate 1 — the pre-market fingerprint, as it stands at 08:25 CT.
 *
 * "Be ready before the bell": which tickers are likely to make a large, clean
 * opening move. Pure — prior session, after-hours and pre-market bars in,
 * fingerprint out — so the engine at 08:25 and the five-year backtest
 * (relay/backtests/premarket.ts) run the same code.
 *
 * ── What the backtest showed (8 tickers, 2021-09 → 2026-09, 9,865 sessions) ─
 * A CLEAN DIRECTIONAL OPEN (label fixed before any predictor was examined):
 * the first 30 minutes' range ≥ 1.5× its 20-session median, net move ≥ 50%
 * of that range, excursion against the move ≤ 25% of it, and at most half
 * the peak move given back. 903 such opens; base rate 8.6% in sample, 10.0%
 * out of sample (after 2024-09-10).
 *
 * MAGNITUDE — PREDICTABLE. With pre-market volume ≥ 1.388× its 20-day
 * average, P(clean open) = 17.4% in sample and 16.4% out of sample (vs
 * 8.6% / 10.0%); adding |gap| ≥ 0.455 ATR, 16.9% / 18.7%. Pre-market range
 * (16.4% / 15.3%) and the prior day's range carry the same kind of lift; the
 * gap alone much less (12.2% / 13.4%). `inPlay` is the volume test.
 *
 * DIRECTION — WEAK, AND ONLY ONE WAY. On in-play days the open tends to FADE
 * the gap. Model-priced, fade beat follow by 2.5 / 4.4 points of 30-minute
 * win rate (in / out of sample, ~1 SE each). On REAL 0DTE prints, out of
 * sample, 424 in-play days with a same-day expiry: fade 44.3% win, mean
 * +6.8% ± 8.8; follow 32.5%, −10.6%; fade − follow z = 2.8. Following the
 * gap at the open is the losing side; fading it only just clears the 43.8%
 * break-even and its mean is not distinguishable from zero. `fadeDirection`
 * is reported as information, not as a trade.
 *
 * The case that started this — AAPL, 2026-09-11, +2% by 08:39 — was NOT in
 * play by this fingerprint: gap −0.2%, pre-market volume 0.57× average,
 * a flat pre-market (efficiency 0.006, 7th percentile). Its only extreme
 * readings were the prior day (+3.1%, closed at 98.6% of its range).
 *
 * Thresholds are the in-sample (2021-09 → 2024-09) top-quintile cuts, fixed
 * before the out-of-sample test. Changing one is a backtest re-run.
 */

export interface PremarketBar {
  open:   number;
  high:   number;
  low:    number;
  close:  number;
  volume: number;
}

export interface PremarketInput {
  /** The previous regular session (8:30–15:00 CT), ascending. */
  priorSession: readonly PremarketBar[];
  /** The previous day's after-hours (15:00–19:00 CT). */
  afterHours:   readonly PremarketBar[];
  /** Today's pre-market bars up to the decision (03:00–08:25 CT). */
  premarket:    readonly PremarketBar[];
  /** 14-session average true range of prior regular sessions. */
  atr:          number | null;
  /** Mean pre-market volume over the same window, prior 20 sessions. */
  premarketVolumeAvg20: number | null;
}

export const IN_PLAY = {
  /** Pre-market volume ÷ its 20-session average. */
  PM_VOLUME_RATIO: 1.388,
  /** Pre-market high − low, in ATRs. */
  PM_RANGE_ATR:    0.646,
  /** |gap| of the last pre-market price vs the prior close, in ATRs. */
  GAP_ATR:         0.455,
} as const;

/** Fewer pre-market bars than this and the fingerprint is absent. */
export const MIN_PREMARKET_BARS = 10;

export type PremarketFingerprint =
  | { dataQuality: 'absent'; reason: string }
  | {
      dataQuality: 'real';
      prevClose:            number;
      last:                 number;
      gapPct:               number;
      gapAtr:               number;
      overnightRangeAtr:    number;
      premarketRangeAtr:    number;
      premarketVolumeRatio: number | null;
      /** |net| ÷ path of the pre-market closes: 1 = one straight line, 0 = flat. */
      premarketEfficiency:  number;
      premarketDirection:   -1 | 0 | 1;
      /** Where the last price sits in the overnight range (0 = low, 1 = high). */
      lastLocation:         number;
      priorReturn:          number;
      /** Where the prior close sat in the prior day's range (0 = low, 1 = high). */
      priorCloseLocation:   number;
      priorRangeAtr:        number;
      inPlay:               boolean;
      inPlayReasons:        string[];
      /** The side a gap fade would take — information only (see header). */
      fadeDirection:        'long' | 'short' | null;
    };

export function premarketFingerprint(input: PremarketInput): PremarketFingerprint {
  const { priorSession: ps, afterHours: ah, premarket: pm, atr } = input;
  if (ps.length === 0) return { dataQuality: 'absent', reason: 'no prior regular session' };
  if (pm.length < MIN_PREMARKET_BARS) return { dataQuality: 'absent', reason: `only ${pm.length} pre-market bars` };
  if (!(atr !== null && atr > 0)) return { dataQuality: 'absent', reason: 'no ATR history' };

  const hi = (bars: readonly PremarketBar[]) => Math.max(...bars.map((b) => b.high));
  const lo = (bars: readonly PremarketBar[]) => Math.min(...bars.map((b) => b.low));
  const prevClose = ps[ps.length - 1].close, prevOpen = ps[0].open;
  const prevHigh = hi(ps), prevLow = lo(ps);
  const last = pm[pm.length - 1].close;
  const on = [...ah, ...pm];
  const onHigh = hi(on), onLow = lo(on);
  const pmHigh = hi(pm), pmLow = lo(pm);
  let path = 0;
  for (let k = 1; k < pm.length; k++) path += Math.abs(pm[k].close - pm[k - 1].close);
  const net = last - pm[0].open;
  const volume = pm.reduce((a, b) => a + b.volume, 0);
  const avg = input.premarketVolumeAvg20;
  const volumeRatio = avg !== null && avg > 0 ? volume / avg : null;

  const gapAtr = (last - prevClose) / atr;
  const pmRangeAtr = (pmHigh - pmLow) / atr;
  // In play = pre-market volume alone. Chosen on the in-sample numbers:
  // volume 17.4% P(clean), range 16.4%, gap 12.2%, and "any of the three"
  // only 13.8% — the gap trigger dilutes it. Range and gap are still noted.
  const inPlay = volumeRatio !== null && volumeRatio >= IN_PLAY.PM_VOLUME_RATIO;
  const reasons: string[] = [];
  if (inPlay) reasons.push(`pre-market volume ${volumeRatio!.toFixed(2)}× average`);
  if (pmRangeAtr >= IN_PLAY.PM_RANGE_ATR) reasons.push(`(note) pre-market range ${pmRangeAtr.toFixed(2)} ATR`);
  if (Math.abs(gapAtr) >= IN_PLAY.GAP_ATR) reasons.push(`(note) gap ${gapAtr.toFixed(2)} ATR`);

  return {
    dataQuality: 'real',
    prevClose, last,
    gapPct: last / prevClose - 1, gapAtr,
    overnightRangeAtr: (onHigh - onLow) / atr,
    premarketRangeAtr: pmRangeAtr,
    premarketVolumeRatio: volumeRatio,
    premarketEfficiency: path > 0 ? Math.abs(net) / path : 0,
    premarketDirection: net > 0 ? 1 : net < 0 ? -1 : 0,
    lastLocation: onHigh > onLow ? (last - onLow) / (onHigh - onLow) : 0.5,
    priorReturn: prevClose / prevOpen - 1,
    priorCloseLocation: prevHigh > prevLow ? (prevClose - prevLow) / (prevHigh - prevLow) : 0.5,
    priorRangeAtr: (prevHigh - prevLow) / atr,
    inPlay,
    inPlayReasons: reasons,
    fadeDirection: last > prevClose ? 'short' : last < prevClose ? 'long' : null,
  };
}

/** The label the backtest scores against — a clean directional open. */
export function isCleanOpen(first30: readonly PremarketBar[], usualRange30: number): { clean: boolean; direction: -1 | 0 | 1 } {
  if (first30.length === 0 || !(usualRange30 > 0)) return { clean: false, direction: 0 };
  const o = first30[0].open, c = first30[first30.length - 1].close;
  const h = Math.max(...first30.map((b) => b.high)), l = Math.min(...first30.map((b) => b.low));
  const R = h - l, net = c - o, dir = net > 0 ? 1 : net < 0 ? -1 : 0;
  if (R <= 0 || dir === 0) return { clean: false, direction: 0 };
  const fav = dir > 0 ? h - o : o - l, adv = dir > 0 ? o - l : h - o;
  const giveback = fav > 0 ? (fav - Math.abs(net)) / fav : 1;
  return { clean: R >= 1.5 * usualRange30 && Math.abs(net) >= 0.5 * R && adv <= 0.25 * R && giveback <= 0.5, direction: dir };
}
