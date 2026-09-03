/**
 * ChainCockpit — rebuilt against helios-full-mockup.html spec.
 *
 * Structure:
 *   1. Sticky search box (real-time filter: symbol prefix or company name)
 *   2. Expiry tab row (0DTE … furthest monthly, derived from chain rows)
 *   3. Context bar: price · %chg · maxPain · P/C · regime · bias
 *   4. Sub-tabs: TABLE | GREEKS | FLOW | GEX
 *   5. TABLE sub-tab has Standard ↔ Calls|Puts toggle
 *      Calls|Puts: exactly 5 columns, table-layout:fixed, no horizontal scroll at 390px
 *      Columns: C Vol(13%) | C Bid/Ask(29%) | Strike(16%) | P Bid/Ask(29%) | P Vol(13%)
 *   6. Sticky footer card: P/C ratio · IV rank · call wall · put wall
 *
 * Token rules:
 *   - Active state: amber only (--amb)
 *   - No blue, no rounded-xl, no zinc-* or slate-* overrides
 *   - Green/red for directional data only
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as barsStore   from '../stores/barsStore';
import * as marketStore from '../stores/marketStore';
import * as cvdStore    from '../stores/cvdStore';
import {
  getDirectionState,
  subscribe as subscribeDirection,
  FEED_TICKERS,
  CONTEXT_ONLY_TICKERS,
  CASH_SETTLED_TICKERS,
} from '../state/directionState';
import type { DirectionState } from '../state/directionState';
import type { MarketContext }  from '../stores/marketStore';
import type { ChainRow }       from '../stores/types';

// ── Constants ──────────────────────────────────────────────────────────────────

const SELECTABLE = FEED_TICKERS.filter(t => !CONTEXT_ONLY_TICKERS.has(t));

const COMPANY_NAMES: Record<string, string> = {
  SPX: 'S&P 500 Index', SPY: 'SPDR S&P 500 ETF', QQQ: 'Invesco QQQ Trust',
  NDX: 'Nasdaq 100 Index', IWM: 'iShares Russell 2000', AAPL: 'Apple Inc',
  NVDA: 'NVIDIA Corp', TSLA: 'Tesla Inc', MSFT: 'Microsoft Corp',
  AMZN: 'Amazon.com Inc', META: 'Meta Platforms', GOOGL: 'Alphabet Inc',
  AMD: 'Advanced Micro Devices', NFLX: 'Netflix Inc', JPM: 'JPMorgan Chase',
  BAC: 'Bank of America', COIN: 'Coinbase Global', PLTR: 'Palantir Technologies',
  MSTR: 'MicroStrategy Inc', HOOD: 'Robinhood Markets', GLD: 'SPDR Gold Trust',
  TLT: 'iShares 20Y Treasury', HYG: 'iShares HY Corp Bond',
};

type SubTab = 'TABLE' | 'GREEKS' | 'FLOW' | 'GEX';
type TableView = 'standard' | 'splitside';

// ── Formatting helpers ────────────────────────────────────────────────────────

function _fmtP(n: number): string {
  if (n === 0) return '—';
  return n >= 1000
    ? n.toLocaleString('en-US', { maximumFractionDigits: 0 })
    : n.toFixed(2);
}
function _fmtPct(n: number): string {
  const sign = n >= 0 ? '+' : '';
  return `${sign}${n.toFixed(2)}%`;
}
function _fmtIV(iv: number): string {
  return iv === 0 ? '—' : `${(iv * 100).toFixed(1)}%`;
}
function _fmtVol(v: number): string {
  if (v === 0) return '—';
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000)     return `${(v / 1_000).toFixed(0)}K`;
  return String(v);
}
function _fmtGex(gex: number): string {
  const abs = Math.abs(gex);
  const sign = gex < 0 ? '-' : '';
  if (abs >= 1_000_000_000) return `${sign}${(abs / 1_000_000_000).toFixed(1)}B`;
  if (abs >= 1_000_000)     return `${sign}${(abs / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000)         return `${sign}${(abs / 1_000).toFixed(0)}K`;
  return gex.toFixed(0);
}
function _fmtDelta(d: number): string {
  return d === 0 ? '—' : d.toFixed(2);
}
function _fmtBA(bid: number, ask: number): string {
  if (bid === 0 && ask === 0) return '—';
  return `${bid.toFixed(2)} / ${ask.toFixed(2)}`;
}

// ── Expiry helpers ────────────────────────────────────────────────────────────

const ATM_STRIKE_WINDOW_PCT = 0.15; // show strikes within ±15% of spot

/** Derive sorted expiry list from chain rows. Returns nearest expiry first. */
function _getExpiries(rows: ChainRow[]): string[] {
  const seen = new Set<string>();
  for (const r of rows) {
    if (r.expiry) seen.add(r.expiry);
  }
  if (seen.size === 0) return ['Current'];
  return Array.from(seen).sort();
}

/** Format expiry for display: "Jul 18" or "0DTE" for today */
function _fmtExpiry(expiry: string): string {  if (expiry === 'Current') return 'Current';
  try {
    // Parse YYYY-MM-DD
    const [, m, d] = expiry.split('-').map(Number);
    const today = new Date();
    const expDate = new Date(expiry + 'T12:00:00'); // noon local avoids tz issues
    const isToday = today.toDateString() === expDate.toDateString();
    if (isToday) return '0DTE';
    const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    return `${months[m - 1]} ${d}`;
  } catch {
    return expiry;
  }
}

// ── Row classification helpers ────────────────────────────────────────────────

