/**
 * Mid-session CVD reconstruction.
 *
 * CVD is cumulative from the session open. cvdStore keeps buyDelta/sellDelta/
 * tickCount in a module-level Map with no persistence, and Railway restarts the
 * process on every deploy — so a mid-session restart starts CVD at zero.
 *
 * The failure that creates is silent and expensive: the CVD is small, correctly
 * shaped, and completely wrong, and confluenceEngine scores 25 points against
 * it. Nothing anywhere indicates the number is partial. This module rebuilds
 * from the session open before live ticks are accepted, and — just as important
 * — marks the result so a failed or empty rebuild can never masquerade as a
 * real, quiet session.
 *
 * This gives MassiveRestClient.fetchTradesSince its first caller. It has been
 * dead code since it was written; cvdStore's header describes gap-fill
 * behaviour that has never once executed.
 *
 * ── Fidelity limit, recorded rather than hidden ────────────────────────────
 * Replayed trades arrive without a synchronised quote. Live classification
 * uses the quote test first (price >= ask → buy, <= bid → sell) and only falls
 * back to the uptick rule mid-spread. Replay has no spread at all, so every
 * replayed tick classifies by the uptick fallback. That is measurably less
 * accurate than live classification, it is a real difference in the data, and
 * it is reported in the result rather than smoothed over.
 */

import type { MassiveRestClient } from '../lib/massive/api.ts';
import { classifyTick } from '../engines/cvdEngine.ts';
import * as cvdStore from '../stores/cvdStore.ts';
import { toCentralTime } from '../lib/time.ts';
import type { CvdTick, AssetClass } from '../stores/types.ts';

/**
 * Quality of a rebuilt CVD series.
 *
 *   'real'   trades were fetched and replayed.
 *   'absent' the rebuild ran but produced nothing — no trades returned, or the
 *            fetch failed. NOT the same as a CVD of zero, and must never be
 *            presented as one.
 */
export type RebuildQuality = 'real' | 'absent';

export interface TickerRebuildResult {
  ticker:        string;
  quality:       RebuildQuality;
  tradesFetched: number;
  ticksApplied:  number;
  sessionOpenUtc: number;
  /** True when classification used the uptick fallback for every tick. */
  classifiedWithoutQuotes: boolean;
  /** Present when quality is 'absent' — why nothing was produced. */
  reason?: string;
}

export interface RebuildSummary {
  results:      TickerRebuildResult[];
  realCount:    number;
  absentCount:  number;
  sessionOpenUtc: number;
}

/** Regular session open, Central Time: 8:30 AM CT. */
const SESSION_OPEN_HOUR_CT   = 8;
const SESSION_OPEN_MINUTE_CT = 30;

/** Max pages to follow per ticker. A busy megacap can exceed one page badly. */
const MAX_PAGES_PER_TICKER = 25;
const PAGE_LIMIT           = 1000;

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
 * Rebuild CVD for one ticker from the session open.
 *
 * Applies ticks through cvdStore.appendClassifiedTick — the same write path
 * live ticks use — so no second accumulation path exists to drift.
 */
