-- signal_outcomes — close the same permission gap just found and fixed on
-- gex_regime_log and engine_shadow_signals (2026-09-13).
--
-- Found by Wegic, unprompted, while checking whether the same schema-default
-- over-grant existed on production tables: `signal_outcomes` has the same raw
-- grant to anon as every other table here (DELETE, INSERT, REFERENCES,
-- SELECT, TRIGGER, TRUNCATE, UPDATE), but — unlike `signals`, whose UPDATE
-- policy narrows to one real state transition (status='pending' -> status IN
-- ('resolved','expired')) — its UPDATE policy is unconditioned: using(true),
-- with check(true). Confirmed reachable through the ordinary REST client
-- (PostgREST exposes `patch` for anon on this table).
--
-- Real impact: anyone with the public anon key could rewrite pnl_pct, result,
-- exit_price or exit_tct on any resolved signal's outcome — the historical
-- record Brain's win-rate stats and every backtest-vs-forward comparison in
-- this project reads as ground truth.
--
-- The fix is NOT column-scoping (unlike gex_regime_log): outcomeResolver.ts's
-- upsert legitimately writes every column in OutcomeRow on every call, so
-- restricting to a subset of columns would break the real write path. The
-- real guardrail, checked against outcomeResolver.ts's actual behaviour
-- (relay/engine/ledger/outcomeResolver.ts): it only ever queries signals
-- WHERE status = 'pending' (line 126), and a signal's status only ever
-- becomes 'resolved' or 'expired' once — never back to 'pending'. So a
-- legitimate write to signal_outcomes can only ever target a row whose
-- PARENT signal is still pending. This is the exact same state-machine
-- discipline the `signals` table's own policy already uses; the equivalent
-- guardrail here is scoped through the foreign key instead of a local column.
--
-- TRUNCATE is not reachable through PostgREST (no HTTP verb for it) — not
-- fixed here for the same reason it wasn't fixed on the other two tables,
-- though revoking ALL removes it too as a side effect.
--
-- ── Round 1 of this fix was incomplete — corrected 2026-09-13 ──────────────
-- The first version below only did `drop policy if exists signal_outcomes_update`
-- before creating the new one, on the wrong assumption that any pre-existing
-- UPDATE policy would share that name. It didn't: the original unrestricted
-- policy already had its own name, `anon_update_outcomes`, from whenever this
-- table was first set up — unknown to us until Wegic ran a full pg_policies
-- listing and reported it back. Postgres runs multiple PERMISSIVE policies
-- for the same command as an OR: a row is allowed through if it satisfies
-- ANY of them. So the old unconditioned policy stayed active side by side
-- with the new restricted one, and the table was exactly as open as before —
-- adding a stricter policy does not override a looser one under a different
-- name; the looser one has to be dropped explicitly, by its real name.
-- The general lesson: `drop policy if exists <name-you-expect>` is only safe
-- when you know every existing policy's actual name — list them first
-- (`select policyname from pg_policies where tablename = '<table>'`) rather
-- than assume, especially on a table this session did not create itself.
--
-- Safe to run more than once.

revoke all on public.signal_outcomes from anon;
grant select, insert, update on public.signal_outcomes to anon;
-- (the sequence/id grant, if any, is unchanged by this file — signal_outcomes'
-- primary key convention was not part of this investigation)

-- The original permissive policy, name confirmed by Wegic 2026-09-13 — must
-- be dropped explicitly, not assumed away by dropping our own policy's name.
drop policy if exists anon_update_outcomes on public.signal_outcomes;
drop policy if exists signal_outcomes_update on public.signal_outcomes;
create policy signal_outcomes_update on public.signal_outcomes
  for update to anon
  using (
    exists (
      select 1 from public.signals s
      where s.id = signal_outcomes.signal_id and s.status = 'pending'
    )
  )
  with check (
    exists (
      select 1 from public.signals s
      where s.id = signal_outcomes.signal_id and s.status = 'pending'
    )
  );

-- Verify immediately after running:
--   select privilege_type
--   from information_schema.role_table_grants
--   where table_schema = 'public' and table_name = 'signal_outcomes' and grantee = 'anon'
--   order by 1;
-- Expected: INSERT, SELECT, UPDATE only — no DELETE, TRUNCATE, REFERENCES, TRIGGER.
--
--   select policyname, cmd, qual, with_check
--   from pg_policies
--   where tablename = 'signal_outcomes'
--   order by cmd, policyname;
-- List every row — do not just check for the one you expect. Confirm by eye:
-- exactly ONE row with cmd = 'UPDATE', named signal_outcomes_update, and its
-- qual/with_check both reference signals.status = 'pending'. If a second
-- UPDATE row shows up under any other name, it must be dropped by that name
-- before this table is actually fixed — send the full list back either way.
--
-- Verify it does not break the live write path (run this AFTER the next
-- resolution pass while the market is open — outcomeResolver polls every 60s):
--   select count(*) from public.signal_outcomes where created_at > now() - interval '10 minutes';
-- Expected: > 0 on any session with at least one pending signal aged past its
-- first 5-minute window. If this stays 0 while signals are actively pending,
-- the policy is blocking a legitimate write — check Railway logs for
-- "[outcomeResolver] Upsert failed" and report back before assuming success.
