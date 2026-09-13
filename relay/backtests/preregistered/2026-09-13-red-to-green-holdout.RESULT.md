# Result — red-to-green holdout (pre-registration 76ab65e)

Run 2026-09-13 on the 53 holdout tickers, after the pre-registration commit. Raw output of relay/backtests/r2gHoldout.ts, unedited:

```
Red-to-green holdout — 29875 signals on 53 tickers (none in the discovery set)

PRIMARY — all red-to-green, day-clustered, M 1.0
  in sample      n=18024 days=752 win 39.9% mirror 44.2% edge -4.3 pts z -4.46
  out of sample  n=11851 days=502 win 39.7% mirror 43.2% edge -3.6 pts z -3.22
  bar 1  OOS one-sided z <= -2.33: met
  bar 2  in-sample edge negative:      met
  bar 3  no discovery tickers:          met
  VERDICT: PASS — following red-to-green loses on names that never generated the hypothesis. Next and only step: the mirror on real 0DTE prints.

  robustness (not part of the bar) M 1.3 out of sample: n=11851 days=502 win 37.2% mirror 40.8% edge -3.6 pts z -3.28

SECONDARY — reported, never accepted on their own (4 cells)
  K1 in-play         n=1658 days=450 win 42.0% mirror 42.2% edge -0.2 pts z -0.06
  K2 15m agrees      n=7992 days=502 win 38.4% mirror 42.9% edge -4.5 pts z -3.59
  K3 15m and 60m     n=4263 days=500 win 38.7% mirror 41.1% edge -2.4 pts z -1.44
  K4 prior POC side  n=7719 days=502 win 39.8% mirror 43.1% edge -3.3 pts z -2.46
```
