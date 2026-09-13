# Pre-registration — red-to-green is anti-predictive (holdout test)

**Written and committed 2026-09-13, before the holdout data was analysed.**
The git commit containing this file is the timestamp. Nothing below may be
changed after the run; a changed test is a new pre-registration.

## Where the hypothesis came from

The 48-ticker conjunction run (relay/backtests/conjunctions.ts, 2026-09-12)
reported 78 cells. One per-setup cell showed the same sign in BOTH halves
across three separate conjunctions, the only one of 78 to do so:

| cell | in-sample | out-of-sample |
|---|---|---|
| red-to-green ∧ 15m agrees (K2) | −7.1 pts, z −4.97 | −5.1 pts, z −3.16 |
| red-to-green ∧ 15m ∧ 60m (K3) | −6.9 pts, z −4.22 | −4.2 pts, z −2.29 |
| red-to-green ∧ prior POC (K4) | −5.4 pts, z −3.55 | −5.3 pts, z −3.12 |

## Why the test is NOT run on those 48 tickers

The pattern was found by looking at the 48-ticker data. Re-running the same
tickers over the same dates would reproduce the same numbers — it would test
the arithmetic, not the hypothesis. The test therefore uses tickers that
played no part in generating it.

## Sample

- **Tickers:** the 53 names in the 101-ticker optionable universe
  (ranked by dollar volume on 2026-09-10, option chain confirmed, ≥400
  sessions) that were NOT among the 48 already tested. Listed in
  `holdout_tickers.txt` in the run's scratch directory and reproduced here:
  SQQQ, HOOD, MSTR, BAC, ASML, WMT, UNH, COHR, USO, PANW, FCX, IREN, PG, CRWD,
  SHOP, EEM, NFLX, XBI, APP, JPM, XLF, CAT, V, HD, IBIT, IBM, GEV, SLV, XLI,
  XLV, JNJ, CSCO, VTI, RKLB, WFC, NU, NET, SNOW, GE, NEE, XOP, CRDO, NKE, HPE,
  MRK, MRNA, KO, XLK, PEP, SMCI, C, EWZ, MS.
- **Dates:** the same window and split as every other backtest here —
  evaluation from 2021-09-10, out of sample from 2024-09-10.
- **Population caveat, stated in advance:** these names rank lower by dollar
  volume than the 48 (roughly ranks 49–101), and include leveraged and
  crypto-linked products (SQQQ, IBIT, MSTR). A failure could be a population
  difference rather than a refutation, and a pass could be specific to less
  liquid names. Either outcome is reported with that caveat.
- **Detector, pricing, exits:** unchanged — `detectAll` from
  engine/setups/setups.ts, ATM 0DTE, trading-time Black-Scholes at M 1.0 (M 1.3
  reported), per-ticker spread (default 3% where none was measured), 30-minute
  exit, the identical entry taken the other way as the control.

## Hypothesis

H1: a red-to-green signal's direction loses to its mirror. The edge
(signal win rate minus mirror win rate, clustered by day) is negative.

## Tests — 1 primary, 4 secondary, nothing else

**Primary (the only test that can pass):** all red-to-green signals on the 53
holdout tickers, out of sample, edge clustered by DAY.
**Pass requires all of:**
1. one-sided z ≤ −2.33 (p < 0.01) out of sample;
2. edge negative in sample on the same holdout tickers (sign only);
3. the tickers in the rows do not overlap the 48 discovery tickers (a
   contamination guard, checked by the analysis script, fails loudly).

**Secondary (reported, never accepted on their own):** red-to-green ∧ K1, ∧ K2,
∧ K3, ∧ K4 on the holdout, out of sample. 4 cells.

**Cell count:** 5. The primary bar is set for one test because only one test
can pass; the secondaries cannot rescue a failed primary.

## What a pass would and would not mean

A pass establishes that **following** red-to-green loses on names that never
contributed to the hypothesis. It does NOT establish that **fading** it pays:
the round-trip asymmetry measured on K5 (following lost −8.2%, fading gained
only +4.0% on real prints) means a win-rate edge smaller than about 8 points is
presumed not tradeable. So a pass leads to exactly one next step — the mirror
on real 0DTE prints — and nothing is built on it before that.

A fail is reported as a fail, with the population caveat above, and the
hypothesis is closed.

## Analysis

`relay/backtests/r2gHoldout.ts`, committed with this file, reads the rows that
`conjunctions.ts` writes (`ROWS_OUT`) for the holdout run and applies exactly
the bars above. It prints PASS or FAIL for the primary; it has no parameters
that change the bar.