function _isATM(r: ChainRow, spot: number): boolean {
  return Math.abs(r.strike - spot) < spot * 0.003;
}
function _isFlip(r: ChainRow, flip: number, spot: number): boolean {
  return Math.abs(r.strike - flip) < spot * 0.003;
}

// ── Skeleton / Error ──────────────────────────────────────────────────────────

function Skeleton() {
  return (
    <div className="flex flex-col gap-1.5 p-4">
      {Array.from({ length: 14 }).map((_, i) => (
        <div key={i} className="h-7 animate-pulse bg-white/5" style={{ opacity: 1 - i * 0.055, borderRadius: 1 }} />
      ))}
    </div>
  );
}

function ErrorBanner({ reason }: { reason: string }) {
  return (
    <div className="mx-4 mt-4 px-4 py-3 text-sm text-col-r border border-col-r/30 bg-col-r/5">
      {reason}
    </div>
  );
}

// ── ATM / Flip / MaxPain label chips ─────────────────────────────────────────

function StrikeChips({ labels }: { labels: string[] }) {
  if (labels.length === 0) return null;
  return (
    <span className="flex gap-1 ml-1">
      {labels.map(l => (
        <span
          key={l}
          className="text-[9px] font-bold px-1 py-0.5 leading-none"
          style={{
            borderRadius: 2,
            background: l === 'ATM' ? 'var(--amb-solid)' : l === 'FLIP' ? 'rgba(0,217,126,0.18)' : 'rgba(255,255,255,0.08)',
            color: l === 'ATM' ? 'var(--void)' : l === 'FLIP' ? 'var(--g)' : 'var(--mut)',
          }}
        >
          {l}
        </span>
      ))}
    </span>
  );
}

// ── TABLE sub-tab — Standard view ────────────────────────────────────────────

const STD_COLS = 'grid-cols-[1fr_1fr_1fr_1fr_1fr_1fr_1fr_1fr_1fr_1fr_1fr]';
const STD_MIN  = 'min-w-[700px]';

function StandardTable({
  rows,
  ctx,
  spot,
}: {
  rows: ChainRow[];
  ctx: MarketContext;
  spot: number;
}) {
  const { flipLevel, maxPain } = ctx;
  const scrollRef = useRef<HTMLDivElement>(null);

  // Scroll ATM row into view on first load and when rows change
  useEffect(() => {
    if (!scrollRef.current) return;
    const atm = scrollRef.current.querySelector<HTMLElement>('[data-atm="true"]');
    if (atm) {
      atm.scrollIntoView({ block: 'center', behavior: 'instant' });
    }
  }, [rows.length]);

  return (
    <div className="chain-scroll overflow-x-auto" ref={scrollRef}>
      {/* Header */}
      <div
        className={`grid ${STD_COLS} ${STD_MIN} border-b px-2 py-1.5 text-[10px] font-bold uppercase tracking-widest`}
        style={{ borderColor: 'var(--line)', color: 'var(--dim)' }}
      >
        <span className="text-right">Bid</span>
        <span className="text-right">Ask</span>
        <span className="text-right">Last</span>
        <span className="text-right">IV</span>
        <span className="text-right">Vol</span>
        <span className="text-center">Strike</span>
        <span className="text-left">Vol</span>
        <span className="text-left">IV</span>
        <span className="text-left">Last</span>
        <span className="text-left">Ask</span>
        <span className="text-left">Bid</span>
      </div>
      {/* Rows */}
      <div className={STD_MIN}>
        {rows.map((row, i) => {
          const atm    = _isATM(row, spot);
          const flip   = _isFlip(row, flipLevel, spot);
          const isMP   = row.isMaxPain;
          const labels: string[] = [];
          if (atm) labels.push('ATM');
          if (flip) labels.push('FLIP');
          if (isMP) labels.push('MP');

          const rowBg = atm
            ? 'bg-amber-950/40'
            : flip || isMP
            ? 'bg-white/4'
            : i % 2 === 0 ? 'bg-white/1' : '';

          return (
            <div
              key={row.strike}
              data-atm={atm ? 'true' : undefined}
              className={`grid ${STD_COLS} items-center px-2 py-1 text-[11px] font-mono transition-colors hover:bg-white/6 ${rowBg}`}
            >
              <span className="text-right" style={{ color: 'var(--mut)' }}>{row.callBid > 0 ? row.callBid.toFixed(2) : '—'}</span>
              <span className="text-right" style={{ color: 'var(--ink)' }}>{row.callAsk > 0 ? row.callAsk.toFixed(2) : '—'}</span>
              <span className="text-right" style={{ color: 'var(--ink)' }}>{row.callLast > 0 ? _fmtP(row.callLast) : '—'}</span>
              <span className="text-right" style={{ color: 'var(--mut)' }}>{_fmtIV(row.callIV)}</span>
              <span className="text-right" style={{ color: 'var(--mut)' }}>{_fmtVol(row.callVolume)}</span>
              {/* Strike cell */}
              <div className="flex items-center justify-center gap-1">
                <span
                  className="font-bold text-[11px]"
                  style={{ color: atm ? 'var(--amb-solid)' : 'var(--ink)' }}
                >
                  {_fmtP(row.strike)}
                </span>
                <StrikeChips labels={labels} />
              </div>
              <span className="text-left" style={{ color: 'var(--mut)' }}>{_fmtVol(row.putVolume)}</span>
              <span className="text-left" style={{ color: 'var(--mut)' }}>{_fmtIV(row.putIV)}</span>
              <span className="text-left" style={{ color: 'var(--ink)' }}>{row.putLast > 0 ? _fmtP(row.putLast) : '—'}</span>
              <span className="text-left" style={{ color: 'var(--ink)' }}>{row.putAsk > 0 ? row.putAsk.toFixed(2) : '—'}</span>
              <span className="text-left" style={{ color: 'var(--mut)' }}>{row.putBid > 0 ? row.putBid.toFixed(2) : '—'}</span>
            </div>
          );
        })}
        {rows.length === 0 && (
          <div className="py-12 text-center text-sm" style={{ color: 'var(--dim)' }}>
            No chain data — relay not connected.
          </div>
        )}
      </div>
      {/* maxPain footer note */}
      {maxPain > 0 && (
        <div className="border-t px-4 py-1.5 text-[10px]" style={{ borderColor: 'var(--line)', color: 'var(--dim)' }}>
          Max Pain <span className="font-bold" style={{ color: 'var(--ink)' }}>{_fmtP(maxPain)}</span>
        </div>
      )}
    </div>
  );
}