export async function rebuildTicker(
  client:     MassiveRestClient,
  ticker:     string,
  assetClass: AssetClass = 'stock',
  nowUtcMs:   number = Date.now(),
): Promise<TickerRebuildResult> {
  const sessionOpen = sessionOpenUtcMs(nowUtcMs);

  const base: TickerRebuildResult = {
    ticker,
    quality: 'absent',
    tradesFetched: 0,
    ticksApplied: 0,
    sessionOpenUtc: sessionOpen,
    classifiedWithoutQuotes: true,
  };

  // The store entry must exist before appendClassifiedTick will accept ticks;
  // subscribeTicker is idempotent, so this is safe if cvdEngine already ran.
  cvdStore.subscribeTicker(ticker, assetClass);

  let cursorUtc = sessionOpen;
  let fetched   = 0;
  let applied   = 0;
  let prevPrice = 0;
  let buyDelta  = 0;
  let sellDelta = 0;

  try {
    for (let page = 0; page < MAX_PAGES_PER_TICKER; page++) {
      const trades = await client.fetchTradesSince(ticker, cursorUtc, PAGE_LIMIT);
      if (!Array.isArray(trades) || trades.length === 0) break;

      fetched += trades.length;

      for (const t of trades) {
        const price = t.price ?? 0;
        const size  = t.size ?? 0;
        if (price === 0 || size === 0) continue;

        // No synchronised quote exists for a historical trade, so bid/ask are
        // passed as 0 and classifyTick falls through to the uptick rule. This
        // is the fidelity limit described in the module header — it is
        // deliberate and reported, not an oversight.
        const side = classifyTick(price, 0, 0, prevPrice, { buyDelta, sellDelta });

        if (side === 'buy') buyDelta += size; else sellDelta += size;
        prevPrice = price;

        const ct: CvdTick = {
          ticker,
          side,
          size,
          price,
          dollarFlow: side === 'buy' ? price * size : -(price * size),
          tCT:  toCentralTime(t.timestamp).ctMs,
          tUtc: t.timestamp,
          assetClass,
        };
        cvdStore.appendClassifiedTick(ticker, ct);
        applied++;

        if (t.timestamp > cursorUtc) cursorUtc = t.timestamp;
      }

      // Short page means the history is exhausted.
      if (trades.length < PAGE_LIMIT) break;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[cvdRebuild] ${ticker}: fetch failed — ${message}`);
    return { ...base, tradesFetched: fetched, ticksApplied: applied, reason: `fetch failed: ${message}` };
  }

  if (applied === 0) {
    // A rebuild that produced nothing is 'absent', NEVER a ready CVD of zero.
    // A zeroed CVD looks neutral and plausible, and confluenceEngine would
    // score it as though it were real observed flow.
    console.warn(
      `[cvdRebuild] ${ticker}: quality=absent — ${fetched} trade(s) fetched, 0 applied. ` +
      `CVD for this ticker is NOT real and must not be scored as a genuine zero.`
    );
    return { ...base, tradesFetched: fetched, reason: fetched === 0 ? 'no trades returned since session open' : 'all trades unusable (zero price or size)' };
  }

  console.log(
    `[cvdRebuild] ${ticker}: quality=real — replayed ${applied} tick(s) from ${fetched} fetched ` +
    `since ${new Date(sessionOpen).toISOString()} (uptick-rule classification — no historical quotes).`
  );

  return {
    ...base,
    quality: 'real',
    tradesFetched: fetched,
    ticksApplied: applied,
  };
}

/**
 * Rebuild every supplied ticker, serially.
 *
 * Serial rather than parallel on purpose: this runs during boot, alongside the
 * cold-start backfills, and firing ~23 paginated trade fetches at once is the
 * same connection pile-up that forced the 250ms chainAggregator stagger and
 * the 2s ingestion spacing.
 */
export async function rebuildAll(
  client:   MassiveRestClient,
  tickers:  readonly string[],
  nowUtcMs: number = Date.now(),
): Promise<RebuildSummary> {
  const sessionOpen = sessionOpenUtcMs(nowUtcMs);
  console.log(
    `[cvdRebuild] Rebuilding CVD for ${tickers.length} ticker(s) from session open ` +
    `${new Date(sessionOpen).toISOString()}…`
  );

  const results: TickerRebuildResult[] = [];
  for (const ticker of tickers) {
    results.push(await rebuildTicker(client, ticker, 'stock', nowUtcMs));
  }

  const realCount   = results.filter(r => r.quality === 'real').length;
  const absentCount = results.filter(r => r.quality === 'absent').length;

  // console.error so it stands out in Railway's log view: a rebuild where most
  // tickers came back absent means CVD is largely synthetic this session, and
  // that must not be discovered later by wondering why signals look odd.
  const report = `[cvdRebuild] Complete — ${realCount} real, ${absentCount} absent, of ${results.length}.`;
  if (absentCount > 0) console.error(report + ' Absent tickers have NO real CVD and must not be treated as zero-flow.');
  else console.log(report);

  return { results, realCount, absentCount, sessionOpenUtc: sessionOpen };
}
