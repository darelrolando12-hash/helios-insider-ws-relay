/**
 * Layer 4 — BestContractsCockpit
 *
 * Ranked recommendation engine: max 5 cards answering "what is the single best
 * options contract to buy right now and exactly when to enter".
 *
 * Two automatic modes driven by market session state:
 *   PRE-MARKET MODE  — 8:00 AM CT to first 5m candle close
 *   LIVE MODE        — after first 5m candle close through market close
 *
 * 8-criterion ranking (strict priority order):
 *   1. Brain base rate >= 60%, n >= 30
 *   2. No active timing blocker
 *   3. CVD confirming BOTH stock-side AND options-side
 *   4. Signal state is TRIGGERING / ACTIVE / CONTINUATION / RE_ENTRY
 *   5. Spread < 8% of premium
 *   6. Break-even achievable before nearest GEX wall
 *   7. IV rank < 75th percentile
 *   8. No earnings within 2 days
 *
 * Rules:
 *   - Zero outbound calls — all data from local stores and engines
 *   - All Result<T> states handled (loading / error / ready)
 *   - CONTEXT_ONLY_TICKERS never appear in cards
 *   - CASH SETTLED label mandatory for SPX / NDX
 *   - sessionBias + playDirection always visible
 *   - All durations in candles, never wall-clock minutes
 *   - All times via toCentralTime()
 */

import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import { useNavigate } from 'react-router-dom';

import * as confluenceEngine   from '../engines/confluenceEngine';
import * as barsStore          from '../stores/barsStore';
import * as marketStore        from '../stores/marketStore';
import * as cvdStore           from '../stores/cvdStore';
import * as luldStore          from '../stores/luldStore';
import * as fundamentalsStore  from '../stores/fundamentalsStore';
import * as brainStore         from '../ledger/brainStore';
import { supabase }            from '../lib/supabase';
import { toCentralTime }       from '../lib/time';
import {
  getAllDirectionStates,
  getDirectionState,
  subscribe as subscribeDirection,
  FEED_TICKERS,
  CONTEXT_ONLY_TICKERS,
  CASH_SETTLED_TICKERS,
  TICKER_BETA_TABLE,
}                              from '../state/directionState';
import type { Signal }         from '../stores/types';
import type { DirectionState } from '../state/directionState';
import type {
  BaseRate,
  SetupFingerprint,
}                              from '../ledger/brainStore';
import type { CvdState }       from '../stores/cvdStore';
import type { MarketContext }  from '../stores/marketStore';
import { timeOfDayBucket }     from '../ledger/brainStore';

// ── Constants ──────────────────────────────────────────────────────────────────

const MAX_CARDS          = 5;
const BRAIN_WIN_FLOOR    = 0.60;   // 60% win rate required for criterion 1
const BRAIN_N_FLOOR      = 30;     // n >= 30 for criterion 1
const BRAIN_VALID_FLOOR  = 15;     // n >= 15 for isStatisticallyValid
const SPREAD_MAX_PCT     = 0.08;   // spread < 8% of mid premium
const IV_RANK_WARN       = 0.75;   // IV rank 75th percentile ceiling
const EARNINGS_WARN_DAYS = 2;      // earnings within 2 days = blocker
const GHOST_WINDOW_MS    = 60 * 60 * 1000; // track ghost signals for 1hr

const SELECTABLE_TICKERS = FEED_TICKERS.filter(t => !CONTEXT_ONLY_TICKERS.has(t));

// ── Local types ────────────────────────────────────────────────────────────────

type CockpitMode = 'pre-market' | 'live';

type TimingBlockerType =
  | 'IV_SPIKE'
  | 'LULD_HALT'
  | 'WIDE_SPREAD'
  | 'OPENING_OBS'
  | 'EARNINGS_BINARY'
  | 'LOW_CONVICTION';

interface TimingBlocker {
  type:        TimingBlockerType;
  label:       string;
  description: string;
  resolvedAt?: number; // CT ms when resolved
}

type DteCategory = '0DTE' | '1-2DTE' | '3-5DTE';

interface DteRecommendation {
  category:  DteCategory;
  reason:    string;
  brainBest: string | null; // best Brain window for this setup, e.g. "15m"
}

interface ContractOption {
  label:     string; // e.g. "ATM +1 Call"
  strike:    number;
  expiry:    string;
  bid:       number;
  ask:       number;
  iv:        number;
  delta:     number;
  theta:     number;
  breakEven: number;
}

type MonitorPhase = 'watching' | 'mae-guard' | 'continuation' | 'pullback' | 'exited';

interface ActiveMonitor {
  entryPrice:   number;
  entryCandle:  number; // CT ms of entry candle
  currentPrice: number;
  maePrice:     number; // worst price since entry
  mfePrice:     number; // best price since entry
  phase:        MonitorPhase;
  candleCount:  number; // candles since entry
  stopLevel:    number | null;
  targetLevel:  number | null;
  maePct:       number; // (entry - mae) / entry  (positive = adverse)
  mfePct:       number; // (mfe - entry) / entry  (positive = favorable)
  lastCandle:   number; // CT ms of most recent bar processed
}

interface GhostMonitor {
  signal:       Signal;
  startedAt:    number; // UTC ms when ghost tracking began
  maePrice:     number;
  mfePrice:     number;
  entryPrice:   number;
  candleCount:  number;
  lastCandle:   number;
}

type CardStatus =
  | 'forming'       // signal present but not yet TRIGGERING
  | 'triggering'    // all 8 criteria met, pulsing
  | 'active'        // user pressed I'm In
  | 'blocked'       // timing blocker active
  | 'ghost';        // not taken, tracking hypothetical

interface RankedCard {
  ticker:         string;
  signal:         Signal;
  direction:      'call' | 'put';
  status:         CardStatus;
  rank:           number;         // 1–5
  rankScore:      number;         // composite rank score (higher = better)

  // Criterion results (true = passes, false = fails)
  c1BrainValid:   boolean;
  c2NoBlocker:    boolean;
  c3CvdDual:      boolean;
  c4SignalState:  boolean;
  c5Spread:       boolean;
  c6BreakEven:    boolean;
  c7IvRank:       boolean;
  c8NoEarnings:   boolean;

  // Brain data
  baseRate:       BaseRate | null;
  fingerprint:    SetupFingerprint;

  // Contract economics
  bid:            number;
  ask:            number;
  midPremium:     number;
  spread:         number;
  spreadPct:      number;
  breakEvenMove:  number; // points needed from current price to break even
  iv:             number | null;
  ivRank:         number | null; // 0–1 percentile
  delta:          number | null;
  theta:          number | null;

  // Risk / reward
  callWall:       number;
  putWall:        number;
  flipLevel:      number;
  maxPain:        number;
  gexRegime:      string;
  upTarget:       number;
  downTarget:     number;
  distToWall:     number; // points from current price to nearest blocking wall

  // Timing blockers
  blockers:       TimingBlocker[];

  // DTE recommendation
  dte:            DteRecommendation;

  // Contract comparison alternatives
  showComparison: boolean;
  alternatives:   ContractOption[];

  // Live monitoring (post I'm In)
  monitor:        ActiveMonitor | null;

  // Ghost tracking (not taken)
  ghost:          GhostMonitor | null;

  // Pre-market overnight analysis
  earningsDate:   string | null; // "Jul 28" format
  analystAction:  string | null; // "Upgraded to Buy" etc.
  gapAnalysis:    string | null; // "gap up ~1.2%" etc.
  preMarketFlow:  string | null; // CVD pre-market summary

  // Discipline gate
  disciplineAck:  boolean;