// ── TABLE sub-tab — Calls|Puts split (5-column, table-layout:fixed) ───────────
// Columns: C Vol(13%) | C Bid/Ask(29%) | Strike(16%) | P Bid/Ask(29%) | P Vol(13%)
// No horizontal scroll at 390px — table-layout:fixed with explicit widths.

function SplitTable({
  rows,
  ctx,
  spot,
}: {
  rows: ChainRow[];
  ctx: MarketContext;
  spot: number;
}) {
  const { flipLevel, maxPain } = ctx;
  const scrollRef = useRef<HTMLDivElement>(null);

  // Scroll ATM row into view on first load and when rows change
  useEffect(() => {
    if (!scrollRef.current) return;
    const atm = scrollRef.current.querySelector<HTMLElement>('[data-atm="true"]');
    if (atm) {
      atm.scrollIntoView({ block: 'center', behavior: 'instant' });
    }
  }, [rows.length]);

  return (
    <div className="chain-scroll" ref={scrollRef}>
      <table
        className="w-full"
        style={{
          tableLayout: 'fixed',
          borderCollapse: 'collapse',
          fontSize: '11px',
          fontFamily: 'JetBrains Mono, monospace',
        }}
      >
        <colgroup>
          <col style={{ width: '13%' }} />
          <col style={{ width: '29%' }} />
          <col style={{ width: '16%' }} />
          <col style={{ width: '29%' }} />
          <col style={{ width: '13%' }} />
        </colgroup>
        <thead>
          <tr style={{ borderBottom: `1px solid var(--line)` }}>
            <th className="text-right py-1.5 px-1 text-[10px] font-bold uppercase tracking-widest" style={{ color: 'var(--dim)' }}>C Vol</th>
            <th className="text-right py-1.5 px-1 text-[10px] font-bold uppercase tracking-widest" style={{ color: 'var(--g)' }}>C Bid/Ask</th>
            <th className="text-center py-1.5 px-1 text-[10px] font-bold uppercase tracking-widest" style={{ color: 'var(--ink)' }}>Strike</th>
            <th className="text-left  py-1.5 px-1 text-[10px] font-bold uppercase tracking-widest" style={{ color: 'var(--r)' }}>P Bid/Ask</th>
            <th className="text-left  py-1.5 px-1 text-[10px] font-bold uppercase tracking-widest" style={{ color: 'var(--dim)' }}>P Vol</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => {
            const atm  = _isATM(row, spot);
            const flip = _isFlip(row, flipLevel, spot);
            const isMP = row.isMaxPain;
            const labels: string[] = [];
            if (atm) labels.push('ATM');
            if (flip) labels.push('FLIP');
            if (isMP) labels.push('MP');

            const rowBg = atm
              ? 'rgba(245,166,35,0.08)'
              : flip || isMP
              ? 'rgba(255,255,255,0.03)'
              : i % 2 === 0 ? 'rgba(255,255,255,0.01)' : 'transparent';

            return (
              <tr
                key={row.strike}
                data-atm={atm ? 'true' : undefined}
                style={{ background: rowBg }}
                className="hover:bg-white/5 transition-colors"
              >
                {/* C Vol */}
                <td className="text-right py-1 px-1 truncate" style={{ color: 'var(--mut)' }}>
                  {_fmtVol(row.callVolume)}
                </td>
                {/* C Bid/Ask */}
                <td className="text-right py-1 px-1 truncate" style={{ color: 'var(--g)' }}>
                  {_fmtBA(row.callBid, row.callAsk)}
                </td>
                {/* Strike */}
                <td className="text-center py-1 px-1">
                  <div className="flex items-center justify-center gap-1">
                    <span
                      className="font-bold truncate"
                      style={{ color: atm ? 'var(--amb-solid)' : 'var(--ink)' }}
                    >
                      {_fmtP(row.strike)}
                    </span>
                    <StrikeChips labels={labels} />
                  </div>
                </td>
                {/* P Bid/Ask */}
                <td className="text-left py-1 px-1 truncate" style={{ color: 'var(--r)' }}>
                  {_fmtBA(row.putBid, row.putAsk)}
                </td>
                {/* P Vol */}
                <td className="text-left py-1 px-1 truncate" style={{ color: 'var(--mut)' }}>
                  {_fmtVol(row.putVolume)}
                </td>
              </tr>
            );
          })}
          {rows.length === 0 && (
            <tr>
              <td colSpan={5} className="py-12 text-center text-sm" style={{ color: 'var(--dim)' }}>
                No chain data — relay not connected.
              </td>
            </tr>
          )}
        </tbody>
      </table>
      {maxPain > 0 && (
        <div className="border-t px-4 py-1.5 text-[10px]" style={{ borderColor: 'var(--line)', color: 'var(--dim)' }}>
          Max Pain <span className="font-bold" style={{ color: 'var(--ink)' }}>{_fmtP(maxPain)}</span>
        </div>
      )}
    </div>
  );
}

