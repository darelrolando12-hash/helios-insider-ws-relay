# Shadow → live cutover — ordered handoff

**Status: prepared, not scheduled. This is Darel's decision, not an engineering step.**

The engine has been running in `ENGINE_MODE=shadow` since it went up: it computes
everything and logs what it *would* write. The browser still writes. Flipping the
engine to `live` while browsers also write produces duplicate rows in `signals`,
`signal_outcomes` and every ingestion table — the exact failure shadow mode exists
to prevent. So the flip and the browser-write disable are **one step, not two**.

Two migrations below are independent of the cutover and can run any time. The
cutover itself has an order that matters.

---

## Part A — migrations that can run now (no cutover needed)

These two tables are written by the engine's *observation* path, which shadow mode
deliberately does not gate. Nothing else writes them, so there is no duplicate-write
risk at any point.

1. **`backups/gex-regime-log-table.sql`** — the gamma-regime forward log.
   Urgency: every session without it is a session that can never be tested for
   regime interaction. The flip is the only model input that cannot be re-fetched
   from vendor history (snapshots ignore `as_of`, no open-interest endpoint, no OI
   in option aggregates). Bars, trades, quotes and option prices can all be
   re-fetched; this cannot.

2. **`backups/engine-shadow-signals-table.sql`** — every signal the engine decides
   on while shadow mode stops it writing. Railway keeps only a few hundred log
   lines, so without this the decisions are discarded as they are made.

**Verify after one session:**

```sql
select session_date, ticker, count(*), count(flip_level) as with_flip,
       count(fwd_30m_pct) as with_outcome
from public.gex_regime_log group by 1,2 order by 1 desc, 2 limit 20;

select session_date, signal_type, count(*)
from public.engine_shadow_signals group by 1,2 order by 1 desc, 3 desc;
```

Until they exist the engine logs `MIGRATION NOT RUN: create table …` once per boot,
naming the file. That line in Railway is the signal that this part is still pending.

---

## Part B — the cutover itself, in order

### Prerequisites — all four, or the diff fails for reasons that are not bugs

- **Part A is live and populating.** `engine_shadow_signals` is the engine's side
  of the diff; with no table there is nothing to compare.
- **The comprehensive UI handoff (Package 2) is live on Wegic.** Wegic's current
  build has no signal hysteresis, so a score hovering around a threshold
  re-emits on every crossing (measured: 20 emissions → 1 on a replayed hovering
  score). The engine has the hysteresis. Diffing before Package 2 compares a
  flapping browser against a debounced engine and "fails" every session.
- **A browser tab is open from before 08:30 CT until 15:00 CT on each diff
  session.** The browser has no CVD rebuild — its CVD starts when the page
  loads — so a tab opened at 10:00 scores a different CVD (25 of 100 points)
  all day and fires at different moments. Open the app before the bell and
  leave it open; sessions without that are not qualifying sessions.
- **SPX and NDX are excluded.** The engine deliberately does not score them
  (index products print no trades); the browser still does.

### What "matching" means, numerically

A browser row and an engine row **match** when they have the same `ticker` and
the same signal type, and their fire times are within **120 seconds**
(`abs(engine_shadow_signals.fired_at − signals.entry_utc) ≤ 120000`), paired
one-to-one, earliest first. Both columns hold the UTC millisecond the signal
fired in its own process, so a small gap is expected; two minutes is generous.

A **qualifying session passes** when all of these hold:

| check | threshold |
|---|---|
| engine recall — share of engine signals with a browser match | ≥ 90% |
| browser recall — share of browser signals with an engine match | ≥ 90% |
| confidence gap on matched pairs, `abs(confidence − conviction)` | median ≤ 3 pts, 95th percentile ≤ 8 pts |
| price gap on matched pairs, `abs(trigger_price − entry_price) / entry_price` | median ≤ 0.05% |

**The cutover gate:** three consecutive qualifying sessions pass, AND across
those three sessions no single ticker or signal type with at least 10 signals
has recall below 75% in either direction. A pass on totals that hides one
systematically missing ticker is not a pass.

