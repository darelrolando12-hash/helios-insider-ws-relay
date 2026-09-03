/**
 * InsidersCockpit — Form 4 insider transaction feed.
 *
 * Data source: fundamentalsStore exclusively. Zero outbound calls.
 * fundamentalsStore holds every transaction type and both 10b5-1 states —
 * filtering for "which rows matter" happens here, at the display layer,
 * via the filter tabs below.
 *
 * Filter tabs: All | Buys | Sells | Non-10b5-1 | 10b5-1
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

// Spec filter set: All / Buys / Sells / Non-10b5-1 / 10b5-1
// fundamentalsStore holds every transaction type and both 10b5-1 states —
// each tab filters the real underlying data, none are structurally empty.
type FilterTab = 'all' | 'buys' | 'sells' | 'non_10b51' | 'is_10b51';

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

// (officer/director helpers removed — spec filters are All/Buys/Sells/Non-10b5-1/10b5-1)

// ── Sub-components ─────────────────────────────────────────────────────────────

function HeaderBar() {
  const tickers = ['SPY', 'QQQ', 'IWM'];
  return (
    <div className="sticky top-0 z-20 bg-void border-b" style={{ borderColor: 'var(--line)' }}>
      <div className="flex items-center justify-between px-4 py-2 flex-wrap gap-2">
        <div className="flex items-center gap-4 flex-wrap">
          <span className="text-xs text-mut uppercase tracking-wider font-bold">INSIDERS</span>
          {tickers.map(t => {
            const ds = getDirectionState(t);
            if (!ds) return null;
            const biasColor = ds.sessionBias === 'bullish'
              ? 'bg-col-g/15 text-col-g border-col-g/30'
              : ds.sessionBias === 'bearish'
              ? 'bg-col-r/15 text-col-r border-col-r/30'
              : 'bg-white/5 text-white/40 border-white/10';
            const playColor = ds.playDirection === 'calls'
              ? 'bg-col-g/15 text-col-g border-col-g/30'
              : ds.playDirection === 'puts'
              ? 'bg-col-r/15 text-col-r border-col-r/30'
              : 'bg-white/5 text-white/40 border-white/10';
            return (
              <div key={t} className="flex items-center gap-1">
                <span className="text-xs text-mut font-mono">{t}</span>
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
        <span className="text-xs text-mut">Form 4 · non-10b5-1 only</span>
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
    { id: 'all',       label: 'All'         },
    { id: 'buys',      label: 'Buys'        },
    { id: 'sells',     label: 'Sells'       },
    { id: 'non_10b51', label: 'Non-10b5-1'  },
    { id: 'is_10b51',  label: '10b5-1'      },
  ];

  return (
    <div className="flex gap-1 overflow-x-auto scrollbar-none pb-1">
      {tabs.map(tab => (
        <button
          key={tab.id}
          onClick={() => onChange(tab.id)}
          className={`flex-shrink-0 px-3 py-1.5 text-xs font-semibold transition-colors ${
            active === tab.id
              ? 'bg-amb/20 text-amb border border-amb/40'
              : 'bg-white/5 text-white/40 border border-white/8 hover:text-white/70'
          }`}
          style={{ borderRadius: 4 }}
        >
          {tab.label}
          <span className={`ml-1.5 ${active === tab.id ? 'text-amb/70' : 'text-white/25'}`}>
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

  const color = ds.sessionBias === 'bullish' ? 'text-col-g' : 'text-col-r';
  const label = ds.playDirection === 'calls' ? 'CALL' : ds.playDirection === 'puts' ? 'PUT' : null;
  if (!label) return null;

  return (
    <span className={`text-[10px] px-1 py-0.5 rounded font-bold border ${
      ds.sessionBias === 'bullish'
        ? 'border-col-g/40 bg-col-g/15 text-col-g'
        : 'border-col-r/40 bg-col-r/15 text-col-r'
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
    ? 'border-col-r/40 bg-col-r/15 text-col-r'
    : 'border-amb/40 bg-amb/15 text-amb';

  return (
    <span className={`text-[10px] px-1 py-0.5 rounded font-bold border ${color}`}>
      SQUEEZE {score}
    </span>
  );
}

function TransactionRow({ tx }: { tx: EnrichedTx }) {
  const isBuy    = tx.transactionType === 'buy';
  const dirColor = isBuy ? 'text-col-g' : 'text-col-r';
  const dirIcon  = isBuy ? '↑' : '↓';
  const borderColor = isBuy ? 'border-col-g/20' : 'border-col-r/15';

  return (
    <div className={`bg-[var(--panel)] border ${borderColor} px-4 py-3`} style={{ borderRadius: 4 }}>
      {/* Top row */}
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2 flex-wrap">
          <span className={`text-lg font-bold ${dirColor}`}>{dirIcon}</span>
          <span className="font-mono text-sm font-bold text-[var(--ink)]">{tx.ticker}</span>
          <span className={`text-2xl font-extrabold tabular-nums ${dirColor}`}>
            {_formatDollar(tx.totalValue)}
          </span>
          {/* 10b5-1 pill — load-bearing per spec */}
          {tx.is10b51
            ? (
              <span className="text-[10px] px-1.5 py-0.5 border border-white/15 text-dim font-bold"
                style={{ borderRadius: 3 }}>
                10b5-1 Scheduled
              </span>
            ) : (
              <span className="text-[10px] px-1.5 py-0.5 border border-col-g/40 bg-col-g/15 text-col-g font-bold"
                style={{ borderRadius: 3 }}>
                Not 10b5-1
              </span>
            )
          }
        </div>
        <div className="flex items-center gap-1.5 flex-wrap">
          <SignalIndicator ticker={tx.ticker} />
          <SqueezeIndicator ticker={tx.ticker} />
        </div>
      </div>

      {/* Detail row */}
      <div className="mt-1.5 flex items-center gap-3 flex-wrap text-xs text-[var(--mut)]">
        <span className="text-[var(--ink)]/70 font-medium">{tx.insiderName}</span>
        <span className="text-[var(--dim)]">·</span>
        <span>{tx.relationship}</span>
        <span className="text-[var(--dim)]">·</span>
        <span>{_formatShares(tx.shares)}</span>
        <span className="text-[var(--dim)]">·</span>
        <span>@ ${tx.pricePerShare.toFixed(2)}/sh</span>
        <span className="text-[var(--dim)]">·</span>
        <span>{_formatDate(tx.transactedAt)}</span>
      </div>
    </div>
  );
}

