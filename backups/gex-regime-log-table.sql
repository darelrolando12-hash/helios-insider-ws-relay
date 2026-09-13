-- gex_regime_log — a forward record of the gamma regime, every 5 minutes per
-- ticker during the regular session, with the realised move that followed.
--
-- Why this table has to exist, and soon: the gamma flip is the ONLY model
-- input that cannot be rebuilt later. Massive's option snapshot ignores
-- `as_of` (probed 2026-09-11: it returns today's chain), there is no
-- open-interest endpoint, and option daily aggregates carry no OI. Minute
-- bars, trades, quotes and option prices can all be re-fetched for any past
-- day; the flip cannot. Every session that runs without this table is a
-- session that can never be tested for regime interaction.
--
-- Written by relay/engine/session/regimeLog.ts with the ANON key, through an
-- observation-only client that shadow mode deliberately does not gate
-- (nothing else writes this table, so there is no duplicate-write risk).
-- The engine performs exactly three operations here, and the permissions
-- below grant exactly those three:
--   INSERT one row per ticker every 5 minutes
--   SELECT id, ticker, spot of the rows it just inserted (insert ... returning)
--   UPDATE fwd_30m_pct / fwd_60m_pct on those rows 30 and 60 minutes later
--
-- Volume: 23 tickers x 78 five-minute marks x ~252 sessions ~= 450k rows/year.
-- Safe to run more than once.

create table if not exists public.gex_regime_log (
  id                  bigserial   primary key,
  observed_at         timestamptz not null,
  session_date        date        not null,
  ticker              text        not null,
  spot                numeric,
  flip_level          numeric,
  flip_absent_reason  text,
  gex_regime          text        not null,
  call_wall           numeric,
  put_wall            numeric,
  snapshot_age_s      integer,
  fwd_30m_pct         numeric,
  fwd_60m_pct         numeric
);

-- An earlier copy of this file (2026-09-12) had no outcome columns. If the
-- table was already created from that copy, these add them; otherwise they
-- do nothing.
alter table public.gex_regime_log add column if not exists fwd_30m_pct numeric;
alter table public.gex_regime_log add column if not exists fwd_60m_pct numeric;

create index if not exists gex_regime_log_session_ticker
  on public.gex_regime_log (session_date, ticker, observed_at);

-- Permissions for the anon role, which is the only key the engine has.
-- Without these, inserts fail; under row level security without policies,
-- the outcome UPDATE would match zero rows and report success — the silent
-- failure this project has already hit once on `signals` (a DELETE that
-- returned 200 and removed nothing).
grant select, insert on public.gex_regime_log to anon;
grant update (fwd_30m_pct, fwd_60m_pct) on public.gex_regime_log to anon;
grant usage, select on sequence public.gex_regime_log_id_seq to anon;

alter table public.gex_regime_log enable row level security;

drop policy if exists gex_regime_log_select on public.gex_regime_log;
create policy gex_regime_log_select on public.gex_regime_log
  for select to anon using (true);

drop policy if exists gex_regime_log_insert on public.gex_regime_log;
create policy gex_regime_log_insert on public.gex_regime_log
  for insert to anon with check (true);

drop policy if exists gex_regime_log_update on public.gex_regime_log;
create policy gex_regime_log_update on public.gex_regime_log
  for update to anon using (true) with check (true);

-- Verify immediately after running. Table-level grants (expect INSERT and
-- SELECT for anon) are in role_table_grants; the UPDATE is granted on two
-- columns only, so it appears in column_privileges, NOT role_table_grants
-- (expect fwd_30m_pct and fwd_60m_pct):
--   select grantee, privilege_type
--   from information_schema.role_table_grants
--   where table_schema = 'public' and table_name = 'gex_regime_log'
--   order by 1, 2;
--   select grantee, column_name, privilege_type
--   from information_schema.column_privileges
--   where table_schema = 'public' and table_name = 'gex_regime_log'
--     and grantee = 'anon' and privilege_type = 'UPDATE'
--   order by 2;
--
-- Verify after one session (with_flip > 0 for most tickers; with_outcome
-- close to count minus the last hour):
--   select session_date, ticker, count(*),
--          count(flip_level)  as with_flip,
--          count(fwd_30m_pct) as with_outcome,
--          min(observed_at), max(observed_at)
--   from public.gex_regime_log
--   group by 1, 2 order by 1 desc, 2 limit 30;
