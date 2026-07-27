/**
 * Layer 4 — ChainCockpit
 *
 * Full options chain viewer with four sub-tabs: CHAIN / FLOW / GREEKS / GEX.
 * Ticker selector and expiry selector at top. Context bar always visible.
 *
 * Data reads (zero outbound calls):
 *   marketStore    — chain rows, GEX regime, walls, flip, maxPain, pcRatio, netGex
 *   barsStore      — live price, prior close for % change
 *   directionState — sessionBias, playDirection
 *
 * Layout:
 *   ┌──────────────────────────────────────────────────────────┐
 *   │  TICKER SELECTOR  |  EXPIRY SELECTOR                     │
 *   │  CONTEXT BAR: price • %chg • maxPain • regime • bias     │
 *   │  TABS: CHAIN | FLOW | GREEKS | GEX                       │
 *   ├──────────────────────────────────────────────────────────┤
 *   │  TAB CONTENT                                             │
 *   └──────────────────────────────────────────────────────────┘
 *
 * Rules enforced:
 *   - CONTEXT_ONLY_TICKERS excluded from ticker selector
 *   - SPX / NDX show "CASH SETTLED" label in context bar
 *   - sessionBias + playDirection always visible
 *   - All three Result<T> states handled (loading / error / ready)
 *   - No cockpit imports from another cockpit
 *   - Zero outbound calls
 */

import { useCallback, useEffect, useState } from 'react';

import * as barsStore   from '../stores/barsStore';
import * as marketStore from '../stores/marketStore';
import {
  getDirectionState,
  subscribe as subscribeDirection,
  FEED_TICKERS,
  CONTEXT_ONLY_TICKERS,
  CASH_SETTLED_TICKERS,
} from '../state/directionState';
import type { DirectionState }  from '../state/directionState';
import type { MarketContext }    from '../stores/marketStore';
import type { ChainRow }         from '../stores/types';

// ── Local types ────────────────────────────────────────────────────────────────

type SubTab = 'CHAIN' | 'FLOW' | 'GREEKS' | 'GEX';

