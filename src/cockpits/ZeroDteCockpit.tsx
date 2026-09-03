/**
 * Layer 4 — ZeroDteCockpit (Full Expansion)
 *
 * Live trading floor: all 23 FEED_TICKERS ranked simultaneously.
 * Entry from BestContractsCockpit via /zerod/:ticker or browsed standalone at /zerod.
 *
 * Sections:
 *   1. Global sticky header — TRADE/REDUCE/STAND DOWN verdict, SPY/QQQ/IWM badges, VIX, candles, halt strip
 *   2. Active position widgets — pinned compact 64px, tap to expand (post-entry view)
 *   3. Opportunity stack — all tickers ranked by 8-criterion score, NO_SIGNAL at bottom
 *   4. Inline expanded pre-entry card — 8-factor check, CVD, contract, entry trigger, I'm In
 *   5. Inline expanded post-entry card — conviction sparkline, exhaustion, pullback, P&L, snapshots, exit
 *   6. TradingView widget bottom sheet — 65% height, dark, 5m
 *
 * Rules:
 *   - Zero outbound calls — all data from local stores
 *   - All Result<T> states handled
 *   - CONTEXT_ONLY_TICKERS never shown
 *   - CASH_SETTLED_TICKERS always labeled
 *   - Candle-based timing, never wall-clock
 *   - All times via toCentralTime()
 *   - Max 5 active position widgets
 *   - 30s snapshots start on I'm In, stop on exit
 *   - TradingView in bottom sheet only
 */

import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import { useNavigate, useParams } from 'react-router-dom';

import * as barsStore         from '../stores/barsStore';
import * as marketStore       from '../stores/marketStore';
import * as cvdStore          from '../stores/cvdStore';
import * as brainStore        from '../ledger/brainStore';
import * as luldStore         from '../stores/luldStore';
import * as fundamentalsStore from '../stores/fundamentalsStore';
import { supabase }           from '../lib/supabase';
import { toCentralTime }      from '../lib/time';
import {
  FEED_TICKERS,
  CONTEXT_ONLY_TICKERS,
  CASH_SETTLED_TICKERS,
  TICKER_BETA_TABLE,
  getDirectionState,
  subscribe as subscribeDirection,
  computeTradeType,
}                             from '../state/directionState';
import type { DirectionState, SessionBias, TradeType } from '../state/directionState';
import type { Bar }           from '../stores/types';
import type { CvdState }      from '../stores/cvdStore';
import type { MarketContext } from '../stores/marketStore';
import { timeOfDayBucket, vixBucket } from '../ledger/brainStore';
import type { SetupFingerprint, BaseRate } from '../ledger/brainStore';
import { computeEma }         from '../engines/confluenceEngine';
import { HeliosChart }        from '../components/HeliosChart';

// ── Constants ─────────────────────────────────────────────────────────────────

const MAX_ACTIVE       = 5;
const SNAPSHOT_MS      = 30_000;

const SELECTABLE = FEED_TICKERS.filter(t => !CONTEXT_ONLY_TICKERS.has(t));

// Scoring weights — mirror BestContractsCockpit exactly
const W = { c1: 128, c2: 64, c3: 32, c4: 16, c5: 8, c6: 4, c7: 2, c8: 1 };

// ── Types ──────────────────────────────────────────────────────────────────────

type MonitorPhase = 'watching' | 'mae-guard' | 'continuation' | 'pullback' | 'exited';
type RowPhase = 'no-signal' | 'forming' | 'triggering' | 'consolidating' | 'active';
type ExhaustionLevel = 0 | 1 | 2 | 3 | 4;
type PullbackClass = 'normal' | 'concerning' | 'reversal';
type ConsolidationState = 'unclear' | 'consolidating' | 'continuation' | 'exit-signal';
type ExitResult = 'win' | 'loss' | 'scratch';
type Verdict = 'TRADE' | 'REDUCE' | 'STAND DOWN';

interface ExtFingerprint extends SetupFingerprint {
  tradeType: TradeType;
}

interface ActiveMonitor {
  signalId:     string;
  ticker:       string;
  direction:    'call' | 'put';
  entryPrice:   number;
  entryCandle:  number;
  entryPremium: number;
  entryDelta:   number;
  entryGamma:   number;
  entryTheta:   number;
  stopLevel:    number | null;
  targetLevel:  number | null;
  tradeType:    TradeType;
  // live
  currentPrice:  number;
  maePrice:      number;
  mfePrice:      number;
  maePct:        number;
  mfePct:        number;
  candleCount:   number;
  lastCandle:    number;
  phase:         MonitorPhase;
  // conviction history (last 5 readings)
  convictionHistory: number[];
  currentConviction: number;
}

interface StackRow {
  ticker:       string;
  direction:    'call' | 'put';
  score:        number;
  rowPhase:     RowPhase;
  c1:  boolean; c2: boolean; c3: boolean; c4: boolean;
  c5:  boolean; c6: boolean; c7: boolean; c8: boolean;
  price:        number;
  callWall:     number;
  putWall:      number;
  flipLevel:    number;
  upTarget:     number;
  downTarget:   number;
  cashSettled:  boolean;
  baseRate:     BaseRate | null;
  tradeType:    TradeType;
  entryTrigger: string;
  invalidation: string;
  hasNews:      boolean;
  midPremium:   number;
  delta:        number;
  gamma:        number;
  theta:        number;
  spread:       number;
  ivRank:       number | null;
  leaderCvdOk:  boolean;
  tickerCvdOk:  boolean;
  isHalted:     boolean;
}

// ── Pure helpers ───────────────────────────────────────────────────────────────

function convictionMultiplier(t: TradeType): number {
  if (t === 'continuation')   return 1.05;
  if (t === 'counter_session') return 0.85;
  return 1.0;
}

function classifyPhase(
  entryPrice: number,
  maePrice: number,
  mfePrice: number,
  currentPrice: number,
  candleCount: number,
  direction: 'call' | 'put',
): MonitorPhase {
  const adv = direction === 'call'
    ? (entryPrice - currentPrice) / entryPrice
    : (currentPrice - entryPrice) / entryPrice;
  const fav = direction === 'call'
    ? (currentPrice - entryPrice) / entryPrice
    : (entryPrice - currentPrice) / entryPrice;
  const mfePct = direction === 'call'
    ? (mfePrice - entryPrice) / entryPrice
    : (entryPrice - mfePrice) / entryPrice;

  if (adv > 0.01) return 'mae-guard';
  if (fav > 0.015 && candleCount >= 2) return 'continuation';
  if (mfePct > 0.01 && fav < mfePct * 0.5) return 'pullback';
  void maePrice;
  return 'watching';
}

function candlesSince(startCT: number, nowCT: number): number {
  return Math.max(0, Math.floor((nowCT - startCT) / (5 * 60 * 1000)));
}

function directionFromBias(bias: SessionBias, play: string): 'call' | 'put' {
  if (play === 'calls') return 'call';
  if (play === 'puts')  return 'put';
  if (bias === 'bullish') return 'call';
  return 'put';
}

function computeExhaustion(bars: Bar[], direction: 'call' | 'put', cvd: CvdState | null): ExhaustionLevel {
  if (bars.length < 3) return 0;
  const last3 = bars.slice(-3);
  let count = 0;

  // 1. Body compression
  const bodies = last3.map(b => Math.abs(b.close - b.open));
  if (bodies[2] < bodies[0] * 0.6) count++;

  // 2. Rejection wick
  const last = last3[2];
  const wick = direction === 'call'
    ? last.high - Math.max(last.open, last.close)
    : Math.min(last.open, last.close) - last.low;
  const body = Math.abs(last.close - last.open) || 0.001;
  if (wick / body > 1.5) count++;

  // 3. Volume declining
  const vols = last3.map(b => b.volume ?? 0);
  if (vols[2] < vols[0] * 0.7) count++;

  // 4. CVD slope flat
  if (cvd && Math.abs(cvd.callPct - 50) < 5) count++;

  return Math.min(4, count) as ExhaustionLevel;
}

function classifyPullback(
  bars: Bar[],
  direction: 'call' | 'put',
  cvd: CvdState | null,
): PullbackClass {
  if (bars.length < 3) return 'normal';
  const closes = bars.map(b => b.close);
  const ema21  = computeEma(closes, 21);
  const last   = bars[bars.length - 1];
  const vol    = last.volume ?? 0;
  const avgVol = bars.slice(-5).reduce((s, b) => s + (b.volume ?? 0), 0) / 5;

  const belowEma21 = direction === 'call'
    ? last.close < ema21
    : last.close > ema21;
  const highVol = vol > avgVol * 1.3;

  if (!belowEma21) {
    // Held EMA + CVD still confirms = normal (do not exit)
    const cvdOk = cvd
      ? (direction === 'call' ? cvd.callPct > 55 : cvd.putPct > 55)
      : true;
    return cvdOk ? 'normal' : 'concerning';
  }

  if (belowEma21 && highVol) return 'concerning';

  // CVD crossed and held 2 candles
  if (cvd) {
    const crossed = direction === 'call'
      ? cvd.classification === 'bearish'
      : cvd.classification === 'bullish';
    if (crossed && bars.length >= 2) return 'reversal';
  }

  return 'concerning';
}

