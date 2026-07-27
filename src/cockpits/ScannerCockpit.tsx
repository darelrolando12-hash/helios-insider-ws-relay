/**
 * Layer 4 — ScannerCockpit
 *
 * Three-column live signal scanner: FORMING | TRIGGERING | ACTIVE
 * Plus a bottom resolved row for today's completed signals.
 *
 * Data reads (zero outbound calls — all from Layer 1–3 stores and engines):
 *   confluenceEngine  — onSignal subscription for incoming signals
 *   directionState    — sessionBias + playDirection header badges
 *   marketStore       — walls, flipLevel, upTarget for contract context
 *   barsStore         — candle count, live price, break-even calc
 *   brainStore        — base rates when n >= 15
 *   signalLedger      — "I'm In" log (writes one row via supabase)
 *
 * Signal lifecycle within this cockpit:
 *   onSignal fires → score 5–7 factors → FORMING card
 *   all 8 factors → TRIGGERING card (pulsing CSS animation)
 *   user presses "I'm In" → logs signal + navigates to ZeroDteCockpit
 *   signal in flight → ACTIVE card with live state dots
 *   resolved today → RESOLVED row
 *
 * Rules enforced here:
 *   - CONTEXT_ONLY_TICKERS (HYG, TLT, I:VIX) never surface in any column
 *   - SPX and NDX cards carry a "CASH SETTLED" label everywhere they appear
 *   - Duration shown in candles only — never wall-clock minutes
 *   - All three Result<T> states handled: loading skeleton / error / ready
 *   - sessionBias + playDirection badges always visible at screen top
 */