// ── TABLE tab wrapper — Standard / Calls|Puts toggle ─────────────────────────

function TableTab({
  rows,
  ctx,
  spot,
}: {
  rows: ChainRow[];
  ctx: MarketContext;
  spot: number;
}) {
  const [view, setView] = useState<TableView>('splitside');

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Toggle */}
      <div className="flex flex-shrink-0 border-b" style={{ borderColor: 'var(--line)' }}>
        {(['standard', 'splitside'] as TableView[]).map(v => (
          <button
            key={v}
            onClick={() => setView(v)}
            className="flex-1 py-1.5 text-[10px] font-bold uppercase tracking-widest transition-colors"
            style={{
              color: view === v ? 'var(--amb-solid)' : 'var(--dim)',
              borderBottom: `2px solid ${view === v ? 'var(--amb-solid)' : 'transparent'}`,
              background: 'transparent',
            }}
          >
            {v === 'standard' ? 'Standard' : 'Calls | Puts'}
          </button>
        ))}
      </div>
      {/* Content */}
      <div className="flex-1 overflow-hidden">
        {view === 'standard'
          ? <StandardTable rows={rows} ctx={ctx} spot={spot} />
          : <SplitTable    rows={rows} ctx={ctx} spot={spot} />
        }
      </div>
    </div>
  );
}

// ── GREEKS tab ────────────────────────────────────────────────────────────────

const GRK_COLS = 'grid-cols-[1fr_1fr_1fr_1fr_1fr_1fr_1fr]';
const GRK_MIN  = 'min-w-[540px]';

function GreeksTab({ rows, spot }: { rows: ChainRow[]; spot: number }) {
  return (
    <div className="greeks-scroll overflow-x-auto">
      <div
        className={`grid ${GRK_COLS} ${GRK_MIN} border-b px-2 py-1.5 text-[10px] font-bold uppercase tracking-widest`}
        style={{ borderColor: 'var(--line)', color: 'var(--dim)' }}
      >
        <span className="text-center">Strike</span>
        <span className="text-right">Δ Call</span>
        <span className="text-right">Δ Put</span>
        <span className="text-right">Γ</span>
        <span className="text-right">Θ Call</span>
        <span className="text-right">Θ Put</span>
        <span className="text-right">Vega</span>
      </div>
      <div className={GRK_MIN}>
        {rows.map((row, i) => {
          const atm = _isATM(row, spot);
          return (
            <div
              key={row.strike}
              className={`grid ${GRK_COLS} items-center px-2 py-1 text-[11px] font-mono transition-colors hover:bg-white/5 ${i % 2 === 0 ? 'bg-white/1' : ''} ${atm ? 'bg-amber-950/40' : ''}`}
            >
              <span
                className="text-center font-bold"
                style={{ color: atm ? 'var(--amb-solid)' : 'var(--ink)' }}
              >
                {_fmtP(row.strike)}
              </span>
              <span className="text-right" style={{ color: row.callDelta >= 0.5 ? 'var(--g)' : 'var(--mut)' }}>{_fmtDelta(row.callDelta)}</span>
              <span className="text-right" style={{ color: Math.abs(row.putDelta) >= 0.5 ? 'var(--r)' : 'var(--mut)' }}>{_fmtDelta(row.putDelta)}</span>
              <span className="text-right" style={{ color: 'var(--ink)' }}>{row.callGamma > 0 ? row.callGamma.toFixed(4) : '—'}</span>
              <span className="text-right" style={{ color: 'var(--r)' }}>{row.callTheta !== 0 ? row.callTheta.toFixed(3) : '—'}</span>
              <span className="text-right" style={{ color: 'var(--r)' }}>{row.putTheta !== 0 ? row.putTheta.toFixed(3) : '—'}</span>
              <span className="text-right" style={{ color: 'var(--mut)' }}>{row.callVega > 0 ? row.callVega.toFixed(3) : '—'}</span>
            </div>
          );
        })}
        {rows.length === 0 && (
          <div className="py-12 text-center text-sm" style={{ color: 'var(--dim)' }}>No Greeks data.</div>
        )}
      </div>
    </div>
  );
}

// ── FLOW tab ──────────────────────────────────────────────────────────────────

type FlowScope = 'overall' | 'ticker';

