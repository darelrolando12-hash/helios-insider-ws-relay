/**
 * NewsCockpit — real-time news feed with macro event calendar and catalyst analysis.
 *
 * Reads exclusively from newsStore, cvdStore, marketStore, fundamentalsStore,
 * directionState. Zero additional API calls.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import * as newsStore        from '../stores/newsStore';
import * as cvdStore         from '../stores/cvdStore';
import * as marketStore      from '../stores/marketStore';
import * as fundamentalsStore from '../stores/fundamentalsStore';
import {
  getDirectionState,
  subscribe as subscribeDirection,
  FEED_TICKERS,
  CONTEXT_ONLY_TICKERS,
} from '../state/directionState';
import { toCentralTime }     from '../lib/time';
import type { NewsArticle }  from '../stores/newsStore';

// ── Constants ──────────────────────────────────────────────────────────────────

const TRADEABLE = FEED_TICKERS.filter(t => !CONTEXT_ONLY_TICKERS.has(t));

// Bearish / bullish keyword sets for manual catalyst analysis
const BULLISH_WORDS = /\b(surge|rally|beat|approval|buyback|upgrade|soar|jump|record|strong|positive|boost|raise|win|profit)\b/i;
const BEARISH_WORDS = /\b(miss|decline|investigation|halt|downgrade|cut|recall|layoff|drop|plunge|loss|weak|negative|fine|probe|lawsuit|delay)\b/i;

const ALIAS_MAP: Array<{ pattern: RegExp; ticker: string }> = [
  { pattern: /\bapple\b/i,                      ticker: 'AAPL'  },
  { pattern: /\btesla\b/i,                       ticker: 'TSLA'  },
  { pattern: /\bnvidia\b/i,                      ticker: 'NVDA'  },
  { pattern: /\bmicrosoft\b/i,                   ticker: 'MSFT'  },
  { pattern: /\bamazon\b/i,                      ticker: 'AMZN'  },
  { pattern: /\bmeta\b/i,                        ticker: 'META'  },
  { pattern: /\bgoogle\b|\balphabet\b/i,         ticker: 'GOOGL' },
  { pattern: /\bamd\b/i,                         ticker: 'AMD'   },
  { pattern: /\bnetflix\b/i,                     ticker: 'NFLX'  },
  { pattern: /\bcoinbase\b/i,                    ticker: 'COIN'  },
  { pattern: /\bpalantir\b/i,                    ticker: 'PLTR'  },
  { pattern: /\bmicrostrategy\b/i,               ticker: 'MSTR'  },
  { pattern: /\bjpmorgan\b|\bj\.p\. morgan\b/i,  ticker: 'JPM'   },
  { pattern: /\bbank of america\b/i,             ticker: 'BAC'   },
];

// ── Macro calendar helpers ─────────────────────────────────────────────────────

/** True if today (CT) is the first Friday of the month — NFP day */
function _isNFPDay(now: Date): boolean {
  const d = new Date(now);
  d.setDate(1);
  const offset = (5 - d.getDay() + 7) % 7;
  d.setDate(1 + offset);
  return d.getDate() === now.getDate();
}

/** Approximate CPI day: 2nd or 3rd Tuesday of the month */
function _isCPIDay(now: Date): boolean {
  const d    = new Date(now);
  const date = now.getDate();
  d.setDate(1);
  const offset = (2 - d.getDay() + 7) % 7; // first Tuesday
  const firstTue = 1 + offset;
  return date === firstTue + 7 || date === firstTue + 14;
}

/** Approximate PPI day: day after CPI */
function _isPPIDay(now: Date): boolean {
  const cpiDate = new Date(now);
  cpiDate.setDate(now.getDate() - 1);
  return _isCPIDay(cpiDate);
}

/**
 * Hard-coded 2025-2026 FOMC decision dates (UTC noon as proxy).
 * These are the 8 annual FOMC meeting close days.
 */
const FOMC_DATES = [
  '2025-01-29', '2025-03-19', '2025-05-07', '2025-06-18',
  '2025-07-30', '2025-09-17', '2025-10-29', '2025-12-10',
  '2026-01-28', '2026-03-18', '2026-05-06', '2026-06-17',
  '2026-07-29', '2026-09-16', '2026-10-28', '2026-12-09',
];

