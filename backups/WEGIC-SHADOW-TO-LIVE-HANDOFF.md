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

**Do not start Part B until Part A has produced at least two weeks of rows.** The
shadow-signal log is what makes step 2 checkable: it is the record of what the
engine decided, which is exactly what the diff in step 2 compares.

1. **Diff the engine against the browser on the same live data.**
   Run both for a full session and compare, per ticker and minute: signal type,
   confidence, trigger price. `engine_shadow_signals` holds the engine's side;
   `signals` holds the browser's. They must match in count and in type before
   anything flips. Any systematic difference is a bug in one of them — find it
   first. (CLAUDE.md, SHADOW MODE: "only flip to live when they match".)

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
