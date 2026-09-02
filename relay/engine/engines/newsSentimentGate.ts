/**
 * Layer 2 — newsSentimentGate
 *
 * Pure scoring of newsStore's real, per-ticker articles into a bounded
 * catalyst-subtotal modifier. Mirrors catalystGate.ts's contract exactly:
 * stateless, no store reads, no event emission — the caller (confluenceEngine)
 * reads newsStore and passes the result in, the same way it reads
 * fundamentalsStore and passes `fund` into catalystGate.computeTags().
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 * Audited 2026-09-02: newsStore.ts polls Massive's real news endpoint every
 * 5 minutes, correctly classifies real sentiment (Massive's own `insights`
 * field, confirmed live), and reached NO consumer — not confluenceEngine, not
 * catalystGate, no DB persistence. Real work, discarded every cycle. This
 * module is the fix: the actual consumer.
 *
 * ── Why bearish is not just "bullish inverted" in how it's floored ─────────
 * scoreCatalyst floors the combined catalyst subtotal at 0 (a catalyst boost
 * never makes the overall score worse than not having one). That floor is
 * applied AFTER this module's negative contribution is added in, not here —
 * this module itself returns a genuinely signed value. The practical effect:
 * bullish news can only ever matter when insiderBuy/materialEvent haven't
 * already saturated the 20-pt cap (the "softest evidence, crowded out first"
 * design decision) — but bearish news can still pull the subtotal down even
 * on a day where insider+material are already maxed. Real-time bad news
 * mattering regardless of a stale positive catalyst is intentional, not an
 * asymmetry bug.
 *
 * ── Combining multiple qualifying articles — an implementation-level call ──
 * Not resolved in the design round, made explicit here for the same reason
 * `dataQuality` gets named instead of assumed: sum each qualifying article's
 * decayed, impact-weighted contribution, then clamp to [-MAX_MAGNITUDE,
 * +MAX_MAGNITUDE]. Multiple real, corroborating articles legitimately
 * reinforce a read (and keep it near the ceiling longer as any one article
 * decays) without being able to exceed the agreed cap. Impact tier
 * (HIGH/MEDIUM/LOW, already computed by newsStore's keyword classifier)
 * scales each article's base weight — a LOW-impact tangential mention
 * shouldn't move the score as much as a HIGH-impact one.
 */

import type { NewsArticle } from '../stores/newsStore.ts';

export type NewsDataQuality = 'real' | 'absent';

export interface NewsSentimentResult {
  /** Signed, bounded to [-MAX_MAGNITUDE, +MAX_MAGNITUDE]. */
  points: number;
  /**
   * 'real'   — the feed was confirmed fresh for this ticker, so a 0 here
   *            means a genuine "no net directional news right now".
   * 'absent' — the feed was NOT confirmed fresh (newsStore hasn't polled
   *            recently, or has never polled) — a 0 here is "couldn't
   *            check", not "checked and found nothing". Caller decides
   *            whether this alone flips the whole catalyst component's
   *            dataQuality, the same way catalystGate's `tags === null`
   *            case does — see confluenceEngine.ts's scoreCatalyst.
   */
  dataQuality: NewsDataQuality;
  reason: string;
}

/** Full weight at age 0, linearly decayed to 0 by this age — the agreed 60-90min band's midpoint. */
const DECAY_WINDOW_MS = 75 * 60 * 1000;

/** Matches the agreed +5 cap; symmetric for the bearish case per the same design round. */
const MAX_MAGNITUDE = 5;

const IMPACT_BASE_WEIGHT: Record<NewsArticle['impact'], number> = {
  HIGH: 5,
  MEDIUM: 3,
  LOW: 1,
};

function _decayFactor(ageMs: number): number {
  if (ageMs <= 0) return 1;               // never let a clock-skewed future publishedUtc over-weight
  if (ageMs >= DECAY_WINDOW_MS) return 0;
  return 1 - ageMs / DECAY_WINDOW_MS;      // linear — simple, bounded, no tuning surface beyond the window itself
}

/**
 * Score a ticker's real, recent news into a bounded catalyst modifier.
 *
 * @param articles   newsStore.getArticlesForTicker(ticker) — already
 *                   ticker-filtered by the caller, not filtered here.
 * @param nowMs      Current time, for decay. Passed explicitly (never read
 *                   internally) so this stays a pure, deterministic function.
 * @param feedFresh  Whether newsStore has successfully polled for this
 *                   ticker recently (see newsStore.isFreshForTicker). A
 *                   caller-supplied boolean, not derived from `articles`
 *                   itself — an empty `articles` array is a genuine real
 *                   zero only when the feed is actually fresh; a stale feed
 *                   with zero articles has told us nothing.
 */
export function scoreNewsSentiment(
  articles: readonly NewsArticle[],
  nowMs: number,
  feedFresh: boolean,
): NewsSentimentResult {
  if (!feedFresh) {
    return { points: 0, dataQuality: 'absent', reason: 'news feed not confirmed fresh for this ticker — could not check' };
  }

  let total = 0;
  let counted = 0;
  for (const a of articles) {
    if (a.sentiment !== 'bullish' && a.sentiment !== 'bearish') continue; // mixed/neutral: no directional contribution
    const ageMs = nowMs - a.publishedUtc;
    if (ageMs < 0) continue; // future-dated article — do not let clock skew inflate weight
    const decay = _decayFactor(ageMs);
    if (decay <= 0) continue;
    const base = IMPACT_BASE_WEIGHT[a.impact];
    total += (a.sentiment === 'bullish' ? base : -base) * decay;
    counted += 1;
  }

  const clamped = Math.max(-MAX_MAGNITUDE, Math.min(MAX_MAGNITUDE, total));
  return {
    points: clamped,
    dataQuality: 'real',
    reason: counted > 0
      ? `${counted} directional article(s) within the decay window, net ${clamped.toFixed(2)}`
      : 'feed fresh, no directional articles within the decay window — real zero',
  };
}