function _isFOMCDay(now: Date): boolean {
  const ymd = now.toISOString().slice(0, 10);
  return FOMC_DATES.includes(ymd);
}

interface MacroEvent {
  label:    string;
  type:     'fomc' | 'cpi' | 'ppi' | 'nfp' | 'earnings';
  ticker?:  string;
  withinMs: number; // how far away in ms (negative = past)
  risk:     'binary' | 'amber';
}

function _buildMacroEvents(): MacroEvent[] {
  const events: MacroEvent[] = [];
  const nowCt = toCentralTime(Date.now());
  // Use CT date components to construct a local midnight for today in CT
  const todayCT = new Date(
    nowCt.year, nowCt.month - 1, nowCt.day,
    nowCt.hour, nowCt.minute, nowCt.second
  );

  if (_isFOMCDay(todayCT)) {
    events.push({ label: 'FOMC DAY', type: 'fomc', risk: 'binary', withinMs: 0 });
  }
  if (_isCPIDay(todayCT)) {
    events.push({ label: 'CPI', type: 'cpi', risk: 'binary', withinMs: 0 });
  }
  if (_isPPIDay(todayCT)) {
    events.push({ label: 'PPI', type: 'ppi', risk: 'binary', withinMs: 0 });
  }
  if (_isNFPDay(todayCT)) {
    events.push({ label: 'NFP', type: 'nfp', risk: 'binary', withinMs: 0 });
  }

  // Earnings within 3 days
  for (const ticker of TRADEABLE) {
    const res = fundamentalsStore.getResult(ticker);
    if (res.status !== 'ready') continue;
    const earnings = res.data.recentDisclosures.filter(d => d.category === 'earnings');
    for (const e of earnings) {
      const diff = e.filedAt - Date.now();
      if (diff > -86400000 && diff < 3 * 86400000) {
        events.push({
          label: `${ticker} EARNINGS`,
          type:  'earnings',
          ticker,
          withinMs: diff,
          risk: 'amber',
        });
      }
    }
  }

  return events;
}

/** Convert ms to "N candles" (5m per candle) */
function _msToCandles(ms: number): string {
  const candles = Math.round(Math.abs(ms) / (5 * 60 * 1000));
  return `${candles} candle${candles !== 1 ? 's' : ''}`;
}

// ── Article time helper ────────────────────────────────────────────────────────

function _formatArticleTime(utcMs: number): string {
  const ct  = toCentralTime(utcMs);
  const pad = (n: number) => String(n).padStart(2, '0');
  const h   = ct.hour % 12 || 12;
  const ampm = ct.hour < 12 ? 'AM' : 'PM';
  return `${h}:${pad(ct.minute)} ${ampm} CT`;
}

// ── Catalyst analysis ──────────────────────────────────────────────────────────

interface CatalystCard {
  ticker:    string;
  sentiment: 'bullish' | 'bearish' | 'neutral';
  cvdDir:    string;
  cvdPct:    number;
  cvdLabel:  string;
  gex:       string;
  biasNote:  string;
}

