/**
 * Session CVD reconstruction at boot.
 *
 * CVD is cumulative from the session open. cvdStore keeps its totals in a
 * module-level Map with no persistence, and Railway restarts the process on
 * every deploy — so a mid-session restart starts CVD at zero.
 *
 * The failure that creates is silent and expensive: the CVD is small, correctly
 * shaped, and completely wrong, and confluenceEngine scores 25 points against
 * it. This module rebuilds today's regular session from the open, and marks the
 * result — real, partial, absent — so a failed or incomplete rebuild can never
 * masquerade as a real, quiet session.
 *
 * ── Rewritten 2026-09-11, from measured data ───────────────────────────────
 * The first version never ran: every request was rejected (HTTP 400, wrong
 * timestamp filter), on every ticker, on every boot. Fixing the request
 * exposed three faults the failure had been hiding:
 *   - It stopped after 25 pages × 1,000 trades. SPY's 2026-09-11 regular
 *     session was 470,114 trades — the cap covered about 5% of it.
 *   - It paged with a millisecond timestamp cursor. 32,723 of those 470,114
 *     trades share their nanosecond with the trade before them, so a
 *     timestamp cursor skips trades at page edges. Paging now follows
 *     Massive's own next_url cursor, checked exact at a real page boundary.
 *   - It fetched up to "now" through the live write path while live trades
 *     were already arriving over the relay's shared subscriptions — every
 *     trade in that window counted twice. The live feed is now subscribed
 *     FIRST, and cvdStore.appendRebuiltTicks drops any replayed trade at or
 *     after the first live trade.
 *
 * ── Fidelity limit, recorded rather than hidden ────────────────────────────
 * Replayed trades arrive without a synchronised quote. Live classification
 * uses the quote test first (price >= ask → buy, <= bid → sell) and only falls
 * back to the uptick rule mid-spread. Replay has no spread at all, so every
 * replayed tick classifies by the uptick fallback. That is measurably less
 * accurate than live classification, it is a real difference in the data, and
 * it is reported in the result rather than smoothed over. Trades sharing the
 * first live trade's millisecond but printed before it are in neither set.
 *
 * How big that difference is, measured 2026-09-11 on SPY's first ten minutes
 * (25,745 trades classified both ways): the uptick rule and the quote test
 * agree on 72.5% of trades, 36.1% print inside the spread, and the cumulative
 * delta lands 3× apart (1,259k vs 411k), biased toward "buy" in a rising
 * tape. Per-minute signs agreed 9 times in 10 — the shape holds, the scale
 * does not. Quotes are available (/v3/quotes) but cost ~8M rows per ticker
 * per session against ~470k trades, which is not affordable at boot for 21
 * tickers; consumers should prefer imbalance ratios over raw cumulative
 * delta across the rebuilt/live boundary (cvdStore.getCoverage, liveFromUtc).
 */

import type { MassiveRestClient } from '../lib/massive/api.ts';
import { classifyTick } from '../engines/cvdEngine.ts';
import * as cvdStore from '../stores/cvdStore.ts';
import { toCentralTime } from '../lib/time.ts';
import { NO_TRADE_FEED_TICKERS } from '../state/directionState.ts';
import type { CvdTick, AssetClass } from '../stores/types.ts';

/**
 * Quality of a rebuilt CVD session.
 *
 *   'real'        every regular-session trade before the live feed replayed.
 *   'partial'     some replayed, but the rebuild stopped short (page cap).
 *   'absent'      the rebuild ran and produced nothing — no trades, or the
 *                 fetch failed. NOT the same as a CVD of zero, and must never
 *                 be presented as one.
 *   'none-needed' there was no session to rebuild: booted before today's
 *                 open (live ticks will cover all of it) or on a weekend.
 */
export type RebuildQuality = 'real' | 'partial' | 'absent' | 'none-needed';

export interface TickerRebuildResult {
  ticker:        string;
  quality:       RebuildQuality;
  tradesFetched: number;
  ticksApplied:  number;
  /** Replayed trades dropped because the live feed had already counted them. */
  droppedAsLive: number;
  pages:         number;
  sessionOpenUtc: number;
  /** True when classification used the uptick fallback for every tick. */
  classifiedWithoutQuotes: boolean;
  /** Present when quality is not 'real' — why. */
  reason?: string;
}

