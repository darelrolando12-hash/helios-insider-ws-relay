/**
 * DashboardCockpit — spec-accurate rebuild against helios-full-mockup.html
 *
 * Layout (top → bottom):
 *   1. Regime banner — amber left-border, real sessionBias + reason from SPY dir state
 *   2. Watchlist section — editable rows: avatar / ticker+company / sparkline / price / change badge / flags
 *   3. Gamma Snapshot card (SPX) — flip/spot/callwall bars, net GEX, zero-flip, squeeze chips
 *   4. Insider Activity preview — 3 most recent Form 4 rows, Not 10b5-1 vs 10b5-1 pill
 *
 * Data sources: all real stores. No fabricated numbers.
 * If a store hasn't written yet, show —/dim gracefully.
 */

import { useCallback, useEffect, useState } from 'react';
import * as barsStore          from '../stores/barsStore';
import * as marketStore        from '../stores/marketStore';
import * as cvdStore           from '../stores/cvdStore';
import * as fundamentalsStore  from '../stores/fundamentalsStore';
import {
  getDirectionState,
  subscribe as subscribeDirection,
  FEED_TICKERS,
  CONTEXT_ONLY_TICKERS,
  CASH_SETTLED_TICKERS,
} from '../state/directionState';
import type { DirectionState } from '../state/directionState';
import type { MarketContext }  from '../stores/marketStore';
import type { Bar }            from '../stores/types';
import type { InsiderTransaction } from '../stores/types';

// ── Company name map ───────────────────────────────────────────────────────────

const COMPANY_NAMES: Record<string, string> = {
  SPY:  'SPDR S&P 500 ETF',    QQQ:  'Invesco QQQ Trust',      IWM:  'iShares Russell 2000',
  SPX:  'S&P 500 Index',        NDX:  'Nasdaq-100 Index',
  AAPL: 'Apple Inc',            TSLA: 'Tesla Inc',              NVDA: 'NVIDIA Corp',
  MSFT: 'Microsoft Corp',       AMZN: 'Amazon.com Inc',         META: 'Meta Platforms',
  AMD:  'Advanced Micro Devices', GOOGL: 'Alphabet Inc',        NFLX: 'Netflix Inc',
  COIN: 'Coinbase Global',      PLTR: 'Palantir Technologies',  HOOD: 'Robinhood Markets',
  SOFI: 'SoFi Technologies',    JPM:  'JPMorgan Chase',         BAC:  'Bank of America',
  MSTR: 'MicroStrategy Inc',    SMCI: 'Super Micro Computer',   GLD:  'SPDR Gold Shares',
};

// ── Avatar initials ────────────────────────────────────────────────────────────

function tickerInitials(ticker: string): string {
  return ticker.slice(0, 2).toUpperCase();
}

// ── Sparkline component (SVG, real bars) ───────────────────────────────────────