function _analyseText(text: string): CatalystCard[] {
  const cards: CatalystCard[] = [];
  const isBull = BULLISH_WORDS.test(text);
  const isBear = BEARISH_WORDS.test(text);
  const sentiment: 'bullish' | 'bearish' | 'neutral' = isBull && !isBear
    ? 'bullish' : isBear && !isBull ? 'bearish' : 'neutral';

  // Detect mentioned tickers
  const mentioned = new Set<string>();
  for (const ticker of TRADEABLE) {
    const re = new RegExp(`\\b${ticker}\\b`, 'i');
    if (re.test(text)) mentioned.add(ticker);
  }
  for (const { pattern, ticker } of ALIAS_MAP) {
    if (pattern.test(text)) mentioned.add(ticker);
  }

  for (const ticker of mentioned) {
    const cvdRes = cvdStore.getResult(ticker);
    const mktRes = marketStore.getResult(ticker);
    const dsState = getDirectionState(ticker);

    const cvdState  = cvdRes.status === 'ready' ? cvdRes.data : null;
    const mktState  = mktRes.status === 'ready' ? mktRes.data : null;

    const cvdDir    = cvdState?.classification ?? 'unknown';
    const cvdPct    = sentiment === 'bullish'
      ? (cvdState?.callPct ?? 50)
      : (cvdState?.putPct ?? 50);
    const cvdLabel  = cvdState
      ? (sentiment === 'bullish'
          ? `CVD ${Math.round(cvdState.callPct)}% calls${cvdState.classification === 'bullish' ? ' (confirming)' : ' (not confirming)'}`
          : `CVD ${Math.round(cvdState.putPct)}% puts${cvdState.classification === 'bearish' ? ' (confirming)' : ' (not confirming)'}`)
      : 'CVD unavailable';

    const gexRegime = mktState?.gexRegime ?? 'unknown';
    const gex       = gexRegime === 'negative'
      ? 'NEG GEX (amplifies moves)'
      : gexRegime === 'positive'
      ? 'POS GEX (dampens moves)'
      : 'GEX neutral';

    const bias = dsState?.sessionBias ?? null;
    const biasNote = bias
      ? (sentiment === 'bullish' && bias === 'bullish'
          ? 'Reinforces: CALL thesis active'
          : sentiment === 'bearish' && bias === 'bearish'
          ? 'Reinforces: PUT thesis active'
          : `Contradicts: ${bias} session bias active`)
      : 'No active direction thesis';

    cards.push({ ticker, sentiment, cvdDir, cvdPct, cvdLabel, gex, biasNote });
  }

  return cards;
}

// ── Sub-components ─────────────────────────────────────────────────────────────

function StatusDot({ status }: { status: 'idle' | 'polling' | 'error' }) {
  if (status === 'polling') {
    return (
      <span className="flex items-center gap-1 text-xs text-emerald-400">
        <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
        LIVE
      </span>
    );
  }
  if (status === 'error') {
    return (
      <span className="flex items-center gap-1 text-xs text-rose-400">
        <span className="w-2 h-2 rounded-full bg-rose-400" />
        ERROR
      </span>
    );
  }
  return (
    <span className="flex items-center gap-1 text-xs text-amber-400">
      <span className="w-2 h-2 rounded-full bg-amber-400" />
      IDLE
    </span>
  );
}

function BiasBadge({ ticker }: { ticker: string }) {
  const ds = getDirectionState(ticker);
  if (!ds) return <span className="text-xs text-slate-500">{ticker} —</span>;

  const biasColor = ds.sessionBias === 'bullish'
    ? 'bg-emerald-900/60 text-emerald-300 border border-emerald-700'
    : ds.sessionBias === 'bearish'
    ? 'bg-rose-900/60 text-rose-300 border border-rose-700'
    : 'bg-slate-800 text-slate-400 border border-slate-700';

  const playColor = ds.playDirection === 'calls'
    ? 'bg-emerald-900/60 text-emerald-300 border border-emerald-700'
    : ds.playDirection === 'puts'
    ? 'bg-rose-900/60 text-rose-300 border border-rose-700'
    : 'bg-slate-800 text-slate-400 border border-slate-700';

  return (
    <div className="flex items-center gap-1">
      <span className="text-xs text-slate-500 font-mono">{ticker}</span>
      <span className={`text-[10px] px-1.5 py-0.5 rounded font-bold uppercase ${biasColor}`}>
        {ds.sessionBias}
      </span>
      <span className={`text-[10px] px-1.5 py-0.5 rounded font-bold uppercase ${playColor}`}>
        {ds.playDirection}
      </span>
    </div>
  );
}