function FlowTab({ ticker, rows }: { ticker: string; rows: ChainRow[] }) {
  const [scope, setScope] = useState<FlowScope>('overall');
  const [, forceUpdate]   = useState(0);

  useEffect(() => {
    const unsub = cvdStore.subscribe(() => forceUpdate(n => n + 1));
    return () => unsub();
  }, []);

  // Overall: CVD data for the ticker
  const cvdRes  = cvdStore.getResult(ticker);
  const cvd     = cvdRes.status === 'ready' ? cvdRes.data : null;

  // This Ticker: sum call/put volume from chain rows
  const callVol = rows.reduce((s, r) => s + r.callVolume, 0);
  const putVol  = rows.reduce((s, r) => s + r.putVolume, 0);
  const totalVol = callVol + putVol;
  const callPct = totalVol > 0 ? (callVol / totalVol) * 100 : 50;
  const putPct  = totalVol > 0 ? (putVol  / totalVol) * 100 : 50;

  return (
    <div className="flow-scroll px-4 py-3 space-y-4">
      {/* Scope toggle */}
      <div className="flex gap-2">
        {(['overall', 'ticker'] as FlowScope[]).map(s => (
          <button
            key={s}
            onClick={() => setScope(s)}
            className="px-3 py-1 text-[10px] font-bold uppercase tracking-widest transition-colors border"
            style={{
              borderRadius: 3,
              background: scope === s ? 'var(--amb-dim)' : 'transparent',
              borderColor: scope === s ? 'var(--amb-solid)' : 'var(--line)',
              color: scope === s ? 'var(--amb-solid)' : 'var(--mut)',
            }}
          >
            {s === 'overall' ? 'Overall' : `This Ticker (${ticker})`}
          </button>
        ))}
      </div>

      {scope === 'overall' ? (
        cvd ? (
          <div className="space-y-3">
            {/* Call/Put CVD bar */}
            <div>
              <div className="flex justify-between text-[10px] mb-1" style={{ color: 'var(--mut)' }}>
                <span className="text-[var(--g)] font-bold">CALLS {Math.round(cvd.callPct)}%</span>
                <span className="text-[var(--r)] font-bold">PUTS {Math.round(cvd.putPct)}%</span>
              </div>
              <div className="h-3 overflow-hidden" style={{ background: 'var(--r-dim)', borderRadius: 2 }}>
                <div
                  className="h-full transition-all"
                  style={{ width: `${cvd.callPct}%`, background: 'var(--g)' }}
                />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="p-2 space-y-0.5" style={{ background: 'var(--panel2)', borderRadius: 2 }}>
                <div className="text-[10px]" style={{ color: 'var(--dim)' }}>NET DELTA</div>
                <div className="text-sm font-bold font-mono" style={{ color: cvd.netDelta >= 0 ? 'var(--g)' : 'var(--r)' }}>
                  {cvd.netDelta >= 0 ? '+' : ''}{cvd.netDelta.toFixed(2)}
                </div>
              </div>
              <div className="p-2 space-y-0.5" style={{ background: 'var(--panel2)', borderRadius: 2 }}>
                <div className="text-[10px]" style={{ color: 'var(--dim)' }}>CLASSIFICATION</div>
                <div
                  className="text-sm font-bold uppercase"
                  style={{ color: cvd.classification === 'bullish' ? 'var(--g)' : cvd.classification === 'bearish' ? 'var(--r)' : 'var(--mut)' }}
                >
                  {cvd.classification}
                </div>
              </div>
              <div className="p-2 space-y-0.5" style={{ background: 'var(--panel2)', borderRadius: 2 }}>
                <div className="text-[10px]" style={{ color: 'var(--dim)' }}>TICK COUNT</div>
                <div className="text-sm font-bold font-mono" style={{ color: 'var(--ink)' }}>
                  {cvd.tickCount.toLocaleString()}
                </div>
              </div>
            </div>
          </div>
        ) : (
          <div className="py-8 text-center text-sm" style={{ color: 'var(--dim)' }}>CVD data unavailable.</div>
        )
      ) : (
        /* This Ticker: chain-derived vol split */
        <div className="space-y-3">
          <div>
            <div className="flex justify-between text-[10px] mb-1" style={{ color: 'var(--mut)' }}>
              <span className="text-[var(--g)] font-bold">CALLS {Math.round(callPct)}%</span>
              <span className="text-[var(--r)] font-bold">PUTS {Math.round(putPct)}%</span>
            </div>
            <div className="h-3 overflow-hidden" style={{ background: 'var(--r-dim)', borderRadius: 2 }}>
              <div className="h-full transition-all" style={{ width: `${callPct}%`, background: 'var(--g)' }} />
            </div>
          </div>
          <div className="grid grid-cols-3 gap-2">
            {[
              { label: 'CALL VOL', val: _fmtVol(callVol), col: 'var(--g)' },
              { label: 'PUT VOL',  val: _fmtVol(putVol),  col: 'var(--r)' },
              { label: 'TOTAL',    val: _fmtVol(totalVol), col: 'var(--ink)' },
            ].map(({ label, val, col }) => (
              <div key={label} className="p-2 space-y-0.5" style={{ background: 'var(--panel2)', borderRadius: 2 }}>
                <div className="text-[10px]" style={{ color: 'var(--dim)' }}>{label}</div>
                <div className="text-sm font-bold font-mono" style={{ color: col }}>{val}</div>
              </div>
            ))}
          </div>
          {rows.length === 0 && (
            <div className="py-4 text-center text-sm" style={{ color: 'var(--dim)' }}>No chain rows loaded.</div>
          )}
        </div>
      )}
    </div>
  );
}

// ── GEX Map tab ───────────────────────────────────────────────────────────────