This replaces "wait two weeks": the diff needs enough sessions to expose a
systematic difference, not a large sample. Three clean sessions is that.

### The diff query (run once per session date)

```sql
with e as (
  select id, ticker, signal_type, confidence, trigger_price, fired_at
  from public.engine_shadow_signals
  where session_date = date '2026-09-14'            -- the session to check
    and ticker not in ('SPX', 'NDX')
), b as (
  select id, ticker, signal_type, conviction, entry_price, entry_utc
  from public.signals
  where to_timestamp(entry_utc / 1000.0) at time zone 'America/Chicago' >= timestamp '2026-09-14 08:30'
    and to_timestamp(entry_utc / 1000.0) at time zone 'America/Chicago' <  timestamp '2026-09-14 15:00'
    and ticker not in ('SPX', 'NDX')
    and coalesce(is_backtested, false) = false
), pairs as (
  -- nearest browser row within 120 s for each engine row
  select distinct on (e.id) e.id as eid, b.id as bid, e.ticker, e.signal_type,
         abs(e.confidence - b.conviction)                  as conf_gap,
         abs(e.trigger_price - b.entry_price) / b.entry_price as price_gap
  from e join b
    on b.ticker = e.ticker and b.signal_type = e.signal_type
   and abs(e.fired_at - b.entry_utc) <= 120000
  order by e.id, abs(e.fired_at - b.entry_utc)
), one_to_one as (
  select distinct on (bid) * from pairs order by bid, conf_gap
)
select
  (select count(*) from e)                                              as engine_signals,
  (select count(*) from b)                                              as browser_signals,
  count(*)                                                              as matched,
  round(count(*)::numeric / nullif((select count(*) from e), 0), 3)    as engine_recall,
  round(count(*)::numeric / nullif((select count(*) from b), 0), 3)    as browser_recall,
  percentile_cont(0.5)  within group (order by conf_gap)                as conf_gap_median,
  percentile_cont(0.95) within group (order by conf_gap)                as conf_gap_p95,
  percentile_cont(0.5)  within group (order by price_gap)               as price_gap_median
from one_to_one;
```

For the per-ticker check, add `group by ticker` (and separately `group by
signal_type`) to the final select, with the same counts computed per group.

1. **Run the diff** on each qualifying session until the gate above passes. Any
   systematic difference is a bug in one of the two engines — find and fix it
   first, then restart the count of three.

2. **Disable browser writes, in the same deploy as the flip.**
   Wegic side: stop `signalLedger` / ingestion writes in the browser build.
   Railway side: set `ENGINE_MODE=live`.
   These two must land together. If the browser stops writing first, nothing is
   recorded until Railway redeploys; if the engine goes live first, every row is
   written twice.

3. **Confirm in the first live session:**

```sql
-- no duplicates on the natural key (the index added in round 1 makes this
-- impossible, so a non-zero result means the index is gone)
select ticker, entry_tct, direction, signal_type, count(*)
from public.signals where entry_tct::date = current_date
group by 1,2,3,4 having count(*) > 1;

-- and that rows are arriving at all
select count(*), min(entry_utc), max(entry_utc)
from public.signals where entry_tct::date = current_date;
```

4. **Then, and only then, paper execution.** `paperExecution.ts` is not wired into
   the engine's boot at all today. Wiring it is a separate change after the
   cutover is proven, and it carries its own known gap: the ladder path passes
   `side: 'buy'` where the type (and the direct path) uses `'BUY'` — two of the
   four errors in the relay type-check baseline. Fix that before any order path
   runs, paper or not.

---

## Rollback

Set `ENGINE_MODE=shadow` and redeploy; re-enable browser writes on the Wegic side.
The engine stops writing within one deploy. Rows already written stay — the unique
index (`signals_natural_key_uniq`) means a re-run cannot duplicate them.

---

## What the cutover is worth

Every backtest in `relay/backtests` can be wrong about its own assumptions. A
forward record of live decisions, with real timestamps and real outcomes, is the
one test that cannot be. Six rounds of backtesting found no directional edge that
survives out of sample; the forward record is how that conclusion gets checked
against reality rather than against another model.