function classifyConsolidation(
  bars: Bar[],
  direction: 'call' | 'put',
  cvd: CvdState | null,
): ConsolidationState {
  if (bars.length < 5) return 'unclear';
  const last5 = bars.slice(-5);
  const closes = last5.map(b => b.close);
  const highs  = last5.map(b => b.high);
  const lows   = last5.map(b => b.low);
  const vols   = last5.map(b => b.volume ?? 0);

  const bodies = last5.map(b => Math.abs(b.close - b.open));
  const bodyComp = bodies[4] < bodies[0] * 0.7;

  const zoneHigh = Math.max(...highs.slice(0, 4));
  const zoneLow  = Math.min(...lows.slice(0, 4));
  const wickOverlap = last5.slice(1).every(b => b.low <= zoneHigh && b.high >= zoneLow);

  const avgVol = vols.slice(0, 4).reduce((s, v) => s + v, 0) / 4;
  const volDec  = vols[4] < avgVol * 0.8;

  const cvdFlat = cvd ? Math.abs(cvd.callPct - 50) < 8 : false;

  const lastClose = closes[4];
  const noBreak   = lastClose <= zoneHigh && lastClose >= zoneLow;

  const conditions = [bodyComp, wickOverlap, volDec, cvdFlat, noBreak];
  const met = conditions.filter(Boolean).length;

  if (met >= 4) {
    // Check for break
    const lastBar = last5[4];
    if (direction === 'call' && lastBar.close > zoneHigh) return 'continuation';
    if (direction === 'put'  && lastBar.close < zoneLow)  return 'continuation';
    const breakAgainst = direction === 'call'
      ? lastBar.close < zoneLow
      : lastBar.close > zoneHigh;
    if (breakAgainst) return 'exit-signal';
    return 'consolidating';
  }
  return 'unclear';
}

function computeConviction(
  bars: Bar[],
  cvd: CvdState | null,
  ctx: MarketContext | null,
  direction: 'call' | 'put',
  baseConviction: number,
  tradeType: TradeType,
): number {
  let score = baseConviction;
  if (!bars.length || !cvd || !ctx) return Math.round(score * convictionMultiplier(tradeType));

  const last = bars[bars.length - 1];
  const closes = bars.map(b => b.close);
  const ema8  = computeEma(closes, 8);
  const ema21 = computeEma(closes, 21);
  const vwap  = ctx.walls?.callWall ?? last.close; // approximation

  // CVD alignment
  const cvdAligned = direction === 'call'
    ? cvd.classification === 'bullish' || cvd.callPct > 55
    : cvd.classification === 'bearish' || cvd.putPct > 55;
  if (cvdAligned)   score += 5;
  else              score -= 5;

  // EMA stack
  if (direction === 'call' && ema8 > ema21 && last.close > ema8) score += 5;
  if (direction === 'put'  && ema8 < ema21 && last.close < ema8) score += 5;

  // VWAP
  if (direction === 'call' && last.close > vwap) score += 3;
  if (direction === 'put'  && last.close < vwap) score += 3;

  return Math.min(100, Math.max(0, Math.round(score * convictionMultiplier(tradeType))));
}

function globalVerdict(
  spyState: DirectionState | null,
  qqqState: DirectionState | null,
  activeCount: number,
): Verdict {
  if (activeCount >= MAX_ACTIVE) return 'STAND DOWN';
  if (!spyState || !qqqState) return 'STAND DOWN';
  const bullCount = [spyState, qqqState].filter(s => s.sessionBias === 'bullish').length;
  const bearCount = [spyState, qqqState].filter(s => s.sessionBias === 'bearish').length;
  if (bullCount + bearCount === 0) return 'STAND DOWN';
  if (bullCount === 2 || bearCount === 2) return 'TRADE';
  return 'REDUCE';
}

function entryTriggerText(row: StackRow): string {
  if (row.tradeType === 'counter_session') {
    return `Enter on VWAP reclaim ${row.direction === 'call' ? 'above' : 'below'} with CVD confirming`;
  }
  if (row.tradeType === 'continuation') {
    return `Continuation — enter on next candle open above prior high`;
  }
  const wall = row.direction === 'call' ? row.callWall : row.putWall;
  return `GEX wall at ${wall.toFixed(2)} — enter on close ${row.direction === 'call' ? 'above' : 'below'} flip level`;
}


function buildStackRow(ticker: string): StackRow | null {
  const dir = getDirectionState(ticker);
  const barsR  = barsStore.getResult(ticker);
  const ctxR   = marketStore.getResult(ticker);
  const cvdR   = cvdStore.getResult(ticker);
  const luldR  = luldStore.getResult(ticker);
  const fundR  = fundamentalsStore.getResult(ticker);

  const bars = barsR.status  === 'ready' ? barsR.data  : null;
  const ctx  = ctxR.status   === 'ready' ? ctxR.data   : null;
  const cvd  = cvdR.status   === 'ready' ? cvdR.data   : null;
  const luld = luldR.status  === 'ready' ? luldR.data  : null;
  const fund = fundR.status  === 'ready' ? fundR.data  : null;

  const direction = dir
    ? directionFromBias(dir.sessionBias, dir.playDirection)
    : 'call';

  const price       = bars?.length ? bars[bars.length - 1].close : 0;
  const callWall    = ctx?.walls.callWall  ?? 0;
  const putWall     = ctx?.walls.putWall   ?? 0;
  const flipLevel   = ctx?.flipLevel       ?? 0;
  const upTarget    = ctx?.upTarget        ?? 0;
  const downTarget  = ctx?.downTarget      ?? 0;
  const gexRegime   = ctx?.gexRegime       ?? 'neutral';
  const cashSettled = CASH_SETTLED_TICKERS.has(ticker);
  const isHalted    = luld?.isCurrentlyHalted ?? false;

  // Nearest ATM chain row
  let midPremium = 0, delta = 0, gamma = 0, theta = 0, spread = 0, ivRank: number | null = null;
  if (ctx?.chain && bars?.length) {
    const sorted = [...ctx.chain].sort((a, b) =>
      Math.abs(a.strike - price) - Math.abs(b.strike - price),
    );
    const atm = sorted[0];
    if (atm) {
      const bid  = direction === 'call' ? atm.callBid   : atm.putBid;
      const ask  = direction === 'call' ? atm.callAsk   : atm.putAsk;
      midPremium = (bid + ask) / 2;
      spread     = ask - bid;
      delta      = direction === 'call' ? atm.callDelta : atm.putDelta;
      gamma      = direction === 'call' ? atm.callGamma : atm.putGamma;
      theta      = direction === 'call' ? atm.callTheta : atm.putTheta;
      ivRank     = atm.callIV > 0 ? atm.callIV / 100 : null;
    }
  }

  const spreadPct = midPremium > 0 ? spread / midPremium : 0;

  // CVD criterion
  const leaderSym = TICKER_BETA_TABLE[ticker]?.leader ?? 'SPY';
  const leaderCvd = cvdStore.getResult(leaderSym);
  const leaderCvdOk = leaderCvd.status === 'ready'
    ? (direction === 'call'
        ? leaderCvd.data.classification === 'bullish'
        : leaderCvd.data.classification === 'bearish')
    : false;
  const tickerCvdOk = cvd
    ? (direction === 'call'
        ? cvd.classification === 'bullish' || cvd.classification === 'neutral'
        : cvd.classification === 'bearish' || cvd.classification === 'neutral')
    : false;

  // Earnings check
  const hasNews = !!(fund?.recentDisclosures.some(d =>
    d.category === 'earnings' && Date.now() - d.filedAt < 48 * 3600_000,
  ));

  // Fingerprint for brain
  const nowCT  = toCentralTime(Date.now());
  const tradeType = computeTradeType(direction, dir?.sessionBias ?? 'neutral', null, null);
  const vixR = barsStore.getResult('I:VIX');
  const vixClose = vixR.status === 'ready' && vixR.data.length > 0
    ? vixR.data[vixR.data.length - 1].close
    : null;

  const fingerprint: ExtFingerprint = {
    ticker,
    direction,
    gexRegime,
    vixBucket: vixClose !== null ? vixBucket(vixClose) : '<15',
    timeOfDay: timeOfDayBucket(nowCT.ctMs),
    tradeType,
  };

  const brainR = brainStore.getBaseRate(fingerprint);
  const baseRate = brainR.status === 'ready' ? brainR.data : null;

  // 8 criteria
  const c1 = !!(baseRate?.isStatisticallyValid && baseRate.n >= 30 && baseRate.winRate >= 0.6);
  const c2 = !isHalted;
  const c3 = leaderCvdOk && tickerCvdOk;
  const c4 = !!(dir && (dir.playDirection === 'calls' || dir.playDirection === 'puts'));
  const c5 = spreadPct < 0.08 || midPremium === 0;
  const c6 = (() => {
    if (!ctx || !bars?.length) return true;
    const wall = direction === 'call' ? callWall : putWall;
    return midPremium < Math.abs(wall - price);
  })();
  const c7 = ivRank === null || ivRank < 0.75;
  const c8 = !hasNews;

  const score =
    (c1 ? W.c1 : 0) + (c2 ? W.c2 : 0) + (c3 ? W.c3 : 0) + (c4 ? W.c4 : 0) +
    (c5 ? W.c5 : 0) + (c6 ? W.c6 : 0) + (c7 ? W.c7 : 0) + (c8 ? W.c8 : 0);

  let rowPhase: RowPhase = 'no-signal';
  if (!dir || dir.playDirection === 'none') {
    rowPhase = 'no-signal';
  } else if (dir.playDirection === 'consolidating') {
    rowPhase = 'consolidating';
  } else if (score >= W.c1 + W.c2) {
    rowPhase = 'triggering';
  } else if (score > 0) {
    rowPhase = 'forming';
  }

  const row: StackRow = {
    ticker, direction, score, rowPhase, cashSettled,
    c1, c2, c3, c4, c5, c6, c7, c8,
    price, callWall, putWall, flipLevel, upTarget, downTarget,
    baseRate, tradeType, midPremium, delta, gamma, theta, spread, ivRank,
    spreadPct, leaderCvdOk, tickerCvdOk, isHalted, hasNews,
    entryTrigger: entryTriggerText({ ticker, direction, tradeType, callWall, putWall, flipLevel, upTarget, downTarget } as StackRow),
    invalidation: direction === 'call'
      ? `Close below ${flipLevel.toFixed(2)} (flip level)`
      : `Close above ${flipLevel.toFixed(2)} (flip level)`,
  } as StackRow;

  return row;
}

