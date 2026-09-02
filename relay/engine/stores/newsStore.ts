/**
 * Layer 1 — newsStore
 *
 * Polls Massive's reference/news endpoint every 5 minutes during market hours.
 * Classifies impact, detects FEED_TICKERS by symbol and company-name alias,
 * deduplicates by article id, and keeps the last 200 articles in memory.
 *
 * ── Ticker-scoped queries (2026-09-02) ──────────────────────────────────────
 * Previously one unfiltered global call (`/v2/reference/news?limit=50`, no
 * ticker param), relying on FEED_TICKERS mentions surviving into the top-50
 * most-recent-across-everything window. Empirically fine for mega-caps
 * (verified live: 9/23 FEED_TICKERS present in one real 50-article/~5-hour
 * snapshot) but left real coverage on the table for less-covered names
 * (COIN, PLTR, HOOD, SOFI, MSTR, SMCI, JPM, BAC, GLD — none appeared in that
 * snapshot). Massive's endpoint supports `?ticker=X` — confirmed live,
 * verified real, correctly-tagged results. Now one scoped call per
 * FEED_TICKER per poll cycle, small stagger between calls (not a rate-limit
 * requirement — Massive's real limit is 100 req/sec and this is a fraction
 * of that — just avoiding a 23-request burst in one tick, same caution
 * chainAggregator's boot stagger already uses for a similar reason).
 *
 * Public API:
 *   getArticles()                   → NewsArticle[]  (newest first)
 *   getLatestHighImpact()           → NewsArticle[]  (last 3 HIGH)
 *   getArticlesForTicker(ticker)    → NewsArticle[]
 *   isFreshForTicker(ticker)        → boolean  (real per-ticker poll freshness)
 *   subscribe(listener)             → () => void
 *   startPolling()                  → void  (call once on app init)
 *   stopPolling()                   → void
 *   getStatus()                     → 'idle' | 'polling' | 'error'
 */

import { MASSIVE_API_KEY } from '../../config.ts';
import * as barsStore from './barsStore.ts';
import { FEED_TICKERS } from '../state/directionState.ts';

// ── NewsArticle ────────────────────────────────────────────────────────────────

export interface NewsArticle {
  id:             string;
  title:          string;
  description:    string;
  publishedUtc:   number;       // Unix ms
  source:         string;
  articleUrl:     string;
  tickers:        string[];     // FEED_TICKERS mentioned
  impact:         'HIGH' | 'MEDIUM' | 'LOW';
  sentiment:      'bullish' | 'bearish' | 'mixed' | 'neutral';
  sentimentScore: number | null;
}

// ── Constants ──────────────────────────────────────────────────────────────────

const POLL_INTERVAL_MS = 5 * 60 * 1000;
const MAX_ARTICLES     = 200;
const PER_TICKER_LIMIT = 20; // per scoped call — 23 tickers x 20 comfortably covers real per-5-min volume
const STAGGER_MS       = 200; // gap between each ticker's call within one poll cycle — see header note

/**
 * A ticker's per-poll data is "fresh" within this many missed cycles' worth
 * of time — generous enough that one transient failure doesn't immediately
 * flip newsSentimentGate's dataQuality to 'absent', tight enough that a
 * sustained outage does. 3x the poll interval = 15 minutes.
 */
const FRESHNESS_WINDOW_MS = POLL_INTERVAL_MS * 3;

const HIGH_KEYWORDS = [
  'fed', 'fomc', 'cpi', 'ppi', 'jobs report', 'nonfarm', 'earnings',
  'ceo', 'sec', 'fda', 'merger', 'acquisition', 'bankruptcy', 'halt',
  'investigation',
];

const MEDIUM_KEYWORDS = [
  'analyst', 'upgrade', 'downgrade', 'price target', 'guidance',
  'offering', 'buyback', 'dividend increase',
];