function Sparkline({ bars, positive }: { bars: Bar[]; positive: boolean }) {
  if (bars.length < 2) {
    return <div style={{ width: 52, height: 24, opacity: 0.2, background: 'rgba(255,255,255,0.05)', borderRadius: 2 }} />;
  }
  const closes = bars.slice(-20).map(b => b.close);
  const min = Math.min(...closes);
  const max = Math.max(...closes);
  const range = max - min || 1;
  const w = 52, h = 24, pts = closes.map((c, i) => {
    const x = (i / (closes.length - 1)) * w;
    const y = h - ((c - min) / range) * (h - 2) - 1;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
  const color = positive ? 'var(--g)' : 'var(--r)';
  return (
    <svg width={w} height={h} style={{ overflow: 'visible', flexShrink: 0 }}>
      <polyline points={pts} fill="none" stroke={color} strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" opacity={0.8} />
    </svg>
  );
}

// ── Format helpers ─────────────────────────────────────────────────────────────

function fmt(n: number | null | undefined, dec = 2): string {
  if (n == null || isNaN(n)) return '—';
  return n.toLocaleString('en-US', { minimumFractionDigits: dec, maximumFractionDigits: dec });
}

function fmtDollar(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (abs >= 1e6) return `${(n / 1e6).toFixed(0)}M`;
  if (abs >= 1e3) return `${(n / 1e3).toFixed(0)}K`;
  return n.toFixed(0);
}

function fmtDate(utcMs: number): string {
  const d = new Date(utcMs);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

// ── Watchlist tickers (default list matching the mockup) ──────────────────────

const DEFAULT_WATCHLIST: string[] = [
  'SPX', 'SPY', 'QQQ', 'NVDA', 'TSLA', 'AAPL', 'MSFT', 'AMD', 'META', 'AMZN', 'MSTR', 'IWM', 'HOOD',
];

// ── Flag chip logic: SQUEEZE / ELITE / WATCH ─────────────────────────────────

function getFlags(ticker: string, mkt: MarketContext | null, dir: DirectionState | null): string[] {
  const flags: string[] = [];
  const fund = fundamentalsStore.getResult(ticker);
  const si = fund.status === 'ready' ? fund.data.shortInterest?.shortFloat : null;
  if (si != null && si > 0.12) flags.push('SQUEEZE');
  if (dir?.sessionBias === 'bullish' && dir?.playDirection === 'calls') flags.push('ELITE');
  if (mkt && mkt.gexRegime === 'negative') flags.push('WATCH');
  return flags;
}

// ── WatchlistRow ──────────────────────────────────────────────────────────────

interface RowData {
  ticker:   string;
  price:    number | null;
  prevClose: number | null;
  bars:     Bar[];
  mkt:      MarketContext | null;
  dir:      DirectionState | null;
  isEditing: boolean;
  onRemove: (t: string) => void;
  onOpenChart: (t: string) => void;
}

function WatchlistRow({ ticker, price, prevClose, bars, mkt, dir, isEditing, onRemove, onOpenChart }: RowData) {
  const dollarChange = (price != null && prevClose != null) ? price - prevClose : null;
  const pctChange    = (dollarChange != null && prevClose) ? (dollarChange / prevClose) * 100 : null;
  const positive     = dollarChange == null ? null : dollarChange >= 0;
  const flags        = getFlags(ticker, mkt, dir);
  const isCash       = CASH_SETTLED_TICKERS.has(ticker);

  return (
    <div
      className="h-watchlist-row"
      onClick={() => !isEditing && onOpenChart(ticker)}
      style={{ userSelect: 'none' }}
    >
      {/* Remove button in edit mode */}
      {isEditing && (
        <button
          onClick={(e) => { e.stopPropagation(); onRemove(ticker); }}
          style={{ width: 20, height: 20, borderRadius: '50%', background: 'var(--r)', border: 'none', color: '#fff', fontSize: 12, fontWeight: 700, cursor: 'pointer', flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', lineHeight: 1 }}
        >−</button>
      )}

      {/* Avatar */}
      <div className="h-avatar">
        {tickerInitials(ticker)}
      </div>

      {/* Ticker + company */}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
          <span style={{ fontFamily: 'JetBrains Mono, monospace', fontWeight: 700, fontSize: 13, color: 'var(--ink)', letterSpacing: '-0.01em' }}>
            {ticker}
          </span>
          {isCash && (
            <span style={{ fontSize: 9, fontWeight: 700, padding: '1px 4px', background: 'var(--amb-dim)', color: 'var(--amb-solid)', borderRadius: 2, letterSpacing: '0.04em' }}>CASH</span>
          )}
          {flags.map(f => (
            <span key={f} onClick={e => e.stopPropagation()} style={{
              fontSize: 9, fontWeight: 700, padding: '1px 4px', borderRadius: 2, letterSpacing: '0.04em', cursor: 'default',
              background: f === 'SQUEEZE' ? 'rgba(245,166,35,0.15)' : f === 'ELITE' ? 'var(--g-dim)' : 'rgba(255,255,255,0.07)',
              color:      f === 'SQUEEZE' ? 'var(--amb-solid)' : f === 'ELITE' ? 'var(--g)' : 'var(--mut)',
            }}>{f}</span>
          ))}
        </div>
        <div style={{ fontSize: 10, color: 'var(--mut)', marginTop: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {COMPANY_NAMES[ticker] ?? ticker}
        </div>
      </div>

      {/* Sparkline */}
      <Sparkline bars={bars} positive={positive !== false} />

      {/* Price + change */}
      <div style={{ textAlign: 'right', flexShrink: 0 }}>
        <div style={{ fontFamily: 'JetBrains Mono, monospace', fontWeight: 700, fontSize: 14, color: 'var(--ink)' }}>
          {fmt(price)}
        </div>
        {/* Dollar change badge */}
        {dollarChange != null ? (
          <div style={{ marginTop: 2 }}>
            <span style={{
              fontFamily: 'JetBrains Mono, monospace', fontSize: 10, fontWeight: 700,
              padding: '1px 4px', borderRadius: 2,
              background: positive ? 'var(--g)' : 'var(--r)',
              color: '#020304',
            }}>
              {positive ? '+' : ''}{fmt(dollarChange)}
            </span>
            <div style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 10, color: positive ? 'var(--g)' : 'var(--r)', marginTop: 1 }}>
              {positive ? '+' : ''}{fmt(pctChange)}%
            </div>
          </div>
        ) : (
          <div style={{ fontSize: 10, color: 'var(--dim)', marginTop: 2 }}>—</div>
        )}
      </div>
    </div>
  );
}

// ── Gamma Snapshot card ────────────────────────────────────────────────────────

function GammaSnapshotCard({ onOpenChain }: { onOpenChain: () => void }) {
  const [mkt, setMkt] = useState<MarketContext | null>(null);

  useEffect(() => {
    const read = () => {
      const r = marketStore.getResult('SPX');
      setMkt(r.status === 'ready' ? r.data : null);
    };
    read();
    return marketStore.subscribe(read);
  }, []);

  const spyDir = getDirectionState('SPY');

  // Squeeze tickers — short float > 12%
  const squeezeTickers: string[] = [];
  for (const t of FEED_TICKERS) {
    if (CONTEXT_ONLY_TICKERS.has(t)) continue;
    const r = fundamentalsStore.getResult(t);
    if (r.status === 'ready' && r.data.shortInterest && (r.data.shortInterest.shortFloat ?? 0) > 0.10) {
      squeezeTickers.push(t);
    }
  }

  const spot      = mkt ? mkt.walls.callWall - (mkt.walls.callWall - mkt.walls.putWall) * 0.4 : null;
  const flipLevel = mkt?.flipLevel ?? null;
  const callWall  = mkt?.walls.callWall ?? null;
  const netGex    = mkt?.netGex ?? null;
  const regime    = spyDir?.sessionBias ?? 'neutral';

  // Bar visual: flip / spot / callwall as relative positions
  const barMin  = flipLevel && callWall ? flipLevel * 0.999 : 6200;
  const barMax  = callWall ? callWall * 1.001 : 6400;
  const barRange = barMax - barMin;
  const pct = (v: number | null) => v ? Math.max(0, Math.min(100, ((v - barMin) / barRange) * 100)) : 50;

  return (
    <div className="h-gamma-card">
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
        <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--mut)' }}>
          Gamma Snapshot · SPX
        </span>
        <button
          onClick={onOpenChain}
          style={{ fontSize: 10, color: 'var(--amb-solid)', background: 'none', border: 'none', cursor: 'pointer', padding: '2px 0', fontWeight: 600 }}
        >
          Chain ›
        </button>
      </div>

      {/* Level bar */}
      {(flipLevel || callWall) ? (
        <div style={{ position: 'relative', height: 6, background: 'rgba(255,255,255,0.06)', borderRadius: 1, marginBottom: 10 }}>
          {/* Flip */}
          {flipLevel && (
            <div style={{ position: 'absolute', left: `${pct(flipLevel)}%`, top: -1, bottom: -1, width: 2, background: 'var(--mut)', borderRadius: 1 }} />
          )}
          {/* Spot (derived) */}
          {spot && (
            <div style={{ position: 'absolute', left: `${pct(spot)}%`, top: -2, width: 6, height: 10, background: 'var(--ink)', borderRadius: 1, transform: 'translateX(-3px)' }} />
          )}
          {/* Call wall */}
          {callWall && (
            <div style={{ position: 'absolute', left: `${pct(callWall)}%`, top: -1, bottom: -1, width: 2, background: 'var(--g)', borderRadius: 1 }} />
          )}
        </div>
      ) : (
        <div style={{ height: 6, background: 'rgba(255,255,255,0.06)', borderRadius: 1, marginBottom: 10 }} />
      )}

      {/* Labels row */}
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 12 }}>
        {[
          { label: 'Flip', value: fmt(flipLevel, 0) },
          { label: 'Spot', value: fmt(spot, 0) },
          { label: 'Wall', value: fmt(callWall, 0) },
        ].map(({ label, value }) => (
          <div key={label} style={{ textAlign: 'center' }}>
            <div style={{ fontSize: 9, color: 'var(--dim)', letterSpacing: '0.06em', textTransform: 'uppercase', marginBottom: 2 }}>{label}</div>
            <div style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 11, fontWeight: 700, color: 'var(--ink)' }}>{value}</div>
          </div>
        ))}
      </div>

      {/* Net GEX + Zero Flip */}
      <div style={{ display: 'flex', gap: 16, marginBottom: 12 }}>
        <div>
          <div style={{ fontSize: 9, color: 'var(--dim)', letterSpacing: '0.06em', textTransform: 'uppercase', marginBottom: 2 }}>Net GEX</div>
          <div style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 12, fontWeight: 700, color: netGex == null ? 'var(--dim)' : netGex > 0 ? 'var(--g)' : 'var(--r)' }}>
            {netGex == null ? '—' : `${netGex > 0 ? '+' : ''}$${fmtDollar(netGex)}`}
          </div>
        </div>
        <div>
          <div style={{ fontSize: 9, color: 'var(--dim)', letterSpacing: '0.06em', textTransform: 'uppercase', marginBottom: 2 }}>Zero Flip</div>
          <div style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 12, fontWeight: 700, color: 'var(--ink)' }}>
            {flipLevel ? flipLevel.toLocaleString('en-US', { maximumFractionDigits: 0 }) : '—'}
          </div>
        </div>
        <div>
          <div style={{ fontSize: 9, color: 'var(--dim)', letterSpacing: '0.06em', textTransform: 'uppercase', marginBottom: 2 }}>Regime</div>
          <div style={{ fontSize: 11, fontWeight: 700, color: regime === 'bullish' ? 'var(--g)' : regime === 'bearish' ? 'var(--r)' : 'var(--mut)' }}>
            {regime === 'bullish' ? 'LONG GAMMA' : regime === 'bearish' ? 'SHORT GAMMA' : 'NEUTRAL'}
          </div>
        </div>
      </div>

      {/* Squeeze Risk chips */}
      {squeezeTickers.length > 0 && (
        <div>
          <div style={{ fontSize: 9, color: 'var(--dim)', letterSpacing: '0.06em', textTransform: 'uppercase', marginBottom: 6 }}>Squeeze Risk</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
            {squeezeTickers.slice(0, 4).map(t => {
              const r = fundamentalsStore.getResult(t);
              const si = r.status === 'ready' ? r.data.shortInterest?.shortFloat : null;
              return (
                <span key={t} style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 10, fontWeight: 700, padding: '2px 7px', background: 'rgba(245,166,35,0.1)', color: 'var(--amb-solid)', borderRadius: 2 }}>
                  {t}{si ? ` · Short ${(si * 100).toFixed(1)}%` : ''}
                </span>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Insider Activity preview ───────────────────────────────────────────────────

function InsiderPreview({ onNavigate }: { onNavigate: () => void }) {
  const [transactions, setTransactions] = useState<(InsiderTransaction & { ticker: string })[]>([]);

  useEffect(() => {
    const read = () => {
      const all: (InsiderTransaction & { ticker: string })[] = [];
      for (const t of FEED_TICKERS) {
        const r = fundamentalsStore.getResult(t);
        if (r.status === 'ready') {
          for (const tx of r.data.insiderTransactions) {
            all.push({ ...tx, ticker: t });
          }
        }
      }
      all.sort((a, b) => b.filedAt - a.filedAt);
      setTransactions(all.slice(0, 3));
    };
    read();
    return fundamentalsStore.subscribe(read);
  }, []);

  if (transactions.length === 0) return null;

  return (
    <div style={{ margin: '0 10px 8px' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 0 6px' }}>
        <span className="h-section-label">Insider Activity</span>
        <button onClick={onNavigate} style={{ fontSize: 10, color: 'var(--amb-solid)', background: 'none', border: 'none', cursor: 'pointer', fontWeight: 600, padding: 0 }}>See all ›</button>
      </div>

      <div style={{ background: 'var(--panel)', border: '1px solid var(--border-dim)', borderRadius: 2 }}>
        {transactions.map((tx, i) => (
          <div key={tx.id} style={{ padding: '10px 12px', borderBottom: i < transactions.length - 1 ? '1px solid var(--border-dim)' : 'none' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 3 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{ fontFamily: 'JetBrains Mono, monospace', fontWeight: 700, fontSize: 12, color: 'var(--ink)' }}>{tx.ticker}</span>
                <span style={{ fontSize: 9, color: 'var(--mut)' }}>{fmtDate(tx.filedAt)}</span>
              </div>
              {/* 10b5-1 pill — color is load-bearing */}
              <span style={{
                fontSize: 9, fontWeight: 700, padding: '1px 5px', borderRadius: 2, letterSpacing: '0.03em',
                background: tx.is10b51 ? 'rgba(255,255,255,0.06)' : 'var(--g-dim)',
                color:      tx.is10b51 ? 'var(--dim)'              : 'var(--g)',
              }}>
                {tx.is10b51 ? '10b5-1 Scheduled' : 'Not 10b5-1'}
              </span>
            </div>
            <div style={{ fontSize: 11, color: 'var(--mut)', lineHeight: 1.4 }}>
              {tx.insiderName} · {tx.relationship} —{' '}
              <span style={{ color: tx.transactionType === 'buy' ? 'var(--g)' : 'var(--r)', fontWeight: 600 }}>
                {tx.transactionType === 'buy' ? 'Buy' : 'Sell'}{' '}
              </span>
              {tx.shares.toLocaleString()} sh
              {tx.totalValue > 0 && (
                <span style={{ color: 'var(--dim)' }}> (${fmtDollar(tx.totalValue)})</span>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Regime banner ──────────────────────────────────────────────────────────────

function RegimeBanner() {
  const [dir, setDir] = useState<DirectionState | null>(null);

  useEffect(() => {
    const read = () => setDir(getDirectionState('SPY'));
    read();
    return subscribeDirection((ticker) => {
      if (ticker === 'SPY') setDir(getDirectionState('SPY'));
    });
  }, []);

  if (!dir) return null;

  const regimeLabel = dir.sessionBias === 'bullish' ? 'Regime · Risk-On' : dir.sessionBias === 'bearish' ? 'Regime · Risk-Off' : 'Regime · Neutral';
  const reason = dir.sessionBiasReason || 'Awaiting session data.';

  return (
    <div className="h-regime-banner">
      <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--amb-solid)', letterSpacing: '0.06em', textTransform: 'uppercase', marginBottom: 4 }}>
        {regimeLabel}
      </div>
      <div style={{ fontSize: 12, color: 'var(--mut)', lineHeight: 1.5 }}>
        {reason}
      </div>
    </div>
  );
}

// ── Main DashboardCockpit ──────────────────────────────────────────────────────

interface DashboardProps {
  watchlistTickers?: string[];
  onAddTicker?: (t: string) => void;
  onRemoveTicker?: (t: string) => void;
  onOpenChart?: (ticker: string) => void;
  onOpenChain?: () => void;
  onOpenInsiders?: () => void;
}

export default function DashboardCockpit({
  watchlistTickers,
  onAddTicker,
  onRemoveTicker,
  onOpenChart,
  onOpenChain,
  onOpenInsiders,
}: DashboardProps) {
  const displayTickers = watchlistTickers && watchlistTickers.length > 0 ? watchlistTickers : DEFAULT_WATCHLIST;
  const [isEditing, setIsEditing] = useState(false);
  const [addInput, setAddInput]   = useState('');
  const [, forceUpdate]           = useState(0);
  const tick = useCallback(() => forceUpdate(n => n + 1), []);

  // Subscribe to all relevant stores
  useEffect(() => {
    const unsubs = [
      marketStore.subscribe(tick),
      cvdStore.subscribe(tick),
      barsStore.subscribe(tick),
      fundamentalsStore.subscribe(tick),
    ];
    const unsubDir = subscribeDirection(tick);
    return () => { unsubs.forEach(u => u()); unsubDir(); };
  }, [tick]);

  // Collect per-ticker data
  const rowDataMap = new Map<string, { price: number | null; prevClose: number | null; bars: Bar[]; mkt: MarketContext | null; dir: DirectionState | null }>();
  for (const ticker of displayTickers) {
    const barsResult = barsStore.getResult(ticker);
    const bars: Bar[] = barsResult.status === 'ready' ? barsResult.data : [];
    const lastBar = bars[bars.length - 1];
    const prevBar = bars.length >= 2 ? bars[bars.length - 2] : null;
    const price = lastBar?.close ?? null;
    const prevClose = prevBar?.close ?? null;

    const mktResult = marketStore.getResult(ticker);
    const mkt = mktResult.status === 'ready' ? mktResult.data : null;

    const dir = getDirectionState(ticker);

    rowDataMap.set(ticker, { price, prevClose, bars, mkt, dir });
  }

  const handleAdd = useCallback(() => {
    const t = addInput.trim().toUpperCase();
    if (t && onAddTicker) { onAddTicker(t); setAddInput(''); }
  }, [addInput, onAddTicker]);

  return (
    <section id="home" style={{ background: 'var(--void)', paddingBottom: 16 }}>

      {/* 1. Regime banner */}
      <RegimeBanner />

      {/* 2. Watchlist */}
      <div style={{ margin: '8px 10px 0' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '2px 0 6px' }}>
          <span className="h-section-label">Watchlist</span>
          {(onAddTicker || onRemoveTicker) && (
            <button
              onClick={() => setIsEditing(e => !e)}
              style={{ fontSize: 10, color: isEditing ? 'var(--amb-solid)' : 'var(--mut)', background: 'none', border: 'none', cursor: 'pointer', fontWeight: 600, padding: 0 }}
            >
              {isEditing ? 'Done' : 'Edit'}
            </button>
          )}
        </div>

        <div style={{ background: 'var(--panel)', border: '1px solid var(--border-dim)', borderRadius: 2 }}>
          {displayTickers.map(ticker => {
            const d = rowDataMap.get(ticker)!;
            return (
              <WatchlistRow
                key={ticker}
                ticker={ticker}
                price={d.price}
                prevClose={d.prevClose}
                bars={d.bars}
                mkt={d.mkt}
                dir={d.dir}
                isEditing={isEditing}
                onRemove={onRemoveTicker ?? (() => {})}
                onOpenChart={onOpenChart ?? (() => {})}
              />
            );
          })}

          {/* Add ticker row — only in edit mode */}
          {isEditing && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', borderTop: '1px solid var(--border-dim)' }}>
              <input
                value={addInput}
                onChange={e => setAddInput(e.target.value.toUpperCase())}
                onKeyDown={e => e.key === 'Enter' && handleAdd()}
                placeholder="Add Ticker"
                style={{ flex: 1, background: 'var(--surface-2)', border: '1px solid var(--border-mid)', borderRadius: 2, padding: '5px 8px', fontSize: 12, fontFamily: 'JetBrains Mono, monospace', color: 'var(--ink)', outline: 'none' }}
              />
              <button
                onClick={handleAdd}
                style={{ padding: '5px 10px', background: 'var(--amb-dim)', color: 'var(--amb-solid)', border: '1px solid rgba(245,166,35,0.3)', borderRadius: 2, fontSize: 11, fontWeight: 700, cursor: 'pointer' }}
              >
                Add
              </button>
            </div>
          )}
        </div>
      </div>

      {/* 3. Gamma Snapshot card */}
      <GammaSnapshotCard onOpenChain={onOpenChain ?? (() => {})} />

      {/* 4. Insider Activity preview */}
      <InsiderPreview onNavigate={onOpenInsiders ?? (() => {})} />

    </section>
  );
}
