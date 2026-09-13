-- engine_shadow_signals — every signal the engine decides on while it runs in
-- shadow mode, recorded as an observation.
--
-- Why: the engine already scores and decides continuously; in shadow its
-- writes are intercepted and logged instead of executed, and Railway's log
-- buffer holds only the last few hundred lines. A forward record of live
-- decisions with real timestamps is the one test a backtest cannot be wrong
-- about, and it costs nothing to start accruing months before it is needed.
--
-- Written by relay/engine/session/shadowSignalLog.ts through the
-- observation-only Supabase client. Nothing else writes this table — the real
-- `signals` table stays owned by signalLedger and stays shadow-gated — so
-- there is no duplicate-write risk. This is NOT the shadow->live cutover;
-- that is a separate, coordinated change (CLAUDE.md, SHADOW MODE).
--
-- Safe to run more than once.

create table if not exists public.engine_shadow_signals (
  id            bigserial primary key,
  observed_at   timestamptz not null,
  session_date  date        not null,
  ticker        text        not null,
  signal_type   text        not null,
  confidence    numeric     not null,
  trigger_price numeric     not null,
  fired_at      bigint      not null,
  sources       text[],
  catalyst_data_quality text,
  signal_id     text        not null
);

create index if not exists engine_shadow_signals_session_ticker
  on public.engine_shadow_signals (session_date, ticker, observed_at);

-- Verify, after one session:
--   select session_date, signal_type, count(*)
--   from public.engine_shadow_signals
--   group by 1, 2 order by 1 desc, 3 desc;