function GexTab({ rows, spot }: { rows: ChainRow[]; spot: number }) {
  const maxAbs = useMemo(() => {
    return rows.reduce((m, r) => Math.max(m, Math.abs(r.netGex)), 1);
  }, [rows]);

  return (
    <div className="gex-scroll px-2 py-2 space-y-0.5">
      {rows.length === 0 && (
        <div className="py-12 text-center text-sm" style={{ color: 'var(--dim)' }}>No GEX data.</div>
      )}
      {rows.map((row) => {
        const gex  = row.netGex;
        const pct  = Math.abs(gex) / maxAbs;
        const atm  = _isATM(row, spot);
        const pos  = gex >= 0;
        return (
          <div key={row.strike} className="flex items-center gap-2 py-0.5">
            {/* Strike label */}
            <span
              className="w-14 shrink-0 text-right text-[11px] font-mono font-bold"
              style={{ color: atm ? 'var(--amb-solid)' : 'var(--mut)' }}
            >
              {_fmtP(row.strike)}
            </span>
            {/* Bar */}
            <div className="flex-1 h-5 relative overflow-hidden" style={{ background: 'var(--line)', borderRadius: 1 }}>
              <div
                className="h-full absolute top-0 left-0 transition-all"
                style={{
                  width: `${pct * 100}%`,
                  background: pos ? 'var(--g-dim)' : 'var(--r-dim)',
                  borderRight: `2px solid ${pos ? 'var(--g)' : 'var(--r)'}`,
                }}
              />
            </div>
            {/* GEX value */}
            <span
              className="w-16 shrink-0 text-right text-[11px] font-mono"
              style={{ color: pos ? 'var(--g)' : 'var(--r)' }}
            >
              {_fmtGex(gex)}
            </span>
          </div>
        );
      })}
    </div>
  );
}

// ── Footer card ───────────────────────────────────────────────────────────────

function FooterCard({ ctx }: { ctx: MarketContext | null }) {
  if (!ctx) return null;
  const { pcRatio, walls, netGex } = ctx;
  const ivRank = (ctx as MarketContext & { ivRank?: number }).ivRank ?? null;

  return (
    <div
      className="flex-shrink-0 flex items-center justify-around px-4 py-2 border-t"
      style={{
        background: 'var(--panel)',
        borderColor: 'var(--line)',
        minHeight: 44,
      }}
    >
      {[
        { label: 'P/C', val: pcRatio > 0 ? pcRatio.toFixed(2) : '—', col: pcRatio > 1 ? 'var(--r)' : pcRatio > 0 ? 'var(--g)' : 'var(--dim)' },
        { label: 'IV RANK', val: ivRank != null ? `${ivRank.toFixed(0)}%` : '—', col: 'var(--ink)' },
        { label: 'CALL WALL', val: walls?.callWall > 0 ? _fmtP(walls.callWall) : '—', col: 'var(--g)' },
        { label: 'PUT WALL', val: walls?.putWall > 0 ? _fmtP(walls.putWall) : '—', col: 'var(--r)' },
        { label: 'NET GEX', val: netGex !== 0 ? _fmtGex(netGex) : '—', col: netGex >= 0 ? 'var(--g)' : 'var(--r)' },
      ].map(({ label, val, col }) => (
        <div key={label} className="flex flex-col items-center">
          <span className="text-[9px] font-bold uppercase tracking-widest" style={{ color: 'var(--dim)' }}>{label}</span>
          <span className="text-[13px] font-bold font-mono" style={{ color: col }}>{val}</span>
        </div>
      ))}
    </div>
  );
}

// ── Main ChainCockpit ─────────────────────────────────────────────────────────