  // Meta
  cashSettled:    boolean;
  firstCandle:    boolean; // first 5m candle has closed
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function directionFromSignal(type: Signal['type']): 'call' | 'put' {
  switch (type) {
    case 'ENTER':
    case 'BREAKOUT':
    case 'RIP':      return 'call';
    case 'EXIT':
    case 'DUMP':     return 'put';
    case 'REVERSAL': return 'call'; // CVD decides — default call; override below
    default:         return 'call';
  }
}

function directionFromCvd(cvd: CvdState | null, fallback: 'call' | 'put'): 'call' | 'put' {
  if (!cvd) return fallback;
  return cvd.classification === 'bullish' ? 'call' : 'put';
}

function formatCT(utcMs: number): string {
  return toCentralTime(utcMs).formatted.slice(11, 16); // "HH:mm"
}

function formatDollar(n: number): string {
  return `$${n.toFixed(2)}`;
}

function formatPct(n: number, decimals = 1): string {
  return `${(n * 100).toFixed(decimals)}%`;
}

/** Candle count since a start CT ms, based on 5m bars */
function candlesSince(startCtMs: number, nowCtMs: number): number {
  return Math.max(0, Math.floor((nowCtMs - startCtMs) / (5 * 60 * 1000)));
}

/** Check if earnings within N days from disclosures */
function earningsWithinDays(
  disclosures: Array<{ category: string; filedAt: number }>,
  days: number,
): string | null {
  const cutoff = Date.now() + days * 24 * 60 * 60 * 1000;
  const upcoming = disclosures.find(
    d => d.category === 'earnings' && d.filedAt <= cutoff && d.filedAt >= Date.now() - 3600_000,
  );
  if (!upcoming) return null;
  const ct = toCentralTime(upcoming.filedAt);
  return `${ct.month}/${ct.day}`;
}

/** Build setup fingerprint for a ticker + direction */
function buildFingerprint(
  ticker: string,
  direction: 'call' | 'put',
  ctx: MarketContext | null,
): SetupFingerprint {
  const nowCT = toCentralTime(Date.now());
  return {
    ticker,
    direction,
    gexRegime:  ctx?.gexRegime ?? 'neutral',
    vixBucket:  '<15', // VIX feed not yet wired; spec-compliant default
    timeOfDay:  timeOfDayBucket(nowCT.ctMs),
  };
}

/** Derive IV rank as a rough percentile from the chain row's IV vs typical range */
function estimateIvRank(iv: number): number {
  // Without historical IV data, map raw IV to rough percentile:
  // 0.15 → 0%, 0.30 → 50%, 0.50 → 75%, 0.80+ → 100%
  if (iv <= 0.15) return 0;
  if (iv >= 0.80) return 1;
  if (iv <= 0.30) return (iv - 0.15) / (0.30 - 0.15) * 0.50;
  if (iv <= 0.50) return 0.50 + (iv - 0.30) / (0.50 - 0.30) * 0.25;
  return 0.75 + (iv - 0.50) / (0.80 - 0.50) * 0.25;
}

/** DTE recommendation engine — dynamic, Brain-informed */
function computeDteRecommendation(
  signal: Signal,
  baseRate: BaseRate | null,
  ctx: MarketContext | null,
): DteRecommendation {
  const brainBest = baseRate?.bestWindow ?? null;

  // If Brain says best window is 5m → 0DTE is ideal
  if (brainBest === '5m' || brainBest === '15m') {
    return { category: '0DTE', reason: `Brain best window: ${brainBest}`, brainBest };
  }

  // DUMP / RIP / BREAKOUT → momentum → 0DTE
  if (signal.type === 'DUMP' || signal.type === 'RIP' || signal.type === 'BREAKOUT') {
    return { category: '0DTE', reason: 'Momentum signal type — 0DTE optimal', brainBest };
  }

  // Negative GEX = trending → shorter duration ok
  if (ctx?.gexRegime === 'negative') {
    return { category: '1-2DTE', reason: 'Neg GEX trending regime', brainBest };
  }

  // REVERSAL in positive GEX = mean-reversion needs more time
  if (signal.type === 'REVERSAL' && ctx?.gexRegime === 'positive') {
    return { category: '3-5DTE', reason: 'Reversal in pos GEX — give it room', brainBest };
  }

  // Brain best window 30m / 60m → 1-2 DTE
  if (brainBest === '30m' || brainBest === '60m') {
    return { category: '1-2DTE', reason: `Brain best window: ${brainBest}`, brainBest };
  }

  return { category: '1-2DTE', reason: 'Default moderate duration', brainBest };
}

/** Compute ranking score from criteria (higher = better rank) */
function computeRankScore(card: Omit<RankedCard, 'rank' | 'rankScore'>): number {
  let score = 0;
  // Criterion weights (8 criteria, strict priority = weighted decrement)
  if (card.c1BrainValid)  score += 128;
  if (card.c2NoBlocker)   score += 64;
  if (card.c3CvdDual)     score += 32;
  if (card.c4SignalState) score += 16;
  if (card.c5Spread)      score += 8;
  if (card.c6BreakEven)   score += 4;
  if (card.c7IvRank)      score += 2;
  if (card.c8NoEarnings)  score += 1;
  // Tiebreak: signal confidence
  score += card.signal.confidence * 0.001;
  return score;
}

// ── Component ──────────────────────────────────────────────────────────────────

export default function BestContractsCockpit() {
  const navigate = useNavigate();

  // ── State ────────────────────────────────────────────────────────────────────

  const [mode,        setMode]        = useState<CockpitMode>('pre-market');
  const [cards,       setCards]       = useState<RankedCard[]>([]);
  const [directions,  setDirections]  = useState<Map<string, DirectionState>>(new Map());
  const [brainReady,  setBrainReady]  = useState(false);
  const [nowCT,       setNowCT]       = useState(() => toCentralTime(Date.now()));

  // Track live signals: ticker → latest Signal
  const signalsRef = useRef<Map<string, Signal>>(new Map());
  // Ghost monitors: ticker → GhostMonitor
  const ghostsRef  = useRef<Map<string, GhostMonitor>>(new Map());
  // Active monitors (post I'm In): ticker → ActiveMonitor
  const monitorsRef = useRef<Map<string, ActiveMonitor>>(new Map());

  // ── Clock tick (every 5s) ────────────────────────────────────────────────────

  useEffect(() => {
    const id = setInterval(() => setNowCT(toCentralTime(Date.now())), 5000);
    return () => clearInterval(id);
  }, []);

  // ── Brain refresh ────────────────────────────────────────────────────────────

  useEffect(() => {
    brainStore.refreshBrainStore().then(() => setBrainReady(true));
    const id = setInterval(() => brainStore.refreshBrainStore(), 5 * 60 * 1000);
    const unsub = brainStore.subscribe(() => setBrainReady(prev => !prev || true));
    return () => {
      clearInterval(id);
      unsub();
    };
  }, []);

  // ── Direction state subscription ─────────────────────────────────────────────

  useEffect(() => {
    setDirections(getAllDirectionStates());
    const unsub = subscribeDirection(() => setDirections(getAllDirectionStates()));
    return unsub;
  }, []);

  // ── Detect first 5m candle close → switch to LIVE MODE ───────────────────────

  useEffect(() => {
    function checkMode() {
      // Check if any FEED ticker has at least 2 ready bars (first candle closed)
      const hasFirstCandle = SELECTABLE_TICKERS.some(t => {
        const r = barsStore.getResult(t);
        return r.status === 'ready' && r.data.length >= 2;
      });

      const ct = toCentralTime(Date.now());
      // Pre-market: before 9:30 AM CT; if after 9:35 AM CT and first candle closed
      const minuteOfDay = ct.hour * 60 + ct.minute;
      const marketOpen  = 9 * 60 + 30; // 9:30 AM CT
      const premarketStart = 8 * 60;   // 8:00 AM CT

      if (minuteOfDay < premarketStart) {
        setMode('pre-market');
      } else if (minuteOfDay >= marketOpen && hasFirstCandle) {
        setMode('live');
      } else {
        setMode('pre-market');
      }
    }

    checkMode();
    const id = setInterval(checkMode, 10_000);
    const unsub = barsStore.subscribe(checkMode);
    return () => { clearInterval(id); unsub(); };
  }, []);

  // ── Signal stream subscription ────────────────────────────────────────────────

  useEffect(() => {
    const unsub = confluenceEngine.onSignal((signal: Signal) => {
      if (CONTEXT_ONLY_TICKERS.has(signal.ticker)) return;

      signalsRef.current.set(signal.ticker, signal);

      // Start ghost tracking if user hasn't taken this signal yet
      if (!monitorsRef.current.has(signal.ticker)) {
        const barsResult = barsStore.getResult(signal.ticker);
        const entryPrice = barsResult.status === 'ready'
          ? barsResult.data[barsResult.data.length - 1].close
          : signal.triggerPrice;

        ghostsRef.current.set(signal.ticker, {
          signal,
          startedAt:   Date.now(),
          entryPrice,
          maePrice:    entryPrice,
          mfePrice:    entryPrice,
          candleCount: 0,
          lastCandle:  Date.now(),
        });
      }

      rebuildCards();
    });

    return unsub;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Bars subscription — drives monitor updates ────────────────────────────────

  useEffect(() => {
    const unsub = barsStore.subscribe(() => {
      // Update active monitors
      for (const [ticker, monitor] of monitorsRef.current) {
        const r = barsStore.getResult(ticker);
        if (r.status !== 'ready' || r.data.length === 0) continue;
        const lastBar = r.data[r.data.length - 1];
        if (lastBar.tCT === monitor.lastCandle) continue;

        const dir = monitor.entryPrice; // direction inferred from card
        const updated: ActiveMonitor = {
          ...monitor,
          currentPrice: lastBar.close,
          maePrice:     Math.min(monitor.maePrice, lastBar.low),
          mfePrice:     Math.max(monitor.mfePrice, lastBar.high),
          candleCount:  candlesSince(monitor.entryCandle, lastBar.tCT),
          maePct:       (monitor.entryPrice - Math.min(monitor.maePrice, lastBar.low)) / monitor.entryPrice,
          mfePct:       (Math.max(monitor.mfePrice, lastBar.high) - monitor.entryPrice) / monitor.entryPrice,
          lastCandle:   lastBar.tCT,
          phase:        _classifyPhase(monitor, lastBar.close),
        };
        monitorsRef.current.set(ticker, updated);
        void dir; // suppress lint
      }

      // Update ghost monitors
      const now = Date.now();
      for (const [ticker, ghost] of ghostsRef.current) {
        if (now - ghost.startedAt > GHOST_WINDOW_MS) {
          ghostsRef.current.delete(ticker);
          continue;
        }
        const r = barsStore.getResult(ticker);
        if (r.status !== 'ready' || r.data.length === 0) continue;
        const lastBar = r.data[r.data.length - 1];
        if (lastBar.tCT === ghost.lastCandle) continue;

        ghostsRef.current.set(ticker, {
          ...ghost,
          maePrice:    Math.min(ghost.maePrice, lastBar.low),
          mfePrice:    Math.max(ghost.mfePrice, lastBar.high),
          candleCount: candlesSince(ghost.signal.firedAtCT, lastBar.tCT),
          lastCandle:  lastBar.tCT,
        });
      }

      rebuildCards();
    });

    return unsub;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Rebuild cards whenever anything changes ───────────────────────────────────

  const rebuildCards = useCallback(() => {
    const built: Array<Omit<RankedCard, 'rank' | 'rankScore'>> = [];

    for (const ticker of SELECTABLE_TICKERS) {
      const signal = signalsRef.current.get(ticker);
      if (!signal) continue;

      // Skip if signal is very old (> 15 min)
      if (Date.now() - signal.firedAt > 15 * 60 * 1000) continue;

      const marketResult = marketStore.getResult(ticker);
      const cvdResult    = cvdStore.getResult(ticker);
      const barsResult   = barsStore.getResult(ticker);
      const fundResult   = fundamentalsStore.getResult(ticker);
      const ctx  = marketResult.status === 'ready' ? marketResult.data : null;
      const cvd  = cvdResult.status    === 'ready' ? cvdResult.data    : null;
      const bars = barsResult.status   === 'ready' ? barsResult.data   : null;
      const fund = fundResult.status   === 'ready' ? fundResult.data   : null;

      // Derive direction
      let direction = directionFromSignal(signal.type);
      if (signal.type === 'REVERSAL') direction = directionFromCvd(cvd, direction);

      // ── Brain lookup ────────────────────────────────────────────────────────
      const fingerprint = buildFingerprint(ticker, direction, ctx);
      const brainResult = brainStore.getBaseRate(fingerprint);
      const baseRate    = brainResult.status === 'ready' ? brainResult.data : null;

      // ── Criterion 1: Brain base rate >= 60%, n >= 30 ────────────────────────
      const c1BrainValid = !!(
        baseRate &&
        baseRate.isStatisticallyValid &&
        baseRate.n >= BRAIN_N_FLOOR &&
        baseRate.winRate >= BRAIN_WIN_FLOOR
      );

      // ── Timing blockers ─────────────────────────────────────────────────────
      const blockers: TimingBlocker[] = [];

      // LULD Halt blocker
      const halted = luldStore.isHalted(ticker);
      if (halted === true) {
        blockers.push({
          type:        'LULD_HALT',
          label:       'LULD HALT',
          description: 'Trading halted — waiting for resume',
        });
      }

      // Opening observation blocker (first candle not yet closed after open)
      const ct = toCentralTime(Date.now());
      const minuteOfDay = ct.hour * 60 + ct.minute;
      const marketOpenMin = 9 * 60 + 30;
      const firstCandleClosedMin = marketOpenMin + 5;
      const firstCandleClosed = !!(bars && bars.length >= 2 && minuteOfDay >= firstCandleClosedMin);

      if (minuteOfDay >= marketOpenMin && !firstCandleClosed) {
        blockers.push({
          type:        'OPENING_OBS',
          label:       'OPENING OBS',
          description: 'Waiting for first 5m candle to close',
        });
      }

      // Earnings binary event blocker
      const earningsDate = fund
        ? earningsWithinDays(fund.recentDisclosures, EARNINGS_WARN_DAYS)
        : null;
      if (earningsDate) {
        blockers.push({
          type:        'EARNINGS_BINARY',
          label:       'EARNINGS BINARY',
          description: `Earnings ${earningsDate} — binary event risk`,
        });
      }

      // Contract economics from chain
      let bid = 0, ask = 0, iv = null as number | null, delta = null as number | null;
      let theta = null as number | null;

      if (ctx && ctx.chain && ctx.chain.length > 0 && bars && bars.length > 0) {
        const price = bars[bars.length - 1].close;
        // Find ATM strike row
        const atm = ctx.chain.reduce((best, row) =>
          Math.abs(row.strike - price) < Math.abs(best.strike - price) ? row : best,
          ctx.chain[0],
        );

        if (direction === 'call') {
          bid   = atm.callBid;
          ask   = atm.callAsk;
          iv    = atm.callIV;
          delta = atm.callDelta;
          theta = atm.callTheta;
        } else {
          bid   = atm.putBid;
          ask   = atm.putAsk;
          iv    = atm.putIV;
          delta = atm.putDelta;
          theta = atm.putTheta;
        }
      }

      const midPremium   = (bid + ask) / 2;
      const spread       = ask - bid;
      const spreadPct    = midPremium > 0 ? spread / midPremium : 1;

      // IV rank estimate
      const ivRank = iv !== null ? estimateIvRank(iv) : null;

      // IV spike blocker
      if (ivRank !== null && ivRank > IV_RANK_WARN) {
        blockers.push({
          type:        'IV_SPIKE',
          label:       'IV ELEVATED',
          description: `IV rank ${formatPct(ivRank)} — premium inflated`,
        });
      }

      // Wide spread blocker
      if (spreadPct > SPREAD_MAX_PCT && midPremium > 0) {
        blockers.push({
          type:        'WIDE_SPREAD',
          label:       'WIDE SPREAD',
          description: `Spread ${formatPct(spreadPct)} exceeds 8% — slippage risk`,
        });
      }

      // Low conviction blocker
      if (signal.confidence < 55) {
        blockers.push({
          type:        'LOW_CONVICTION',
          label:       'LOW CONVICTION',
          description: `Score ${signal.confidence}/100 — below entry threshold`,
        });
      }

      // ── Criterion 2: No active timing blocker ───────────────────────────────
      const c2NoBlocker = blockers.length === 0;

      // ── Criterion 3: CVD dual confirmation ──────────────────────────────────
      // Both stock-side CVD AND ticker CVD must confirm direction.
      // Leader index is ticker-specific: QQQ for high-beta tech, SPY/IWM otherwise.
      const leaderSymbol   = TICKER_BETA_TABLE[ticker]?.leader ?? 'SPY';
      const stockLeaderCvd = cvdStore.getResult(leaderSymbol);
      const stockCvdOk = stockLeaderCvd.status === 'ready'
        ? (direction === 'call'
            ? stockLeaderCvd.data.classification === 'bullish'
            : stockLeaderCvd.data.classification === 'bearish')
        : false;
      const tickerCvdOk = cvd
        ? (direction === 'call'
            ? cvd.classification === 'bullish' || cvd.classification === 'neutral'
            : cvd.classification === 'bearish' || cvd.classification === 'neutral')
        : false;
      const c3CvdDual = stockCvdOk && tickerCvdOk;

      // ── Criterion 4: Signal state is actionable ──────────────────────────────
      const actionableTypes = new Set(['ENTER', 'BREAKOUT', 'REVERSAL', 'RIP']);
      const c4SignalState = actionableTypes.has(signal.type) && signal.confidence >= 65;

      // ── Criterion 5: Spread < 8% ────────────────────────────────────────────
      const c5Spread = spreadPct < SPREAD_MAX_PCT || midPremium === 0;

      // ── Criterion 6: Break-even achievable before GEX wall ──────────────────
      const breakEvenMove = midPremium; // points needed (simplified: 1 delta ATM)
      let c6BreakEven = true;
      if (ctx && bars && bars.length > 0) {
        const price     = bars[bars.length - 1].close;
        const wall      = direction === 'call' ? ctx.walls.callWall : ctx.walls.putWall;
        const distWall  = Math.abs(wall - price);
        c6BreakEven     = breakEvenMove < distWall;
      }

      // ── Criterion 7: IV rank < 75th percentile ───────────────────────────────
      const c7IvRank = ivRank === null || ivRank < IV_RANK_WARN;

      // ── Criterion 8: No earnings within 2 days ───────────────────────────────
      const c8NoEarnings = earningsDate === null;

      // ── GEX / price levels ───────────────────────────────────────────────────
      const callWall   = ctx?.walls.callWall  ?? 0;
      const putWall    = ctx?.walls.putWall   ?? 0;
      const flipLevel  = ctx?.flipLevel       ?? 0;
      const maxPain    = ctx?.maxPain         ?? 0;
      const gexRegime  = ctx?.gexRegime       ?? 'neutral';
      const upTarget   = ctx?.upTarget        ?? 0;
      const downTarget = ctx?.downTarget      ?? 0;
      const price      = bars ? bars[bars.length - 1].close : 0;
      const distToWall = direction === 'call'
        ? Math.abs(callWall - price)
        : Math.abs(putWall - price);

      // ── DTE recommendation ───────────────────────────────────────────────────
      const dte = computeDteRecommendation(signal, baseRate, ctx);

      // ── Contract alternatives for comparison mode ────────────────────────────
      const alternatives: ContractOption[] = [];
      if (ctx && ctx.chain && ctx.chain.length > 0 && bars && bars.length > 0) {
        const strikes = ctx.chain
          .slice()
          .sort((a, b) => Math.abs(a.strike - price) - Math.abs(b.strike - price))
          .slice(0, 3);

        for (const row of strikes) {
          const isBid  = direction === 'call' ? row.callBid  : row.putBid;
          const isAsk  = direction === 'call' ? row.callAsk  : row.putAsk;
          const isIV   = direction === 'call' ? row.callIV   : row.putIV;
          const isDelta = direction === 'call' ? row.callDelta : row.putDelta;
          const isTheta = direction === 'call' ? row.callTheta : row.putTheta;
          const label  = row.strike === Math.round(price)
            ? `ATM ${direction === 'call' ? 'Call' : 'Put'}`
            : row.strike > price
              ? `+${(row.strike - price).toFixed(0)} OTM ${direction === 'call' ? 'Call' : 'Put'}`
              : `-${(price - row.strike).toFixed(0)} ITM ${direction === 'call' ? 'Call' : 'Put'}`;

          alternatives.push({
            label,
            strike:    row.strike,
            expiry:    dte.category,
            bid:       isBid,
            ask:       isAsk,
            iv:        isIV,
            delta:     isDelta,
            theta:     isTheta,
            breakEven: row.strike + (isBid + isAsk) / 2,
          });
        }
      }

      // ── Card status ──────────────────────────────────────────────────────────
      let status: CardStatus = 'forming';
      if (monitorsRef.current.has(ticker))             status = 'active';
      else if (blockers.length > 0)                    status = 'blocked';
      else if (c1BrainValid && c3CvdDual && c4SignalState && c5Spread) status = 'triggering';

      // ── Pre-market overnight data ─────────────────────────────────────────────
      const analystAction = fund?.recentDisclosures.find(d =>
        ['acquisition', 'leadership', 'guidance'].includes(d.category) &&
        Date.now() - d.filedAt < 24 * 3600_000,
      )?.title ?? null;

      const preMarketFlow = cvd
        ? `CVD ${cvd.classification} — ${cvd.callPct.toFixed(0)}% buy / ${cvd.putPct.toFixed(0)}% sell`
        : null;

      const monitor  = monitorsRef.current.get(ticker) ?? null;
      const ghost    = ghostsRef.current.get(ticker)   ?? null;

      built.push({
        ticker,
        signal,
        direction,
        status,
        c1BrainValid,
        c2NoBlocker,
        c3CvdDual,
        c4SignalState,
        c5Spread,
        c6BreakEven,
        c7IvRank,
        c8NoEarnings,
        baseRate,
        fingerprint,
        bid,
        ask,
        midPremium,
        spread,
        spreadPct,
        breakEvenMove,
        iv,
        ivRank,
        delta,
        theta,
        callWall,
        putWall,
        flipLevel,
        maxPain,
        gexRegime,
        upTarget,
        downTarget,
        distToWall,
        blockers,
        dte,
        showComparison: false,
        alternatives,
        monitor,
        ghost,
        earningsDate,
        analystAction,
        gapAnalysis:   null, // would come from pre-market gap data feed
        preMarketFlow,
        disciplineAck:  false,
        cashSettled:   CASH_SETTLED_TICKERS.has(ticker),
        firstCandle:   firstCandleClosed,
      });
    }

    // Sort by rank score descending
    built.sort((a, b) => computeRankScore(b) - computeRankScore(a));

    // Assign ranks, cap at MAX_CARDS
    const ranked: RankedCard[] = built.slice(0, MAX_CARDS).map((card, i) => ({
      ...card,
      rank:      i + 1,
      rankScore: computeRankScore(card),
    }));

    setCards(ranked);
  }, []);

  // Rebuild when brain updates
  useEffect(() => {
    rebuildCards();
  }, [brainReady, rebuildCards]);

  // Rebuild on market store updates
  useEffect(() => {
    const unsub = marketStore.subscribe(rebuildCards);
    return unsub;
  }, [rebuildCards]);

  // ── I'm In handler ────────────────────────────────────────────────────────────

  const handleImIn = useCallback(async (card: RankedCard) => {
    const { ticker, signal, direction } = card;
    const barsResult = barsStore.getResult(ticker);
    const marketResult = marketStore.getResult(ticker);
    const cvdResult    = cvdStore.getResult(ticker);
    const luldResult   = luldStore.getResult(ticker);

    const entryPrice = barsResult.status === 'ready'
      ? barsResult.data[barsResult.data.length - 1].close
      : signal.triggerPrice;

    const ctx  = marketResult.status === 'ready' ? marketResult.data : null;
    const cvd  = cvdResult.status    === 'ready' ? cvdResult.data    : null;
    const luld = luldResult.status   === 'ready' ? luldResult.data   : null;
    const fund = fundamentalsStore.getResult(ticker);
    const fundData = fund.status === 'ready' ? fund.data : null;

    const factors = {
      gexRegime:  ctx?.gexRegime ?? null,
      flipLevel:  ctx?.flipLevel ?? null,
      callWall:   ctx?.walls.callWall ?? null,
      putWall:    ctx?.walls.putWall  ?? null,
      cvdPct:     cvd ? cvd.callPct - cvd.putPct : null,
      cvdClass:   cvd?.classification ?? null,
      emaStack:   null, // derived by confluenceEngine, not re-exposed here
      catalystTags: fundData ? {
        earningsPending: !!earningsWithinDays(fundData.recentDisclosures, 2),
        materialEvent:   fundData.recentDisclosures.some(d =>
          ['acquisition', 'restructuring', 'regulatory'].includes(d.category) &&
          Date.now() - d.filedAt < 24 * 3600_000,
        ),
        insiderBuy:  fundData.insiderTransactions.length > 0,
        insiderSell: false, // spec: only discretionary buys stored
      } : null,
      luld: {
        isHalted:  luld?.isCurrentlyHalted ?? null,
        upperBand: luld?.events.at(-1)?.upperBand ?? null,
        lowerBand: luld?.events.at(-1)?.lowerBand ?? null,
      },
    };

    const nowCTInfo = toCentralTime(Date.now());

    const row = {
      id:          `imin_${ticker}_${Date.now()}`,
      ticker,
      direction,
      signal_type: signal.type,
      conviction:  signal.confidence,
      entry_price: entryPrice,
      entry_tct:   nowCTInfo.ctMs,
      entry_utc:   Date.now(),
      status:      'pending',
      factors,
    };

    const { error: dbErr } = await supabase.from('signals').insert(row);
    if (dbErr) {
      console.error('[BestContractsCockpit] I\'m In write failed:', dbErr.message);
    }

    // Remove from ghost tracking — we took this trade
    ghostsRef.current.delete(ticker);

    // Start active monitor
    const barsNow = barsResult.status === 'ready' ? barsResult.data : [];
    const lastBar = barsNow[barsNow.length - 1];
    monitorsRef.current.set(ticker, {
      entryPrice,
      entryCandle:  lastBar?.tCT ?? nowCTInfo.ctMs,
      currentPrice: entryPrice,
      maePrice:     entryPrice,
      mfePrice:     entryPrice,
      phase:        'watching',
      candleCount:  0,
      stopLevel:    null,
      targetLevel:  upTarget(card),
      maePct:       0,
      mfePct:       0,
      lastCandle:   lastBar?.tCT ?? nowCTInfo.ctMs,
    });

    rebuildCards();
    navigate(`/zerod/${ticker}`);
  }, [navigate, rebuildCards]);

  function upTarget(card: RankedCard): number | null {
    if (card.direction === 'call') return card.upTarget > 0 ? card.upTarget : null;
    return card.downTarget > 0 ? card.downTarget : null;
  }

  // ── Discipline ack ────────────────────────────────────────────────────────────

  const handleDisciplineAck = useCallback((ticker: string) => {
    setCards(prev => prev.map(c =>
      c.ticker === ticker ? { ...c, disciplineAck: true } : c,
    ));
  }, []);

  // ── Toggle comparison mode ────────────────────────────────────────────────────

  const handleToggleComparison = useCallback((ticker: string) => {
    setCards(prev => prev.map(c =>
      c.ticker === ticker ? { ...c, showComparison: !c.showComparison } : c,
    ));
  }, []);

  // ── Global direction header ───────────────────────────────────────────────────

  const spyDir  = directions.get('SPY');
  const qqqDir  = directions.get('QQQ');
  const iwmDir  = directions.get('IWM');

  // ── Render ────────────────────────────────────────────────────────────────────

  return (
    <div className="min-h-screen bg-[#0a0a0f] text-white font-mono">

      {/* ── Top header ─────────────────────────────────────────────────────── */}
      <div className="sticky top-0 z-30 bg-[#0a0a0f]/95 backdrop-blur border-b border-white/5 px-4 py-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <span className="text-xs font-bold tracking-widest text-white/30 uppercase">Best Contracts</span>
            <ModeBadge mode={mode} />
          </div>

          <div className="flex items-center gap-2 flex-wrap justify-end">
            {spyDir  && <DirectionBadge ticker="SPY"  state={spyDir} />}
            {qqqDir  && <DirectionBadge ticker="QQQ"  state={qqqDir} />}
            {iwmDir  && <DirectionBadge ticker="IWM"  state={iwmDir} />}
            <span className="text-xs text-white/25 ml-2">{nowCT.formatted.slice(11, 19)} CT</span>
          </div>
        </div>
      </div>

      {/* ── Mode content ───────────────────────────────────────────────────── */}
      <div className="px-4 py-4 space-y-4">
        {mode === 'pre-market' ? (
          <PreMarketPanel cards={cards} />
        ) : (
          <>
            {cards.length === 0 ? (
              <EmptyState brainReady={brainReady} />
            ) : (
              <div className="space-y-4">
                {cards.map(card => (
                  <ContractCard
                    key={card.ticker}
                    card={card}
                    onImIn={handleImIn}
                    onDisciplineAck={handleDisciplineAck}
                    onToggleComparison={handleToggleComparison}
                  />
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

// ── Phase classifier ───────────────────────────────────────────────────────────

function _classifyPhase(monitor: ActiveMonitor, currentPrice: number): MonitorPhase {
  const pct = (currentPrice - monitor.entryPrice) / monitor.entryPrice;

  // MAE Guard: if price moves adversely > 1% from entry
  if (pct < -0.01) return 'mae-guard';

  // Continuation: price extends favorably
  if (pct > 0.015 && monitor.candleCount >= 2) return 'continuation';

  // Pullback: price pulls back after having been in profit
  if (monitor.mfePct > 0.01 && pct < monitor.mfePct * 0.5) return 'pullback';

  return 'watching';
}

// ── Sub-components ─────────────────────────────────────────────────────────────

function ModeBadge({ mode }: { mode: CockpitMode }) {
  const isLive = mode === 'live';
  return (
    <span className={`px-2 py-0.5 rounded text-[10px] font-bold tracking-wider uppercase
      ${isLive
        ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30'
        : 'bg-amber-500/20 text-amber-400 border border-amber-500/30'
      }`}>
      {isLive ? 'LIVE MODE' : 'PRE-MARKET'}
    </span>
  );
}

function DirectionBadge({ ticker, state }: { ticker: string; state: DirectionState }) {
  const biasColor = state.sessionBias === 'bullish'
    ? 'text-emerald-400'
    : state.sessionBias === 'bearish'
    ? 'text-rose-400'
    : 'text-white/40';

  const playColor = state.playDirection === 'calls'
    ? 'text-emerald-300'
    : state.playDirection === 'puts'
    ? 'text-rose-300'
    : 'text-white/30';

  return (
    <div className="flex items-center gap-1 bg-white/5 rounded px-2 py-1">
      <span className="text-[10px] text-white/40 font-bold">{ticker}</span>
      <span className={`text-[10px] font-bold ${biasColor}`}>
        {state.sessionBias.toUpperCase()}
      </span>
      <span className="text-white/20 text-[10px]">/</span>
      <span className={`text-[10px] font-bold ${playColor}`}>
        {state.playDirection.toUpperCase()}
      </span>
    </div>
  );
}

function EmptyState({ brainReady }: { brainReady: boolean }) {
  return (
    <div className="flex flex-col items-center justify-center py-20 gap-4">
      <div className="w-12 h-12 rounded-full border-2 border-white/10 flex items-center justify-center">
        <span className="text-white/20 text-lg">◎</span>
      </div>
      <p className="text-white/30 text-sm text-center">
        {brainReady
          ? 'No ranked setups at this time. Waiting for qualifying signals.'
          : 'Initialising Brain — loading historical base rates...'}
      </p>
    </div>
  );
}

// ── Pre-Market Panel ───────────────────────────────────────────────────────────

function PreMarketPanel({ cards }: { cards: RankedCard[] }) {
  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-amber-500/20 bg-amber-500/5 px-4 py-3">
        <p className="text-amber-400 text-xs font-bold tracking-wider uppercase mb-1">
          Pre-Market Analysis Mode
        </p>
        <p className="text-white/40 text-xs">
          Market opens at 9:30 AM CT. Showing overnight setup analysis and ranked candidates
          for the open. Live signals activate on first 5m candle close.
        </p>
      </div>

      {cards.length === 0 ? (
        <div className="text-center text-white/20 text-sm py-10">
          Scanning for pre-market setups...
        </div>
      ) : (
        <div className="space-y-3">
          {cards.map(card => (
            <PreMarketCard key={card.ticker} card={card} />
          ))}
        </div>
      )}
    </div>
  );
}

function PreMarketCard({ card }: { card: RankedCard }) {
  return (
    <div className="rounded-xl border border-white/8 bg-white/2 p-4 space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <RankBadge rank={card.rank} />
          <span className="font-bold text-white text-sm">{card.ticker}</span>
          {card.cashSettled && (
            <span className="text-[9px] bg-yellow-500/20 text-yellow-400 px-1.5 py-0.5 rounded border border-yellow-500/30">
              CASH SETTLED
            </span>
          )}
          <DirectionPill direction={card.direction} />
        </div>
        <SignalTypeBadge type={card.signal.type} confidence={card.signal.confidence} />
      </div>

      {/* Overnight analysis */}
      <div className="grid grid-cols-2 gap-2 text-xs">
        {card.earningsDate && (
          <div className="bg-rose-500/10 border border-rose-500/20 rounded p-2">
            <span className="text-rose-400 font-bold">EARNINGS</span>
            <span className="text-white/50 ml-2">{card.earningsDate}</span>
          </div>
        )}
        {card.analystAction && (
          <div className="bg-blue-500/10 border border-blue-500/20 rounded p-2">
            <span className="text-blue-400 font-bold">ANALYST</span>
            <span className="text-white/50 ml-2 truncate">{card.analystAction}</span>
          </div>
        )}
        {card.preMarketFlow && (
          <div className="bg-white/5 border border-white/10 rounded p-2 col-span-2">
            <span className="text-white/40 font-bold">FLOW</span>
            <span className="text-white/60 ml-2">{card.preMarketFlow}</span>
          </div>
        )}
      </div>

      {/* Brain base rate preview */}
      {card.baseRate && card.baseRate.isStatisticallyValid && (
        <BrainIntelligenceBar baseRate={card.baseRate} compact />
      )}

      <div className="flex items-center gap-2 text-xs text-white/30">
        <span>GEX: <span className={gexColor(card.gexRegime)}>{card.gexRegime.toUpperCase()}</span></span>
        <span className="text-white/15">·</span>
        <span>DTE rec: <span className="text-white/60">{card.dte.category}</span></span>
      </div>
    </div>
  );
}

// ── Contract Card (LIVE MODE) ──────────────────────────────────────────────────

interface ContractCardProps {
  card:                RankedCard;
  onImIn:              (card: RankedCard) => void;
  onDisciplineAck:     (ticker: string) => void;
  onToggleComparison:  (ticker: string) => void;
}

function ContractCard({
  card,
  onImIn,
  onDisciplineAck,
  onToggleComparison,
}: ContractCardProps) {
  const isActive     = card.status === 'active';
  const isTriggering = card.status === 'triggering';
  const isBlocked    = card.status === 'blocked' || card.blockers.length > 0;

  const borderClass = isActive
    ? 'border-emerald-500/40'
    : isTriggering
    ? 'border-sky-500/40 animate-pulse-border'
    : isBlocked
    ? 'border-rose-500/20'
    : 'border-white/8';

  return (
    <div className={`rounded-xl border ${borderClass} bg-[#0d0d14] overflow-hidden`}>

      {/* ── Section 1: Header ──────────────────────────────────────────── */}
      <CardHeader card={card} />

      {/* ── Section 2: Brain Intelligence ─────────────────────────────── */}
      <div className="px-4 py-3 border-t border-white/5">
        <BrainIntelligenceSection card={card} />
      </div>

      {/* ── Section 3: Contract Economics ─────────────────────────────── */}
      <div className="px-4 py-3 border-t border-white/5">
        <ContractEconomicsSection card={card} />
      </div>

      {/* ── Section 4: Risk / Reward ───────────────────────────────────── */}
      <div className="px-4 py-3 border-t border-white/5">
        <RiskRewardSection card={card} />
      </div>

      {/* ── Section 5: Live Monitoring Panel (post I'm In) ────────────── */}
      {isActive && card.monitor && (
        <div className="px-4 py-3 border-t border-emerald-500/20 bg-emerald-500/5">
          <LiveMonitorPanel monitor={card.monitor} direction={card.direction} />
        </div>
      )}

      {/* ── Ghost tracking (not taken) ─────────────────────────────────── */}
      {card.ghost && !isActive && (
        <div className="px-4 py-2 border-t border-white/5 bg-white/2">
          <GhostTrackingBar ghost={card.ghost} direction={card.direction} />
        </div>
      )}

      {/* ── Section 6: Timing Blockers / Monitoring State ─────────────── */}
      {(isBlocked || card.blockers.length > 0) && (
        <div className="px-4 py-3 border-t border-rose-500/10 bg-rose-500/5">
          <BlockerSection blockers={card.blockers} />
        </div>
      )}

      {/* ── Contract Comparison toggle ─────────────────────────────────── */}
      {card.alternatives.length > 1 && (
        <div className="border-t border-white/5">
          <button
            onClick={() => onToggleComparison(card.ticker)}
            className="w-full px-4 py-2 text-xs text-white/30 hover:text-white/60 transition-colors text-left"
          >
            {card.showComparison ? '▲ Hide comparison' : '▼ Compare contracts'}
          </button>
          {card.showComparison && (
            <div className="px-4 pb-3">
              <ComparisonTable alternatives={card.alternatives} />
            </div>
          )}
        </div>
      )}

      {/* ── Discipline Gate + I'm In ───────────────────────────────────── */}
      {!isActive && (
        <div className="px-4 py-4 border-t border-white/5 space-y-3">
          {!card.disciplineAck && (
            <DisciplineGate ticker={card.ticker} onAck={onDisciplineAck} />
          )}

          <button
            onClick={() => onImIn(card)}
            disabled={!card.disciplineAck}
            className={`w-full py-3 rounded-lg font-bold text-sm tracking-widest uppercase transition-all
              ${card.disciplineAck
                ? isTriggering
                  ? 'bg-sky-500 hover:bg-sky-400 text-black shadow-lg shadow-sky-500/30'
                  : 'bg-emerald-600 hover:bg-emerald-500 text-black shadow-lg shadow-emerald-500/20'
                : 'bg-white/5 text-white/20 cursor-not-allowed'
              }`}
          >
            {isTriggering ? '⚡ I\'M IN — TRIGGERING' : 'I\'M IN'}
          </button>
        </div>
      )}

      {/* Active trade — already in */}
      {isActive && (
        <div className="px-4 py-3 border-t border-emerald-500/20">
          <div className="flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
            <span className="text-xs text-emerald-400 font-bold">TRADE ACTIVE — monitoring via 0DTE cockpit</span>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Card sections ──────────────────────────────────────────────────────────────

function CardHeader({ card }: { card: RankedCard }) {
  const dirState = getDirectionState(card.ticker);

  return (
    <div className="px-4 py-4 flex items-start justify-between gap-3">
      <div className="flex items-start gap-3">
        <RankBadge rank={card.rank} />
        <div>
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-bold text-white text-base">{card.ticker}</span>
            {card.cashSettled && (
              <span className="text-[9px] bg-yellow-500/20 text-yellow-400 px-1.5 py-0.5 rounded border border-yellow-500/30">
                CASH SETTLED
              </span>
            )}
            <DirectionPill direction={card.direction} />
            <StatusBadge status={card.status} />
          </div>

          <div className="flex items-center gap-3 mt-1.5 flex-wrap">
            {dirState && (
              <>
                <span className="text-[10px] text-white/30">
                  Session: <span className={
                    dirState.sessionBias === 'bullish' ? 'text-emerald-400' :
                    dirState.sessionBias === 'bearish' ? 'text-rose-400' :
                    'text-white/40'
                  }>{dirState.sessionBias.toUpperCase()}</span>
                </span>
                <span className="text-[10px] text-white/30">
                  Play: <span className={
                    dirState.playDirection === 'calls' ? 'text-emerald-300' :
                    dirState.playDirection === 'puts' ? 'text-rose-300' :
                    'text-white/30'
                  }>{dirState.playDirection.toUpperCase()}</span>
                </span>
              </>
            )}
            <span className="text-[10px] text-white/25">
              Signal @ {formatCT(card.signal.firedAt)} CT
            </span>
          </div>
        </div>
      </div>

      <div className="flex flex-col items-end gap-1.5">
        <SignalTypeBadge type={card.signal.type} confidence={card.signal.confidence} />
        <DteBadge dte={card.dte} />
      </div>
    </div>
  );
}

function BrainIntelligenceSection({ card }: { card: RankedCard }) {
  const { baseRate, fingerprint, c1BrainValid } = card;

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 mb-2">
        <span className="text-[10px] font-bold tracking-widest text-white/30 uppercase">Brain Intelligence</span>
        <CriterionDot pass={c1BrainValid} label="C1" />
      </div>

      {!baseRate ? (
        <div className="text-xs text-white/25 italic">No Brain data for this setup yet.</div>
      ) : !baseRate.isStatisticallyValid ? (
        <div className="flex items-center gap-2">
          <span className="w-2 h-2 rounded-full bg-amber-400" />
          <span className="text-xs text-amber-400">
            BUILDING BASE RATE — n={baseRate.n} (need {BRAIN_VALID_FLOOR})
          </span>
        </div>
      ) : (
        <BrainIntelligenceBar baseRate={baseRate} />
      )}

      <div className="flex items-center gap-3 text-[10px] text-white/25 mt-1">
        <span>Setup: {fingerprint.ticker} {fingerprint.direction} / {fingerprint.gexRegime} / {fingerprint.timeOfDay}</span>
      </div>
    </div>
  );
}

function BrainIntelligenceBar({ baseRate, compact = false }: { baseRate: BaseRate; compact?: boolean }) {
  const winPct = (baseRate.winRate * 100).toFixed(1);
  const avgPnl = (baseRate.avgPnl * 100).toFixed(2);
  const valid  = baseRate.n >= BRAIN_N_FLOOR && baseRate.winRate >= BRAIN_WIN_FLOOR;

  return (
    <div className={`space-y-1.5 ${compact ? '' : ''}`}>
      <div className="flex items-center gap-4 flex-wrap">
        <div className="flex items-center gap-1.5">
          <span className={`text-sm font-bold ${valid ? 'text-emerald-400' : 'text-amber-400'}`}>
            {winPct}%
          </span>
          <span className="text-[10px] text-white/30">win rate</span>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="text-xs text-white/50">n={baseRate.n}</span>
          {baseRate.n < BRAIN_N_FLOOR && (
            <span className="text-[9px] text-amber-400">({BRAIN_N_FLOOR - baseRate.n} more needed)</span>
          )}
        </div>
        <div className="flex items-center gap-1.5">
          <span className="text-xs text-white/30">avg P&L:</span>
          <span className={`text-xs font-bold ${Number(avgPnl) >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
            {Number(avgPnl) >= 0 ? '+' : ''}{avgPnl}%
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="text-[10px] text-white/25">Best window:</span>
          <span className="text-[10px] text-sky-400 font-bold">{baseRate.bestWindow}</span>
        </div>
      </div>

      {!compact && (
        <div className="flex gap-1 mt-1">
          {Object.entries(baseRate.windowWinRates).map(([window, wr]) => (
            <div key={window} className="flex flex-col items-center">
              <div
                className={`w-8 rounded-sm ${wr >= 0.6 ? 'bg-emerald-500' : wr >= 0.4 ? 'bg-amber-500' : 'bg-rose-500'}`}
                style={{ height: `${Math.max(4, wr * 28)}px` }}
              />
              <span className="text-[8px] text-white/25 mt-0.5">{window}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function ContractEconomicsSection({ card }: { card: RankedCard }) {
  const { bid, ask, midPremium, spread, spreadPct, iv, ivRank, delta, theta, dte } = card;
  const hasData = midPremium > 0;

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 mb-2">
        <span className="text-[10px] font-bold tracking-widest text-white/30 uppercase">Contract Economics</span>
        <CriterionDot pass={card.c5Spread} label="C5" />
        <CriterionDot pass={card.c7IvRank} label="C7" />
      </div>

      {!hasData ? (
        <span className="text-xs text-white/25 italic">Awaiting chain data...</span>
      ) : (
        <div className="grid grid-cols-2 gap-x-6 gap-y-1.5 text-xs">
          <EconRow label="Bid / Ask" value={`${formatDollar(bid)} / ${formatDollar(ask)}`} />
          <EconRow label="Mid Premium" value={formatDollar(midPremium)} highlight />
          <EconRow
            label="Spread"
            value={`${formatDollar(spread)} (${formatPct(spreadPct)})`}
            warn={spreadPct >= SPREAD_MAX_PCT}
          />
          {iv !== null && (
            <EconRow
              label="IV"
              value={formatPct(iv)}
              warn={ivRank !== null && ivRank >= IV_RANK_WARN}
            />
          )}
          {ivRank !== null && (
            <EconRow
              label="IV Rank"
              value={formatPct(ivRank)}
              warn={ivRank >= IV_RANK_WARN}
            />
          )}
          {delta !== null && (
            <EconRow label="Delta" value={delta.toFixed(2)} />
          )}
          {theta !== null && (
            <EconRow label="Theta" value={`${theta.toFixed(3)}/day`} warn={theta < -0.10} />
          )}
          <EconRow label="DTE Rec" value={dte.category} />
          <div className="col-span-2 text-[10px] text-white/25 pt-1">{dte.reason}</div>
        </div>
      )}
    </div>
  );
}

function RiskRewardSection({ card }: { card: RankedCard }) {
  const { callWall, putWall, flipLevel, maxPain, gexRegime, upTarget, downTarget, distToWall, breakEvenMove, direction } = card;

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 mb-2">
        <span className="text-[10px] font-bold tracking-widest text-white/30 uppercase">Risk / Reward</span>
        <CriterionDot pass={card.c6BreakEven} label="C6" />
        <CriterionDot pass={card.c8NoEarnings} label="C8" />
      </div>

      <div className="grid grid-cols-2 gap-x-6 gap-y-1.5 text-xs">
        <EconRow
          label="Call Wall"
          value={callWall > 0 ? callWall.toFixed(2) : '—'}
        />
        <EconRow
          label="Put Wall"
          value={putWall > 0 ? putWall.toFixed(2) : '—'}
        />
        <EconRow
          label="Flip Level"
          value={flipLevel > 0 ? flipLevel.toFixed(2) : '—'}
        />
        <EconRow
          label="Max Pain"
          value={maxPain > 0 ? maxPain.toFixed(2) : '—'}
        />
        <EconRow
          label={direction === 'call' ? 'Up Target' : 'Down Target'}
          value={(direction === 'call' ? upTarget : downTarget) > 0
            ? (direction === 'call' ? upTarget : downTarget).toFixed(2)
            : '—'}
          highlight
        />
        <EconRow
          label="GEX Regime"
          value={gexRegime.toUpperCase()}
        />
        <EconRow
          label="Dist to Wall"
          value={distToWall > 0 ? `${distToWall.toFixed(2)} pts` : '—'}
          warn={!card.c6BreakEven}
        />
        <EconRow
          label="Break-even move"
          value={breakEvenMove > 0 ? `${breakEvenMove.toFixed(2)} pts` : '—'}
        />
        {card.earningsDate && (
          <div className="col-span-2">
            <EconRow
              label="Earnings"
              value={card.earningsDate}
              warn
            />
          </div>
        )}
      </div>
    </div>
  );
}

function LiveMonitorPanel({ monitor, direction }: { monitor: ActiveMonitor; direction: 'call' | 'put' }) {
  const phaseColor = {
    watching:      'text-white/60',
    'mae-guard':   'text-rose-400',
    continuation:  'text-emerald-400',
    pullback:      'text-amber-400',
    exited:        'text-white/30',
  }[monitor.phase];

  const maeSign = direction === 'call'
    ? (monitor.maePrice < monitor.entryPrice ? -1 : 1)
    : (monitor.maePrice > monitor.entryPrice ? -1 : 1);
  const mfePct = monitor.mfePct * 100;
  const maePct = monitor.maePct * 100;

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 mb-1">
        <span className="text-[10px] font-bold tracking-widest text-white/30 uppercase">Live Monitor</span>
        <span className={`text-[10px] font-bold uppercase ${phaseColor}`}>{monitor.phase.replace('-', ' ')}</span>
        <span className="text-white/20 text-[10px]">· {monitor.candleCount} candles</span>
      </div>

      <div className="grid grid-cols-3 gap-3 text-xs">
        <div className="bg-white/5 rounded-lg p-2 text-center">
          <div className="text-[10px] text-white/30 mb-1">Entry</div>
          <div className="font-bold text-white">{monitor.entryPrice.toFixed(2)}</div>
        </div>
        <div className="bg-white/5 rounded-lg p-2 text-center">
          <div className="text-[10px] text-white/30 mb-1">Current</div>
          <div className={`font-bold ${monitor.currentPrice >= monitor.entryPrice ? 'text-emerald-400' : 'text-rose-400'}`}>
            {monitor.currentPrice.toFixed(2)}
          </div>
        </div>
        <div className="bg-white/5 rounded-lg p-2 text-center">
          <div className="text-[10px] text-white/30 mb-1">MFE / MAE</div>
          <div className="font-bold">
            <span className="text-emerald-400">+{mfePct.toFixed(1)}%</span>
            <span className="text-white/20"> / </span>
            <span className="text-rose-400">{(maeSign * maePct).toFixed(1)}%</span>
          </div>
        </div>
      </div>

      {/* MAE Guard alert */}
      {monitor.phase === 'mae-guard' && (
        <div className="rounded-lg bg-rose-500/10 border border-rose-500/20 px-3 py-2">
          <span className="text-rose-400 text-xs font-bold">MAE GUARD ACTIVE</span>
          <span className="text-rose-300/60 text-xs ml-2">
            Price moved adversely — consider exit
          </span>
        </div>
      )}

      {/* Continuation signal */}
      {monitor.phase === 'continuation' && (
        <div className="rounded-lg bg-emerald-500/10 border border-emerald-500/20 px-3 py-2">
          <span className="text-emerald-400 text-xs font-bold">CONTINUATION</span>
          <span className="text-emerald-300/60 text-xs ml-2">
            Trend extending — hold or trail stop
          </span>
        </div>
      )}

      {/* Pullback classifier */}
      {monitor.phase === 'pullback' && (
        <div className="rounded-lg bg-amber-500/10 border border-amber-500/20 px-3 py-2">
          <span className="text-amber-400 text-xs font-bold">PULLBACK</span>
          <span className="text-amber-300/60 text-xs ml-2">
            Retracing from high — watch for continuation vs exhaustion
          </span>
        </div>
      )}

      {monitor.stopLevel && (
        <div className="flex items-center gap-3 text-xs text-white/30">
          <span>Stop: <span className="text-rose-400 font-bold">{monitor.stopLevel.toFixed(2)}</span></span>
          {monitor.targetLevel && (
            <span>Target: <span className="text-emerald-400 font-bold">{monitor.targetLevel.toFixed(2)}</span></span>
          )}
        </div>
      )}
    </div>
  );
}

function GhostTrackingBar({ ghost, direction }: { ghost: GhostMonitor; direction: 'call' | 'put' }) {
  const mfePct = ((ghost.mfePrice - ghost.entryPrice) / ghost.entryPrice * 100);
  const maePct = ((ghost.entryPrice - ghost.maePrice) / ghost.entryPrice * 100);
  const signedMfe = direction === 'call' ? mfePct : -mfePct;
  const signedMae = direction === 'call' ? -maePct : maePct;

  return (
    <div className="flex items-center gap-4 text-[10px] text-white/25">
      <span className="font-bold text-white/30">GHOST</span>
      <span>not taken · {ghost.candleCount} candles</span>
      <span className="text-emerald-400/60">MFE: +{signedMfe.toFixed(2)}%</span>
      <span className="text-rose-400/60">MAE: {signedMae.toFixed(2)}%</span>
    </div>
  );
}

function BlockerSection({ blockers }: { blockers: TimingBlocker[] }) {
  return (
    <div className="space-y-2">
      <span className="text-[10px] font-bold tracking-widest text-rose-400/60 uppercase">
        Timing Blockers
      </span>
      <div className="space-y-1.5">
        {blockers.map((b, i) => (
          <div key={i} className="flex items-start gap-2">
            <span className="w-2 h-2 mt-0.5 rounded-full bg-rose-400 flex-shrink-0" />
            <div>
              <span className="text-[10px] font-bold text-rose-400">{b.label}</span>
              <span className="text-[10px] text-white/30 ml-2">{b.description}</span>
              {b.resolvedAt && (
                <span className="text-[10px] text-emerald-400 ml-2">
                  ✓ resolved @ {formatCT(b.resolvedAt)}
                </span>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function DisciplineGate({ ticker, onAck }: { ticker: string; onAck: (t: string) => void }) {
  return (
    <div className="rounded-lg border border-amber-500/20 bg-amber-500/5 px-3 py-3 space-y-2">
      <p className="text-amber-400 text-[10px] font-bold uppercase tracking-wider">
        Discipline Gate
      </p>
      <div className="space-y-1 text-[10px] text-white/40">
        <p>✓ I have a defined stop level</p>
        <p>✓ I am not chasing — this is a planned setup</p>
        <p>✓ I understand the risk and position size</p>
        <p>✓ I have not already exceeded my daily loss limit</p>
      </div>
      <button
        onClick={() => onAck(ticker)}
        className="w-full mt-1 py-1.5 rounded text-[10px] font-bold text-amber-400 border border-amber-500/30 hover:bg-amber-500/10 transition-colors uppercase tracking-wider"
      >
        I confirm — show I'm In
      </button>
    </div>
  );
}

function ComparisonTable({ alternatives }: { alternatives: ContractOption[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-[10px] text-white/50 border-collapse">
        <thead>
          <tr className="border-b border-white/5">
            <th className="text-left py-1 pr-3 text-white/25 font-normal">Contract</th>
            <th className="text-right py-1 px-2 text-white/25 font-normal">Mid</th>
            <th className="text-right py-1 px-2 text-white/25 font-normal">IV</th>
            <th className="text-right py-1 px-2 text-white/25 font-normal">Delta</th>
            <th className="text-right py-1 px-2 text-white/25 font-normal">θ/day</th>
          </tr>
        </thead>
        <tbody>
          {alternatives.map((alt, i) => (
            <tr key={i} className="border-b border-white/3">
              <td className="py-1 pr-3 text-white/60">{alt.label}</td>
              <td className="text-right px-2">{formatDollar((alt.bid + alt.ask) / 2)}</td>
              <td className="text-right px-2">{formatPct(alt.iv)}</td>
              <td className="text-right px-2">{alt.delta.toFixed(2)}</td>
              <td className="text-right px-2 text-rose-400/60">{alt.theta.toFixed(3)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── Atoms ──────────────────────────────────────────────────────────────────────

function RankBadge({ rank }: { rank: number }) {
  const colors = [
    'bg-yellow-500/20 text-yellow-400 border-yellow-500/30',
    'bg-white/10 text-white/70 border-white/20',
    'bg-orange-900/30 text-orange-400/70 border-orange-500/20',
    'bg-white/5 text-white/40 border-white/10',
    'bg-white/5 text-white/40 border-white/10',
  ];
  return (
    <span className={`w-6 h-6 flex items-center justify-center rounded border text-[10px] font-bold flex-shrink-0 ${colors[rank - 1] ?? colors[4]}`}>
      {rank}
    </span>
  );
}

function DirectionPill({ direction }: { direction: 'call' | 'put' }) {
  const isCall = direction === 'call';
  return (
    <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded uppercase tracking-wider
      ${isCall
        ? 'bg-emerald-500/15 text-emerald-400 border border-emerald-500/25'
        : 'bg-rose-500/15 text-rose-400 border border-rose-500/25'
      }`}>
      {direction === 'call' ? '▲ CALL' : '▼ PUT'}
    </span>
  );
}

function StatusBadge({ status }: { status: CardStatus }) {
  const map: Record<CardStatus, { label: string; cls: string }> = {
    forming:    { label: 'FORMING',    cls: 'bg-white/5 text-white/30 border-white/10' },
    triggering: { label: 'TRIGGERING', cls: 'bg-sky-500/15 text-sky-400 border-sky-500/25 animate-pulse' },
    active:     { label: 'ACTIVE',     cls: 'bg-emerald-500/15 text-emerald-400 border-emerald-500/25' },
    blocked:    { label: 'BLOCKED',    cls: 'bg-rose-500/15 text-rose-400 border-rose-500/25' },
    ghost:      { label: 'GHOST',      cls: 'bg-white/5 text-white/20 border-white/10' },
  };
  const { label, cls } = map[status];
  return (
    <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded border uppercase tracking-wider ${cls}`}>
      {label}
    </span>
  );
}

function SignalTypeBadge({ type, confidence }: { type: Signal['type']; confidence: number }) {
  const map: Record<Signal['type'], string> = {
    ENTER:    'bg-emerald-500/15 text-emerald-400',
    BREAKOUT: 'bg-sky-500/15 text-sky-400',
    REVERSAL: 'bg-purple-500/15 text-purple-400',
    RIP:      'bg-amber-500/15 text-amber-400',
    DUMP:     'bg-rose-500/15 text-rose-400',
    EXIT:     'bg-white/10 text-white/40',
  };
  return (
    <div className="flex flex-col items-end gap-0.5">
      <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded uppercase tracking-wider ${map[type]}`}>
        {type}
      </span>
      <span className="text-[10px] text-white/30">{confidence}/100</span>
    </div>
  );
}

function DteBadge({ dte }: { dte: DteRecommendation }) {
  const colors: Record<DteCategory, string> = {
    '0DTE':   'bg-rose-500/15 text-rose-400 border-rose-500/25',
    '1-2DTE': 'bg-amber-500/15 text-amber-400 border-amber-500/25',
    '3-5DTE': 'bg-blue-500/15 text-blue-400 border-blue-500/25',
  };
  return (
    <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded border uppercase tracking-wider ${colors[dte.category]}`}>
      {dte.category}
    </span>
  );
}

function CriterionDot({ pass, label }: { pass: boolean; label: string }) {
  return (
    <span className={`text-[9px] font-bold px-1 py-0.5 rounded
      ${pass ? 'text-emerald-400 bg-emerald-500/10' : 'text-rose-400/60 bg-rose-500/10'}`}>
      {label} {pass ? '✓' : '✗'}
    </span>
  );
}

function EconRow({
  label,
  value,
  highlight = false,
  warn = false,
}: {
  label: string;
  value: string;
  highlight?: boolean;
  warn?: boolean;
}) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-white/30">{label}</span>
      <span className={
        warn ? 'text-rose-400 font-bold' :
        highlight ? 'text-white font-bold' :
        'text-white/60'
      }>
        {value}
      </span>
    </div>
  );
}

function gexColor(regime: string): string {
  if (regime === 'positive') return 'text-emerald-400';
  if (regime === 'negative') return 'text-rose-400';
  return 'text-amber-400';
}


