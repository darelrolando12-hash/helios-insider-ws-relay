/**
 * InsidersCockpit — Form 4 insider transaction feed.
 *
 * Data source: fundamentalsStore exclusively. Zero outbound calls.
 * Only non-10b5-1 transactions are shown (is10b51 === false — already filtered
 * at write time in fundamentalsStore; this cockpit never relaxes that filter).
 *
 * Filter tabs: All | Buys Only | Sells | Officers | Directors
 * Signal indicator: shown when ticker has an active directionState signal.
 * Squeeze risk: shown from squeezeEngine when available.
 */

import { useState, useEffect, useCallback } from 'react';
import * as fundamentalsStore               from '../stores/fundamentalsStore';
import * as squeezeEngine                   from '../engines/squeezeEngine';
import {
  getDirectionState,
  subscribe as subscribeDirection,
  FEED_TICKERS,
  CONTEXT_ONLY_TICKERS,
} from '../state/directionState';
import { toCentralTime }                    from '../lib/time';
import type { InsiderTransaction }          from '../stores/types';

// ── Constants ──────────────────────────────────────────────────────────────────

const TRADEABLE = FEED_TICKERS.filter(t => !CONTEXT_ONLY_TICKERS.has(t));

type FilterTab = 'all' | 'buys' | 'sells' | 'officers' | 'directors';

interface EnrichedTx extends InsiderTransaction {
  ticker: string; // pulled from the parent fundamentals record
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function _formatDollar(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1_000_000_000) return `$${(n / 1_000_000_000).toFixed(2)}B`;
  if (abs >= 1_000_000)     return `$${(n / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000)         return `$${(n / 1_000).toFixed(1)}K`;
  return `$${n.toFixed(0)}`;
}

function _formatShares(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M shares`;
  if (n >= 1_000)     return `${(n / 1_000).toFixed(1)}K shares`;
  return `${n} shares`;
}

