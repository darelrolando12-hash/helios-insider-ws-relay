-- engine_shadow_signals — every signal the engine decides on while it runs in
-- shadow mode, recorded as an observation.
--
-- Why: the engine already scores and decides continuously; in shadow its
-- writes are intercepted and logged instead of executed, and Railway's log
-- buffer holds only the last few hundred lines. A forward record of live
-- decisions with real timestamps is the one test a backtest cannot be wrong
-- about, and it is also the engine's side of the diff that must pass before
-- the shadow -> live cutover.
--
-- Written by relay/engine/session/shadowSignalLog.ts with the ANON key,
-- through the observation-only client. Nothing else writes this table — the
-- real `signals` table stays owned by signalLedger and stays shadow-gated —
-- so there is no duplicate-write risk. This is NOT the cutover itself.
-- The engine performs one operation here (INSERT); SELECT is granted so the
-- cutover diff can be run with the same key.
--
-- Safe to run more than once.

create table if not exists public.engine_shadow_signals (
  id                     bigserial   primary key,
  observed_at            timestamptz not null,
  session_date           date        not null,
  ticker                 text        not null,
  signal_type            text        not null,
  confidence             numeric     not null,
  trigger_price          numeric     not null,
  fired_at               bigint      not null,
  sources                text[],
  catalyst_data_quality  text,
  signal_id              text        not null
);

create index if not exists engine_shadow_signals_session_ticker
  on public.engine_shadow_signals (session_date, ticker, observed_at);

-- Permissions for the anon role, which is the only key the engine has.
-- Without these the insert fails and the engine logs it; under row level
-- security without policies a read would silently return nothing.
--
-- REVOKE ALL first — see gex-regime-log-table.sql's grant comment for why:
-- Supabase's schema-level default grants ALL to anon on every new table
-- automatically, and a GRANT alone cannot narrow that. Confirmed 2026-09-13
-- on this table too (anon held DELETE/REFERENCES/TRIGGER/TRUNCATE/UPDATE in
-- addition to the intended SELECT/INSERT). Idempotent; safe to re-run.
revoke all on public.engine_shadow_signals from anon;
grant select, insert on public.engine_shadow_signals to anon;
grant usage, select on sequence public.engine_shadow_signals_id_seq to anon;

alter table public.engine_shadow_signals enable row level security;

drop policy if exists engine_shadow_signals_select on public.engine_shadow_signals;
create policy engine_shadow_signals_select on public.engine_shadow_signals
  for select to anon using (true);

drop policy if exists engine_shadow_signals_insert on public.engine_shadow_signals;
create policy engine_shadow_signals_insert on public.engine_shadow_signals
  for insert to anon with check (true);

-- Verify immediately after running (expect INSERT and SELECT for anon):
--   select grantee, privilege_type
--   from information_schema.role_table_grants
--   where table_schema = 'public' and table_name = 'engine_shadow_signals'
--   order by 1, 2;
--
-- Verify after one session:
--   select session_date, signal_type, count(*)
--   from public.engine_shadow_signals
--   group by 1, 2 order by 1 desc, 3 desc;