export interface RebuildSummary {
  results:      TickerRebuildResult[];
  realCount:    number;
  partialCount: number;
  absentCount:  number;
  sessionOpenUtc: number;
}

/** Regular session open, Central Time: 8:30 AM CT (NYSE 9:30 AM ET). */
const SESSION_OPEN_HOUR_CT   = 8;
const SESSION_OPEN_MINUTE_CT = 30;
/** Regular session length: 9:30 AM–4:00 PM ET. No early-close calendar exists (CLAUDE.md, KNOWN GAPS). */
const SESSION_MS = 390 * 60_000;

/** 50,000 trades per page is accepted by Massive (measured 2026-09-11). */
const PAGE_LIMIT = 50_000;
/**
 * Safety stop, not an expected limit: 100 × 50,000 = 5,000,000 trades. SPY's
 * whole 2026-09-11 session needed 10 pages. Hitting it is reported 'partial'.
 */
const MAX_PAGES_PER_TICKER = 100;
/** How long to wait for a ticker's first live trade before rebuilding it mid-session. */
const LIVE_WAIT_MS = 5_000;
/** Tickers rebuilt at once — each is a serial chain of ~3.6 s pages. */
const CONCURRENCY = 4;

/**
 * UTC epoch ms of today's session open, derived through lib/time.ts.
 *
 * Never uses new Date().getHours() — Railway runs UTC and the market runs
 * Central, and that mismatch is a documented recurring bug class here. The
 * conversion works by walking back from `nowUtcMs` to find the UTC instant
 * whose Central-time components are today's 8:30 AM CT, so DST is handled by
 * the IANA database rather than by an offset constant.
 */
export function sessionOpenUtcMs(nowUtcMs: number = Date.now()): number {
  const ct = toCentralTime(nowUtcMs);

  // Minutes elapsed in the CT day, then step back to 8:30 AM CT.
  const minutesNow  = ct.hour * 60 + ct.minute;
  const minutesOpen = SESSION_OPEN_HOUR_CT * 60 + SESSION_OPEN_MINUTE_CT;
  const deltaMin    = minutesNow - minutesOpen;

  // Subtracting from the UTC instant preserves DST correctness: we are moving
  // by a real elapsed duration, not reconstructing a wall-clock time.
  return nowUtcMs - deltaMin * 60_000 - ct.second * 1_000 - ct.millisecond;
}

/**
 * Rebuild today's regular session for one ticker.
 *
 * Fetches [open, min(now, close)) page by page and hands each page to
 * cvdStore.appendRebuiltTicks, which drops anything the live feed already
 * counted. Call it AFTER the ticker's live subscription is up.
 */