function _formatDate(utcMs: number): string {
  const ct  = toCentralTime(utcMs);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${ct.year}-${pad(ct.month)}-${pad(ct.day)}`;
}

function _isOfficer(relationship: string): boolean {
  return /\b(ceo|cfo|coo|cto|president|vp|chief|officer|svp|evp)\b/i.test(relationship);
}

function _isDirector(relationship: string): boolean {
  return /\bdirector\b/i.test(relationship);
}

// ── Sub-components ─────────────────────────────────────────────────────────────

function HeaderBar() {
  const tickers = ['SPY', 'QQQ', 'IWM'];
  return (
    <div className="sticky top-0 z-20 bg-slate-950 border-b border-slate-800">
      <div className="flex items-center justify-between px-4 py-2 flex-wrap gap-2">
        <div className="flex items-center gap-4 flex-wrap">
          <span className="text-xs text-slate-500 uppercase tracking-wider font-bold">INSIDERS</span>
          {tickers.map(t => {
            const ds = getDirectionState(t);
            if (!ds) return null;
            const biasColor = ds.sessionBias === 'bullish'
              ? 'bg-emerald-900/60 text-emerald-300 border-emerald-700'
              : ds.sessionBias === 'bearish'
              ? 'bg-rose-900/60 text-rose-300 border-rose-700'
              : 'bg-slate-800 text-slate-400 border-slate-700';
            const playColor = ds.playDirection === 'calls'
              ? 'bg-emerald-900/60 text-emerald-300 border-emerald-700'
              : ds.playDirection === 'puts'
              ? 'bg-rose-900/60 text-rose-300 border-rose-700'
              : 'bg-slate-800 text-slate-400 border-slate-700';
            return (
              <div key={t} className="flex items-center gap-1">
                <span className="text-xs text-slate-500 font-mono">{t}</span>
                <span className={`text-[10px] px-1.5 py-0.5 rounded font-bold uppercase border ${biasColor}`}>
                  {ds.sessionBias}
                </span>
                <span className={`text-[10px] px-1.5 py-0.5 rounded font-bold uppercase border ${playColor}`}>
                  {ds.playDirection}
                </span>
              </div>
            );
          })}
        </div>
        <span className="text-xs text-slate-500">Form 4 · non-10b5-1 only</span>
      </div>
    </div>
  );
}

function FilterTabs({
  active,
  onChange,
  counts,
}: {
  active: FilterTab;
  onChange: (t: FilterTab) => void;
  counts: Record<FilterTab, number>;
}) {
  const tabs: { id: FilterTab; label: string }[] = [
    { id: 'all',       label: 'All'       },
    { id: 'buys',      label: 'Buys Only' },
    { id: 'sells',     label: 'Sells'     },
    { id: 'officers',  label: 'Officers'  },
    { id: 'directors', label: 'Directors' },
  ];

  return (
    <div className="flex gap-1 overflow-x-auto scrollbar-none pb-1">
      {tabs.map(tab => (
        <button
          key={tab.id}
          onClick={() => onChange(tab.id)}
          className={`flex-shrink-0 px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors ${
            active === tab.id
              ? 'bg-sky-700 text-white'
              : 'bg-slate-800 text-slate-400 hover:bg-slate-700'
          }`}
        >
          {tab.label}
          <span className={`ml-1.5 ${active === tab.id ? 'text-sky-200' : 'text-slate-500'}`}>
            {counts[tab.id]}
          </span>
        </button>
      ))}
    </div>
  );
}

function SignalIndicator({ ticker }: { ticker: string }) {
  const ds = getDirectionState(ticker);
  if (!ds || ds.sessionBias === 'neutral') return null;

  const color = ds.sessionBias === 'bullish' ? 'text-emerald-400' : 'text-rose-400';
  const label = ds.playDirection === 'calls' ? 'CALL' : ds.playDirection === 'puts' ? 'PUT' : null;
  if (!label) return null;

  return (
    <span className={`text-[10px] px-1 py-0.5 rounded font-bold border ${
      ds.sessionBias === 'bullish'
        ? 'border-emerald-700 bg-emerald-900/40 text-emerald-400'
        : 'border-rose-700 bg-rose-900/40 text-rose-400'
    } ${color}`}>
      ▲ {label} active
    </span>
  );
}

function SqueezeIndicator({ ticker }: { ticker: string }) {
  const res = squeezeEngine.getResult(ticker);
  if (res.status !== 'ready') return null;
  const { level, score } = res.data;
  if (level === 'low') return null;

  const color = level === 'high'
    ? 'border-rose-700 bg-rose-900/40 text-rose-400'
    : 'border-amber-700 bg-amber-900/40 text-amber-400';

  return (
    <span className={`text-[10px] px-1 py-0.5 rounded font-bold border ${color}`}>
      SQUEEZE {score}
    </span>
  );
}

function TransactionRow({ tx }: { tx: EnrichedTx }) {
  const isBuy    = tx.transactionType === 'buy';
  const dirColor = isBuy ? 'text-emerald-400' : 'text-rose-400';
  const dirIcon  = isBuy ? '↑' : '↓';
  const borderColor = isBuy ? 'border-emerald-800' : 'border-rose-900';

  return (
    <div className={`bg-slate-900 border ${borderColor} rounded-lg px-4 py-3`}>
      {/* Top row */}
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2 flex-wrap">
          <span className={`text-lg font-bold ${dirColor}`}>{dirIcon}</span>
          <span className="font-mono text-sm font-bold text-slate-100">{tx.ticker}</span>
          <span className={`text-2xl font-extrabold tabular-nums ${dirColor}`}>
            {_formatDollar(tx.totalValue)}
          </span>
        </div>
        <div className="flex items-center gap-1.5 flex-wrap">
          <SignalIndicator ticker={tx.ticker} />
          <SqueezeIndicator ticker={tx.ticker} />
        </div>
      </div>

      {/* Detail row */}
      <div className="mt-1.5 flex items-center gap-3 flex-wrap text-xs text-slate-400">
        <span className="text-slate-300 font-medium">{tx.insiderName}</span>
        <span className="text-slate-500">·</span>
        <span>{tx.relationship}</span>
        <span className="text-slate-500">·</span>
        <span>{_formatShares(tx.shares)}</span>
        <span className="text-slate-500">·</span>
        <span>@ ${tx.pricePerShare.toFixed(2)}/sh</span>
        <span className="text-slate-500">·</span>
        <span>{_formatDate(tx.transactedAt)}</span>
      </div>
    </div>
  );
}

function SkeletonRow() {
  return (
    <div className="bg-slate-900 border border-slate-800 rounded-lg px-4 py-3 animate-pulse space-y-2">
      <div className="h-4 bg-slate-800 rounded w-48" />
      <div className="h-3 bg-slate-800 rounded w-72" />
    </div>
  );
}

// ── Main Component ─────────────────────────────────────────────────────────────

export default function InsidersCockpit() {
  const [allTxs,  setAllTxs]  = useState<EnrichedTx[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter,  setFilter]  = useState<FilterTab>('buys');
  const [, forceRender]       = useState(0);

  const rebuild = useCallback(() => {
    const txs: EnrichedTx[] = [];
    let anyReady = false;

    for (const ticker of TRADEABLE) {
      const res = fundamentalsStore.getResult(ticker);
      if (res.status !== 'ready') continue;
      anyReady = true;

      for (const tx of res.data.insiderTransactions) {
        // is10b5-1 filter: fundamentalsStore already excludes them at write time,
        // but we double-guard here per spec.
        if (tx.is10b51) continue;
        txs.push({ ...tx, ticker });
      }
    }

    // Sort newest first by transactedAt
    txs.sort((a, b) => b.transactedAt - a.transactedAt);
    setAllTxs(txs);
    setLoading(!anyReady);
  }, []);

  useEffect(() => {
    const unsubFund = fundamentalsStore.subscribe(() => rebuild());
    const unsubDir  = subscribeDirection(() => forceRender(n => n + 1));
    const unsubSqz  = squeezeEngine.subscribe(() => forceRender(n => n + 1));
    rebuild();
    return () => {
      unsubFund();
      unsubDir();
      unsubSqz();
    };
  }, [rebuild]);

  // Apply filter
  const filtered = allTxs.filter(tx => {
    if (filter === 'buys')      return tx.transactionType === 'buy';
    if (filter === 'sells')     return tx.transactionType === 'sell';
    if (filter === 'officers')  return _isOfficer(tx.relationship);
    if (filter === 'directors') return _isDirector(tx.relationship);
    return true;
  });

  const counts: Record<FilterTab, number> = {
    all:       allTxs.length,
    buys:      allTxs.filter(t => t.transactionType === 'buy').length,
    sells:     allTxs.filter(t => t.transactionType === 'sell').length,
    officers:  allTxs.filter(t => _isOfficer(t.relationship)).length,
    directors: allTxs.filter(t => _isDirector(t.relationship)).length,
  };

  return (
    <div className="flex flex-col min-h-screen bg-slate-950 text-slate-100 font-mono">
      <HeaderBar />

      <div className="flex-1 max-w-4xl w-full mx-auto px-4 py-4 space-y-4">

        {/* Filter tabs */}
        <section id="filter-tabs">
          <FilterTabs active={filter} onChange={setFilter} counts={counts} />
        </section>

        {/* Feed */}
        <section id="insider-feed" className="space-y-2">
          {loading && (
            <>
              <SkeletonRow />
              <SkeletonRow />
              <SkeletonRow />
            </>
          )}

          {!loading && filtered.length === 0 && (
            <div className="text-center py-12 text-slate-600 text-sm">
              {filter === 'buys'
                ? 'No discretionary insider buys on file.'
                : filter === 'sells'
                ? 'No insider sells on file.'
                : 'No transactions match this filter.'}
            </div>
          )}

          {filtered.map((tx, i) => (
            <TransactionRow key={`${tx.ticker}-${tx.transactedAt}-${i}`} tx={tx} />
          ))}
        </section>

        {!loading && allTxs.length === 0 && (
          <p className="text-center text-xs text-slate-600 pb-4">
            Insider data loads after the post-market cron runs. No Form 4 filings detected yet.
          </p>
        )}
      </div>
    </div>
  );
}
