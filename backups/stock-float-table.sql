-- stock_float — free float per ticker, one row each, overwritten in place.
--
-- Why this file exists: relay/engine/ingestion/shortInterestIngestion.ts
-- fetches real free-float data from Massive and upserts it here, but the
-- table has never been created (the engine holds no service-role key and
-- cannot run DDL). Railway has logged, on every deploy since W8:
--
--   [shortInterestIngestion] free float hydrate failed —
--   relation "public.stock_float" does not exist
--
-- Impact today is limited, not fatal: the ingestion still writes the real
-- value into the in-memory fundamentals store on every run (9 s after boot,
-- then weekly), so squeezeEngine's short-float-of-free-float is real while
-- the process lives. Creating the table adds durability across restarts and
-- a fallback when Massive's float endpoint is unavailable.
--
-- Safe to run more than once.

create table if not exists public.stock_float (
  ticker              text primary key,
  free_float          bigint not null,
  free_float_percent  numeric,
  effective_date      date not null,
  fetched_at          timestamptz not null default now()
);

-- Verify:
--   select ticker, free_float, free_float_percent, effective_date
--   from public.stock_float order by ticker;
-- After the next float run (weekly, or 9 s after a relay restart) this should
-- hold one row per feed ticker except the ETFs, which have no float concept.
