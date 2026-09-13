/**
 * Confirmed anti-signals — setups whose own direction loses to the identical
 * trade taken the other way, confirmed on data that played no part in finding
 * them.
 *
 * They are BLOCKERS, not fades. Following one loses; that does not make the
 * opposite trade pay. The round trip (spread plus decay) is paid in either
 * direction: on K5 following lost −8.2% while fading gained only +4.0% on real
 * option prices, which is why the pre-registration set ~8 points as the floor
 * below which an edge is presumed untradeable. So the value of an entry here
 * is the block: nothing may present it as an entry.
 *
 * ── Not consulted by any live path yet ─────────────────────────────────────
 * No engine or cockpit acts on engine/setups/setups.ts detections today —
 * they exist only in relay/backtests. Any future path that turns a setup into
 * a displayed entry must call antiSignalBlock() first and surface its scope.
 *
 * ── Scope, stated where it is used ─────────────────────────────────────────
 * The confirmation ran on 53 less-liquid names (roughly ranks 49–101 of the
 * optionable universe by dollar volume), including leveraged and crypto-linked
 * products. The effect was first found on the 48 most liquid names — same sign
 * in both halves there — but that is discovery, not independent confirmation.
 * Everything else is untested. The block applies everywhere; `scope` says how
 * far the evidence actually reaches for the ticker in hand, so a UI can say
 * "confirmed" or "extrapolated" instead of implying the same certainty.
 */

export type AntiSignalScope = 'confirmed' | 'discovered' | 'untested';

export interface AntiSignal {
  setup:        string;
  summary:      string;
  /** Out-of-sample holdout result: day-clustered edge versus the mirror, in points. */
  holdout:      { edgePts: number; z: number; signals: number; days: number };
  inSample:     { edgePts: number; z: number };
  preRegistration: string;
  result:       string;
  /** Tickers the holdout confirmed it on — none of them helped generate the hypothesis. */
  confirmedOn:  readonly string[];
  /** Tickers where it was found (same sign in both halves) but not independently confirmed. */
  discoveredOn: readonly string[];
}

export const ANTI_SIGNALS: readonly AntiSignal[] = [
  {
    setup: 'red-to-green',
    summary:
      'Gap against the prior close, then the first close back through it. The signal direction lost to the ' +
      'opposite trade on names that played no part in finding it; the effect held its size on new data.',
    holdout:  { edgePts: -3.6, z: -3.22, signals: 11_851, days: 502 },
    inSample: { edgePts: -4.3, z: -4.46 },
    preRegistration: 'relay/backtests/preregistered/2026-09-13-red-to-green-holdout.md (commit 76ab65e)',
    result:          'relay/backtests/preregistered/2026-09-13-red-to-green-holdout.RESULT.md (commit bd18d5e)',
    confirmedOn: [
      'SQQQ', 'HOOD', 'MSTR', 'BAC', 'ASML', 'WMT', 'UNH', 'COHR', 'USO', 'PANW', 'FCX', 'IREN', 'PG', 'CRWD',
      'SHOP', 'EEM', 'NFLX', 'XBI', 'APP', 'JPM', 'XLF', 'CAT', 'V', 'HD', 'IBIT', 'IBM', 'GEV', 'SLV', 'XLI',
      'XLV', 'JNJ', 'CSCO', 'VTI', 'RKLB', 'WFC', 'NU', 'NET', 'SNOW', 'GE', 'NEE', 'XOP', 'CRDO', 'NKE', 'HPE',
      'MRK', 'MRNA', 'KO', 'XLK', 'PEP', 'SMCI', 'C', 'EWZ', 'MS',
    ],
    discoveredOn: [
      'SPY', 'QQQ', 'IWM', 'AAPL', 'TSLA', 'NVDA', 'META', 'AMD',
      'MU', 'IVV', 'VOO', 'INTC', 'ORCL', 'AVGO', 'MSFT', 'GOOGL', 'AMZN', 'SOXL', 'GOOG', 'TLT',
      'GLD', 'TQQQ', 'MRVL', 'SMH', 'TSM', 'PLTR', 'SOXX', 'LRCX', 'DELL', 'NBIS', 'BE', 'QCOM',
      'XOM', 'EWY', 'SOXS', 'CRM', 'ADBE', 'UBER', 'VRT', 'DIA', 'XLE', 'LLY', 'AMAT', 'GDX',
      'WDC', 'SGOV', 'CVX', 'GS',
    ],
  },
];

export type AntiSignalBlock =
  | { blocked: false }
  | { blocked: true; setup: string; scope: AntiSignalScope; reason: string };

/**
 * Whether a detected setup must be blocked from being shown as an entry.
 * Applies to every ticker; the scope says how far the evidence reaches.
 */
export function antiSignalBlock(setup: string, ticker: string): AntiSignalBlock {
  const a = ANTI_SIGNALS.find((x) => x.setup === setup);
  if (!a) return { blocked: false };
  const t = ticker.toUpperCase();
  const scope: AntiSignalScope = a.confirmedOn.includes(t) ? 'confirmed' : a.discoveredOn.includes(t) ? 'discovered' : 'untested';
  const reach =
    scope === 'confirmed'  ? `confirmed out of sample on ${t}'s holdout set` :
    scope === 'discovered' ? `found on ${t}'s set but not independently confirmed there` :
                             `never tested on ${t} — the block is an extrapolation`;
  return {
    blocked: true, setup, scope,
    reason: `${setup} loses to its opposite trade (holdout ${a.holdout.edgePts} pts, z ${a.holdout.z}); ${reach}.`,
  };
}