import React, {
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import { useNavigate } from 'react-router-dom';

import * as confluenceEngine from '../engines/confluenceEngine';
import * as barsStore        from '../stores/barsStore';
import * as marketStore      from '../stores/marketStore';
import * as brainStore       from '../ledger/brainStore';
import { supabase }          from '../lib/supabase';
import {
  getAllDirectionStates,
  subscribe as subscribeDirection,
  FEED_TICKERS,
  CONTEXT_ONLY_TICKERS,
  CASH_SETTLED_TICKERS,
} from '../state/directionState';
import type { Signal }         from '../stores/types';
import type { DirectionState } from '../state/directionState';
import type { BaseRate, SetupFingerprint } from '../ledger/brainStore';

// ── Local types ────────────────────────────────────────────────────────────────

/** Setup type labels inferred from signal source tags */
type SetupType =
  | 'COIL'
  | 'WALL_TEST'
  | 'DIVERGENCE'
  | 'INSIDER_SQUEEZE'
  | 'CATALYST'
  | 'DUMP_RIP';

/** Which of the 8 confluence factors is confirmed */
interface FactorStatus {
  cvdStrength:    boolean;
  gexAlignment:   boolean;
  emaTrend:       boolean;
  catalyst:       boolean;
  dumpRipUrgency: boolean;
  priceVsVwap:    boolean;
  volumeSpike:    boolean;
  momentumStack:  boolean;
}

/** Column classification */
type SignalPhase = 'FORMING' | 'TRIGGERING' | 'ACTIVE';

/** Live state shown in the ACTIVE column */
type ActiveState = 'ACTIVE' | 'CONSOLIDATING' | 'CONTINUATION' | 'FLIP_DETECTED';

interface LiveSignalCard {
  signal:        Signal;
  phase:         SignalPhase;
  setupType:     SetupType;
  factors:       FactorStatus;
  confirmedCount: number;    // 0–8
  candlesElapsed: number;
  activeState:   ActiveState;
  /** Only present once in ACTIVE and TRIGGERING phase */
  baseRate:      BaseRate | null;
  /** Entry candle index for elapsed-candle math */
  entryBarIndex: number;
  /** Whether user pressed "I'm In" already */
  userTracked:   boolean;
  addedAt:       number;     // Date.now() at intake
}

/** A resolved signal for the bottom row */
interface ResolvedCard {
  signal:        Signal;
  result:        'WIN' | 'LOSS' | 'SCRATCH';
  pnlPct:        number;
  durationCandles: number;
  exitReason:    string;
}

// ── Constants ─────────────────────────────────────────────────────────────────

/** Signals older than this many seconds graduate out of TRIGGERING if untouched */
const TRIGGERING_TTL_S   = 120;
/** Signals older than this many candles graduate out of ACTIVE into RESOLVED */
const ACTIVE_MAX_CANDLES = 12;
/** Factor confirmations needed to be TRIGGERING (all 8) */
const TRIGGERING_THRESHOLD = 8;
/** Factor confirmations needed to be FORMING (5, 6, or 7 of 8) */
const FORMING_MIN    = 5;

// ── Helpers ───────────────────────────────────────────────────────────────────

function _inferSetupType(signal: Signal): SetupType {
  const src = signal.sources.join(' ');
  if (src.includes('dumpRipDetector'))   return 'DUMP_RIP';
  if (src.includes('catalyst'))          return 'CATALYST';
  if (src.includes('squeeze'))           return 'INSIDER_SQUEEZE';
  if (src.includes('wall'))              return 'WALL_TEST';
  if (src.includes('divergence'))        return 'DIVERGENCE';
  return 'COIL';
}

function _buildFactorStatus(signal: Signal): FactorStatus {
  const src = signal.sources;
  return {
    cvdStrength:    src.includes('cvd'),
    gexAlignment:   src.includes('gex'),
    emaTrend:       src.includes('ema'),
    catalyst:       src.includes('catalyst'),
    dumpRipUrgency: src.includes('dumpRipDetector'),
    priceVsVwap:    src.includes('vwap'),
    volumeSpike:    src.includes('volume'),
    momentumStack:  src.includes('momentum') || signal.confidence >= 85,
  };
}

function _countConfirmed(f: FactorStatus): number {
  return Object.values(f).filter(Boolean).length;
}

function _candlesElapsed(signal: Signal): number {
  const barsResult = barsStore.getResult(signal.ticker);
  if (barsResult.status !== 'ready') return 0;
  const bars = barsResult.data;
  // Find entry bar by closest tUtc
  const entryMs = signal.firedAt;
  let closestIdx = 0;
  let closestDelta = Infinity;
  for (let i = 0; i < bars.length; i++) {
    const d = Math.abs(bars[i].tUtc - entryMs);
    if (d < closestDelta) { closestDelta = d; closestIdx = i; }
  }
  return Math.max(0, bars.length - 1 - closestIdx);
}

function _currentPrice(ticker: string): number | null {
  const r = barsStore.getResult(ticker);
  if (r.status !== 'ready' || r.data.length === 0) return null;
  return r.data[r.data.length - 1].close;
}

function _inferActiveState(signal: Signal, candles: number): ActiveState {
  if (candles < 2) return 'ACTIVE';
  const price = _currentPrice(signal.ticker);
  if (!price) return 'ACTIVE';
  const mkt = marketStore.getResult(signal.ticker);
  if (mkt.status !== 'ready') return 'ACTIVE';
  const ctx = mkt.data;

  // Flip detected: price crossed through flipLevel against signal direction
  const isCallSignal = signal.type === 'ENTER' || signal.type === 'BREAKOUT' || signal.type === 'RIP';
  if (isCallSignal && price < ctx.flipLevel)  return 'FLIP_DETECTED';
  if (!isCallSignal && price > ctx.flipLevel) return 'FLIP_DETECTED';

  // Consolidation: price between put wall and call wall for 2+ candles
  if (price > ctx.walls.putWall && price < ctx.walls.callWall) {
    return candles >= 4 ? 'CONSOLIDATING' : 'ACTIVE';
  }

  // Continuation: price beyond primary wall
  if (isCallSignal && price >= ctx.walls.callWall)  return 'CONTINUATION';
  if (!isCallSignal && price <= ctx.walls.putWall)  return 'CONTINUATION';

  return 'ACTIVE';
}

function _lookupBaseRate(signal: Signal): BaseRate | null {
  const mkt = marketStore.getResult(signal.ticker);
  if (mkt.status !== 'ready') return null;
  const dir = (signal.type === 'ENTER' || signal.type === 'BREAKOUT' || signal.type === 'RIP')
    ? 'call' as const
    : 'put' as const;
  const fp: SetupFingerprint = {
    ticker:    signal.ticker,
    direction: dir,
    gexRegime: mkt.data.gexRegime,
    vixBucket: '<15', // default until VIX feed wired
    timeOfDay: brainStore.timeOfDayBucket(signal.firedAtCT),
  };
  const r = brainStore.getBaseRate(fp);
  if (r.status !== 'ready' || !r.data.isStatisticallyValid) return null;
  return r.data;
}

function _fmtPct(n: number): string {
  return (n >= 0 ? '+' : '') + n.toFixed(2) + '%';
}

function _setupTypeLabel(t: SetupType): string {
  return t.replace('_', ' ');
}

const FACTOR_LABELS: Record<keyof FactorStatus, string> = {
  cvdStrength:    'CVD Strength',
  gexAlignment:   'GEX Align',
  emaTrend:       'EMA Trend',
  catalyst:       'Catalyst',
  dumpRipUrgency: 'DUMP/RIP',
  priceVsVwap:    'vs VWAP',
  volumeSpike:    'Vol Spike',
  momentumStack:  'Momentum',
};

const ACTIVE_STATE_COLORS: Record<ActiveState, string> = {
  ACTIVE:        'text-emerald-400',
  CONSOLIDATING: 'text-amber-400',
  CONTINUATION:  'text-sky-400',
  FLIP_DETECTED: 'text-rose-400',
};

// ── Sub-components ────────────────────────────────────────────────────────────

function LoadingSkeleton() {
  return (
    <div className="flex gap-3 h-full animate-pulse">
      {[0, 1, 2].map(i => (
        <div key={i} className="flex-1 flex flex-col gap-2">
          <div className="h-5 bg-white/10 rounded w-24" />
          {[0, 1, 2].map(j => (
            <div key={j} className="h-28 bg-white/5 rounded-lg border border-white/10" />
          ))}
        </div>
      ))}
    </div>
  );
}

function ErrorBanner({ reason }: { reason: string }) {
  return (
    <div className="rounded-lg border border-rose-500/40 bg-rose-500/10 px-4 py-3 text-rose-300 text-sm">
      Scanner error: {reason}
    </div>
  );
}

interface DirectionBadgesProps {
  dirStates: Map<string, DirectionState>;
}

function DirectionBadges({ dirStates }: DirectionBadgesProps) {
  // Aggregate across all tickers for a global session read
  const states = Array.from(dirStates.values());
  if (states.length === 0) {
    return (
      <div className="flex gap-2 text-xs text-white/30 italic">
        Awaiting direction state…
      </div>
    );
  }

  const bullish  = states.filter(s => s.sessionBias === 'bullish').length;
  const bearish  = states.filter(s => s.sessionBias === 'bearish').length;
  const total    = states.length;
  const dominant = bullish > bearish ? 'BULL' : bearish > bullish ? 'BEAR' : 'NEUTRAL';

  const callPlay  = states.filter(s => s.playDirection === 'calls').length;
  const putPlay   = states.filter(s => s.playDirection === 'puts').length;
  const playDom   = callPlay > putPlay ? 'CALLS' : putPlay > callPlay ? 'PUTS' : 'MIXED';

  const biasColor: Record<string, string> = {
    BULL: 'bg-emerald-500/20 text-emerald-300 border-emerald-500/30',
    BEAR: 'bg-rose-500/20 text-rose-300 border-rose-500/30',
    NEUTRAL: 'bg-white/10 text-white/60 border-white/20',
  };
  const playColor: Record<string, string> = {
    CALLS: 'bg-sky-500/20 text-sky-300 border-sky-500/30',
    PUTS:  'bg-orange-500/20 text-orange-300 border-orange-500/30',
    MIXED: 'bg-white/10 text-white/60 border-white/20',
  };

  return (
    <div className="flex items-center gap-2 flex-wrap">
      <span className={`px-2.5 py-0.5 rounded border text-xs font-semibold tracking-wide ${biasColor[dominant]}`}>
        SESSION {dominant} ({bullish}/{total})
      </span>
      <span className={`px-2.5 py-0.5 rounded border text-xs font-semibold tracking-wide ${playColor[playDom]}`}>
        PLAY {playDom} ({Math.max(callPlay, putPlay)}/{total})
      </span>
    </div>
  );
}

interface FactorDotsProps {
  factors:   FactorStatus;
  live?:     boolean;
}

function FactorDots({ factors, live = false }: FactorDotsProps) {
  return (
    <div className="flex flex-wrap gap-x-2 gap-y-1 mt-1.5">
      {(Object.entries(factors) as [keyof FactorStatus, boolean][]).map(([key, confirmed]) => (
        <span
          key={key}
          className={`flex items-center gap-1 text-[10px] font-medium ${
            confirmed
              ? 'text-emerald-400'
              : live
                ? 'text-amber-400/70 animate-pulse'
                : 'text-white/25'
          }`}
        >
          <span className={`inline-block w-1.5 h-1.5 rounded-full ${
            confirmed ? 'bg-emerald-400' : live ? 'bg-amber-400/70' : 'bg-white/20'
          }`} />
          {FACTOR_LABELS[key]}
        </span>
      ))}
    </div>
  );
}

interface CashSettledTagProps { ticker: string }
function CashSettledTag({ ticker }: CashSettledTagProps) {
  if (!CASH_SETTLED_TICKERS.has(ticker)) return null;
  return (
    <span className="ml-1.5 px-1.5 py-px text-[9px] font-bold tracking-wider rounded
      bg-amber-500/20 text-amber-300 border border-amber-500/30 uppercase">
      CASH SETTLED
    </span>
  );
}

interface BaseRateBadgeProps { rate: BaseRate }
function BaseRateBadge({ rate }: BaseRateBadgeProps) {
  const pct = (rate.winRate * 100).toFixed(0);
  const color = rate.winRate >= 0.6 ? 'text-emerald-400' : rate.winRate >= 0.45 ? 'text-amber-400' : 'text-rose-400';
  return (
    <span className={`text-[10px] font-semibold ${color}`}>
      Brain {pct}% ({rate.n}n) · best {rate.bestWindow}
    </span>
  );
}

// ── FORMING card ──────────────────────────────────────────────────────────────

interface FormingCardProps {
  card:      LiveSignalCard;
  onWatch:   (id: string) => void;
  watching:  Set<string>;
}

function FormingCard({ card, onWatch, watching }: FormingCardProps) {
  const { signal, setupType, factors, confirmedCount } = card;
  const isWatching = watching.has(signal.id);

  const pending = (Object.entries(factors) as [keyof FactorStatus, boolean][])
    .filter(([, v]) => !v)
    .map(([k]) => FACTOR_LABELS[k]);

  return (
    <div className="rounded-lg border border-white/10 bg-white/[0.03] p-3 flex flex-col gap-2
      hover:border-white/20 transition-colors duration-200">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5">
          <span className="text-sm font-bold text-white tracking-wide">{signal.ticker}</span>
          <CashSettledTag ticker={signal.ticker} />
        </div>
        <span className="text-[10px] font-semibold text-white/40 tabular-nums">
          {confirmedCount}/8
        </span>
      </div>

      {/* Setup type */}
      <div className="flex items-center gap-1.5">
        <span className="px-1.5 py-0.5 rounded text-[10px] font-bold bg-indigo-500/15
          text-indigo-300 border border-indigo-500/25 tracking-wider">
          {_setupTypeLabel(setupType)}
        </span>
        <span className="text-[10px] text-white/35">
          score {signal.confidence}
        </span>
      </div>

      {/* Factor dots */}
      <FactorDots factors={factors} />

      {/* Pending conditions */}
      {pending.length > 0 && (
        <div className="text-[10px] text-white/30 leading-tight">
          Waiting: {pending.join(', ')}
        </div>
      )}

      {/* WATCH button */}
      <button
        onClick={() => onWatch(signal.id)}
        className={`mt-1 w-full py-1 rounded text-[11px] font-semibold tracking-wide
          transition-all duration-150 border ${
            isWatching
              ? 'bg-indigo-500/20 text-indigo-300 border-indigo-500/30 cursor-default'
              : 'bg-white/5 text-white/60 border-white/10 hover:bg-indigo-500/15 hover:text-indigo-300 hover:border-indigo-500/25'
          }`}
      >
        {isWatching ? 'WATCHING' : 'WATCH'}
      </button>
    </div>
  );
}

// ── TRIGGERING card ───────────────────────────────────────────────────────────

interface TriggeringCardProps {
  card:      LiveSignalCard;
  onImIn:    (card: LiveSignalCard) => void;
}

function TriggeringCard({ card, onImIn }: TriggeringCardProps) {
  const { signal, setupType, factors, baseRate } = card;

  const mkt        = marketStore.getResult(signal.ticker);
  const price      = _currentPrice(signal.ticker);
  const targetWall = mkt.status === 'ready'
    ? (signal.type === 'ENTER' || signal.type === 'BREAKOUT' || signal.type === 'RIP'
        ? mkt.data.walls.callWall
        : mkt.data.walls.putWall)
    : null;

  // Break-even: entry price + spread (approximated at 0.5% for equity options)
  const breakEven = price != null ? (price * 1.005).toFixed(2) : '—';

  return (
    <div className="rounded-lg border border-amber-400/40 bg-amber-400/5 p-3 flex flex-col gap-2
      animate-pulse-border relative overflow-hidden">
      {/* Pulsing glow ring */}
      <div className="absolute inset-0 rounded-lg pointer-events-none
        ring-1 ring-amber-400/30 animate-ping-slow" />

      {/* Header */}
      <div className="flex items-center justify-between relative z-10">
        <div className="flex items-center gap-1.5">
          <span className="text-sm font-bold text-white tracking-wide">{signal.ticker}</span>
          <CashSettledTag ticker={signal.ticker} />
        </div>
        <span className="text-[10px] font-semibold text-amber-400/80 tabular-nums">
          ALL 8 ✓
        </span>
      </div>

      {/* Setup + score */}
      <div className="flex items-center gap-1.5 relative z-10">
        <span className="px-1.5 py-0.5 rounded text-[10px] font-bold bg-amber-500/15
          text-amber-300 border border-amber-500/30 tracking-wider">
          {_setupTypeLabel(setupType)}
        </span>
        <span className="text-[10px] font-bold text-amber-300">
          {signal.confidence}
        </span>
      </div>

      {/* Contract context */}
      <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-[10px] relative z-10">
        <div className="text-white/40">Entry</div>
        <div className="text-white font-semibold tabular-nums">
          ${price?.toFixed(2) ?? '—'}
        </div>
        <div className="text-white/40">Break-even</div>
        <div className="text-white/70 tabular-nums">${breakEven}</div>
        <div className="text-white/40">Target wall</div>
        <div className="text-emerald-400 font-semibold tabular-nums">
          {targetWall != null ? `$${targetWall.toFixed(2)}` : '—'}
        </div>
        <div className="text-white/40">Candles</div>
        <div className="text-white/60 tabular-nums">{card.candlesElapsed}</div>
      </div>

      {/* Factor dots — all confirmed */}
      <div className="relative z-10">
        <FactorDots factors={factors} />
      </div>

      {/* Brain base rate */}
      {baseRate && (
        <div className="relative z-10">
          <BaseRateBadge rate={baseRate} />
        </div>
      )}

      {/* I'm In */}
      <button
        onClick={() => onImIn(card)}
        className="mt-1 w-full py-1.5 rounded text-xs font-bold tracking-widest
          bg-amber-500/25 text-amber-200 border border-amber-500/50
          hover:bg-amber-500/40 hover:text-white transition-all duration-150
          active:scale-[0.98] relative z-10"
      >
        I'M IN
      </button>
    </div>
  );
}

// ── ACTIVE card ───────────────────────────────────────────────────────────────

interface ActiveCardProps {
  card: LiveSignalCard;
}

function ActiveCard({ card }: ActiveCardProps) {
  const { signal, setupType, factors, candlesElapsed, activeState, baseRate } = card;

  const price     = _currentPrice(signal.ticker);
  const entryPnl  = price != null
    ? ((price - signal.triggerPrice) / signal.triggerPrice) * 100
    : null;
  const isCall = signal.type === 'ENTER' || signal.type === 'BREAKOUT' || signal.type === 'RIP';
  const pnlPct = entryPnl != null ? (isCall ? entryPnl : -entryPnl) : null;

  const stateColor = ACTIVE_STATE_COLORS[activeState];

  return (
    <div className="rounded-lg border border-white/10 bg-white/[0.03] p-3 flex flex-col gap-2
      hover:border-white/18 transition-colors duration-200">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5">
          <span className="text-sm font-bold text-white tracking-wide">{signal.ticker}</span>
          <CashSettledTag ticker={signal.ticker} />
        </div>
        <span className={`text-[10px] font-bold tabular-nums ${stateColor}`}>
          {activeState}
        </span>
      </div>

      {/* Setup */}
      <div className="flex items-center gap-1.5">
        <span className="px-1.5 py-0.5 rounded text-[10px] font-bold bg-white/8
          text-white/60 border border-white/10 tracking-wider">
          {_setupTypeLabel(setupType)}
        </span>
        <span className="text-[10px] text-white/35">
          {candlesElapsed} candles
        </span>
      </div>

      {/* Live P&L */}
      <div className="flex items-center gap-2">
        <span className="text-[10px] text-white/40">Live P&amp;L est.</span>
        <span className={`text-sm font-bold tabular-nums ${
          pnlPct == null ? 'text-white/30' :
          pnlPct >= 0 ? 'text-emerald-400' : 'text-rose-400'
        }`}>
          {pnlPct != null ? _fmtPct(pnlPct) : '—'}
        </span>
      </div>

      {/* Factor live dots */}
      <FactorDots factors={factors} live />

      {/* Brain base rate */}
      {baseRate && <BaseRateBadge rate={baseRate} />}
    </div>
  );
}

// ── RESOLVED row card ─────────────────────────────────────────────────────────

interface ResolvedCardItemProps {
  card: ResolvedCard;
}

function ResolvedCardItem({ card }: ResolvedCardItemProps) {
  const { signal, result, pnlPct, durationCandles, exitReason } = card;

  const resultStyles: Record<string, string> = {
    WIN:     'text-emerald-400 bg-emerald-500/10 border-emerald-500/25',
    LOSS:    'text-rose-400 bg-rose-500/10 border-rose-500/25',
    SCRATCH: 'text-white/50 bg-white/5 border-white/15',
  };

  return (
    <div className="flex items-center gap-3 px-3 py-2 rounded-lg border border-white/8
      bg-white/[0.025] hover:border-white/15 transition-colors duration-200 min-w-0">

      {/* Result badge */}
      <span className={`flex-shrink-0 px-2 py-0.5 rounded border text-[10px] font-bold
        tracking-wider ${resultStyles[result]}`}>
        {result}
      </span>

      {/* Ticker + setup */}
      <div className="flex items-center gap-1 min-w-0 flex-shrink-0">
        <span className="text-xs font-bold text-white">{signal.ticker}</span>
        <CashSettledTag ticker={signal.ticker} />
      </div>

      {/* P&L */}
      <span className={`text-xs font-semibold tabular-nums flex-shrink-0 ${
        pnlPct > 0 ? 'text-emerald-400' : pnlPct < 0 ? 'text-rose-400' : 'text-white/40'
      }`}>
        {_fmtPct(pnlPct)}
      </span>

      {/* Duration */}
      <span className="text-[10px] text-white/35 flex-shrink-0">
        {durationCandles}c
      </span>

      {/* Exit reason */}
      <span className="text-[10px] text-white/35 truncate min-w-0">{exitReason}</span>
    </div>
  );
}

// ── Column wrapper ─────────────────────────────────────────────────────────────

interface ColumnProps {
  title:    string;
  count:    number;
  accent:   string;  // Tailwind color class for the header dot
  children: React.ReactNode;
  isLoading?: boolean;
  errorMsg?:  string;
}

function Column({ title, count, accent, children, isLoading, errorMsg }: ColumnProps) {
  return (
    <div className="flex-1 flex flex-col min-w-0">
      {/* Column header */}
      <div className="flex items-center gap-2 mb-3">
        <span className={`w-2 h-2 rounded-full ${accent}`} />
        <span className="text-xs font-bold tracking-widest text-white/70 uppercase">
          {title}
        </span>
        <span className="text-xs text-white/30 tabular-nums">({count})</span>
      </div>

      {/* Content */}
      <div className="flex flex-col gap-2 overflow-y-auto flex-1 pr-0.5 scanner-col-scroll">
        {isLoading && (
          <div className="flex flex-col gap-2">
            {[0, 1].map(i => (
              <div key={i} className="h-28 rounded-lg bg-white/5 border border-white/8 animate-pulse" />
            ))}
          </div>
        )}
        {errorMsg && <ErrorBanner reason={errorMsg} />}
        {!isLoading && !errorMsg && count === 0 && (
          <div className="text-[11px] text-white/20 italic pt-2">No signals</div>
        )}
        {!isLoading && !errorMsg && children}
      </div>
    </div>
  );
}

// ── Main cockpit ───────────────────────────────────────────────────────────────

export default function ScannerCockpit() {
  const navigate = useNavigate();

  // ── State ────────────────────────────────────────────────────────────────────
  const [cards, setCards]                  = useState<Map<string, LiveSignalCard>>(new Map());
  const [resolved, setResolved]            = useState<ResolvedCard[]>([]);
  const [watching, setWatching]            = useState<Set<string>>(new Set());
  const [dirStates, setDirStates]          = useState<Map<string, DirectionState>>(new Map());
  const [brainReady, setBrainReady]        = useState(false);
  const [engineError, setEngineError]      = useState<string | null>(null);
  const [initialising, setInitialising]    = useState(true);
  const tickInterval                       = useRef<ReturnType<typeof setInterval> | null>(null);

  // ── Refresh candle counts + active state for all live cards ─────────────────
  const refreshCards = useCallback(() => {
    setCards(prev => {
      const next = new Map(prev);
      const now  = Date.now();

      for (const [id, card] of next) {
        const candles      = _candlesElapsed(card.signal);
        const activeState  = _inferActiveState(card.signal, candles);
        const baseRate     = _lookupBaseRate(card.signal);
        const confirmedCount = _countConfirmed(card.factors);

        // Graduate TRIGGERING → ACTIVE if TTL exceeded
        let phase = card.phase;
        if (phase === 'TRIGGERING') {
          const ageS = (now - card.addedAt) / 1000;
          if (ageS > TRIGGERING_TTL_S) phase = 'ACTIVE';
        }

        // Graduate ACTIVE → RESOLVED if max candles exceeded
        if (phase === 'ACTIVE' && candles >= ACTIVE_MAX_CANDLES) {
          const price  = _currentPrice(card.signal.ticker) ?? card.signal.triggerPrice;
          const isCall = card.signal.type === 'ENTER' || card.signal.type === 'BREAKOUT' || card.signal.type === 'RIP';
          const rawPnl = ((price - card.signal.triggerPrice) / card.signal.triggerPrice) * 100;
          const pnlPct = isCall ? rawPnl : -rawPnl;
          const result: ResolvedCard['result'] = pnlPct > 0.5 ? 'WIN' : pnlPct < -0.5 ? 'LOSS' : 'SCRATCH';

          setResolved(r => [
            {
              signal:           card.signal,
              result,
              pnlPct,
              durationCandles:  candles,
              exitReason:       activeState === 'FLIP_DETECTED' ? 'Flip detected' : 'Max candles',
            },
            ...r.slice(0, 29), // keep today's last 30
          ]);
          next.delete(id);
          continue;
        }

        next.set(id, {
          ...card,
          phase,
          candlesElapsed: candles,
          activeState,
          baseRate,
          confirmedCount: confirmedCount,
        });
      }

      return next;
    });
  }, []);

  // ── Incoming signal handler ──────────────────────────────────────────────────
  const onSignal = useCallback((signal: Signal) => {
    // Never surface context-only tickers
    if (CONTEXT_ONLY_TICKERS.has(signal.ticker)) return;

    const factors        = _buildFactorStatus(signal);
    const confirmedCount = _countConfirmed(factors);
    const setupType      = _inferSetupType(signal);
    const candles        = _candlesElapsed(signal);
    const baseRate       = _lookupBaseRate(signal);

    // Classify phase from confirmed count
    if (confirmedCount < FORMING_MIN) return; // below threshold, ignore
    const phase: SignalPhase =
      confirmedCount >= TRIGGERING_THRESHOLD ? 'TRIGGERING' : 'FORMING';

    const card: LiveSignalCard = {
      signal,
      phase,
      setupType,
      factors,
      confirmedCount,
      candlesElapsed:  candles,
      activeState:     'ACTIVE',
      baseRate,
      entryBarIndex:   0,
      userTracked:     false,
      addedAt:         Date.now(),
    } as LiveSignalCard;

    setCards(prev => new Map(prev).set(signal.id, card));
    setEngineError(null);
  }, []);

  // ── "I'm In" handler ─────────────────────────────────────────────────────────
  const handleImIn = useCallback(async (card: LiveSignalCard) => {
    const { signal } = card;

    // Mark as user-tracked and move to ACTIVE
    setCards(prev => {
      const next = new Map(prev);
      const existing = next.get(signal.id);
      if (existing) {
        next.set(signal.id, { ...existing, phase: 'ACTIVE', userTracked: true });
      }
      return next;
    });

    // Log to signalLedger DB (best-effort — failure must not block navigation)
    try {
      await supabase.from('signals').upsert({
        id:          signal.id,
        ticker:      signal.ticker,
        direction:   (signal.type === 'ENTER' || signal.type === 'BREAKOUT' || signal.type === 'RIP') ? 'call' : 'put',
        signal_type: signal.type,
        conviction:  signal.confidence,
        entry_price: signal.triggerPrice,
        entry_tct:   signal.firedAtCT,
        entry_utc:   signal.firedAt,
        status:      'pending',
      }, { onConflict: 'id', ignoreDuplicates: true });
    } catch (e) {
      console.warn('[ScannerCockpit] I\'m In DB log failed (non-fatal):', e);
    }

    navigate(`/zerod/${signal.ticker}`);
  }, [navigate]);

  // ── WATCH handler ────────────────────────────────────────────────────────────
  const handleWatch = useCallback((id: string) => {
    setWatching(prev => {
      const next = new Set(prev);
      next.add(id);
      return next;
    });
  }, []);

  // ── Mount / unmount ──────────────────────────────────────────────────────────
  useEffect(() => {
    // Initialise confluenceEngine
    confluenceEngine.init();
    for (const ticker of FEED_TICKERS) {
      confluenceEngine.watchTicker(ticker);
    }

    // Subscribe to signal stream
    const unsubSignal = confluenceEngine.onSignal(onSignal);

    // Subscribe to directionState
    const unsubDir = subscribeDirection((ticker, state) => {
      setDirStates(prev => new Map(prev).set(ticker, state));
    });

    // Seed from existing direction states
    setDirStates(getAllDirectionStates());

    // Subscribe to brainStore
    const unsubBrain = brainStore.subscribe(() => {
      setBrainReady(brainStore.getAllBaseRates().status === 'ready');
    });
    brainStore.refreshBrainStore().catch(console.error);

    setInitialising(false);

    // Per-candle refresh tick (every 30 s — matches 5m candle mid-point updates)
    tickInterval.current = setInterval(refreshCards, 30_000);

    return () => {
      unsubSignal();
      unsubDir();
      unsubBrain();
      if (tickInterval.current) clearInterval(tickInterval.current);
    };
  }, [onSignal, refreshCards]);

  // ── Derive columns from cards ─────────────────────────────────────────────────
  const formingCards    = Array.from(cards.values()).filter(c => c.phase === 'FORMING');
  const triggeringCards = Array.from(cards.values()).filter(c => c.phase === 'TRIGGERING');
  const activeCards     = Array.from(cards.values()).filter(c => c.phase === 'ACTIVE');

  // Sort — TRIGGERING by confidence desc, others by addedAt desc
  triggeringCards.sort((a, b) => b.signal.confidence - a.signal.confidence);
  formingCards.sort((a, b) => b.confirmedCount - a.confirmedCount || b.addedAt - a.addedAt);
  activeCards.sort((a, b) => b.addedAt - a.addedAt);

  // ── Render ───────────────────────────────────────────────────────────────────
  return (
    <section id="scanner" className="min-h-screen bg-[#0a0b0e] text-white flex flex-col">

      {/* ── Top bar ─────────────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between px-5 py-3
        border-b border-white/8 bg-[#0c0d10] sticky top-0 z-20">
        <div className="flex items-center gap-3">
          <span className="text-xs font-bold tracking-[0.2em] text-white/50 uppercase">
            Scanner
          </span>
          <span className="w-px h-3 bg-white/15" />
          <DirectionBadges dirStates={dirStates} />
        </div>
        {!brainReady && (
          <span className="text-[10px] text-white/25 italic">Brain loading…</span>
        )}
      </div>

      {/* ── Three-column body ────────────────────────────────────────────────── */}
      <div className="flex-1 flex gap-4 px-5 pt-4 pb-4 min-h-0 overflow-hidden">
        {initialising ? (
          <LoadingSkeleton />
        ) : engineError ? (
          <div className="flex-1">
            <ErrorBanner reason={engineError} />
          </div>
        ) : (
          <>
            {/* FORMING */}
            <Column
              title="FORMING"
              count={formingCards.length}
              accent="bg-indigo-400"
            >
              {formingCards.map(card => (
                <FormingCard
                  key={card.signal.id}
                  card={card}
                  onWatch={handleWatch}
                  watching={watching}
                />
              ))}
            </Column>

            {/* TRIGGERING */}
            <Column
              title="TRIGGERING"
              count={triggeringCards.length}
              accent="bg-amber-400"
            >
              {triggeringCards.map(card => (
                <TriggeringCard
                  key={card.signal.id}
                  card={card}
                  onImIn={handleImIn}
                />
              ))}
            </Column>

            {/* ACTIVE */}
            <Column
              title="ACTIVE"
              count={activeCards.length}
              accent="bg-emerald-400"
            >
              {activeCards.map(card => (
                <ActiveCard
                  key={card.signal.id}
                  card={card}
                />
              ))}
            </Column>
          </>
        )}
      </div>

      {/* ── RESOLVED row ──────────────────────────────────────────────────────── */}
      {resolved.length > 0 && (
        <div className="border-t border-white/8 bg-[#0c0d10] px-5 py-3 flex-shrink-0">
          <div className="flex items-center gap-2 mb-2">
            <span className="w-2 h-2 rounded-full bg-white/30" />
            <span className="text-xs font-bold tracking-widest text-white/40 uppercase">
              Resolved Today
            </span>
            <span className="text-xs text-white/25 tabular-nums">({resolved.length})</span>
          </div>
          <div className="flex gap-2 overflow-x-auto pb-1 resolved-scroll">
            {resolved.map((card, i) => (
              <div key={`${card.signal.id}_${i}`} className="flex-shrink-0 w-64">
                <ResolvedCardItem card={card} />
              </div>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}