/**
 * Company-name → FEED_TICKER alias map.
 * GLD vs GS ambiguity is noted — Goldman matches GS only, never GLD.
 */
const ALIAS_MAP: Array<{ pattern: RegExp; ticker: string }> = [
  { pattern: /\bapple\b/i,                         ticker: 'AAPL'  },
  { pattern: /\btesla\b/i,                          ticker: 'TSLA'  },
  { pattern: /\bnvidia\b/i,                         ticker: 'NVDA'  },
  { pattern: /\bmicrosoft\b/i,                      ticker: 'MSFT'  },
  { pattern: /\bamazon\b/i,                         ticker: 'AMZN'  },
  { pattern: /\bmeta\b/i,                           ticker: 'META'  },
  { pattern: /\bgoogle\b|\balphabet\b/i,            ticker: 'GOOGL' },
  { pattern: /\bamd\b/i,                            ticker: 'AMD'   },
  { pattern: /\bnetflix\b/i,                        ticker: 'NFLX'  },
  { pattern: /\bcoinbase\b/i,                       ticker: 'COIN'  },
  { pattern: /\bpalantir\b/i,                       ticker: 'PLTR'  },
  { pattern: /\bmicrostrategy\b/i,                  ticker: 'MSTR'  },
  { pattern: /\bjpmorgan\b|\bj\.p\. morgan\b/i,     ticker: 'JPM'   },
  { pattern: /\bbank of america\b/i,                ticker: 'BAC'   },
  // Goldman intentionally avoids GLD ambiguity — match GS only via symbol scan
];

// ── Internal state ─────────────────────────────────────────────────────────────

let _articles:  NewsArticle[]            = [];
const _listeners: Set<() => void>          = new Set();
let _status:    'idle' | 'polling' | 'error' = 'idle';
let _timer:     ReturnType<typeof setInterval> | null = null;

/** UTC ms of each ticker's last SUCCESSFUL scoped fetch — real per-ticker freshness, not a global flag. */
const _lastSuccessAtByTicker = new Map<string, number>();

const _sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ── Helpers ────────────────────────────────────────────────────────────────────

function _notify() {
  _listeners.forEach(fn => fn());
}

/**
 * Classify impact of an article based on title + description text.
 */
function _classifyImpact(title: string, description: string): 'HIGH' | 'MEDIUM' | 'LOW' {
  const text = `${title} ${description}`.toLowerCase();

  for (const kw of HIGH_KEYWORDS) {
    if (text.includes(kw)) return 'HIGH';
  }
  for (const kw of MEDIUM_KEYWORDS) {
    if (text.includes(kw)) return 'MEDIUM';
  }
  return 'LOW';
}

/**
 * Detect mentioned FEED_TICKERS from title + description.
 * Scans for exact ticker symbols (word-boundary, case-insensitive) and company aliases.
 */
function _detectTickers(title: string, description: string): string[] {
  const text    = `${title} ${description}`;
  const found   = new Set<string>();

  // Exact symbol scan
  for (const ticker of FEED_TICKERS) {
    const re = new RegExp(`\\b${ticker}\\b`, 'i');
    if (re.test(text)) found.add(ticker);
  }

  // Company alias scan
  for (const { pattern, ticker } of ALIAS_MAP) {
    if (pattern.test(text)) found.add(ticker);
  }

  return Array.from(found);
}

/**
 * Classify sentiment from insight score if available, else keyword heuristic.
 */
function _classifySentiment(
  title: string,
  description: string,
  score: number | null,
): 'bullish' | 'bearish' | 'mixed' | 'neutral' {
  if (score !== null) {
    if (score > 0.3)  return 'bullish';
    if (score < -0.3) return 'bearish';
    if (Math.abs(score) <= 0.1) return 'neutral';
    return 'mixed';
  }

  const text     = `${title} ${description}`.toLowerCase();
  const bullish  = /surge|rally|beat|approval|buyback|upgrade|soar|jump|record|strong|positive/i.test(text);
  const bearish  = /miss|decline|investigation|halt|downgrade|cut|recall|layoff|drop|plunge|loss|weak|negative/i.test(text);

  if (bullish && bearish) return 'mixed';
  if (bullish)            return 'bullish';
  if (bearish)            return 'bearish';
  return 'neutral';
}

