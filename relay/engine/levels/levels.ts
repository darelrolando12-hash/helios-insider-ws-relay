/**
 * Price levels — the reference prices setups break, retest, sweep and target.
 *
 * Pure: bars in, levels out. No stores, no clock, no network — the Gate 4
 * setup detectors (engine/setups/setups.ts) read these in their five-year
 * backtest (relay/backtests/setups.ts) and live, and the adaptive exit will
 * read the same object later.
 *
 *   prior-high / prior-low / prior-close   the previous REGULAR session
 *   overnight-high / overnight-low         previous after-hours + today's
 *                                          pre-market (the minute feed has no
 *                                          20:00–04:00 ET overnight session —
 *                                          measured: no bars 19:00–03:00 CT)
 *   session-high / session-low             today's regular session so far
 *   poc / value-high / value-low           the previous regular session's
 *                                          volume profile: the busiest price
 *                                          bin and the band holding 70% of
 *                                          its volume around it
 *   round                                  the nearest round numbers above and
 *                                          below price, at a step sized to the
 *                                          price (roundStep)
 *
 * Absent is absent: a level whose inputs are missing is left out, never
 * filled with a stand-in price.
 */

export interface LevelBar {
  high:   number;
  low:    number;
  close:  number;
  volume: number;
}

export type LevelKind =
  | 'prior-high' | 'prior-low' | 'prior-close'
  | 'overnight-high' | 'overnight-low'
  | 'session-high' | 'session-low'
  | 'poc' | 'value-high' | 'value-low'
  | 'round';

export interface Level {
  kind:  LevelKind;
  price: number;
}

export interface LevelInput {
  /** Previous regular session's bars (for H/L/C and the volume profile). */
  priorSession: readonly LevelBar[];
  /** Previous after-hours + today's pre-market. */
  overnight:    readonly LevelBar[];
  /** Today's regular-session bars so far. */
  session:      readonly LevelBar[];
  /** Current price — anchors the round numbers. */
  price:        number;
}

/** Share of a session's volume the value area holds (the conventional 70%). */
export const VALUE_AREA_SHARE = 0.7;

/**
 * Volume profile of `bars`: volume per price bin (each bar's volume spread
 * evenly across the bins its range covers), its point of control, and the
 * value area grown outward from the POC until it holds VALUE_AREA_SHARE.
 * Null when there is no volume.
 */
export function volumeProfile(bars: readonly LevelBar[], binWidth: number): { poc: number; valueHigh: number; valueLow: number } | null {
  const traded = bars.filter((b) => b.volume > 0);
  if (traded.length === 0 || !(binWidth > 0)) return null;
  // The epsilon keeps a price on a bin edge in its own bin: 10.2 / 0.1 is
  // 101.99999999999999 in floating point, and a bare floor files it one low.
  const bin = (x: number) => Math.floor(x / binWidth + 1e-9);
  const base = bin(Math.min(...traded.map((b) => b.low)));
  const top  = bin(Math.max(...traded.map((b) => b.high)));
  const vol = new Array<number>(top - base + 1).fill(0);
  let total = 0;
  for (const b of traded) {
    const lo = bin(b.low) - base, hi = bin(b.high) - base;
    for (let k = lo; k <= hi; k++) vol[k] += b.volume / (hi - lo + 1);
    total += b.volume;
  }
  let poc = 0;
  for (let k = 1; k < vol.length; k++) if (vol[k] > vol[poc]) poc = k;
  // Grow the value area one bin at a time toward the heavier neighbour.
  let lo = poc, hi = poc, held = vol[poc];
  while (held < VALUE_AREA_SHARE * total && (lo > 0 || hi < vol.length - 1)) {
    const up = hi < vol.length - 1 ? vol[hi + 1] : -1;
    const dn = lo > 0 ? vol[lo - 1] : -1;
    if (up >= dn) held += vol[++hi]; else held += vol[--lo];
  }
  return { poc: (base + poc + 0.5) * binWidth, valueHigh: (base + hi + 1) * binWidth, valueLow: (base + lo) * binWidth };
}

/** Round-number step for a price: 1 below $50, 5 below $200, 10 below $1,000, else 50. */
export function roundStep(price: number): number {
  return price < 50 ? 1 : price < 200 ? 5 : price < 1000 ? 10 : 50;
}

export function computeLevels(input: LevelInput): Level[] {
  const out: Level[] = [];
  const hl = (bars: readonly LevelBar[]) => bars.length
    ? { high: Math.max(...bars.map((b) => b.high)), low: Math.min(...bars.map((b) => b.low)) }
    : null;

  const p = hl(input.priorSession);
  if (p) {
    out.push({ kind: 'prior-high', price: p.high }, { kind: 'prior-low', price: p.low });
    out.push({ kind: 'prior-close', price: input.priorSession[input.priorSession.length - 1].close });
    // Bins of 0.05% of price: fine enough to separate nodes on SPY (~$0.38),
    // coarse enough that one session fills them.
    const vp = volumeProfile(input.priorSession, input.priorSession[input.priorSession.length - 1].close * 0.0005);
    if (vp) out.push({ kind: 'poc', price: vp.poc }, { kind: 'value-high', price: vp.valueHigh }, { kind: 'value-low', price: vp.valueLow });
  }
  const o = hl(input.overnight);
  if (o) out.push({ kind: 'overnight-high', price: o.high }, { kind: 'overnight-low', price: o.low });
  const s = hl(input.session);
  if (s) out.push({ kind: 'session-high', price: s.high }, { kind: 'session-low', price: s.low });

  if (input.price > 0) {
    const step = roundStep(input.price);
    const below = Math.floor(input.price / step) * step;
    out.push({ kind: 'round', price: below });
    out.push({ kind: 'round', price: below + step });
  }
  return out;
}