export async function rebuildTicker(
  client:     MassiveRestClient,
  ticker:     string,
  assetClass: AssetClass = 'stock',
  nowUtcMs:   number = Date.now(),
  opts:       { maxPages?: number } = {},
): Promise<TickerRebuildResult> {
  const open  = sessionOpenUtcMs(nowUtcMs);
  const close = open + SESSION_MS;
  const maxPages = opts.maxPages ?? MAX_PAGES_PER_TICKER;

  const base: TickerRebuildResult = {
    ticker, quality: 'absent', tradesFetched: 0, ticksApplied: 0, droppedAsLive: 0, pages: 0,
    sessionOpenUtc: open, classifiedWithoutQuotes: true,
  };

  if (NO_TRADE_FEED_TICKERS.has(ticker)) {
    // An index prints no trades; 'absent' would read as a failed rebuild.
    return { ...base, quality: 'none-needed', reason: 'index product: no trade feed, so CVD is structurally absent' };
  }

  const openCt = toCentralTime(open);
  const weekday = new Date(Date.UTC(openCt.year, openCt.month - 1, openCt.day)).getUTCDay();
  if (weekday === 0 || weekday === 6) {
    return { ...base, quality: 'none-needed', reason: 'no regular session today (weekend)' };
  }
  if (nowUtcMs <= open) {
    return { ...base, quality: 'none-needed', reason: 'booted before the open — live trades cover the whole session' };
  }

  // The store entry must exist before trades are accepted; subscribeTicker
  // is idempotent, so this is safe when cvdEngine already created it.
  cvdStore.subscribeTicker(ticker, assetClass);

  // One CT offset for the whole session: DST changes at 2 AM, never inside
  // 8:30–15:00, and toCentralTime per trade would be ~470,000 Intl calls.
  const ctOffset = openCt.ctMs - open;
  const sessionDay = Math.floor(openCt.ctMs / 86_400_000);

  let fetched = 0, applied = 0, dropped = 0, pages = 0;
  let prevPrice = 0, buyDelta = 0, sellDelta = 0;
  let lastTradeUtc: number | null = null;
  let next: string | null = null;

  try {
    do {
      const page: Awaited<ReturnType<MassiveRestClient['fetchTradesPage']>> = next === null
        ? await client.fetchTradesPage(ticker, { fromUtcMs: open, toUtcMs: Math.min(nowUtcMs, close) }, PAGE_LIMIT)
        : await client.fetchTradesPage(ticker, { cursor: next }, PAGE_LIMIT);
      pages++;
      fetched += page.trades.length;
      next = page.next;

      const ticks: CvdTick[] = [];
      for (const t of page.trades) {
        const price = t.price ?? 0;
        const size  = t.size ?? 0;
        // size 0 = a fractional-share print (the wire carries `decimal_size`,
        // e.g. "0.2837", condition 37). Measured on SPY 2026-09-11: 10% of
        // trades, 0.026% of shares. The live path skips them the same way.
        if (price === 0 || size === 0) continue;
        // No synchronised quote exists for a historical trade, so bid/ask are
        // 0 and classifyTick falls through to the uptick rule — the fidelity
        // limit in the module header.
        const side = classifyTick(price, 0, 0, prevPrice, { buyDelta, sellDelta });
        if (side === 'buy') buyDelta += size; else sellDelta += size;
        prevPrice = price;
        ticks.push({
          ticker, side, size, price,
          dollarFlow: side === 'buy' ? price * size : -(price * size),
          tCT: t.timestamp + ctOffset, tUtc: t.timestamp, assetClass,
        });
        lastTradeUtc = t.timestamp;
      }
      const r = cvdStore.appendRebuiltTicks(ticker, ticks);
      applied += r.applied;
      dropped += r.droppedAsLive;
      // Everything from here on was counted live; stop fetching it.
      if (r.droppedAsLive > 0) next = null;
    } while (next !== null && pages < maxPages);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[cvdRebuild] ${ticker}: fetch failed after ${pages} page(s) — ${message}`);
    cvdStore.setCoverage(ticker, { sessionDay, rebuiltFromUtc: open, rebuiltToUtc: lastTradeUtc, complete: false, note: `rebuild failed: ${message}` });
    return { ...base, quality: applied > 0 ? 'partial' : 'absent', tradesFetched: fetched, ticksApplied: applied, droppedAsLive: dropped, pages, reason: `fetch failed: ${message}` };
  }

  const stoppedShort = next !== null;
  if (applied === 0 && dropped === 0) {
    // A rebuild that produced nothing is 'absent', NEVER a ready CVD of zero.
    // A zeroed CVD looks neutral and plausible, and confluenceEngine would
    // score it as though it were real observed flow.
    console.warn(
      `[cvdRebuild] ${ticker}: quality=absent — ${fetched} trade(s) fetched, 0 applied. ` +
      `CVD for this ticker is NOT real and must not be scored as a genuine zero.`
    );
    cvdStore.setCoverage(ticker, { sessionDay, rebuiltFromUtc: open, rebuiltToUtc: null, complete: false, note: 'rebuild found no trades' });
    return { ...base, tradesFetched: fetched, pages, reason: fetched === 0 ? 'no trades returned since session open' : 'all trades unusable (zero price or size)' };
  }

  cvdStore.setCoverage(ticker, {
    sessionDay, rebuiltFromUtc: open, rebuiltToUtc: lastTradeUtc, complete: !stoppedShort,
    note: stoppedShort ? `rebuild stopped at the ${maxPages}-page cap` : null,
  });
  if (stoppedShort) {
    console.error(`[cvdRebuild] ${ticker}: quality=partial — stopped at ${pages} pages (${fetched} trades); ` +
      `CVD from ${new Date(lastTradeUtc ?? open).toISOString()} to the live feed is MISSING.`);
    return { ...base, quality: 'partial', tradesFetched: fetched, ticksApplied: applied, droppedAsLive: dropped, pages, reason: `stopped at the ${maxPages}-page cap` };
  }

  console.log(
    `[cvdRebuild] ${ticker}: quality=real — replayed ${applied} trade(s) in ${pages} page(s) from ` +
    `${new Date(open).toISOString()}; ${dropped} already counted live (uptick-rule classification — no historical quotes).`
  );
  return { ...base, quality: 'real', tradesFetched: fetched, ticksApplied: applied, droppedAsLive: dropped, pages };
}

/**
 * Resolves when `ticker` has had its first live trade, or after `timeoutMs`.
 * Rebuilding a liquid name before its first live trade lands would let a
 * trade that is still queued behind the page parse be counted twice.
 */
async function _awaitFirstLiveTrade(ticker: string, timeoutMs: number): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (cvdStore.getLiveFromUtc(ticker) === null && Date.now() < until) {
    await new Promise((r) => setTimeout(r, 200));
  }
}

/**
 * Rebuild every supplied ticker, CONCURRENCY at a time. Call after the live
 * subscriptions are up (see engine/index.ts, Phase 4 → 4b).
 *
 * Bounded rather than all-at-once: this runs during boot, alongside the
 * cold-start backfills, and firing ~23 paginated trade fetches at once is the
 * same connection pile-up that forced the 250ms chainAggregator stagger and
 * the 2s ingestion spacing. Serial, though, would now take ~10 minutes at a
 * late-session boot (SPY alone is ~32 s).
 */
export async function rebuildAll(
  client:   MassiveRestClient,
  tickers:  readonly string[],
  nowUtcMs: number = Date.now(),
  opts:     { liveWaitMs?: number } = {},
): Promise<RebuildSummary> {
  const sessionOpen = sessionOpenUtcMs(nowUtcMs);
  const inSession = nowUtcMs > sessionOpen && nowUtcMs < sessionOpen + SESSION_MS;
  console.log(
    `[cvdRebuild] Rebuilding CVD for ${tickers.length} ticker(s) from session open ` +
    `${new Date(sessionOpen).toISOString()}…`
  );

  const results: TickerRebuildResult[] = new Array(tickers.length);
  let nextIndex = 0;
  const worker = async () => {
    while (nextIndex < tickers.length) {
      const i = nextIndex++;
      if (inSession) await _awaitFirstLiveTrade(tickers[i], opts.liveWaitMs ?? LIVE_WAIT_MS);
      results[i] = await rebuildTicker(client, tickers[i], 'stock', nowUtcMs);
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, tickers.length) }, worker));

  const realCount    = results.filter(r => r.quality === 'real').length;
  const partialCount = results.filter(r => r.quality === 'partial').length;
  const absentCount  = results.filter(r => r.quality === 'absent').length;
  const noneCount    = results.filter(r => r.quality === 'none-needed').length;

  // console.error so it stands out in Railway's log view: a rebuild where most
  // tickers came back absent means CVD is largely synthetic this session, and
  // that must not be discovered later by wondering why signals look odd.
  const report = `[cvdRebuild] Complete — ${realCount} real, ${partialCount} partial, ${absentCount} absent, ` +
    `${noneCount} none needed, of ${results.length}.`;
  if (absentCount + partialCount > 0) {
    console.error(report + ' Partial and absent tickers do NOT have CVD from the open and must not be treated as cumulative-from-open.');
  } else {
    console.log(report);
  }

  return { results, realCount, partialCount, absentCount, sessionOpenUtc: sessionOpen };
}