/**
 * Raw Massive news result shape.
 */
interface _MassiveNewsItem {
  id:           string;
  title:        string;
  description?: string;
  published_utc: string;   // ISO-8601
  publisher: {
    name: string;
    homepage_url?: string;
  };
  article_url:  string;
  tickers?:     string[];
  insights?:    Array<{
    ticker:    string;
    sentiment: string;
    sentiment_reasoning?: string;
  }>;
}

interface _MassiveNewsResponse {
  status:  string;
  results: _MassiveNewsItem[];
  next_url?: string;
}

/**
 * Transform a raw Massive news item into a NewsArticle.
 */
function _transform(raw: _MassiveNewsItem): NewsArticle {
  const title       = raw.title ?? '';
  const description = raw.description ?? '';
  const publishedMs = new Date(raw.published_utc).getTime();

  // Prefer Massive's own insight sentiment score when present
  let sentimentScore: number | null = null;
  if (raw.insights && raw.insights.length > 0) {
    const first = raw.insights[0];
    if (first.sentiment === 'positive')  sentimentScore = 0.6;
    else if (first.sentiment === 'negative') sentimentScore = -0.6;
    else if (first.sentiment === 'neutral')  sentimentScore = 0;
  }

  const tickers   = _detectTickers(title, description);
  const impact    = _classifyImpact(title, description);
  const sentiment = _classifySentiment(title, description, sentimentScore);

  return {
    id:             raw.id,
    title,
    description,
    publishedUtc:   publishedMs,
    source:         raw.publisher?.name ?? 'Unknown',
    articleUrl:     raw.article_url,
    tickers,
    impact,
    sentiment,
    sentimentScore,
  };
}

// ── API fetch ──────────────────────────────────────────────────────────────────

/**
 * Determines if the market is currently open by checking whether SPY bars
 * are available and fresh in barsStore. This is the correct gate — barsStore
 * is populated from REST backfill + WS AM.* messages and doesn't depend on
 * gexEngine having run first (unlike marketStore, which was the previous gate).
 */
function _isMarketOpen(): boolean {
  return barsStore.getResult('SPY').status === 'ready';
}

// Server-side: process.env via config, not import.meta.env (a Vite build-time
// substitution that is `undefined` under Node — it threw on import here, and
// would otherwise have silently produced an empty key and a permanently
// skipped poll).
//
// KNOWN DEVIATION: this module calls Massive REST directly rather than going
// through MassiveRestClient, which breaks the one-REST-module rule. That is
// pre-existing browser behaviour, carried over unchanged rather than
// refactored blind; folding it into MassiveRestClient is its own change.
const _API_KEY = MASSIVE_API_KEY;
const _BASE_URL = 'https://api.massive.com';