// ── GlobalHeader ──────────────────────────────────────────────────────────────

function GlobalHeader({
  activeCount,
}: {
  activeCount: number;
}) {
  const [spyState, setSpyState] = useState<DirectionState | null>(() => getDirectionState('SPY'));
  const [qqqState, setQqqState] = useState<DirectionState | null>(() => getDirectionState('QQQ'));
  const [iwmState, setIwmState] = useState<DirectionState | null>(() => getDirectionState('IWM'));
  const [haltedTickers, setHaltedTickers] = useState<string[]>([]);

  const _vixClose = () => {
    const r = barsStore.getResult('I:VIX');
    return r.status === 'ready' && r.data.length > 0 ? r.data[r.data.length - 1].close : null;
  };
  const [vixPrice, setVixPrice] = useState<number | null>(_vixClose);

  useEffect(() => {
    return barsStore.subscribe(() => setVixPrice(_vixClose()));
  }, []);

  useEffect(() => {
    return subscribeDirection((ticker, state) => {
      if (ticker === 'SPY') setSpyState(state);
      if (ticker === 'QQQ') setQqqState(state);
      if (ticker === 'IWM') setIwmState(state);
    });
  }, []);

  useEffect(() => {
    const check = () => {
      const halted = SELECTABLE.filter(t => luldStore.isHalted(t) === true);
      setHaltedTickers(halted);
    };
    check();
    const id = setInterval(check, 5000);
    return () => clearInterval(id);
  }, []);

  // Candles remaining in session
  const candlesRemaining = (() => {
    const ct = toCentralTime(Date.now());
    const closeMin = 16 * 60;
    const nowMin   = ct.hour * 60 + ct.minute;
    const rem = Math.max(0, closeMin - nowMin);
    return Math.floor(rem / 5);
  })();

  const verdict = globalVerdict(spyState, qqqState, activeCount);
  const verdictCfg: Record<Verdict, { bg: string; text: string; label: string }> = {
    'TRADE':      { bg: 'bg-col-g',    text: 'text-void', label: 'TRADE' },
    'REDUCE':     { bg: 'bg-amb',      text: 'text-void', label: 'REDUCE' },
    'STAND DOWN': { bg: 'bg-col-r',    text: 'text-void', label: 'STAND DOWN' },
  };
  const vc = verdictCfg[verdict];

  const vixRegime = vixPrice === null       ? null
    : vixPrice > 35                         ? 'EXTREME FEAR'
    : vixPrice > 28                         ? 'FEAR'
    : vixPrice >= 16                        ? 'NORMAL'
    :                                         'COMPLACENT';
  const vixPillCfg =
    vixRegime === 'EXTREME FEAR' ? { bg: 'bg-col-r',     text: 'text-void',    pulse: 'animate-pulse' } :
    vixRegime === 'FEAR'         ? { bg: 'bg-col-r/80',  text: 'text-void',    pulse: '' } :
    vixRegime === 'NORMAL'       ? { bg: 'bg-white/10',  text: 'text-white/70', pulse: '' } :
    vixRegime === 'COMPLACENT'   ? { bg: 'bg-amb',       text: 'text-void',    pulse: '' } :
                                   { bg: 'bg-white/5',   text: 'text-dim', pulse: '' };

  return (
    <div className="sticky top-0 z-40 bg-[#0a0a0f]/95 backdrop-blur border-b border-white/8">
      {/* Halt strip */}
      {haltedTickers.length > 0 && (
        <div className="bg-col-r text-void text-[10px] font-bold px-4 py-1 flex items-center gap-2">
          <span className="animate-pulse">⚠ HALTED:</span>
          <span>{haltedTickers.join(' · ')}</span>
        </div>
      )}

      <div className="flex items-center gap-2 px-3 py-2 min-w-0">
        {/* Verdict badge */}
        <div className={`${vc.bg} ${vc.text} px-2.5 py-1 rounded font-black text-[11px] tracking-wider shrink-0`}>
          {vc.label}
        </div>

        {/* Index badges — hidden on very narrow screens via min-w-0 */}
        <div className="flex gap-1 shrink-0">
          {([['SPY', spyState], ['QQQ', qqqState], ['IWM', iwmState]] as [string, DirectionState | null][]).map(
            ([sym, state]) => (
              <IndexMini key={sym} sym={sym} state={state} />
            ),
          )}
        </div>

        <div className="flex-1 min-w-0" />

        {/* VIX regime pill */}
        {vixPrice !== null && vixRegime !== null && (
          <div className={`px-1.5 py-0.5 rounded text-[9px] font-bold shrink-0 ${vixPillCfg.bg} ${vixPillCfg.text} ${vixPillCfg.pulse}`}>
            VIX {vixPrice.toFixed(0)} {vixRegime}
          </div>
        )}

        {/* Candles remaining */}
        <div className="flex items-center gap-0.5 text-[10px] text-white/40 shrink-0">
          <span className="tabular-nums font-bold text-white/60">{candlesRemaining}</span>
          <span>c</span>
        </div>

        {/* Active count */}
        <div className={`text-[10px] font-bold tabular-nums shrink-0 ${activeCount >= MAX_ACTIVE ? 'text-col-r' : 'text-white/40'}`}>
          {activeCount}/{MAX_ACTIVE}
        </div>
      </div>
    </div>
  );
}

function IndexMini({ sym, state }: { sym: string; state: DirectionState | null }) {
  const bias = state?.sessionBias ?? 'neutral';
  const play = state?.playDirection ?? 'none';
  const dotColor =
    bias === 'bullish' ? 'bg-col-g' :
    bias === 'bearish' ? 'bg-col-r' :
    play === 'consolidating' ? 'bg-amb' :
    'bg-white/20';
  return (
    <div className="flex items-center gap-1 px-1.5 py-0.5 rounded bg-white/4 border border-white/8 shrink-0">
      <div className={`w-1.5 h-1.5 rounded-full ${dotColor}`} />
      <span className="text-[9px] text-white/50 font-bold">{sym}</span>
    </div>
  );
}

// ── Active Position Widget ────────────────────────────────────────────────────