export default function ChainCockpit({ onOpenChart }: { onOpenChart?: (ticker: string) => void }) {
  const [query,      setQuery]      = useState('');
  const [ticker,     setTicker]     = useState<string>(SELECTABLE[0] ?? 'SPY');
  const [expiry,     setExpiry]     = useState('Current');
  const [activeTab,  setActiveTab]  = useState<SubTab>('TABLE');
  const [, forceUpdate]             = useState(0);
  const searchRef = useRef<HTMLInputElement>(null);

  // ── Store subscriptions ───────────────────────────────────────────────────

  useEffect(() => {
    const unsubMkt  = marketStore.subscribe(() => forceUpdate(n => n + 1));
    const unsubBars = barsStore.subscribe(() => forceUpdate(n => n + 1));
    const unsubDir  = subscribeDirection(() => forceUpdate(n => n + 1));
    return () => { unsubMkt(); unsubBars(); unsubDir(); };
  }, []);

  // ── Derived data ──────────────────────────────────────────────────────────

  const mktRes  = marketStore.getResult(ticker);
  const barsRes = barsStore.getResult(ticker);
  const dir     = getDirectionState(ticker) as DirectionState | null;

  const ctx     = mktRes.status  === 'ready' ? mktRes.data  : null;
  const bars    = barsRes.status === 'ready' ? barsRes.data : null;

  const spot    = bars && bars.length > 0 ? bars[bars.length - 1].close : 0;
  const priorClose = bars && bars.length > 1 ? bars[bars.length - 2].close : null;
  const changePct  = spot > 0 && priorClose && priorClose > 0
    ? ((spot - priorClose) / priorClose) * 100 : null;

  // All chain rows for selected ticker
  const allRows: ChainRow[] = ctx?.chain ?? [];

  // Derive expiry list
  const expiries = useMemo(() => _getExpiries(allRows), [allRows]);

  // Resolve effective expiry synchronously in render — no useEffect flash state.
  // If expiry state is unset or stale (not in current list), fall back to first.
  // Keep expiry state in sync for tab highlighting.
  const effectiveExpiry = expiries.includes(expiry) ? expiry : (expiries[0] ?? 'Current');
  useEffect(() => {
    if (effectiveExpiry !== expiry) setExpiry(effectiveExpiry);
  }, [effectiveExpiry, expiry]);

  // Filter rows by effective expiry — always correct on first paint
  const expiryRows = useMemo(() => {
    if (effectiveExpiry === 'Current' || !effectiveExpiry) return allRows;
    return allRows.filter(r => r.expiry === effectiveExpiry);
  }, [allRows, effectiveExpiry]);

  // ATM filter: keep only strikes within ±15% of spot
  const filteredRows = useMemo(() => {
    if (spot <= 0 || expiryRows.length === 0) return expiryRows;
    const lo = spot * (1 - ATM_STRIKE_WINDOW_PCT);
    const hi = spot * (1 + ATM_STRIKE_WINDOW_PCT);
    const inWindow = expiryRows.filter(r => r.strike >= lo && r.strike <= hi);
    return inWindow.length >= 5 ? inWindow : expiryRows;
  }, [expiryRows, spot]);

  // ── Ticker search filter ──────────────────────────────────────────────────

  const filteredTickers = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return SELECTABLE;
    return SELECTABLE.filter(t => {
      const name = (COMPANY_NAMES[t] ?? '').toLowerCase();
      return t.toLowerCase().startsWith(q) || name.includes(q);
    });
  }, [query]);

  const handleTickerSelect = useCallback((t: string) => {
    setTicker(t);
    setQuery('');
    setExpiry('Current');
  }, []);

  // ── Render tab content ────────────────────────────────────────────────────

  const renderTabContent = useCallback(() => {
    if (mktRes.status === 'loading') return <Skeleton />;
    if (mktRes.status === 'error') return <ErrorBanner reason={mktRes.reason} />;

    switch (activeTab) {
      case 'TABLE':
        return <TableTab rows={filteredRows} ctx={ctx!} spot={spot} />;
      case 'GREEKS':
        return <GreeksTab rows={filteredRows} spot={spot} />;
      case 'FLOW':
        return <FlowTab ticker={ticker} rows={filteredRows} />;
      case 'GEX':
        return <GexTab rows={filteredRows} spot={spot} />;
    }
  }, [mktRes, activeTab, filteredRows, ctx, spot, ticker]);

  const isCash = CASH_SETTLED_TICKERS.has(ticker);

  return (
    <section
      id="chain"
      className="flex flex-col"
      style={{ height: '100%', background: 'var(--void)', color: 'var(--ink)', fontFamily: 'JetBrains Mono, monospace' }}
    >
      {/* ── Ticker search box ── */}
      <div
        className="flex-shrink-0 px-3 py-2 border-b"
        style={{ background: 'var(--panel)', borderColor: 'var(--line)' }}
      >
        <div
          className="flex items-center gap-2 px-2.5 py-1.5"
          style={{ background: 'var(--panel2)', border: '1px solid var(--line)', borderRadius: 3 }}
        >
          <svg width="13" height="13" viewBox="0 0 20 20" fill="none" style={{ flexShrink: 0 }}>
            <circle cx="9" cy="9" r="6" stroke="var(--dim)" strokeWidth="2"/>
            <path d="M14 14l3 3" stroke="var(--dim)" strokeWidth="2" strokeLinecap="round"/>
          </svg>
          <input
            ref={searchRef}
            type="text"
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Search ticker or company…"
            className="flex-1 bg-transparent text-[12px] outline-none placeholder-opacity-40"
            style={{ color: 'var(--ink)', fontFamily: 'inherit' }}
          />
          {query && (
            <button
              onClick={() => setQuery('')}
              className="text-[11px]"
              style={{ color: 'var(--dim)' }}
            >
              ✕
            </button>
          )}
          {/* Active ticker pill — tap to open chart for this ticker */}
          {!query && (
            <span
              className="text-[11px] font-bold px-2 py-0.5 cursor-pointer"
              style={{ background: 'var(--amb-solid)', color: '#000', borderRadius: 2 }}
              onClick={() => onOpenChart?.(ticker)}
              title={`Open chart for ${ticker}`}
            >
              {ticker}
              {isCash && <span className="ml-1 font-normal opacity-70">CASH</span>}
            </span>
          )}
        </div>

        {/* Dropdown results — only show when searching */}
        {query.trim() && (
          <div
            className="mt-1 overflow-y-auto"
            style={{
              maxHeight: 200,
              background: 'var(--panel2)',
              border: '1px solid var(--line)',
              borderRadius: 3,
            }}
          >
            {filteredTickers.length === 0 ? (
              <div className="px-3 py-2 text-[11px]" style={{ color: 'var(--dim)' }}>No match</div>
            ) : (
              filteredTickers.map(t => (
                <button
                  key={t}
                  onClick={() => handleTickerSelect(t)}
                  className="w-full flex items-center gap-3 px-3 py-1.5 text-left transition-colors hover:bg-white/5"
                >
                  <span className="text-[12px] font-bold" style={{ color: 'var(--ink)', minWidth: 36 }}>{t}</span>
                  <span className="text-[11px] truncate" style={{ color: 'var(--mut)' }}>{COMPANY_NAMES[t] ?? ''}</span>
                </button>
              ))
            )}
          </div>
        )}
      </div>

      {/* ── Expiry tabs ── */}
      <div
        className="flex-shrink-0 flex items-center gap-0 overflow-x-auto scrollbar-none border-b"
        style={{ background: 'var(--panel)', borderColor: 'var(--line)' }}
      >
        {expiries.map(exp => (
          <button
            key={exp}
            onClick={() => setExpiry(exp)}
            className="flex-shrink-0 px-4 py-2 text-[11px] font-bold uppercase tracking-widest transition-colors"
            style={{
              color:        effectiveExpiry === exp ? 'var(--amb-solid)' : 'var(--dim)',
              borderBottom: `2px solid ${effectiveExpiry === exp ? 'var(--amb-solid)' : 'transparent'}`,
              background:   'transparent',
            }}
          >
            {_fmtExpiry(exp)}
          </button>
        ))}
      </div>

      {/* ── Context bar ── */}
      <div
        className="flex-shrink-0 flex flex-wrap items-center gap-x-4 gap-y-1.5 px-4 py-2 border-b"
        style={{ background: 'var(--panel2)', borderColor: 'var(--line)' }}
      >
        <div className="flex items-center gap-2">
          <span className="text-sm font-bold" style={{ color: 'var(--ink)' }}>{ticker}</span>
          {isCash && (
            <span
              className="text-[9px] font-bold px-1.5 py-0.5 uppercase tracking-widest"
              style={{ background: 'rgba(167,139,250,0.15)', color: '#c4b5fd', borderRadius: 2 }}
            >
              Cash Settled
            </span>
          )}
        </div>

        <div className="flex items-center gap-2">
          <span className="font-mono text-sm font-bold" style={{ color: 'var(--ink)' }}>
            {spot > 0 ? _fmtP(spot) : '—'}
          </span>
          {changePct != null && (
            <span
              className="text-xs font-semibold font-mono"
              style={{ color: changePct >= 0 ? 'var(--g)' : 'var(--r)' }}
            >
              {_fmtPct(changePct)}
            </span>
          )}
        </div>

        {ctx && (
          <>
            <div className="flex items-center gap-1 text-xs" style={{ color: 'var(--mut)' }}>
              <span className="text-[10px] uppercase font-bold" style={{ color: 'var(--dim)' }}>MAX PAIN</span>
              <span className="font-mono" style={{ color: 'var(--ink)' }}>{_fmtP(ctx.maxPain)}</span>
            </div>
            <div className="flex items-center gap-1 text-xs" style={{ color: 'var(--mut)' }}>
              <span className="text-[10px] uppercase font-bold" style={{ color: 'var(--dim)' }}>P/C</span>
              <span className="font-mono" style={{ color: ctx.pcRatio > 1 ? 'var(--r)' : 'var(--g)' }}>
                {ctx.pcRatio.toFixed(2)}
              </span>
            </div>
            <span
              className="text-[10px] font-bold px-2 py-0.5"
              style={{
                borderRadius: 2,
                background: ctx.gexRegime === 'positive' ? 'var(--g-dim)' : ctx.gexRegime === 'negative' ? 'var(--r-dim)' : 'var(--line)',
                color: ctx.gexRegime === 'positive' ? 'var(--g)' : ctx.gexRegime === 'negative' ? 'var(--r)' : 'var(--mut)',
              }}
            >
              {ctx.gexRegime === 'positive' ? 'POS GEX' : ctx.gexRegime === 'negative' ? 'NEG GEX' : 'GEX NEUTRAL'}
            </span>
          </>
        )}

        {dir && (
          <div className="ml-auto flex items-center gap-1.5">
            <span
              className="text-[10px] font-bold px-2 py-0.5"
              style={{
                borderRadius: 2,
                background: dir.sessionBias === 'bullish' ? 'var(--g-dim)' : dir.sessionBias === 'bearish' ? 'var(--r-dim)' : 'var(--line)',
                color: dir.sessionBias === 'bullish' ? 'var(--g)' : dir.sessionBias === 'bearish' ? 'var(--r)' : 'var(--mut)',
              }}
            >
              {dir.sessionBias === 'bullish' ? 'SESSION BULL' : dir.sessionBias === 'bearish' ? 'SESSION BEAR' : 'NEUTRAL'}
            </span>
            <span
              className="text-[10px] font-bold px-2 py-0.5"
              style={{
                borderRadius: 2,
                background: dir.playDirection === 'calls' ? 'var(--g-dim)' : dir.playDirection === 'puts' ? 'var(--r-dim)' : 'var(--line)',
                color: dir.playDirection === 'calls' ? 'var(--g)' : dir.playDirection === 'puts' ? 'var(--r)' : 'var(--mut)',
              }}
            >
              {dir.playDirection === 'calls' ? 'PLAY CALLS' : dir.playDirection === 'puts' ? 'PLAY PUTS' : dir.playDirection === 'consolidating' ? 'CONSOLIDATING' : 'NO PLAY'}
            </span>
          </div>
        )}
      </div>

      {/* ── Sub-tabs ── */}
      <div
        className="flex-shrink-0 flex items-center border-b"
        style={{ background: 'var(--panel)', borderColor: 'var(--line)' }}
      >
        {(['TABLE', 'GREEKS', 'FLOW', 'GEX'] as SubTab[]).map(tab => (
          <button
            key={tab}
            type="button"
            onClick={() => setActiveTab(tab)}
            className="flex-1 py-2.5 text-[11px] font-bold uppercase tracking-widest transition-colors"
            style={{
              color:        activeTab === tab ? 'var(--amb-solid)' : 'var(--dim)',
              borderBottom: `2px solid ${activeTab === tab ? 'var(--amb-solid)' : 'transparent'}`,
              background:   'transparent',
            }}
          >
            {tab}
          </button>
        ))}
      </div>

      {/* ── Tab content ── */}
      <div className="flex-1 overflow-hidden">
        {renderTabContent()}
      </div>

      {/* ── Sticky footer P/C card ── */}
      <FooterCard ctx={ctx} />
    </section>
  );
}