/** Fetch one ticker's scoped results. Throws on any non-200 or network failure — caller handles per-ticker. */
async function _pollTicker(ticker: string): Promise<NewsArticle[]> {
  const url = `${_BASE_URL}/v2/reference/news?ticker=${encodeURIComponent(ticker)}&limit=${PER_TICKER_LIMIT}&order=desc&apiKey=${_API_KEY}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json: _MassiveNewsResponse = await res.json();
  return (json.results ?? []).map(_transform);
}

async function _poll(): Promise<void> {
  if (!_isMarketOpen()) return;

  if (!_API_KEY) {
    console.warn('[newsStore] MASSIVE_API_KEY not set — skipping poll');
    return;
  }

  const existingIds = new Set(_articles.map(a => a.id));
  const collected: NewsArticle[] = [];
  let anySucceeded = false;
  let anyFailed    = false;

  // Scoped, per-ticker — see this file's header for why the global unfiltered
  // call was replaced. Staggered, not parallel: 23 simultaneous requests in
  // one tick is the same burst-of-first-fetches shape that reset Massive's
  // connections for chainAggregator at boot (engine/index.ts's own comment).
  for (const ticker of FEED_TICKERS) {
    try {
      const arts = await _pollTicker(ticker);
      for (const a of arts) {
        if (!existingIds.has(a.id)) {
          existingIds.add(a.id);
          collected.push(a);
        }
      }
      _lastSuccessAtByTicker.set(ticker, Date.now());
      anySucceeded = true;
    } catch (err) {
      console.error(`[newsStore] Poll failed for ${ticker}:`, err);
      anyFailed = true;
    }
    await _sleep(STAGGER_MS);
  }

  if (collected.length > 0) {
    // Merging 23 independently-scoped batches — sort by recency before
    // capping, since arrival order across tickers is not time order.
    _articles = [...collected, ..._articles]
      .sort((a, b) => b.publishedUtc - a.publishedUtc)
      .slice(0, MAX_ARTICLES);
    _notify();
  }

  // Global `_status` reflects whether THIS cycle made any real progress at
  // all — real per-ticker freshness for scoring is _lastSuccessAtByTicker /
  // isFreshForTicker, not this field. A cycle with some failures and some
  // successes is real partial data, not a global error.
  if (anySucceeded) {
    _status = 'polling';
  } else if (anyFailed) {
    _status = 'error';
    _notify();
  }
}

// ── Public API ─────────────────────────────────────────────────────────────────

/** All articles, newest first. */
export function getArticles(): NewsArticle[] {
  return _articles;
}

/** Last 3 HIGH-impact articles. */
export function getLatestHighImpact(): NewsArticle[] {
  return _articles.filter(a => a.impact === 'HIGH').slice(0, 3);
}

/** All articles that mention `ticker`. */
export function getArticlesForTicker(ticker: string): NewsArticle[] {
  return _articles.filter(a => a.tickers.includes(ticker));
}

/**
 * Real per-ticker freshness — has this ticker's scoped fetch succeeded
 * recently? Distinct from getStatus(), which is a global summary of the
 * last poll CYCLE (23 independent requests) and can't tell a caller whether
 * THIS ticker's data is trustworthy right now. Consumed by
 * newsSentimentGate.ts to decide 'real' vs 'absent' — a stale or
 * never-polled ticker returning zero articles must never be read as a
 * confirmed "no news".
 */
export function isFreshForTicker(ticker: string, maxAgeMs = FRESHNESS_WINDOW_MS): boolean {
  const lastSuccess = _lastSuccessAtByTicker.get(ticker);
  if (lastSuccess == null) return false;
  return Date.now() - lastSuccess <= maxAgeMs;
}

/** Subscribe to store changes. Returns unsubscribe function. */
export function subscribe(listener: () => void): () => void {
  _listeners.add(listener);
  return () => _listeners.delete(listener);
}

/** Start polling. Call once on app init. */
export function startPolling(): void {
  if (_timer !== null) return;
  _status = 'polling';

  // Fire immediately if bars are ready; otherwise subscribe for the first
  // ready event and fire then — prevents the first poll from being skipped
  // when barsStore backfill hasn't completed yet at startup.
  if (_isMarketOpen()) {
    void _poll();
  } else {
    const unsub = barsStore.subscribe(() => {
      if (_isMarketOpen()) {
        unsub();
        void _poll();
      }
    });
  }

  _timer = setInterval(() => void _poll(), POLL_INTERVAL_MS);
}

/** Stop polling. */
export function stopPolling(): void {
  if (_timer !== null) {
    clearInterval(_timer);
    _timer = null;
  }
  _status = 'idle';
}

/** Current store status. */
export function getStatus(): 'idle' | 'polling' | 'error' {
  return _status;
}