function ActiveWidget({
  monitor,
  onExit,
  onOpenTV,
}: {
  monitor:    ActiveMonitor;
  onExit:     (signalId: string, exitPrice: number, result: ExitResult, notes: string) => void;
  onOpenTV:   (ticker: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [exitPrice, setExitPrice] = useState('');
  const [exitResult, setExitResult] = useState<ExitResult>('win');
  const [exitNotes, setExitNotes] = useState('');
  const [mirrorOpen, setMirrorOpen] = useState(false);

  const bars = (() => {
    const r = barsStore.getResult(monitor.ticker);
    return r.status === 'ready' ? r.data : [];
  })();
  const cvd = (() => {
    const r = cvdStore.getResult(monitor.ticker);
    return r.status === 'ready' ? r.data : null;
  })();
  const exhaustion = computeExhaustion(bars, monitor.direction, cvd);
  const pullback   = classifyPullback(bars, monitor.direction, cvd);
  const consol     = classifyConsolidation(bars, monitor.direction, cvd);

  const favPct = monitor.direction === 'call'
    ? ((monitor.currentPrice - monitor.entryPrice) / monitor.entryPrice) * 100
    : ((monitor.entryPrice - monitor.currentPrice) / monitor.entryPrice) * 100;

  const phaseCfg: Record<MonitorPhase, { border: string; badge: string; label: string }> = {
    watching:     { border: 'border-white/12',    badge: 'bg-white/8 text-white/50',         label: 'WATCHING' },
    'mae-guard':  { border: 'border-col-r/50', badge: 'bg-col-r/15 text-col-r',     label: 'MAE GUARD' },
    continuation: { border: 'border-col-g/40', badge: 'bg-col-g/10 text-col-g', label: 'CONTINUATION' },
    pullback:     { border: 'border-amb/40',   badge: 'bg-amb/10 text-amb',        label: 'PULLBACK' },
    exited:       { border: 'border-white/8',     badge: 'bg-white/5 text-dim',         label: 'EXITED' },
  };
  const pc = phaseCfg[monitor.phase];

  // Premium P&L estimate
  const elapsed = candlesSince(monitor.entryCandle, Date.now()) * 5 / 60; // hours
  const priceChange = monitor.currentPrice - monitor.entryPrice;
  const premiumEst = monitor.entryPremium
    + monitor.entryDelta * priceChange
    + 0.5 * monitor.entryGamma * priceChange * priceChange
    - monitor.entryTheta * elapsed;

  const pnlEst = premiumEst - monitor.entryPremium;

  // Conviction trend
  const convHistory = monitor.convictionHistory;
  const convFirst   = convHistory[0] ?? monitor.currentConviction;
  const convTrend   = monitor.currentConviction - convFirst;
  const convStatus  = convTrend >= 5
    ? 'STRENGTHENING'
    : convTrend <= -15
    ? 'DEGRADING'
    : 'STABLE';
  const convStatusCfg: Record<string, string> = {
    STRENGTHENING: 'text-col-g',
    DEGRADING:     'text-amb',
    STABLE:        'text-white/50',
  };

  const markers: import('../components/HeliosChart').ChartSignalMarker[] = [
    {
      id:        `entry_${monitor.signalId}`,
      ticker:    monitor.ticker,
      state:     'ACTIVE' as const,
      direction: monitor.direction,
      tCT:       monitor.entryCandle,
      price:     monitor.entryPrice,
    },
  ];

  const handleExit = useCallback(() => {
    const price = parseFloat(exitPrice);
    if (!isNaN(price) && price > 0) {
      onExit(monitor.signalId, price, exitResult, exitNotes);
    }
  }, [exitPrice, exitResult, exitNotes, monitor.signalId, onExit]);

  return (
    <div className={`border ${pc.border} bg-white/2 overflow-hidden transition-all`}>
      {/* Compact header — always visible */}
      <button
        className="w-full flex items-center gap-3 px-3 py-2.5 text-left hover:bg-white/3 transition-colors"
        onClick={() => setExpanded(e => !e)}
      >
        <DirectionPill direction={monitor.direction} />
        <span className="font-bold text-white text-sm">{monitor.ticker}</span>
        {CASH_SETTLED_TICKERS.has(monitor.ticker) && (
          <span className="text-[9px] bg-amb/10 text-amb px-1 py-0.5 rounded border border-amb/30">CASH</span>
        )}
        <span className={`text-[9px] px-1.5 py-0.5 rounded font-bold uppercase ${pc.badge}`}>{pc.label}</span>

        <div className="flex-1" />

        {/* P&L */}
        <span className={`text-xs font-bold tabular-nums ${favPct >= 0 ? 'text-col-g' : 'text-col-r'}`}>
          {favPct >= 0 ? '+' : ''}{favPct.toFixed(2)}%
        </span>
        <span className="text-white/20 text-xs ml-1">{monitor.candleCount}c</span>
        <span className="text-white/20 text-xs ml-1">{expanded ? '▲' : '▼'}</span>
      </button>

      {/* Expanded post-entry content */}
      {expanded && (
        <div className="border-t border-white/8 px-3 pb-3 space-y-3">
          {/* Conviction banner */}
          {monitor.currentConviction < 30 && (
            <div className="mt-2 bg-col-r/15 border border-col-r/25 rounded p-2 text-[10px] text-col-r font-bold">
              LOW CONVICTION ({monitor.currentConviction}) — Consider exiting
            </div>
          )}
          {monitor.currentConviction >= 30 && monitor.currentConviction < 50 && (
            <div className="mt-2 bg-amb/15 border border-amb/25 rounded p-2 text-[10px] text-amb font-bold">
              WEAKENING CONVICTION ({monitor.currentConviction})
            </div>
          )}

          {/* Price row */}
          <div className="mt-2 grid grid-cols-4 gap-2">
            <MiniStat label="ENTRY"   value={`$${monitor.entryPrice.toFixed(2)}`}   color="text-white/50" />
            <MiniStat label="CURRENT" value={`$${monitor.currentPrice.toFixed(2)}`} color={favPct >= 0 ? 'text-col-g' : 'text-col-r'} />
            <MiniStat label="MAE"     value={`${(monitor.maePct * 100).toFixed(2)}%`} color="text-col-r" />
            <MiniStat label="MFE"     value={`${(monitor.mfePct * 100).toFixed(2)}%`} color="text-col-g" />
          </div>

          {/* Premium P&L estimate */}
          {monitor.entryPremium > 0 && (
            <div className="grid grid-cols-2 gap-2">
              <MiniStat label="PREM EST" value={`$${Math.max(0, premiumEst).toFixed(2)}`} color="text-white/70" />
              <MiniStat label="P&L EST"  value={`${pnlEst >= 0 ? '+' : ''}$${pnlEst.toFixed(2)}`} color={pnlEst >= 0 ? 'text-col-g' : 'text-col-r'} />
            </div>
          )}

          {/* Conviction sparkline */}
          <div className="space-y-1">
            <div className="flex items-center justify-between">
              <span className="text-[9px] text-dim uppercase tracking-wider">Conviction</span>
              <span className={`text-[9px] font-bold ${convStatusCfg[convStatus]}`}>{convStatus}</span>
            </div>
            <ConvictionSparkline history={convHistory} current={monitor.currentConviction} />
          </div>

          {/* Exhaustion */}
          <ExhaustionBar level={exhaustion} />

          {/* Pullback */}
          <PullbackDisplay cls={pullback} />

          {/* Consolidation */}
          <ConsolidationDisplay state={consol} />

          {/* Mini chart */}
          <div className="rounded-lg overflow-hidden" style={{ height: 200 }}>
            <HeliosChart ticker={monitor.ticker} markers={markers} height={200} />
          </div>

          {/* TradingView button */}
          <button
            className="w-full py-2 rounded-lg bg-white/5 border border-white/10 text-[10px] text-white/50 hover:bg-white/8 hover:text-white/70 transition-colors"
            onClick={() => onOpenTV(monitor.ticker)}
          >
            Open TradingView chart (drawing tools)
          </button>

          {/* Exit form */}
          <div className="space-y-2 pt-1">
            <p className="text-[10px] text-dim uppercase tracking-wider">Exit Trade</p>
            <div className="flex gap-2">
              <input
                type="number"
                placeholder="Exit price"
                value={exitPrice}
                onChange={e => setExitPrice(e.target.value)}
                className="flex-1 bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-white placeholder-white/20 focus:outline-none focus:border-white/25"
              />
              <select
                value={exitResult}
                onChange={e => setExitResult(e.target.value as ExitResult)}
                className="bg-white/5 border border-white/10 rounded-lg px-2 py-2 text-sm text-white focus:outline-none focus:border-white/25"
              >
                <option value="win">Win</option>
                <option value="loss">Loss</option>
                <option value="scratch">Scratch</option>
              </select>
            </div>
            <textarea
              placeholder="Notes (optional)"
              value={exitNotes}
              onChange={e => setExitNotes(e.target.value)}
              rows={2}
              className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-white placeholder-white/20 focus:outline-none focus:border-white/25 resize-none"
            />

            {/* Discipline Mirror */}
            <button
              className="w-full text-left text-[10px] text-dim hover:text-white/50 transition-colors"
              onClick={() => setMirrorOpen(m => !m)}
            >
              {mirrorOpen ? '▲' : '▼'} Discipline Mirror
            </button>
            {mirrorOpen && (
              <DisciplineMirror monitor={monitor} currentPrice={monitor.currentPrice} />
            )}

            <button
              className="w-full py-2.5 rounded-lg bg-col-r hover:bg-col-r/80 text-void text-sm font-bold transition-colors"
              onClick={handleExit}
            >
              Confirm Exit
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function DisciplineMirror({
  monitor,
  currentPrice,
}: {
  monitor: ActiveMonitor;
  currentPrice: number;
}) {
  const entryLateness = monitor.entryCandle
    ? `Entry taken ${monitor.candleCount} candle${monitor.candleCount !== 1 ? 's' : ''} into move`
    : '—';
  const vsMaxFav = monitor.mfePct > 0
    ? `Exit is ${((monitor.mfePct - Math.max(0,
        monitor.direction === 'call'
          ? (currentPrice - monitor.entryPrice) / monitor.entryPrice
          : (monitor.entryPrice - currentPrice) / monitor.entryPrice,
      )) * 100).toFixed(1)}% below MFE peak`
    : '—';

  return (
    <div className="bg-white/3 border border-white/8 rounded-lg p-2.5 space-y-1.5 text-[10px]">
      <p className="text-white/25 uppercase tracking-wider font-bold">Discipline Mirror</p>
      <div className="flex justify-between">
        <span className="text-white/40">Entry timing</span>
        <span className="text-white/60">{entryLateness}</span>
      </div>
      <div className="flex justify-between">
        <span className="text-white/40">vs MFE peak</span>
        <span className="text-white/60">{vsMaxFav}</span>
      </div>
      <div className="flex justify-between">
        <span className="text-white/40">MAE drawn down</span>
        <span className={`font-bold ${monitor.maePct > 0.008 ? 'text-col-r' : 'text-white/60'}`}>
          {(monitor.maePct * 100).toFixed(2)}%
        </span>
      </div>
      <div className="flex justify-between">
        <span className="text-white/40">Trade type</span>
        <span className={`font-bold ${
          monitor.tradeType === 'counter_session' ? 'text-amb'
            : monitor.tradeType === 'continuation' ? 'text-white/40'
            : 'text-col-g'
        }`}>{monitor.tradeType ?? '—'}</span>
      </div>
    </div>
  );
}

// ── Opportunity Stack Row ─────────────────────────────────────────────────────

function OpportunityRow({
  row,
  isExpanded,
  isActive,
  onExpand,
  onImIn,
  onOpenTV,
}: {
  row:           StackRow;
  isExpanded:    boolean;
  isActive:      boolean;
  onExpand:      () => void;
  onImIn:        (row: StackRow, premium: number, delta: number, gamma: number, theta: number) => void;
  onOpenTV:      (ticker: string) => void;
}) {
  const phaseCfg: Record<RowPhase, { border: string; pill: string; label: string }> = {
    'no-signal':     { border: 'border-white/5',   pill: 'bg-white/5 text-white/20',                                    label: 'NO SIGNAL' },
    'forming':       { border: 'border-line',      pill: 'bg-panel2 text-mut',                                          label: 'WATCHING' },
    'consolidating': { border: 'border-amb/25',    pill: 'bg-amb-dim text-amb',                                         label: 'CONSOLIDATING' },
    'triggering':    { border: 'border-col-g/50',  pill: 'bg-col-g text-[rgb(2,21,13)] !font-black animate-vbpulse',    label: 'ENTER NOW' },
    'active':        { border: 'border-amb/35',    pill: 'bg-amb/10 text-amb',                                         label: 'ACTIVE' },
  };
  const pc = phaseCfg[row.rowPhase];

  const sessionLabel = row.tradeType === 'counter_session' ? 'COUNTER SESSION' : 'WITH SESSION';
  const sessionColor = row.tradeType === 'counter_session' ? 'text-amb'
    : row.tradeType === 'continuation' ? 'text-white/40'
    : 'text-col-g';

  const rowBg = isActive
    ? 'bg-amb/5'
    : row.rowPhase === 'triggering'
    ? 'bg-col-g/5 hover:bg-col-g/8'
    : 'hover:bg-white/2';

  return (
    <div className={`border ${pc.border} ${rowBg} overflow-hidden transition-all`}>
      {/* Compact row */}
      <button
        className="w-full flex items-center gap-2 px-3 py-2.5 text-left"
        onClick={onExpand}
        disabled={row.rowPhase === 'no-signal' || row.rowPhase === 'consolidating'}
      >
        {/* Score badge */}
        <div className={`w-8 text-center text-[9px] font-black tabular-nums rounded px-1 py-0.5 shrink-0 ${
          row.score >= 200 ? 'bg-col-g/20 text-col-g'
          : row.score >= 100 ? 'bg-amb/20 text-amb'
          : 'bg-white/5 text-white/20'
        }`}>
          {row.score}
        </div>

        <span className={`font-bold text-sm w-12 shrink-0 ${row.rowPhase === 'no-signal' ? 'text-dim' : 'text-white'}`}>
          {row.ticker}
        </span>

        {row.cashSettled && (
          <span className="text-[8px] bg-amb/15 text-amb px-1 rounded border border-amb/25 shrink-0">CASH</span>
        )}

        <DirectionPill direction={row.direction} dim={row.rowPhase === 'no-signal'} />

        <span className={`text-[9px] px-1.5 py-0.5 rounded font-bold uppercase shrink-0 ${pc.pill}`}>
          {pc.label}
        </span>

        {row.rowPhase !== 'no-signal' && row.rowPhase !== 'consolidating' && (
          <span className={`text-[8px] font-bold uppercase shrink-0 ${sessionColor}`}>
            {sessionLabel}
          </span>
        )}

        <div className="flex-1" />

        {/* Criteria dots */}
        <div className="flex gap-0.5 shrink-0">
          {([row.c1, row.c2, row.c3, row.c4, row.c5, row.c6, row.c7, row.c8] as boolean[]).map((v, i) => (
            <div
              key={i}
              className={`w-1.5 h-1.5 rounded-full ${v ? 'bg-col-g' : 'bg-white/10'}`}
            />
          ))}
        </div>

        {row.price > 0 && (
          <span className="text-[10px] text-white/35 tabular-nums w-14 text-right shrink-0">
            ${row.price.toFixed(2)}
          </span>
        )}

        {row.rowPhase !== 'no-signal' && row.rowPhase !== 'consolidating' && (
          <span className="text-white/15 text-xs">{isExpanded ? '▲' : '▼'}</span>
        )}
      </button>

      {/* Expanded: pre-entry card */}
      {isExpanded && !isActive && row.rowPhase !== 'no-signal' && row.rowPhase !== 'consolidating' && (
        <InlinePreEntryCard
          row={row}
          onImIn={onImIn}
          onOpenTV={onOpenTV}
        />
      )}
    </div>
  );
}

// ── Inline Pre-Entry Card ─────────────────────────────────────────────────────

function InlinePreEntryCard({
  row,
  onImIn,
  onOpenTV,
}: {
  row:       StackRow;
  onImIn:    (row: StackRow, premium: number, delta: number, gamma: number, theta: number) => void;
  onOpenTV:  (ticker: string) => void;
}) {
  const cvdR = cvdStore.getResult(row.ticker);
  const cvd  = cvdR.status === 'ready' ? cvdR.data : null;
  const leaderSym = TICKER_BETA_TABLE[row.ticker]?.leader ?? 'SPY';
  const leaderCvdR = cvdStore.getResult(leaderSym);
  const leaderCvd = leaderCvdR.status === 'ready' ? leaderCvdR.data : null;

  // CVD momentum 3-step sequence
  const cvdStep1 = row.direction === 'call'
    ? (cvd?.callPct ?? 0) > 55
    : (cvd?.putPct ?? 0) > 55;
  const cvdStep2 = row.leaderCvdOk;
  const cvdStep3 = cvdStep1 && cvdStep2;

  const tradeTypeCfg: Record<TradeType, { color: string; label: string; desc: string }> = {
    with_session:    { color: 'text-col-g',  label: 'WITH SESSION',    desc: `Target: GEX wall ${(row.direction === 'call' ? row.callWall : row.putWall).toFixed(2)}` },
    counter_session: { color: 'text-amb',    label: 'COUNTER SESSION', desc: 'Target: VWAP reversion — tighter sizing' },
    continuation:    { color: 'text-white/40', label: 'WITH SESSION',  desc: `Re-entry within 90 min — ×1.05 conviction, size down` },
  };
  const ttc = tradeTypeCfg[row.tradeType];

  return (
    <div className="border-t border-white/8 px-3 pb-3 space-y-3">
      {/* Section A: Trade type */}
      <div className="mt-2 flex items-center gap-2">
        <span className={`text-[10px] font-bold px-2 py-1 rounded border ${
          row.tradeType === 'counter_session' ? 'border-amb/30 bg-amb/8 text-amb'
          : row.tradeType === 'continuation'  ? 'border-white/15 bg-white/5 text-white/40'
          : 'border-col-g/30 bg-col-g/8 text-col-g'
        }`}>{ttc.label}</span>
        <span className="text-[10px] text-white/35">{ttc.desc}</span>
      </div>

      {/* Section B: 8-factor live check */}
      <div className="space-y-1.5">
        <p className="text-[9px] text-white/25 uppercase tracking-wider">8-Factor Entry Check</p>
        <div className="grid grid-cols-2 gap-1">
          {[
            { label: 'Brain ≥60%', pass: row.c1 },
            { label: 'No blockers', pass: row.c2 },
            { label: 'CVD dual confirm', pass: row.c3 },
            { label: 'Signal actionable', pass: row.c4 },
            { label: 'Spread < 8%', pass: row.c5 },
            { label: 'Break-even reachable', pass: row.c6 },
            { label: 'IV rank < 75th', pass: row.c7 },
            { label: 'No earnings', pass: row.c8 },
          ].map(({ label, pass }) => (
            <div key={label} className="flex items-center gap-1.5">
              <span className={`w-3 h-3 rounded-full flex-shrink-0 flex items-center justify-center text-[8px] ${
                pass ? 'bg-col-g/20 text-col-g' : 'bg-white/5 text-white/20'
              }`}>
                {pass ? '✓' : '×'}
              </span>
              <span className={`text-[10px] ${pass ? 'text-white/70' : 'text-white/25'}`}>{label}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Section C: CVD momentum 3-step */}
      <div className="space-y-1.5">
        <p className="text-[9px] text-white/25 uppercase tracking-wider">CVD Momentum</p>
        <div className="flex gap-2">
          {[
            { label: `${row.ticker} CVD > 55%`, pass: cvdStep1, val: cvd ? `${Math.round(row.direction === 'call' ? cvd.callPct : cvd.putPct)}%` : '—' },
            { label: `${leaderSym} confirming`, pass: cvdStep2, val: leaderCvd?.classification ?? '—' },
            { label: 'Dual confirmed', pass: cvdStep3, val: cvdStep3 ? 'YES' : 'NO' },
          ].map(({ label, pass, val }) => (
            <div key={label} className={`flex-1 rounded-lg p-2 text-center border ${
              pass ? 'border-col-g/25 bg-col-g/6' : 'border-white/8 bg-white/2'
            }`}>
              <p className={`text-[9px] font-bold ${pass ? 'text-col-g' : 'text-white/25'}`}>{val}</p>
              <p className="text-[8px] text-white/25 mt-0.5">{label}</p>
            </div>
          ))}
        </div>
      </div>

      {/* Section D: Options flow concentration */}
      {cvd && (
        <div className="space-y-1">
          <p className="text-[9px] text-white/25 uppercase tracking-wider">Options Flow</p>
          <div className="h-3 rounded-full overflow-hidden bg-white/5 flex">
            <div className="h-full bg-col-g/60 transition-all" style={{ width: `${cvd.callPct.toFixed(0)}%` }} />
            <div className="h-full bg-col-r/60 transition-all" style={{ width: `${cvd.putPct.toFixed(0)}%` }} />
          </div>
          <div className="flex justify-between text-[9px] text-dim">
            <span>{cvd.callPct.toFixed(0)}% call</span>
            <span>{cvd.putPct.toFixed(0)}% put</span>
          </div>
        </div>
      )}

      {/* Section E: Contract card */}
      {row.midPremium > 0 && (
        <div className="bg-white/3 rounded-lg p-2.5 space-y-1.5">
          <div className="flex items-center justify-between">
            <p className="text-[9px] text-white/25 uppercase tracking-wider">Contract Economics</p>
            <BrainDots n={row.baseRate?.n} />
          </div>
          <div className="grid grid-cols-4 gap-2">
            <MiniStat label="MID"   value={`$${row.midPremium.toFixed(2)}`}       color="text-white/70" />
            <MiniStat label="DELTA" value={row.delta.toFixed(2)}                  color="text-white/70" />
            <MiniStat label="THETA" value={row.theta.toFixed(2)}                  color="text-col-r" />
            <MiniStat label="SPRD"  value={`$${row.spread.toFixed(2)}`}           color={row.c5 ? 'text-white/50' : 'text-amb'} />
          </div>
          {row.ivRank !== null && (
            <div className="text-[9px] text-white/35">
              IV rank: <span className={row.c7 ? 'text-white/50' : 'text-amb'}>{(row.ivRank * 100).toFixed(0)}th pct</span>
            </div>
          )}
        </div>
      )}

      {/* Section F: Entry trigger */}
      <div className="bg-white/3 border border-white/8 rounded-lg p-2.5 space-y-1">
        <p className="text-[9px] text-white/25 uppercase tracking-wider">Entry Trigger</p>
        <p className="text-xs text-white/80">{row.entryTrigger}</p>
        <p className="text-[9px] text-col-r/70 mt-1">⚡ Invalidation: {row.invalidation}</p>
      </div>

      {/* Section G: News alert */}
      {row.hasNews && (
        <div className="bg-col-r/10 border border-col-r/25 rounded-lg p-2 text-[10px] text-col-r font-bold">
          EARNINGS / NEWS EVENT — Binary risk active
        </div>
      )}

      {/* Section H+I: Discipline line + I'm In */}
      <div className="pt-1 space-y-2">
        <DisciplineLine row={row} />
        <div className="flex gap-2">
          <button
            className="flex-1 py-3 bg-col-g/80 hover:bg-col-g text-void font-black text-sm tracking-wide transition-colors"
            onClick={() => onImIn(row, row.midPremium, row.delta, row.gamma, row.theta)}
          >
            I'M IN
          </button>
          <button
            className="px-4 py-3 bg-white/5 border border-white/10 text-white/40 text-xs hover:bg-white/8 transition-colors"
            onClick={() => onOpenTV(row.ticker)}
          >
            TV
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Brain confidence dots: n → 0–5 filled dots ───────────────────────────────
// Thresholds: 0=no data, 1=1–14 (thin), 2=15–24 (just valid),
//             3=25–49 (moderate), 4=50–99 (solid), 5=100+ (high confidence)
function brainConfidenceDots(n: number | null | undefined): number {
  if (!n || n <= 0)  return 0;
  if (n < 15)        return 1;
  if (n < 25)        return 2;
  if (n < 50)        return 3;
  if (n < 100)       return 4;
  return 5;
}

function BrainDots({ n }: { n: number | null | undefined }) {
  const filled = brainConfidenceDots(n);
  return (
    <div className="flex items-center gap-0.5" title={`Brain confidence: ${filled}/5 (n=${n ?? 0})`}>
      {[0, 1, 2, 3, 4].map(i => (
        <div
          key={i}
          className={`w-1.5 h-1.5 rounded-full ${i < filled ? 'bg-amb' : 'bg-white/10'}`}
        />
      ))}
    </div>
  );
}

// ── DisciplineLine: consolidated one-line gate replacing AdaptiveRiskLine + BrainContext ──
// Shows: MAX LOSS {riskPct}% · AVG P&L {avgPnl}% · WIN RATE {adjWinRate}% (n={n}) · session tag
function DisciplineLine({ row }: { row: StackRow }) {
  const stopDist   = row.direction === 'call'
    ? Math.abs(row.price - row.flipLevel)
    : Math.abs(row.flipLevel - row.price);
  const riskPct    = row.price > 0 ? (stopDist / row.price) * 100 : 0;
  const mult       = convictionMultiplier(row.tradeType);

  const br         = row.baseRate;
  const adjWinRate = br ? Math.min(1, (br.winRate ?? 0) * mult) : null;
  const hasData    = br && br.isStatisticallyValid;

  // counter_session = amber (caution); continuation folds into with_session display label
  // (it IS a with_session trade, just a re-entry) + gets grey color to signal caution.
  // with_session = emerald. Blue is not a Helios accent — never used here.
  const ttColor = row.tradeType === 'counter_session' ? 'text-amb'
    : row.tradeType === 'continuation'               ? 'text-white/40'
    : 'text-col-g';
  // Spec: only two display labels — WITH SESSION and COUNTER SESSION.
  // continuation renders as WITH SESSION (it is one) + note below.
  const ttLabel = row.tradeType === 'counter_session' ? 'COUNTER SESSION'
    : 'WITH SESSION';

  return (
    <div className="bg-white/3 border border-white/8 px-3 py-2 space-y-1.5" style={{ borderRadius: 2 }}>
      {/* Label row */}
      <div className="flex items-center justify-between">
        <span className="text-[9px] text-white/25 uppercase tracking-wider">Discipline Gate</span>
        <span className={`text-[9px] font-bold uppercase ${ttColor}`}>
          {ttLabel}
        </span>
      </div>

      {/* Stats line */}
      <div className="flex items-center gap-2 flex-wrap">
        {/* MAX LOSS */}
        <span className="text-[10px] text-white/40">MAX LOSS</span>
        <span className={`text-[10px] font-bold tabular-nums ${riskPct > 1.5 ? 'text-amb' : 'text-white/70'}`}>
          {riskPct.toFixed(2)}%
        </span>

        <span className="text-white/15">·</span>

        {/* AVG P&L */}
        <span className="text-[10px] text-white/40">AVG P&L</span>
        {hasData && adjWinRate !== null ? (
          <span className={`text-[10px] font-bold tabular-nums ${br!.avgPnl >= 0 ? 'text-col-g' : 'text-col-r'}`}>
            {(br!.avgPnl * 100).toFixed(1)}%
          </span>
        ) : (
          <span className="text-[10px] text-white/20">—</span>
        )}

        <span className="text-white/15">·</span>

        {/* WIN RATE (n) */}
        <span className="text-[10px] text-white/40">WIN RATE</span>
        {hasData && adjWinRate !== null ? (
          <span className={`text-[10px] font-bold tabular-nums ${adjWinRate >= 0.6 ? 'text-col-g' : adjWinRate >= 0.5 ? 'text-amb' : 'text-col-r'}`}>
            {(adjWinRate * 100).toFixed(0)}%
            <span className="text-dim font-normal"> (n={br!.n})</span>
          </span>
        ) : (
          <span className="text-[10px] text-white/20">no data{br ? ` (n=${br.n})` : ''}</span>
        )}

        {/* Brain confidence dots */}
        <div className="ml-auto shrink-0">
          <BrainDots n={br?.n} />
        </div>
      </div>

      {/* Stop level sub-line */}
      <p className="text-[9px] text-dim">
        Stop @ flip level <span className="text-white/50 font-mono">${row.flipLevel.toFixed(2)}</span>
        {row.tradeType === 'counter_session' && (
          <span className="text-amb/60"> — size down for counter-session</span>
        )}
        {row.tradeType === 'continuation' && (
          <span className="text-dim"> — re-entry within 90 min, size down</span>
        )}
      </p>
    </div>
  );
}

// ── Exhaustion / Pullback / Consolidation sub-components ──────────────────────

function ExhaustionBar({ level }: { level: ExhaustionLevel }) {
  const labels: Record<ExhaustionLevel, { label: string; color: string }> = {
    0: { label: 'CONTINUATION (0/4)', color: 'text-col-g' },
    1: { label: 'MONITORING (1/4)',   color: 'text-white/50' },
    2: { label: 'MONITORING (2/4)',   color: 'text-amb' },
    3: { label: 'EXHAUSTION FORMING (3/4)', color: 'text-amb' },
    4: { label: 'MOVE LIKELY COMPLETE (4/4)', color: 'text-col-r' },
  };
  const cfg = labels[level];
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between">
        <span className="text-[9px] text-white/25 uppercase tracking-wider">Exhaustion</span>
        <span className={`text-[9px] font-bold ${cfg.color}`}>{cfg.label}</span>
      </div>
      <div className="flex gap-1">
        {[0, 1, 2, 3].map(i => (
          <div
            key={i}
            className={`flex-1 h-1.5 rounded-full ${i < level ? (level >= 3 ? 'bg-col-r' : 'bg-amb') : 'bg-white/10'}`}
          />
        ))}
      </div>
    </div>
  );
}

function PullbackDisplay({ cls }: { cls: PullbackClass }) {
  const cfg: Record<PullbackClass, { color: string; label: string; sub: string }> = {
    normal:     { color: 'text-col-g', label: 'NORMAL PULLBACK',     sub: 'EMA held — do not exit' },
    concerning: { color: 'text-amb',     label: 'CONCERNING PULLBACK', sub: 'EMA21 broken — tighten stop' },
    reversal:   { color: 'text-col-r',   label: 'REVERSAL SIGNAL',     sub: 'CVD crossed — consider exit' },
  };
  const c = cfg[cls];
  return (
    <div className="flex items-center justify-between">
      <span className="text-[9px] text-white/25 uppercase tracking-wider">Pullback</span>
      <div className="text-right">
        <span className={`text-[9px] font-bold ${c.color}`}>{c.label}</span>
        <p className="text-[8px] text-dim">{c.sub}</p>
      </div>
    </div>
  );
}

function ConsolidationDisplay({ state }: { state: ConsolidationState }) {
  const cfg: Record<ConsolidationState, { color: string; label: string }> = {
    unclear:      { color: 'text-white/25',   label: '—' },
    consolidating: { color: 'text-amb',      label: 'CONSOLIDATING — hold' },
    continuation:  { color: 'text-col-g',    label: 'CONTINUATION BREAK — add' },
    'exit-signal': { color: 'text-col-r',    label: 'BREAK AGAINST — exit' },
  };
  const c = cfg[state];
  return (
    <div className="flex items-center justify-between">
      <span className="text-[9px] text-white/25 uppercase tracking-wider">Consolidation</span>
      <span className={`text-[9px] font-bold ${c.color}`}>{c.label}</span>
    </div>
  );
}

function ConvictionSparkline({
  history,
  current,
}: {
  history: number[];
  current: number;
}) {
  const all = [...history, current].slice(-5);
  const max = Math.max(...all, 1);
  return (
    <div className="flex items-end gap-1 h-6">
      {all.map((v, i) => {
        const h = Math.max(4, (v / max) * 24);
        const isLast = i === all.length - 1;
        const color = isLast
          ? current < 30 ? 'bg-col-r'
          : current < 50 ? 'bg-amb'
          : 'bg-col-g'
          : 'bg-white/15';
        return (
          <div key={i} className={`flex-1 rounded-sm ${color} transition-all`} style={{ height: h }} />
        );
      })}
    </div>
  );
}

// ── TradingView Bottom Sheet ──────────────────────────────────────────────────

function TradingViewSheet({
  ticker,
  onClose,
}: {
  ticker: string;
  onClose: () => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);

  // TradingView exchange prefix
  const tvSymbol = (() => {
    const etfs   = new Set(['SPY', 'QQQ', 'IWM', 'GLD']);
    const nasdaq = new Set(['AAPL', 'TSLA', 'NVDA', 'MSFT', 'AMZN', 'META', 'AMD', 'GOOGL', 'NFLX', 'MSTR', 'SMCI', 'COIN', 'PLTR', 'HOOD', 'SOFI']);
    if (etfs.has(ticker))    return `AMEX:${ticker}`;
    if (nasdaq.has(ticker))  return `NASDAQ:${ticker}`;
    return `NYSE:${ticker}`;
  })();

  useEffect(() => {
    if (!containerRef.current) return;
    containerRef.current.innerHTML = '';
    const script = document.createElement('script');
    script.src = 'https://s3.tradingview.com/external-embedding/embed-widget-advanced-chart.js';
    script.async = true;
    script.innerHTML = JSON.stringify({
      symbol:          tvSymbol,
      interval:        '5',
      theme:           'dark',
      style:           '1',
      locale:          'en',
      toolbar_bg:      '#0a0a0f',
      enable_publishing: false,
      hide_top_toolbar: false,
      withdateranges:  true,
      hide_side_toolbar: false,
      allow_symbol_change: false,
      container_id:    'tv_chart_container',
      autosize:        true,
    });
    containerRef.current.appendChild(script);
  }, [tvSymbol]);

  return (
    <div className="fixed inset-0 z-50 flex flex-col justify-end">
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={onClose}
      />
      <div
        className="relative bg-[#0a0a0f] border-t border-white/10 rounded-t-2xl overflow-hidden"
        style={{ height: '65vh' }}
      >
        <div className="flex items-center justify-between px-4 py-2.5 border-b border-white/8">
          <span className="text-sm font-bold text-white">{ticker} — 5m chart</span>
          <button
            className="text-white/40 hover:text-white/70 text-xl transition-colors"
            onClick={onClose}
          >
            ×
          </button>
        </div>
        <div
          id="tv_chart_container"
          ref={containerRef}
          className="w-full"
          style={{ height: 'calc(65vh - 44px)' }}
        />
      </div>
    </div>
  );
}

// ── Small reusable atoms ──────────────────────────────────────────────────────

function MiniStat({
  label,
  value,
  color = 'text-white',
}: {
  label: string;
  value: string;
  color?: string;
}) {
  return (
    <div className="space-y-0.5">
      <p className="text-[9px] text-white/25 uppercase tracking-wider">{label}</p>
      <p className={`text-xs font-bold tabular-nums ${color}`}>{value}</p>
    </div>
  );
}

function DirectionPill({
  direction,
  dim = false,
}: {
  direction: 'call' | 'put';
  dim?: boolean;
}) {
  return (
    <span className={`px-1.5 py-0.5 rounded text-[9px] font-black uppercase shrink-0 ${
      dim
        ? 'bg-white/4 text-white/20 border border-white/8'
        : direction === 'call'
        ? 'bg-col-g/15 text-col-g border border-col-g/25'
        : 'bg-col-r/15 text-col-r border border-col-r/25'
    }`}>
      {direction}
    </span>
  );
}

// ── Main ZeroDteCockpit ───────────────────────────────────────────────────────

export default function ZeroDteCockpit() {
  const { ticker: paramTicker } = useParams<{ ticker?: string }>();
  const navigate = useNavigate();

  const [rows, setRows]             = useState<StackRow[]>([]);
  const [expandedTicker, setExpanded] = useState<string | null>(paramTicker ?? null);
  const [monitors, setMonitors]     = useState<Map<string, ActiveMonitor>>(new Map());
  const [tvTicker, setTvTicker]     = useState<string | null>(null);

  const monitorsRef   = useRef<Map<string, ActiveMonitor>>(new Map());
  const snapshotRefs  = useRef<Map<string, ReturnType<typeof setInterval>>>(new Map());

  // ── Rebuild stack ───────────────────────────────────────────────────────────

  const rebuildStack = useCallback(() => {
    const built: StackRow[] = [];

    for (const ticker of SELECTABLE) {
      const row = buildStackRow(ticker);
      if (!row) continue;
      if (monitorsRef.current.has(ticker)) {
        built.push({ ...row, rowPhase: 'active' });
      } else {
        built.push(row);
      }
    }

    // Sort: active first, then by score desc, no-signal last
    built.sort((a, b) => {
      if (a.rowPhase === 'active' && b.rowPhase !== 'active') return -1;
      if (b.rowPhase === 'active' && a.rowPhase !== 'active') return  1;
      if (a.rowPhase === 'no-signal' && b.rowPhase !== 'no-signal') return  1;
      if (b.rowPhase === 'no-signal' && a.rowPhase !== 'no-signal') return -1;
      return b.score - a.score;
    });

    setRows(built);
  }, []);

  // ── Store subscriptions ─────────────────────────────────────────────────────

  useEffect(() => {
    for (const t of SELECTABLE) {
      barsStore.subscribeTicker(t);
    }

    const unsubBars = barsStore.subscribe(() => {
      // Update active monitors
      for (const [ticker, monitor] of monitorsRef.current) {
        const r = barsStore.getResult(ticker);
        if (r.status !== 'ready' || r.data.length === 0) continue;
        const last = r.data[r.data.length - 1];
        if (last.tCT === monitor.lastCandle) continue;

        const ctxR = marketStore.getResult(ticker);
        const cvdR = cvdStore.getResult(ticker);
        const cvd  = cvdR.status === 'ready' ? cvdR.data : null;
        const ctx  = ctxR.status === 'ready' ? ctxR.data : null;

        const newConviction = computeConviction(
          r.data, cvd, ctx, monitor.direction, monitor.currentConviction, monitor.tradeType,
        );

        const newMae = monitor.direction === 'call'
          ? Math.min(monitor.maePrice, last.low)
          : Math.max(monitor.maePrice, last.high);
        const newMfe = monitor.direction === 'call'
          ? Math.max(monitor.mfePrice, last.high)
          : Math.min(monitor.mfePrice, last.low);
        const maePct = monitor.direction === 'call'
          ? Math.max(0, (monitor.entryPrice - newMae) / monitor.entryPrice)
          : Math.max(0, (newMae - monitor.entryPrice) / monitor.entryPrice);
        const mfePct = monitor.direction === 'call'
          ? Math.max(0, (newMfe - monitor.entryPrice) / monitor.entryPrice)
          : Math.max(0, (monitor.entryPrice - newMfe) / monitor.entryPrice);

        const phase = classifyPhase(
          monitor.entryPrice, newMae, newMfe, last.close,
          candlesSince(monitor.entryCandle, last.tCT),
          monitor.direction,
        );

        const updated: ActiveMonitor = {
          ...monitor,
          currentPrice: last.close,
          maePrice:     newMae,
          mfePrice:     newMfe,
          maePct,
          mfePct,
          candleCount:  candlesSince(monitor.entryCandle, last.tCT),
          lastCandle:   last.tCT,
          phase,
          currentConviction: newConviction,
          convictionHistory: [...monitor.convictionHistory, newConviction].slice(-5),
        };

        monitorsRef.current.set(ticker, updated);
      }

      rebuildStack();
    });

    const unsubDir   = subscribeDirection(() => rebuildStack());
    const unsubMkt   = marketStore.subscribe(() => rebuildStack());
    const unsubCvd   = cvdStore.subscribe(() => rebuildStack());

    rebuildStack();

    return () => {
      unsubBars();
      unsubDir();
      unsubMkt();
      unsubCvd();
    };
  }, [rebuildStack]);

  // Sync monitors → state
  useEffect(() => {
    const interval = setInterval(() => {
      setMonitors(new Map(monitorsRef.current));
    }, 1000);
    return () => clearInterval(interval);
  }, []);

  // Auto-expand param ticker on mount
  useEffect(() => {
    if (paramTicker) setExpanded(paramTicker);
  }, [paramTicker]);

  // ── I'm In handler ──────────────────────────────────────────────────────────

  const handleImIn = useCallback(async (
    row: StackRow,
    premium: number,
    delta: number,
    gamma: number,
    theta: number,
  ) => {
    if (monitorsRef.current.size >= MAX_ACTIVE) return;

    const nowCT    = toCentralTime(Date.now());
    const barsR    = barsStore.getResult(row.ticker);
    const lastBar  = barsR.status === 'ready' && barsR.data.length > 0
      ? barsR.data[barsR.data.length - 1]
      : null;
    const entryPrice = lastBar?.close ?? row.price;

    const signalId = `zerod_${row.ticker}_${Date.now()}`;

    const initialConviction = row.baseRate?.winRate
      ? Math.round(row.baseRate.winRate * 100 * convictionMultiplier(row.tradeType))
      : 65;

    const monitor: ActiveMonitor = {
      signalId,
      ticker:       row.ticker,
      direction:    row.direction,
      entryPrice,
      entryCandle:  lastBar?.tCT ?? nowCT.ctMs,
      entryPremium: premium,
      entryDelta:   delta,
      entryGamma:   gamma,
      entryTheta:   theta,
      stopLevel:    row.flipLevel || null,
      targetLevel:  row.direction === 'call' ? row.upTarget : row.downTarget,
      tradeType:    row.tradeType,
      currentPrice:  entryPrice,
      maePrice:      entryPrice,
      mfePrice:      entryPrice,
      maePct:        0,
      mfePct:        0,
      candleCount:   0,
      lastCandle:    lastBar?.tCT ?? nowCT.ctMs,
      phase:         'watching',
      convictionHistory: [initialConviction],
      currentConviction: initialConviction,
    };

    monitorsRef.current.set(row.ticker, monitor);
    setMonitors(new Map(monitorsRef.current));

    // Write to signals table
    const dbRow = {
      id:          signalId,
      ticker:      row.ticker,
      direction:   row.direction,
      signal_type: 'ZEROD_MANUAL',
      conviction:  initialConviction,
      entry_price: entryPrice,
      entry_tct:   nowCT.ctMs,
      entry_utc:   Date.now(),
      status:      'pending',
      factors: {
        tradeType:   row.tradeType,
        callWall:    row.callWall,
        putWall:     row.putWall,
        flipLevel:   row.flipLevel,
        gexRegime:   null,
        cvdPct:      null,
        cvdClass:    null,
        emaStack:    null,
        catalystTags: null,
        luld:        { isHalted: row.isHalted, upperBand: null, lowerBand: null },
      },
    };

    const { error: dbErr } = await supabase.from('signals').insert(dbRow);
    if (dbErr) console.error('[ZeroDteCockpit] I\'m In write failed:', dbErr.message);

    // Start 30s snapshot loop
    const snapInterval = setInterval(async () => {
      const m = monitorsRef.current.get(row.ticker);
      if (!m) return;
      const snap = {
        signal_id:        signalId,
        ticker:           row.ticker,
        snapshot_at_utc:  Date.now(),
        price:            m.currentPrice,
        cvd_call_pct:     (() => { const r = cvdStore.getResult(row.ticker); return r.status === 'ready' ? r.data.callPct : null; })(),
        cvd_put_pct:      (() => { const r = cvdStore.getResult(row.ticker); return r.status === 'ready' ? r.data.putPct : null; })(),
        conviction:       m.currentConviction,
        phase:            m.phase,
        candle_count:     m.candleCount,
        exhaustion_count: (() => {
          const br = barsStore.getResult(row.ticker);
          const cr = cvdStore.getResult(row.ticker);
          return computeExhaustion(
            br.status === 'ready' ? br.data : [],
            m.direction,
            cr.status === 'ready' ? cr.data : null,
          );
        })(),
        premium_est: (() => {
          const elapsed = m.candleCount * 5 / 60;
          const pc = m.currentPrice - m.entryPrice;
          return m.entryPremium + m.entryDelta * pc + 0.5 * m.entryGamma * pc * pc - m.entryTheta * elapsed;
        })(),
        mae_pct: m.maePct,
        mfe_pct: m.mfePct,
      };
      const { error: snapErr } = await supabase.from('signal_snapshots').insert(snap);
      if (snapErr) console.error('[ZeroDteCockpit] snapshot write failed:', snapErr.message);
    }, SNAPSHOT_MS);

    snapshotRefs.current.set(row.ticker, snapInterval);

    // Collapse pre-entry, navigate to this ticker
    setExpanded(row.ticker);
    rebuildStack();
    navigate(`/zerod/${row.ticker}`, { replace: true });
  }, [rebuildStack, navigate]);

  // ── Exit handler ────────────────────────────────────────────────────────────

  const handleExit = useCallback(async (
    signalId: string,
    exitPrice: number,
    result: ExitResult,
    notes: string,
  ) => {
    // Find the monitor
    let ticker = '';
    for (const [t, m] of monitorsRef.current) {
      if (m.signalId === signalId) { ticker = t; break; }
    }
    if (!ticker) return;

    const monitor = monitorsRef.current.get(ticker);
    if (!monitor) return;

    // Stop snapshot loop
    const snapInt = snapshotRefs.current.get(ticker);
    if (snapInt) { clearInterval(snapInt); snapshotRefs.current.delete(ticker); }

    // Write outcome
    const nowCT = toCentralTime(Date.now());
    const outcome = {
      signal_id:    signalId,
      ticker,
      direction:    monitor.direction,
      entry_price:  monitor.entryPrice,
      exit_price:   exitPrice,
      entry_tct:    monitor.entryCandle,
      exit_tct:     nowCT.ctMs,
      entry_utc:    monitor.entryCandle,
      exit_utc:     Date.now(),
      candle_count: monitor.candleCount,
      mae_pct:      monitor.maePct,
      mfe_pct:      monitor.mfePct,
      pnl_pct:      (exitPrice - monitor.entryPrice) / monitor.entryPrice
        * (monitor.direction === 'put' ? -1 : 1),
      result,
      notes,
      resolved: true,
    };

    const { error: outErr } = await supabase.from('signal_outcomes').insert(outcome);
    if (outErr) console.error('[ZeroDteCockpit] exit write failed:', outErr.message);

    // Update signal status
    await supabase.from('signals').update({ status: 'resolved' }).eq('id', signalId);

    monitorsRef.current.delete(ticker);
    setMonitors(new Map(monitorsRef.current));
    setExpanded(null);
    rebuildStack();

    // Navigate away if this was a deep-linked ticker
    if (paramTicker === ticker) navigate('/zerod', { replace: true });
  }, [paramTicker, navigate, rebuildStack]);

  // ── Render ──────────────────────────────────────────────────────────────────

  const activeMonitors = [...monitors.values()];
  const activeCount    = activeMonitors.length;

  return (
    <section id="zerod" className="min-h-screen bg-[#0a0a0f] text-white">
      {/* Global sticky header */}
      <GlobalHeader activeCount={activeCount} />

      <div className="max-w-2xl mx-auto px-4 pb-24 pt-4 space-y-4">

        {/* Active position widgets */}
        {activeMonitors.length > 0 && (
          <div className="space-y-2">
            <p className="text-[9px] text-white/25 uppercase tracking-widest px-1">
              Active Positions ({activeMonitors.length}/{MAX_ACTIVE})
            </p>
            {activeMonitors.map(m => (
              <ActiveWidget
                key={m.signalId}
                monitor={m}
                onExit={handleExit}
                onOpenTV={setTvTicker}
              />
            ))}
          </div>
        )}

        {/* Opportunity stack */}
        <div className="space-y-2">
          {activeMonitors.length === 0 && (
            <p className="text-[9px] text-white/25 uppercase tracking-widest px-1">Opportunity Stack</p>
          )}
          {rows.length === 0 ? (
            <div className="text-center py-16 text-white/20 text-sm">
              Loading market data...
            </div>
          ) : (
            rows.map(row => (
              <OpportunityRow
                key={row.ticker}
                row={row}
                isExpanded={expandedTicker === row.ticker && !monitors.has(row.ticker)}
                isActive={monitors.has(row.ticker)}
                onExpand={() => setExpanded(
                  expandedTicker === row.ticker ? null : row.ticker,
                )}
                onImIn={handleImIn}
                onOpenTV={setTvTicker}
              />
            ))
          )}
        </div>

        {/* Footer hint */}
        <p className="text-center text-[9px] text-white/15 pb-4">
          {SELECTABLE.length} tickers · candle-based · all times CT
        </p>
      </div>

      {/* TradingView bottom sheet */}
      {tvTicker && (
        <TradingViewSheet ticker={tvTicker} onClose={() => setTvTicker(null)} />
      )}
    </section>
  );
}