function SkeletonRow() {
  return (
    <div className="bg-panel border rounded-lg px-4 py-3 animate-pulse space-y-2" style={{ borderColor: 'var(--line)' }}>
      <div className="h-4 bg-white/8 rounded w-48" />
      <div className="h-3 bg-white/5 rounded w-72" />
    </div>
  );
}

// ── Main Component ─────────────────────────────────────────────────────────────

export default function InsidersCockpit() {
  const [allTxs,  setAllTxs]  = useState<EnrichedTx[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter,  setFilter]  = useState<FilterTab>('all');
  const [, forceRender]       = useState(0);

  const rebuild = useCallback(() => {
    const txs: EnrichedTx[] = [];
    let anyReady = false;

    for (const ticker of TRADEABLE) {
      const res = fundamentalsStore.getResult(ticker);
      if (res.status !== 'ready') continue;
      anyReady = true;

      for (const tx of res.data.insiderTransactions) {
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
    if (filter === 'non_10b51') return !tx.is10b51;
    if (filter === 'is_10b51')  return tx.is10b51;
    return true;
  });

  const counts: Record<FilterTab, number> = {
    all:       allTxs.length,
    buys:      allTxs.filter(t => t.transactionType === 'buy').length,
    sells:     allTxs.filter(t => t.transactionType === 'sell').length,
    non_10b51: allTxs.filter(t => !t.is10b51).length,
    is_10b51:  allTxs.filter(t => t.is10b51).length,
  };

  return (
    <div className="flex flex-col min-h-screen bg-[var(--void)] text-[var(--ink)] font-mono">
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
            <div className="text-center py-12 text-[var(--dim)] text-sm">
              {filter === 'buys'
                ? 'No discretionary insider buys on file.'
                : filter === 'sells'
                ? 'No insider sells on file.'
                : filter === 'non_10b51'
                ? 'No non-10b5-1 transactions on file.'
                : filter === 'is_10b51'
                ? 'No 10b5-1 scheduled transactions on file.'
                : 'No transactions match this filter.'}
            </div>
          )}

          {filtered.map((tx) => (
            <TransactionRow key={tx.id} tx={tx} />
          ))}
        </section>

        {!loading && allTxs.length === 0 && (
          <p className="text-center text-xs text-dim pb-4">
            Insider data loads after the post-market cron runs. No Form 4 filings detected yet.
          </p>
        )}
      </div>
    </div>
  );
}