// Expiry entries derived from chain rows (placeholder — real expiry comes from
// the ingestion layer tagging each row; for now we show a single "Current" slot)
interface ExpiryOption {
  label: string;
  value: string;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const SELECTABLE_TICKERS = FEED_TICKERS.filter(
  (t) => !CONTEXT_ONLY_TICKERS.has(t),
);

const DEFAULT_EXPIRY: ExpiryOption = { label: 'Current', value: 'current' };

// ── Formatting helpers ────────────────────────────────────────────────────────

function _fmtPrice(n: number): string {
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
  if (iv === 0) return '—';
  return `${(iv * 100).toFixed(1)}%`;
}

function _fmtDelta(d: number): string {
  if (d === 0) return '—';
  return d.toFixed(2);
}

function _fmtGex(gex: number): string {
  const abs = Math.abs(gex);
  if (abs >= 1_000_000_000) return `${(gex / 1_000_000_000).toFixed(1)}B`;
  if (abs >= 1_000_000)     return `${(gex / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000)         return `${(gex / 1_000).toFixed(0)}K`;
  return gex.toFixed(0);
}

// ── Sub-components: common ────────────────────────────────────────────────────

function LoadingSkeleton() {
  return (
    <div className="flex flex-col gap-2 p-4">
      {Array.from({ length: 12 }).map((_, i) => (
        <div
          key={i}
          className="h-8 rounded bg-white/5 animate-pulse"
          style={{ opacity: 1 - i * 0.06 }}
        />
      ))}
    </div>
  );
}

function ErrorBanner({ reason }: { reason: string }) {
  return (
    <div className="mx-4 mt-4 rounded border border-rose-700/50 bg-rose-950/40 px-4 py-3 text-sm text-rose-300">
      {reason}
    </div>
  );
}

// ── CashSettledTag ─────────────────────────────────────────────────────────────

function CashSettledTag() {
  return (
    <span className="rounded-sm bg-violet-900/60 px-1.5 py-0.5 text-[10px] font-semibold tracking-widest text-violet-300 uppercase">
      Cash Settled
    </span>
  );
}

// ── GexRegimeBadge ────────────────────────────────────────────────────────────

function GexRegimeBadge({ regime }: { regime: string }) {
  const cfg =
    regime === 'positive'
      ? { label: 'POS GEX', cls: 'bg-emerald-900/60 text-emerald-300 border-emerald-700/40' }
      : regime === 'negative'
      ? { label: 'NEG GEX', cls: 'bg-rose-900/60 text-rose-300 border-rose-700/40' }
      : { label: 'NEUTRAL', cls: 'bg-zinc-800 text-zinc-400 border-zinc-600/40' };

  return (
    <span className={`rounded border px-2 py-0.5 text-[11px] font-bold tracking-wider ${cfg.cls}`}>
      {cfg.label}
    </span>
  );
}

// ── SessionBiasBadge ──────────────────────────────────────────────────────────

function SessionBiasBadge({ bias }: { bias: string }) {
  const cfg =
    bias === 'bullish'
      ? { label: 'SESSION BULL', cls: 'bg-emerald-950/60 text-emerald-300 border-emerald-700/40' }
      : bias === 'bearish'
      ? { label: 'SESSION BEAR', cls: 'bg-rose-950/60 text-rose-300 border-rose-700/40' }
      : { label: 'SESSION NEUTRAL', cls: 'bg-zinc-800 text-zinc-400 border-zinc-600/40' };

  return (
    <span className={`rounded border px-2 py-0.5 text-[11px] font-bold tracking-wider ${cfg.cls}`}>
      {cfg.label}
    </span>
  );
}

function PlayDirectionBadge({ play }: { play: string }) {
  const cfg =
    play === 'calls'
      ? { label: 'PLAY CALLS', cls: 'bg-emerald-950/60 text-emerald-300 border-emerald-700/40' }
      : play === 'puts'
      ? { label: 'PLAY PUTS', cls: 'bg-rose-950/60 text-rose-300 border-rose-700/40' }
      : play === 'consolidating'
      ? { label: 'CONSOLIDATING', cls: 'bg-amber-950/60 text-amber-300 border-amber-700/40' }
      : { label: 'NO PLAY', cls: 'bg-zinc-800 text-zinc-400 border-zinc-600/40' };

  return (
    <span className={`rounded border px-2 py-0.5 text-[11px] font-bold tracking-wider ${cfg.cls}`}>
      {cfg.label}
    </span>
  );
}

// ── Context Bar ───────────────────────────────────────────────────────────────

interface ContextBarProps {
  ticker:    string;
  price:     number | null;
  changePct: number | null;
  ctx:       MarketContext | null;
  dir:       DirectionState | null;
}

function ContextBar({ ticker, price, changePct, ctx, dir }: ContextBarProps) {
  const isCash = CASH_SETTLED_TICKERS.has(ticker);

  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-white/10 bg-zinc-900/80 px-4 py-2.5 backdrop-blur">
      {/* Ticker + cash settled */}
      <div className="flex items-center gap-2">
        <span className="text-base font-bold text-white">{ticker}</span>
        {isCash && <CashSettledTag />}
      </div>

      {/* Live price + change */}
      <div className="flex items-center gap-2">
        <span className="font-mono text-sm font-semibold text-white">
          {price != null ? _fmtPrice(price) : '—'}
        </span>
        {changePct != null && (
          <span
            className={`text-xs font-semibold ${
              changePct >= 0 ? 'text-emerald-400' : 'text-rose-400'
            }`}
          >
            {_fmtPct(changePct)}
          </span>
        )}
      </div>

      {ctx && (
        <>
          {/* Max pain */}
          <div className="flex items-center gap-1.5 text-xs text-zinc-400">
            <span className="text-violet-400 font-semibold">MAX PAIN</span>
            <span className="font-mono text-zinc-200">{_fmtPrice(ctx.maxPain)}</span>
          </div>

          {/* GEX regime */}
          <GexRegimeBadge regime={ctx.gexRegime} />

          {/* P/C ratio */}
          <div className="text-xs text-zinc-400">
            P/C{' '}
            <span className="font-mono text-zinc-200">{ctx.pcRatio.toFixed(2)}</span>
          </div>
        </>
      )}

      {dir && (
        <div className="ml-auto flex items-center gap-2">
          <SessionBiasBadge bias={dir.sessionBias} />
          <PlayDirectionBadge play={dir.playDirection} />
        </div>
      )}
    </div>
  );
}

// ── Row label helpers for CHAIN tab ──────────────────────────────────────────

function _strikeLabels(
  row:       ChainRow,
  spotPrice: number,
  flipLevel: number,
  maxPain:   number,
): string[] {
  const labels: string[] = [];
  const atm = Math.abs(row.strike - spotPrice) < spotPrice * 0.003;
  if (atm)                     labels.push('ATM');
  if (row.strike === maxPain)  labels.push('MP');
  if (Math.abs(row.strike - flipLevel) < spotPrice * 0.003) labels.push('FLIP');
  return labels;
}

function _isITMCall(row: ChainRow, spotPrice: number): boolean {
  return row.strike < spotPrice;
}
function _isITMPut(row: ChainRow, spotPrice: number): boolean {
  return row.strike > spotPrice;
}
function _isFlipRow(row: ChainRow, flipLevel: number, spotPrice: number): boolean {
  return Math.abs(row.strike - flipLevel) < spotPrice * 0.003;
}
function _isMaxPainRow(row: ChainRow): boolean {
  return row.isMaxPain;
}
function _isATMRow(row: ChainRow, spotPrice: number): boolean {
  return Math.abs(row.strike - spotPrice) < spotPrice * 0.003;
}

// ── CHAIN Tab ────────────────────────────────────────────────────────────────

interface ChainTabProps {
  rows:      ChainRow[];
  ctx:       MarketContext;
  spotPrice: number;
  onStrikeSelect: (strike: number) => void;
}

function ChainTab({ rows, ctx, spotPrice, onStrikeSelect }: ChainTabProps) {
  const { flipLevel, maxPain } = ctx;

  return (
    <div className="chain-scroll overflow-x-auto">
      {/* Header */}
      <div className="grid grid-cols-[1fr_1fr_1fr_1fr_1fr_100px_1fr_1fr_1fr_1fr_1fr] min-w-[900px] border-b border-white/10 px-2 py-1.5 text-[11px] font-semibold uppercase tracking-widest text-zinc-500">
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
      <div className="min-w-[900px]">
        {rows.map((row) => {
          const labels    = _strikeLabels(row, spotPrice, flipLevel, maxPain);
          const isATM     = _isATMRow(row, spotPrice);
          const isFlip    = _isFlipRow(row, flipLevel, spotPrice);
          const isMP      = _isMaxPainRow(row);
          const isITMCall = _isITMCall(row, spotPrice);
          const isITMPut  = _isITMPut(row, spotPrice);

          // Row background priority: ATM > flip/MP > ITM
          const rowBg = isATM
            ? 'bg-amber-950/40 hover:bg-amber-950/60'
            : isFlip || isMP
            ? 'bg-violet-950/30 hover:bg-violet-950/50'
            : 'hover:bg-white/[0.03]';

          return (
            <button
              key={row.strike}
              type="button"
              onClick={() => onStrikeSelect(row.strike)}
              className={`grid w-full cursor-pointer grid-cols-[1fr_1fr_1fr_1fr_1fr_100px_1fr_1fr_1fr_1fr_1fr] border-b border-white/5 px-2 py-1 text-xs transition-colors ${rowBg}`}
            >
              {/* Calls side */}
              <span className={`text-right font-mono ${isITMCall ? 'text-emerald-300/80' : 'text-zinc-300'}`}>
                {row.callBid > 0 ? row.callBid.toFixed(2) : '—'}
              </span>
              <span className={`text-right font-mono ${isITMCall ? 'text-emerald-300/80' : 'text-zinc-300'}`}>
                {row.callAsk > 0 ? row.callAsk.toFixed(2) : '—'}
              </span>
              <span className={`text-right font-mono ${isITMCall ? 'text-emerald-300/80' : 'text-zinc-300'}`}>
                {row.callLast > 0 ? row.callLast.toFixed(2) : '—'}
              </span>
              <span className={`text-right font-mono text-[11px] ${isITMCall ? 'text-emerald-300/70' : 'text-zinc-400'}`}>
                {_fmtIV(row.callIV)}
              </span>
              <span className={`text-right font-mono text-[11px] ${isITMCall ? 'text-emerald-300/70' : 'text-zinc-400'}`}>
                {row.callVolume > 0 ? row.callVolume.toLocaleString() : '—'}
              </span>

              {/* Strike column */}
              <div className="flex flex-col items-center justify-center">
                <span
                  className={`font-mono text-[11px] font-bold leading-tight ${
                    isATM ? 'text-amber-300' : isFlip || isMP ? 'text-violet-300' : 'text-zinc-200'
                  }`}
                >
                  {_fmtPrice(row.strike)}
                </span>
                {labels.length > 0 && (
                  <span className="text-[9px] font-bold tracking-wider text-zinc-500">
                    {labels.join(' ')}
                  </span>
                )}
              </div>

              {/* Puts side */}
              <span className={`text-left font-mono text-[11px] ${isITMPut ? 'text-rose-300/70' : 'text-zinc-400'}`}>
                {row.putVolume > 0 ? row.putVolume.toLocaleString() : '—'}
              </span>
              <span className={`text-left font-mono text-[11px] ${isITMPut ? 'text-rose-300/70' : 'text-zinc-400'}`}>
                {_fmtIV(row.putIV)}
              </span>
              <span className={`text-left font-mono ${isITMPut ? 'text-rose-300/80' : 'text-zinc-300'}`}>
                {row.putLast > 0 ? row.putLast.toFixed(2) : '—'}
              </span>
              <span className={`text-left font-mono ${isITMPut ? 'text-rose-300/80' : 'text-zinc-300'}`}>
                {row.putAsk > 0 ? row.putAsk.toFixed(2) : '—'}
              </span>
              <span className={`text-left font-mono ${isITMPut ? 'text-rose-300/80' : 'text-zinc-300'}`}>
                {row.putBid > 0 ? row.putBid.toFixed(2) : '—'}
              </span>
            </button>
          );
        })}
      </div>

      {/* Footer */}
      <ChainFooter ctx={ctx} rows={rows} />
    </div>
  );
}

function ChainFooter({ ctx, rows }: { ctx: MarketContext; rows: ChainRow[] }) {
  const totalCallOI = rows.reduce((s, r) => s + r.callOI, 0);
  const totalPutOI  = rows.reduce((s, r) => s + r.putOI, 0);
  const avgCallIV   = rows.filter((r) => r.callIV > 0).reduce((s, r) => s + r.callIV, 0) /
                      Math.max(1, rows.filter((r) => r.callIV > 0).length);

  return (
    <div className="flex flex-wrap items-center gap-x-6 gap-y-1 border-t border-white/10 px-3 py-2 text-[11px] text-zinc-500">
      <span>Call OI <span className="font-mono text-zinc-300">{totalCallOI.toLocaleString()}</span></span>
      <span>Put OI <span className="font-mono text-zinc-300">{totalPutOI.toLocaleString()}</span></span>
      <span>P/C <span className="font-mono text-zinc-300">{ctx.pcRatio.toFixed(2)}</span></span>
      <span>Avg IV <span className="font-mono text-zinc-300">{_fmtIV(avgCallIV)}</span></span>
      <span>Net GEX <span className={`font-mono ${ctx.netGex >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>{_fmtGex(ctx.netGex)}</span></span>
    </div>
  );
}

// ── FLOW Tab ─────────────────────────────────────────────────────────────────

type FlowMode = 'OI' | 'VOL';

interface FlowTabProps {
  rows: ChainRow[];
  ctx:  MarketContext;
}

function FlowTab({ rows, ctx }: FlowTabProps) {
  const [mode, setMode] = useState<FlowMode>('OI');

  const callWall = ctx.walls.callWall;
  const putWall  = ctx.walls.putWall;

  const getValue = (row: ChainRow, side: 'call' | 'put'): number =>
    mode === 'OI'
      ? side === 'call' ? row.callOI : row.putOI
      : side === 'call' ? row.callVolume : row.putVolume;

  const allValues = rows.flatMap((r) => [getValue(r, 'call'), getValue(r, 'put')]);
  const maxVal    = Math.max(1, ...allValues);

  return (
    <div className="flex flex-col overflow-hidden">
      {/* Mode toggle */}
      <div className="flex items-center gap-2 border-b border-white/10 px-4 py-2">
        {(['OI', 'VOL'] as FlowMode[]).map((m) => (
          <button
            key={m}
            type="button"
            onClick={() => setMode(m)}
            className={`rounded px-3 py-1 text-xs font-bold transition-colors ${
              mode === m
                ? 'bg-white/15 text-white'
                : 'text-zinc-500 hover:text-zinc-300'
            }`}
          >
            {m === 'OI' ? 'Open Interest' : 'Volume'}
          </button>
        ))}
      </div>

      {/* Bar rows */}
      <div className="flow-scroll overflow-y-auto">
        {rows.map((row) => {
          const callVal  = getValue(row, 'call');
          const putVal   = getValue(row, 'put');
          const callPct  = (callVal / maxVal) * 100;
          const putPct   = (putVal  / maxVal) * 100;
          const isCallWall = row.strike === callWall;
          const isPutWall  = row.strike === putWall;

          return (
            <div
              key={row.strike}
              className="flex items-center gap-0 border-b border-white/5 px-2 py-0.5"
            >
              {/* Call bar (left, right-aligned) */}
              <div className="flex flex-1 items-center justify-end gap-2 pr-2">
                {isCallWall && (
                  <span className="text-[9px] font-bold tracking-widest text-emerald-400 uppercase">
                    Call Wall
                  </span>
                )}
                <span className="w-14 text-right font-mono text-[11px] text-zinc-400">
                  {callVal > 0 ? callVal.toLocaleString() : '—'}
                </span>
                <div className="h-5 overflow-hidden rounded-l-sm" style={{ width: '120px' }}>
                  <div
                    className="h-full rounded-l-sm bg-emerald-600/60 transition-all duration-300"
                    style={{ width: `${callPct}%`, marginLeft: 'auto' }}
                  />
                </div>
              </div>

              {/* Strike */}
              <div className="w-20 text-center font-mono text-[11px] font-bold text-zinc-300">
                {_fmtPrice(row.strike)}
              </div>

              {/* Put bar (right, left-aligned) */}
              <div className="flex flex-1 items-center gap-2 pl-2">
                <div className="h-5 w-[120px] overflow-hidden rounded-r-sm">
                  <div
                    className="h-full rounded-r-sm bg-rose-600/60 transition-all duration-300"
                    style={{ width: `${putPct}%` }}
                  />
                </div>
                <span className="w-14 font-mono text-[11px] text-zinc-400">
                  {putVal > 0 ? putVal.toLocaleString() : '—'}
                </span>
                {isPutWall && (
                  <span className="text-[9px] font-bold tracking-widest text-rose-400 uppercase">
                    Put Wall
                  </span>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* Footer */}
      <FlowFooter rows={rows} ctx={ctx} mode={mode} />
    </div>
  );
}

function FlowFooter({ rows, ctx, mode }: { rows: ChainRow[]; ctx: MarketContext; mode: FlowMode }) {
  const callWallStrike = ctx.walls.callWall;
  const putWallStrike  = ctx.walls.putWall;
  const callWallRow    = rows.find((r) => r.strike === callWallStrike);
  const putWallRow     = rows.find((r) => r.strike === putWallStrike);
  const callWallVal    = callWallRow ? (mode === 'OI' ? callWallRow.callOI : callWallRow.callVolume) : null;
  const putWallVal     = putWallRow  ? (mode === 'OI' ? putWallRow.putOI   : putWallRow.putVolume)   : null;

  return (
    <div className="flex flex-wrap items-center gap-x-6 gap-y-1 border-t border-white/10 px-3 py-2 text-[11px] text-zinc-500">
      <span>
        Top Call Wall{' '}
        <span className="font-mono text-emerald-300">
          {_fmtPrice(callWallStrike)}
          {callWallVal != null ? ` (${callWallVal.toLocaleString()})` : ''}
        </span>
      </span>
      <span>
        Top Put Wall{' '}
        <span className="font-mono text-rose-300">
          {_fmtPrice(putWallStrike)}
          {putWallVal != null ? ` (${putWallVal.toLocaleString()})` : ''}
        </span>
      </span>
      <span>Net GEX <span className={`font-mono ${ctx.netGex >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>{_fmtGex(ctx.netGex)}</span></span>
      <span>P/C <span className="font-mono text-zinc-300">{ctx.pcRatio.toFixed(2)}</span></span>
    </div>
  );
}

// ── GREEKS Tab ────────────────────────────────────────────────────────────────

interface GreeksTabProps {
  rows:      ChainRow[];
  ctx:       MarketContext;
  spotPrice: number;
}

function GreeksTab({ rows, ctx, spotPrice }: GreeksTabProps) {
  const { flipLevel } = ctx;

  return (
    <div className="greeks-scroll overflow-x-auto">
      {/* Header — calls */}
      <div className="grid grid-cols-[80px_1fr_1fr_1fr_1fr_1fr_1fr_80px_1fr_1fr_1fr_1fr_1fr_1fr] min-w-[1100px] border-b border-white/10 px-2 py-1.5 text-[11px] font-semibold uppercase tracking-widest text-zinc-500">
        <span className="text-right pr-2 text-zinc-600 col-span-7 text-center">Calls</span>
        <span className="text-center">Strike</span>
        <span className="text-left col-span-6 text-center text-zinc-600">Puts</span>
      </div>
      <div className="grid grid-cols-[80px_1fr_1fr_1fr_1fr_1fr_1fr_80px_1fr_1fr_1fr_1fr_1fr_1fr] min-w-[1100px] border-b border-white/10 px-2 py-1 text-[11px] font-semibold uppercase tracking-widest text-zinc-500">
        <span className="text-right">B/E</span>
        <span className="text-right">IV</span>
        <span className="text-right">Vega</span>
        <span className="text-right">Theta</span>
        <span className="text-right">Gamma</span>
        <span className="text-right">Delta</span>
        <span className="text-right">OI</span>
        <span className="text-center">Strike</span>
        <span className="text-left">OI</span>
        <span className="text-left">Delta</span>
        <span className="text-left">Gamma</span>
        <span className="text-left">Theta</span>
        <span className="text-left">Vega</span>
        <span className="text-left">IV</span>
      </div>

      {/* Rows */}
      <div className="min-w-[1100px]">
        {rows.map((row) => {
          const isATM   = _isATMRow(row, spotPrice);
          const isFlip  = _isFlipRow(row, flipLevel, spotPrice);
          const isMP    = _isMaxPainRow(row);
          const rowBg   = isATM
            ? 'bg-amber-950/40 hover:bg-amber-950/60'
            : isFlip || isMP
            ? 'bg-violet-950/30 hover:bg-violet-950/50'
            : 'hover:bg-white/[0.03]';

          // Break-even = strike + call premium (for calls)
          const callMid = (row.callBid + row.callAsk) / 2;
          const callBE  = callMid > 0 ? row.strike + callMid : 0;

          // Delta colour
          const callDeltaColor =
            row.callDelta >= 0.5 ? 'text-emerald-300 font-bold' :
            row.callDelta >= 0.3 ? 'text-emerald-400' :
            'text-zinc-400';
          const putDeltaColor =
            row.putDelta <= -0.5 ? 'text-rose-300 font-bold' :
            row.putDelta <= -0.3 ? 'text-rose-400' :
            'text-zinc-400';

          return (
            <div
              key={row.strike}
              className={`grid grid-cols-[80px_1fr_1fr_1fr_1fr_1fr_1fr_80px_1fr_1fr_1fr_1fr_1fr_1fr] border-b border-white/5 px-2 py-1 text-xs transition-colors ${rowBg}`}
            >
              {/* Calls */}
              <span className="text-right font-mono text-zinc-300">
                {callBE > 0 ? _fmtPrice(callBE) : '—'}
              </span>
              <span className="text-right font-mono text-zinc-400">{_fmtIV(row.callIV)}</span>
              <span className="text-right font-mono text-zinc-400">{row.callVega !== 0 ? row.callVega.toFixed(3) : '—'}</span>
              <span className="text-right font-mono text-zinc-400">{row.callTheta !== 0 ? row.callTheta.toFixed(3) : '—'}</span>
              <span className="text-right font-mono text-zinc-400">{row.callGamma !== 0 ? row.callGamma.toFixed(4) : '—'}</span>
              <span className={`text-right font-mono ${callDeltaColor}`}>{_fmtDelta(row.callDelta)}</span>
              <span className="text-right font-mono text-zinc-500">{row.callOI > 0 ? row.callOI.toLocaleString() : '—'}</span>

              {/* Strike */}
              <div className="flex flex-col items-center justify-center">
                <span className={`font-mono text-[11px] font-bold ${
                  isATM ? 'text-amber-300' : isFlip || isMP ? 'text-violet-300' : 'text-zinc-200'
                }`}>
                  {_fmtPrice(row.strike)}
                </span>
              </div>

              {/* Puts */}
              <span className="text-left font-mono text-zinc-500">{row.putOI > 0 ? row.putOI.toLocaleString() : '—'}</span>
              <span className={`text-left font-mono ${putDeltaColor}`}>{_fmtDelta(row.putDelta)}</span>
              <span className="text-left font-mono text-zinc-400">{row.putGamma !== 0 ? row.putGamma.toFixed(4) : '—'}</span>
              <span className="text-left font-mono text-zinc-400">{row.putTheta !== 0 ? row.putTheta.toFixed(3) : '—'}</span>
              <span className="text-left font-mono text-zinc-400">{row.putVega !== 0 ? row.putVega.toFixed(3) : '—'}</span>
              <span className="text-left font-mono text-zinc-400">{_fmtIV(row.putIV)}</span>
            </div>
          );
        })}
      </div>

      {/* B/E key */}
      <div className="border-t border-white/10 px-3 py-2 text-[10px] text-zinc-600">
        B/E = Break-even (strike ± mid-market premium). ATM highlighted amber. Flip/MP highlighted violet. Delta ≥ 0.50 bold.
      </div>
    </div>
  );
}

// ── GEX Tab ───────────────────────────────────────────────────────────────────

interface GexTabProps {
  rows:      ChainRow[];
  ctx:       MarketContext;
  spotPrice: number;
}

function GexTab({ rows, ctx, spotPrice }: GexTabProps) {
  const { gexRegime, netGex, walls, flipLevel } = ctx;

  const regimeName =
    gexRegime === 'positive' ? 'POSITIVE GAMMA REGIME' :
    gexRegime === 'negative' ? 'NEGATIVE GAMMA REGIME' :
    'NEUTRAL GAMMA REGIME';

  const regimeColor =
    gexRegime === 'positive' ? 'text-emerald-300' :
    gexRegime === 'negative' ? 'text-rose-300' :
    'text-zinc-400';

  const regimeExplanation =
    gexRegime === 'positive'
      ? 'Dealers are long gamma — they sell into rallies and buy dips, suppressing volatility and keeping price in a range.'
      : gexRegime === 'negative'
      ? 'Dealers are short gamma — they buy into rallies and sell dips, amplifying moves and increasing volatility.'
      : 'Net dealer gamma is near zero — no dominant force; price can break in either direction with modest momentum.';

  // Dot size: scale magnitude relative to max |netGex| in chain
  const maxAbs = Math.max(1, ...rows.map((r) => Math.abs(r.netGex)));
  const dotSize = (absVal: number) => Math.max(4, Math.round((absVal / maxAbs) * 20));

  return (
    <div className="flex flex-col overflow-hidden">
      {/* Regime banner */}
      <div className="border-b border-white/10 px-4 py-4">
        <div className={`text-2xl font-black tracking-tight ${regimeColor}`}>
          {regimeName}
        </div>
        <div className="mt-1 flex items-center gap-3">
          <span className="font-mono text-sm font-bold text-zinc-300">
            Net GEX{' '}
            <span className={netGex >= 0 ? 'text-emerald-400' : 'text-rose-400'}>
              {_fmtGex(netGex)}
            </span>
          </span>
        </div>
        <p className="mt-2 max-w-xl text-sm text-zinc-400">{regimeExplanation}</p>

        {/* Regime pills */}
        <div className="mt-3 flex flex-wrap gap-2">
          <div className="flex items-center gap-2 rounded border border-emerald-700/40 bg-emerald-950/40 px-3 py-1.5">
            <span className="text-[10px] font-bold uppercase tracking-widest text-emerald-500">Main Wall</span>
            <span className="font-mono text-sm font-bold text-emerald-300">{_fmtPrice(walls.callWall)}</span>
          </div>
          <div className="flex items-center gap-2 rounded border border-rose-700/40 bg-rose-950/40 px-3 py-1.5">
            <span className="text-[10px] font-bold uppercase tracking-widest text-rose-500">Put Wall</span>
            <span className="font-mono text-sm font-bold text-rose-300">{_fmtPrice(walls.putWall)}</span>
          </div>
          <div className="flex items-center gap-2 rounded border border-violet-700/40 bg-violet-950/40 px-3 py-1.5">
            <span className="text-[10px] font-bold uppercase tracking-widest text-violet-500">Flip Point</span>
            <span className="font-mono text-sm font-bold text-violet-300">{_fmtPrice(flipLevel)}</span>
          </div>
          <div className="flex items-center gap-2 rounded border border-violet-700/40 bg-violet-950/40 px-3 py-1.5">
            <span className="text-[10px] font-bold uppercase tracking-widest text-violet-500">Max Pain</span>
            <span className="font-mono text-sm font-bold text-violet-300">{_fmtPrice(ctx.maxPain)}</span>
          </div>
        </div>
      </div>

      {/* Per-strike GEX table */}
      <div className="gex-scroll overflow-y-auto">
        {/* Header */}
        <div className="grid grid-cols-[80px_1fr_1fr_1fr_32px] border-b border-white/10 px-3 py-1.5 text-[11px] font-semibold uppercase tracking-widest text-zinc-500">
          <span>Strike</span>
          <span className="text-right">Call GEX</span>
          <span className="text-right">Put GEX</span>
          <span className="text-right">Net GEX</span>
          <span />
        </div>

        {rows.map((row) => {
          const isFlip     = _isFlipRow(row, flipLevel, spotPrice);
          const isMP       = _isMaxPainRow(row);
          const isATM      = _isATMRow(row, spotPrice);
          const rowBg      = isATM
            ? 'bg-amber-950/30'
            : isFlip || isMP
            ? 'bg-violet-950/25'
            : '';
          const netColor   = row.netGex >= 0 ? 'text-emerald-400' : 'text-rose-400';
          const ds         = dotSize(Math.abs(row.netGex));

          return (
            <div
              key={row.strike}
              className={`grid grid-cols-[80px_1fr_1fr_1fr_32px] items-center border-b border-white/5 px-3 py-1 text-xs ${rowBg}`}
            >
              <span className={`font-mono font-bold ${
                isATM ? 'text-amber-300' : isFlip || isMP ? 'text-violet-300' : 'text-zinc-300'
              }`}>
                {_fmtPrice(row.strike)}
              </span>
              <span className="text-right font-mono text-emerald-400/80">{_fmtGex(row.callGex)}</span>
              <span className="text-right font-mono text-rose-400/80">{_fmtGex(row.putGex)}</span>
              <span className={`text-right font-mono font-bold ${netColor}`}>{_fmtGex(row.netGex)}</span>
              {/* Proportional dot */}
              <div className="flex items-center justify-center">
                <div
                  className={`rounded-full ${row.netGex >= 0 ? 'bg-emerald-500/70' : 'bg-rose-500/70'}`}
                  style={{ width: ds, height: ds }}
                />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Main: ChainCockpit ────────────────────────────────────────────────────────

export default function ChainCockpit() {
  const [activeTicker, setActiveTicker] = useState<string>(SELECTABLE_TICKERS[0] ?? 'SPY');
  const [activeTab,    setActiveTab]    = useState<SubTab>('CHAIN');
  const [_expiry,      setExpiry]       = useState<string>(DEFAULT_EXPIRY.value);

  // ── Store state ─────────────────────────────────────────────────────────────
  const [ctxResult,  setCtxResult]  = useState(() => marketStore.getResult(activeTicker));
  const [barsResult, setBarsResult] = useState(() => barsStore.getResult(activeTicker));
  const [dir,        setDir]        = useState<DirectionState | null>(
    () => getDirectionState(activeTicker),
  );

  // Selected strike — stored in local state; navigation will be wired once
  // ZeroDteCockpit is built.
  const [_selectedStrike, setSelectedStrike] = useState<number | null>(null);

  // ── Re-read stores whenever ticker changes or stores update ─────────────────
  const refresh = useCallback(() => {
    setCtxResult(marketStore.getResult(activeTicker));
    setBarsResult(barsStore.getResult(activeTicker));
    setDir(getDirectionState(activeTicker));
  }, [activeTicker]);

  useEffect(() => {
    refresh();

    const unsubs = [
      marketStore.subscribe(refresh),
      barsStore.subscribe(refresh),
      subscribeDirection((_t, _s) => refresh()),
    ];

    return () => { for (const u of unsubs) u(); };
  }, [refresh]);

  // ── Derived data ─────────────────────────────────────────────────────────────

  // Live price + prior close
  let price:     number | null = null;
  let changePct: number | null = null;

  if (barsResult.status === 'ready' && barsResult.data.length >= 2) {
    const bars = barsResult.data;
    price = bars[bars.length - 1].close;
    const prev = bars[0].open;
    if (prev > 0) changePct = ((price - prev) / prev) * 100;
  }

  // ctx + chain rows
  const ctx:   MarketContext | null  = ctxResult.status === 'ready' ? ctxResult.data : null;
  const rows:  ChainRow[]            = ctx?.chain ?? [];
  const spotPrice = price ?? ctx?.flipLevel ?? 0;

  // ── Tab content ───────────────────────────────────────────────────────────────

  function renderTabContent() {
    if (ctxResult.status === 'loading') return <LoadingSkeleton />;
    if (ctxResult.status === 'error')   return <ErrorBanner reason={ctxResult.reason} />;
    if (!ctx || rows.length === 0) {
      return (
        <div className="flex flex-col items-center justify-center gap-2 py-16 text-zinc-500">
          <span className="text-3xl">⛓</span>
          <span className="text-sm">No chain data — waiting for first snapshot</span>
        </div>
      );
    }

    switch (activeTab) {
      case 'CHAIN':
        return (
          <ChainTab
            rows={rows}
            ctx={ctx}
            spotPrice={spotPrice}
            onStrikeSelect={(strike) => {
              setSelectedStrike(strike);
              // TODO: navigate to /zerod/${activeTicker}?strike=${strike}
              // once ZeroDteCockpit is built
            }}
          />
        );
      case 'FLOW':
        return <FlowTab rows={rows} ctx={ctx} />;
      case 'GREEKS':
        return <GreeksTab rows={rows} ctx={ctx} spotPrice={spotPrice} />;
      case 'GEX':
        return <GexTab rows={rows} ctx={ctx} spotPrice={spotPrice} />;
    }
  }

  // ── Render ────────────────────────────────────────────────────────────────────

  return (
    <section id="chain" className="flex h-full flex-col bg-zinc-950 text-white">
      {/* Ticker + Expiry selectors */}
      <div className="flex items-center gap-3 border-b border-white/10 bg-zinc-900/60 px-4 py-2.5">
        {/* Ticker selector */}
        <div className="flex flex-wrap items-center gap-1">
          {SELECTABLE_TICKERS.map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => {
                setActiveTicker(t);
                setSelectedStrike(null);
              }}
              className={`rounded px-2.5 py-1 text-xs font-bold transition-colors ${
                activeTicker === t
                  ? 'bg-white/20 text-white'
                  : 'text-zinc-500 hover:text-zinc-300 hover:bg-white/5'
              }`}
            >
              {t}
            </button>
          ))}
        </div>

        {/* Expiry selector */}
        <div className="ml-auto flex items-center gap-2">
          <span className="text-[11px] font-semibold uppercase tracking-widest text-zinc-500">
            Expiry
          </span>
          <select
            value={_expiry}
            onChange={(e) => setExpiry(e.target.value)}
            className="rounded border border-white/10 bg-zinc-800 px-2 py-1 text-xs text-zinc-300 focus:outline-none focus:ring-1 focus:ring-white/20"
          >
            <option value={DEFAULT_EXPIRY.value}>{DEFAULT_EXPIRY.label}</option>
          </select>
        </div>
      </div>

      {/* Context bar */}
      <ContextBar
        ticker={activeTicker}
        price={price}
        changePct={changePct}
        ctx={ctx}
        dir={dir}
      />

      {/* Sub-tabs */}
      <div className="flex items-center gap-0 border-b border-white/10 bg-zinc-900/40 px-4">
        {(['CHAIN', 'FLOW', 'GREEKS', 'GEX'] as SubTab[]).map((tab) => (
          <button
            key={tab}
            type="button"
            onClick={() => setActiveTab(tab)}
            className={`border-b-2 px-5 py-2.5 text-xs font-bold uppercase tracking-widest transition-colors ${
              activeTab === tab
                ? 'border-white text-white'
                : 'border-transparent text-zinc-500 hover:text-zinc-300'
            }`}
          >
            {tab}
          </button>
        ))}
      </div>

      {/* Tab content */}
      <div className="flex-1 overflow-hidden">
        {renderTabContent()}
      </div>
    </section>
  );
}
