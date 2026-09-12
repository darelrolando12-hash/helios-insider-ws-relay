-- gex_regime_log — a forward record of the gamma regime, every 5 minutes per
-- ticker during the regular session.
--
-- Why this table has to exist, and soon: the gamma flip is the ONLY model
-- input that cannot be rebuilt later. Massive's option snapshot ignores
-- `as_of` (probed 2026-09-11 — it returns today's chain), there is no
-- open-interest endpoint, and option daily aggregates carry no OI. Minute
-- bars, trades, quotes and option prices can all be re-fetched for any past
-- day; the flip cannot. Every session that runs without this table is a
-- session that can never be tested for regime interaction.
--
-- Why it matters: five years of backtests found no directional edge in 16
-- named setups, the pre-market fingerprint, entry timing, order flow,
-- volatility regime, three expiries, multi-day holds, 101 tickers, or the
-- price+flow combination. A rule that works ONLY in negative gamma would
-- test as zero in every one of those, because none of them could condition
-- on the real regime. This is the remaining untested interaction.
--
-- Written by relay/engine/session/regimeLog.ts through the observation-only
-- Supabase client, deliberately not gated by shadow mode: nothing else
-- writes this table, so there is no duplicate-write risk.
--
-- Volume: 23 tickers x 78 five-minute marks x ~252 sessions ~= 450k rows/year.
-- Safe to run more than once.

create table if not exists public.gex_regime_log (
  id                  bigserial primary key,
  observed_at         timestamptz not null,
  session_date        date        not null,
  ticker              text        not null,
  spot                numeric,
  flip_level          numeric,
  flip_absent_reason  text,
  gex_regime          text        not null,
  call_wall           numeric,
  put_wall            numeric,
  snapshot_age_s      integer
);

create index if not exists gex_regime_log_session_ticker
  on public.gex_regime_log (session_date, ticker, observed_at);

-- Verify, after one session:
--   select session_date, ticker, count(*),
--          count(flip_level) as with_flip,
--          min(observed_at), max(observed_at)
--   from public.gex_regime_log
--   group by 1, 2 order by 1 desc, 2 limit 30;