function MacroCalendar({ events }: { events: MacroEvent[] }) {
  if (events.length === 0) {
    return (
      <div className="flex items-center gap-2 px-4 py-2 bg-slate-900 border-b border-slate-800 text-xs text-slate-500">
        No macro events today or tomorrow.
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2 px-4 py-2 bg-slate-900 border-b border-slate-800 overflow-x-auto scrollbar-none">
      {events.map((ev, i) => {
        const isCountdown = Math.abs(ev.withinMs) < 90 * 60 * 1000 && ev.withinMs > 0;
        const base = ev.risk === 'binary'
          ? 'bg-rose-900/50 border-rose-700 text-rose-300'
          : 'bg-amber-900/50 border-amber-700 text-amber-300';
        return (
          <div
            key={i}
            className={`flex-shrink-0 border rounded px-3 py-1.5 text-xs font-bold uppercase ${base}`}
          >
            {ev.label}
            {isCountdown && (
              <span className="ml-2 text-[10px] font-normal opacity-80">
                in {_msToCandles(ev.withinMs)}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}

function ImpactBadge({ article }: { article: NewsArticle }) {
  const ageMs  = Date.now() - article.publishedUtc;
  const recent = ageMs < 10 * 60 * 1000;

  if (article.impact === 'HIGH') {
    return (
      <span className={`text-[10px] px-1.5 py-0.5 rounded font-bold uppercase bg-rose-900/70 text-rose-300 border border-rose-700 ${recent ? 'animate-pulse' : ''}`}>
        HIGH
      </span>
    );
  }
  if (article.impact === 'MEDIUM') {
    return (
      <span className="text-[10px] px-1.5 py-0.5 rounded font-bold uppercase bg-amber-900/70 text-amber-300 border border-amber-700">
        MED
      </span>
    );
  }
  return (
    <span className="text-[10px] px-1.5 py-0.5 rounded font-bold uppercase bg-slate-800 text-slate-400 border border-slate-700">
      LOW
    </span>
  );
}

function SentimentBorder({ sentiment }: { sentiment: NewsArticle['sentiment'] }) {
  const color = sentiment === 'bullish'
    ? 'bg-emerald-500'
    : sentiment === 'bearish'
    ? 'bg-rose-500'
    : sentiment === 'mixed'
    ? 'bg-amber-500'
    : 'bg-slate-600';
  return <div className={`absolute left-0 top-0 bottom-0 w-1 rounded-l ${color}`} />;
}

function HighImpactCrossRef({ article }: { article: NewsArticle }) {
  if (article.tickers.length === 0) return null;
  return (
    <div className="mt-2 pt-2 border-t border-slate-700 space-y-1">
      {article.tickers.map(ticker => {
        const cvdRes = cvdStore.getResult(ticker);
        const mktRes = marketStore.getResult(ticker);
        const cvd    = cvdRes.status === 'ready' ? cvdRes.data : null;
        const mkt    = mktRes.status === 'ready' ? mktRes.data : null;
        return (
          <div key={ticker} className="text-xs text-slate-400">
            <span className="font-mono text-slate-300">{ticker}</span>
            {cvd && (
              <span className="ml-2">
                CVD {Math.round(cvd.callPct)}% calls / {Math.round(cvd.putPct)}% puts
                <span className={`ml-1 font-semibold ${cvd.classification === 'bullish' ? 'text-emerald-400' : cvd.classification === 'bearish' ? 'text-rose-400' : 'text-slate-400'}`}>
                  ({cvd.classification})
                </span>
              </span>
            )}
            {mkt && (
              <span className={`ml-2 ${mkt.gexRegime === 'negative' ? 'text-rose-400' : mkt.gexRegime === 'positive' ? 'text-emerald-400' : 'text-slate-400'}`}>
                · GEX {mkt.gexRegime.toUpperCase()}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}

function ArticleRow({
  article,
  onTickerClick,
}: {
  article: NewsArticle;
  onTickerClick: (t: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const ageMs    = Date.now() - article.publishedUtc;
  const old      = ageMs > 24 * 3600 * 1000;
  const timeStr  = _formatArticleTime(article.publishedUtc);

  return (
    <div className={`relative pl-3 pr-3 py-3 bg-slate-900 border border-slate-800 rounded-lg transition-opacity ${old ? 'opacity-40' : ''}`}>
      <SentimentBorder sentiment={article.sentiment} />
      <div className="flex items-start gap-2 flex-wrap">
        <ImpactBadge article={article} />
        <p className="flex-1 text-sm text-slate-100 leading-snug min-w-0">
          {article.title}
        </p>
        <button
          onClick={() => setExpanded(e => !e)}
          className="text-slate-500 hover:text-slate-300 transition-colors shrink-0"
          aria-label={expanded ? 'Collapse' : 'Expand'}
        >
          <svg className={`w-4 h-4 transition-transform ${expanded ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
          </svg>
        </button>
      </div>
      <div className="flex items-center gap-2 mt-1.5 flex-wrap">
        <span className="text-xs text-slate-500">{article.source} · {timeStr}</span>
        {article.tickers.map(t => (
          <button
            key={t}
            onClick={() => onTickerClick(t)}
            className="text-[10px] px-1.5 py-0.5 rounded bg-slate-800 text-slate-300 border border-slate-700 hover:border-slate-500 transition-colors font-mono"
          >
            {t}
          </button>
        ))}
      </div>
      {expanded && (
        <div className="mt-2 text-xs text-slate-400 leading-relaxed">
          {article.description || 'No description available.'}
          {article.impact === 'HIGH' && <HighImpactCrossRef article={article} />}
          <a
            href={article.articleUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="block mt-1.5 text-sky-500 hover:text-sky-400 transition-colors"
          >
            Read full article →
          </a>
        </div>
      )}
    </div>
  );
}

function CatalystAnalysisList({ cards }: { cards: CatalystCard[] }) {
  if (cards.length === 0) return null;

  return (
    <div className="space-y-2 mt-3">
      {cards.map((c, i) => {
        const sentColor = c.sentiment === 'bullish'
          ? 'text-emerald-400' : c.sentiment === 'bearish'
          ? 'text-rose-400' : 'text-slate-400';
        return (
          <div key={i} className="bg-slate-800/60 border border-slate-700 rounded-lg px-3 py-2">
            <div className="flex items-baseline gap-2 flex-wrap">
              <span className="font-mono text-sm text-slate-200 font-bold">{c.ticker}</span>
              <span className={`text-xs font-semibold uppercase ${sentColor}`}>{c.sentiment} headline</span>
            </div>
            <div className="text-xs text-slate-400 mt-1 space-y-0.5">
              <div>{c.cvdLabel}</div>
              <div>{c.gex}</div>
              <div>{c.biasNote}</div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ── Main Component ─────────────────────────────────────────────────────────────

export default function NewsCockpit() {
  const [articles,       setArticles]       = useState<NewsArticle[]>([]);
  const [status,         setStatus]         = useState<'idle' | 'polling' | 'error'>('idle');
  const [lastRefresh,    setLastRefresh]     = useState('—');
  const [macroEvents,    setMacroEvents]     = useState<MacroEvent[]>([]);
  const [activeFilters,  setActiveFilters]   = useState<Set<string>>(new Set());
  const [catalystText,   setCatalystText]    = useState('');
  const [catalystCards,  setCatalystCards]   = useState<CatalystCard[]>([]);
  const [, forceRender]                     = useState(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Rebuild from stores
  const rebuild = useCallback(() => {
    const arts = newsStore.getArticles();
    setArticles(arts);
    setStatus(newsStore.getStatus());

    if (arts.length > 0) {
      const ct  = toCentralTime(Date.now());
      const pad = (n: number) => String(n).padStart(2, '0');
      setLastRefresh(`${pad(ct.hour)}:${pad(ct.minute)}:${pad(ct.second)} CT`);
    }

    setMacroEvents(_buildMacroEvents());
  }, []);

  useEffect(() => {
    newsStore.startPolling();

    const unsubNews = newsStore.subscribe(() => rebuild());
    const unsubDir  = subscribeDirection(() => forceRender(n => n + 1));
    const unsubMkt  = marketStore.subscribe(() => rebuild());

    rebuild();

    return () => {
      unsubNews();
      unsubDir();
      unsubMkt();
    };
  }, [rebuild]);

  // Filtered article list
  const displayed = activeFilters.size === 0
    ? articles
    : articles.filter(a => a.tickers.some(t => activeFilters.has(t)));

  function toggleFilter(t: string) {
    setActiveFilters(prev => {
      const next = new Set(prev);
      if (next.has(t)) next.delete(t);
      else next.add(t);
      return next;
    });
  }

  function handleCatalystSubmit() {
    const text = catalystText.trim();
    if (!text) return;
    const cards = _analyseText(text);
    setCatalystCards(cards);
    setCatalystText('');
  }

  function handleCatalystKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleCatalystSubmit();
    }
  }

  const hasError = status === 'error';

  return (
    <div className="flex flex-col min-h-screen bg-slate-950 text-slate-100 font-mono">

      {/* ── Sticky header ── */}
      <div className="sticky top-0 z-20 bg-slate-950 border-b border-slate-800">
        <div className="flex items-center justify-between px-4 py-2 flex-wrap gap-2">
          <div className="flex items-center gap-4 flex-wrap">
            <span className="text-xs text-slate-500 uppercase tracking-wider font-bold">NEWS</span>
            <BiasBadge ticker="SPY" />
            <BiasBadge ticker="QQQ" />
            <BiasBadge ticker="IWM" />
          </div>
          <div className="flex items-center gap-3">
            <StatusDot status={status} />
            <span className="text-xs text-slate-500">Updated {lastRefresh}</span>
          </div>
        </div>
      </div>

      {/* ── Macro event calendar strip ── */}
      <MacroCalendar events={macroEvents} />

      <div className="flex-1 max-w-4xl w-full mx-auto px-4 py-4 space-y-4">

        {/* ── Manual catalyst input ── */}
        <section id="catalyst-input">
          <div className="bg-slate-900 border border-slate-700 rounded-xl overflow-hidden">
            <div className="px-3 pt-2 pb-1 text-[10px] text-slate-500 uppercase tracking-wider font-bold">
              Manual Catalyst Analyzer
            </div>
            <textarea
              ref={textareaRef}
              value={catalystText}
              onChange={e => setCatalystText(e.target.value)}
              onKeyDown={handleCatalystKeyDown}
              placeholder="Paste any headline, tweet, or breaking news..."
              rows={2}
              className="w-full bg-transparent px-3 pb-2 text-sm text-slate-200 placeholder-slate-600 resize-none outline-none"
            />
            <div className="flex justify-between items-center px-3 pb-3">
              <span className="text-xs text-slate-600">Enter to analyze · Shift+Enter for new line</span>
              <button
                onClick={handleCatalystSubmit}
                disabled={!catalystText.trim()}
                className="px-3 py-1 text-xs bg-sky-600 hover:bg-sky-500 disabled:bg-slate-800 disabled:text-slate-600 text-white rounded transition-colors"
              >
                Analyze
              </button>
            </div>
          </div>
          {catalystCards.length > 0 && (
            <div>
              <CatalystAnalysisList cards={catalystCards} />
              <button
                onClick={() => setCatalystCards([])}
                className="mt-2 text-xs text-slate-600 hover:text-slate-400 transition-colors"
              >
                Clear analysis
              </button>
            </div>
          )}
        </section>

        {/* ── Ticker filter bar ── */}
        <section id="ticker-filter">
          <div className="flex items-center gap-2 overflow-x-auto scrollbar-none pb-1">
            <button
              onClick={() => setActiveFilters(new Set())}
              className={`flex-shrink-0 text-xs px-3 py-1 rounded-full border transition-colors ${
                activeFilters.size === 0
                  ? 'bg-sky-700 border-sky-600 text-white'
                  : 'bg-slate-900 border-slate-700 text-slate-400 hover:border-slate-500'
              }`}
            >
              ALL
            </button>
            {TRADEABLE.map(t => (
              <button
                key={t}
                onClick={() => toggleFilter(t)}
                className={`flex-shrink-0 text-xs px-2.5 py-1 rounded-full border font-mono transition-colors ${
                  activeFilters.has(t)
                    ? 'bg-sky-700 border-sky-600 text-white'
                    : 'bg-slate-900 border-slate-700 text-slate-400 hover:border-slate-500'
                }`}
              >
                {t}
              </button>
            ))}
          </div>
        </section>

        {/* ── Article feed ── */}
        <section id="article-feed" className="space-y-2">
          {hasError && (
            <div className="text-center py-6 text-rose-400 text-sm">
              News feed error — retrying in 5 minutes.
            </div>
          )}
          {!hasError && articles.length === 0 && (
            <div className="text-center py-12 text-slate-600 text-sm">
              No news loaded — polling starts when market opens.
            </div>
          )}
          {displayed.length === 0 && articles.length > 0 && (
            <div className="text-center py-6 text-slate-600 text-sm">
              No articles for selected ticker(s).
            </div>
          )}
          {displayed.map(article => (
            <ArticleRow
              key={article.id}
              article={article}
              onTickerClick={t => {
                setActiveFilters(new Set([t]));
                window.scrollTo({ top: 0, behavior: 'smooth' });
              }}
            />
          ))}
        </section>

      </div>
    </div>
  );
}
