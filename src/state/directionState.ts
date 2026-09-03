/**
 * Layer 4 — directionState
 *
 * The two-layer direction model. Separates macro session bias from intraday
 * play direction. Every cockpit reads both. The chart uses both for display.
 *
 * Two separate concepts that must never be conflated:
 *
 *   sessionBias   — the macro session direction, updated hourly OR whenever
 *                   the GEX regime changes. A bearish session stays bearish
 *                   even during intraday rips. This is the structural context.
 *
 *   playDirection — what price is doing RIGHT NOW, updated on every completed
 *                   5m candle. A bearish session can have a bullish play direction
 *                   during a VWAP rip. This drives the active signal direction.
 *
 * Example: QQQ bearish session. Price dumps open, rips to VWAP, fades to lows.
 *   sessionBias stays 'bearish' all day.
 *   playDirection goes: 'puts' → 'calls' (rip) → 'puts' (fade).
 *   The system fires signals for all three moves.
 *
 * This state is written by the confluenceEngine at the end of each scoring
 * pass and on each GEX regime update. It is read-only for all cockpits.
 *
 * Both values are always visible in the UI — never hidden behind a tab or
 * expandable. The user always knows the session context and the current play.
 */

import * as barsStore    from '../stores/barsStore';
import * as marketStore  from '../stores/marketStore';
import * as cvdStore     from '../stores/cvdStore';
import { computeEma }    from '../engines/confluenceEngine';
import { formatError }   from '../lib/errors';

// ── Exported types ─────────────────────────────────────────────────────────────

export type SessionBias    = 'bearish' | 'bullish' | 'neutral';
export type PlayDirection  = 'puts' | 'calls' | 'consolidating' | 'none';

export interface DirectionState {
  /** Macro session direction — updates hourly or on GEX regime change. */
  sessionBias:        SessionBias;

  /**
   * Human-readable explanation of why sessionBias is what it is.
   * e.g. "NEG GEX below flip + below VWAP + below EMA55"
   */
  sessionBiasReason:  string;

  /**
   * What price is doing right now — updated on every completed 5m candle.
   * A bearish session CAN have playDirection = 'calls' during an intraday rip.
   */
  playDirection:      PlayDirection;

  /**
   * Human-readable explanation of current play direction.
   * e.g. "CVD calls 67% accelerating, price above VWAP, EMA 8 > 21"
   */
  playDirectionReason: string;

  /** ctMs of the last 5m candle that triggered a playDirection update. */
  playDirectionAsOf:  number;

  /** ctMs of the last sessionBias update. */
  biasAsOf:           number;
}

// ── Trade type classification ───────────────────────────────────────────────────

/**
 * Trade type relative to the macro session bias.
 *   with_session    — direction agrees with sessionBias (or bias is neutral)
 *   counter_session — direction disagrees with sessionBias
 *   continuation    — same direction as a prior resolved signal within the
 *                      continuation window (see computeTradeType below)
 */
export type TradeType = 'with_session' | 'counter_session' | 'continuation';

/** Same-direction window for the 'continuation' trade type. */
const CONTINUATION_GAP_MS = 90 * 60 * 1000; // 90 min

/**
 * Classify a signal's trade type relative to session bias and any prior
 * resolved signal on the same ticker/direction.
 *
 * TODO: priorDirection/priorResolvedAt are currently always passed as
 * null/null by every real caller (signalLedger, ScannerCockpit,
 * SwingCockpit, ZeroDteCockpit) — prior-signal tracking has not been built
 * anywhere yet, so the 'continuation' branch below is genuinely unreachable
 * in the live system today. Wiring real prior-signal lookups is a separate,
 * not-yet-scheduled task.
 */
export function computeTradeType(
  direction: 'call' | 'put',
  sessionBias: SessionBias,
  priorDirection: 'call' | 'put' | null,
  priorResolvedAt: number | null,
): TradeType {
  if (
    priorDirection === direction &&
    priorResolvedAt !== null &&
    Date.now() - priorResolvedAt < CONTINUATION_GAP_MS
  ) return 'continuation';

  const biasMatchesCalls = sessionBias === 'bullish';
  const biasMatchesPuts  = sessionBias === 'bearish';

  if (direction === 'call' && biasMatchesCalls) return 'with_session';
  if (direction === 'put'  && biasMatchesPuts)  return 'with_session';
  if (sessionBias === 'neutral')                return 'with_session';
  return 'counter_session';
}

// ── Ticker beta table ──────────────────────────────────────────────────────────

/**
 * Leader index and beta for each tradeable ticker.
 * Used for the beta-alignment conviction multiplier.
 */
export interface TickerBeta {
  leader: string;
  beta:   number;
}

export const TICKER_BETA_TABLE: Record<string, TickerBeta> = {
  MSTR:  { leader: 'QQQ', beta: 4.5 },
  COIN:  { leader: 'QQQ', beta: 3.2 },
  SMCI:  { leader: 'QQQ', beta: 2.8 },
  TSLA:  { leader: 'QQQ', beta: 2.0 },
  NVDA:  { leader: 'QQQ', beta: 1.8 },
  AMD:   { leader: 'QQQ', beta: 1.7 },
  NFLX:  { leader: 'QQQ', beta: 1.5 },
  META:  { leader: 'QQQ', beta: 1.4 },
  AMZN:  { leader: 'QQQ', beta: 1.3 },
  MSFT:  { leader: 'QQQ', beta: 1.2 },
  GOOGL: { leader: 'QQQ', beta: 1.2 },
  AAPL:  { leader: 'QQQ', beta: 1.1 },
  HOOD:  { leader: 'SPY', beta: 2.4 },
  PLTR:  { leader: 'SPY', beta: 2.1 },
  BAC:   { leader: 'SPY', beta: 1.4 },
  JPM:   { leader: 'SPY', beta: 1.2 },
  SOFI:  { leader: 'IWM', beta: 1.9 },
};

/** Context-only tickers — never generate signals, never appear in cockpits. */
export const CONTEXT_ONLY_TICKERS = new Set(['HYG', 'TLT', 'I:VIX']);

/** Cash-settled index options — labeled "CASH SETTLED" everywhere they appear. */
export const CASH_SETTLED_TICKERS = new Set(['SPX', 'NDX']);

/**
 * Tickers whose PRIMARY listing exchange is Nasdaq. Per Massive's
 * Conditions & Indicators glossary, LULD halt/resume indicators (i codes
 * 17/18) are published ONLY for Nasdaq-listed securities — NYSE and
 * NYSE Arca/AMEX-listed tickers never receive a halt/resume event, even
 * during a real halt, and index tickers (SPX, NDX) have no underlying
 * listing at all. luldStore.isHalted() uses this set to distinguish
 * "confirmed not halted" from "no halt data available for this ticker" —
 * see luldStore.ts.
 *
 * NYSE/NYSE Arca-listed FEED_TICKERS with NO halt coverage: SPY, IWM,
 * GLD, JPM, BAC, PLTR. Index tickers with NO halt coverage: SPX, NDX.
 */
export const NASDAQ_LISTED_TICKERS = new Set([
  'QQQ', 'AAPL', 'TSLA', 'NVDA', 'MSFT', 'AMZN', 'META', 'AMD', 'GOOGL',
  'NFLX', 'MSTR', 'SMCI', 'COIN', 'HOOD', 'SOFI',
]);

/**
 * The 23 feed tickers. Cockpits iterate this to subscribe and render.
 * TLT and HYG are context-only — they appear in Indexes Cockpit as macro
 * context but never in Scanner, Best Contracts, or 0DTE. Neither appears here.
 */
export const FEED_TICKERS = [
  'SPY', 'QQQ', 'IWM', 'SPX', 'NDX',
  'AAPL', 'TSLA', 'NVDA', 'MSFT', 'AMZN', 'META', 'AMD', 'GOOGL', 'NFLX',
  'COIN', 'PLTR', 'HOOD', 'SOFI',
  'JPM', 'BAC',
  'MSTR', 'SMCI',
  'GLD',
] as const;

export type FeedTicker = typeof FEED_TICKERS[number];

// ── Internal state ─────────────────────────────────────────────────────────────

const _stateByTicker = new Map<string, DirectionState>();
const _listeners     = new Set<(ticker: string, state: DirectionState) => void>();

/**
 * Tracks the GEX regime that was in place when sessionBias was last computed,
 * per ticker. Used to detect regime changes and force a bias recompute.
 */
const _lastBiasRegime = new Map<string, string>();

// ── Public read API ────────────────────────────────────────────────────────────

/**
 * Get the current DirectionState for a ticker.
 * Returns null if no state has been computed yet (stores not ready).
 */
export function getDirectionState(ticker: string): DirectionState | null {
  return _stateByTicker.get(ticker) ?? null;
}

/** Get all ticker direction states. Cockpits use this for the global view. */
export function getAllDirectionStates(): Map<string, DirectionState> {
  return new Map(_stateByTicker);
}

export function subscribe(
  listener: (ticker: string, state: DirectionState) => void,
): () => void {
  _listeners.add(listener);
  return () => _listeners.delete(listener);
}

// ── Write API — called by confluenceEngine after each scoring pass ─────────────

/**
 * Recompute and persist the DirectionState for a ticker.
 * Called by the scoring engine on every completed 5m candle and on GEX change.
 *
 * sessionBias is recomputed when ANY of the following is true:
 *   1. No prior state exists (first run).
 *   2. 60 minutes have elapsed since the last bias recompute.
 *   3. The GEX regime in marketStore differs from the regime captured at the
 *      last bias recompute (regime change trigger — immediate recompute).
 *
 * playDirection is always recomputed on every call.
 *
 * All reads are from Layer 1 stores — this function never touches the network.
 */
export function updateDirectionState(ticker: string): void {
  const barsResult   = barsStore.getResult(ticker);
  const cvdResult    = cvdStore.getResult(ticker);
  const marketResult = marketStore.getResult(ticker);

  if (
    barsResult.status   !== 'ready' ||
    cvdResult.status    !== 'ready' ||
    marketResult.status !== 'ready'
  ) return;

  const bars    = barsResult.data;
  const cvd     = cvdResult.data;
  const ctx     = marketResult.data;
  const nowMs   = Date.now();

  if (bars.length === 0) return;

  const lastBar    = bars[bars.length - 1];
  const closes     = bars.map(b => b.close);
  const ema8       = computeEma(closes, 8);
  const ema21      = computeEma(closes, 21);

  // Session VWAP (approximate from bars with vwap field, or close-based mean)
  const vwap = _computeSessionVwap(bars);

  // ── Play Direction (what is price doing RIGHT NOW) ──────────────────────────
  const { playDirection, playDirectionReason } = _computePlayDirection(
    lastBar, ema8, ema21, vwap, cvd,
  );

  // ── Session Bias (macro session structure) ──────────────────────────────────
  const existing           = _stateByTicker.get(ticker);
  const lastRegime         = _lastBiasRegime.get(ticker);
  const currentRegime      = ctx.gexRegime;

  const hoursSinceBiasUpdate = existing
    ? (nowMs - existing.biasAsOf) / (60 * 60 * 1000)
    : Infinity;

  // Trigger recompute on: first run, hourly elapsed, OR GEX regime change
  const regimeChanged       = lastRegime !== undefined && lastRegime !== currentRegime;
  const shouldRecomputeBias = !existing || regimeChanged || hoursSinceBiasUpdate >= 1;

  let sessionBias       = existing?.sessionBias       ?? 'neutral';
  let sessionBiasReason = existing?.sessionBiasReason ?? '';
  let biasAsOf          = existing?.biasAsOf          ?? nowMs;

  if (shouldRecomputeBias) {
    const biasResult = _computeSessionBias(lastBar, ctx, vwap, closes);
    sessionBias       = biasResult.bias;
    sessionBiasReason = biasResult.reason;
    biasAsOf          = nowMs;
    // Record the regime that was in place at this recompute
    _lastBiasRegime.set(ticker, currentRegime);
  }

  const state: DirectionState = {
    sessionBias,
    sessionBiasReason,
    playDirection,
    playDirectionReason,
    playDirectionAsOf: lastBar.tCT,
    biasAsOf,
  };

  _stateByTicker.set(ticker, state);
  _notify(ticker, state);
}

// ── Direction computation ──────────────────────────────────────────────────────

interface PlayDirectionResult {
  playDirection:       PlayDirection;
  playDirectionReason: string;
}

function _computePlayDirection(
  lastBar: { close: number; open: number; high: number; low: number },
  ema8:    number,
  ema21:   number,
  vwap:    number | null,
  cvd:     { callPct: number; putPct: number; classification: string; ticks: { side: string; tCT: number }[] },
): PlayDirectionResult {
  const reasons: string[] = [];

  let bullishVotes = 0;
  let bearishVotes = 0;

  // CVD direction (weight 2)
  if (cvd.callPct > 60) {
    bullishVotes += 2;
    reasons.push(`CVD calls ${cvd.callPct.toFixed(0)}% accelerating`);
  } else if (cvd.putPct > 60) {
    bearishVotes += 2;
    reasons.push(`CVD puts ${cvd.putPct.toFixed(0)}% accelerating`);
  } else {
    reasons.push(`CVD neutral (${cvd.callPct.toFixed(0)}/${cvd.putPct.toFixed(0)})`);
  }

  // EMA 8 vs EMA 21 (weight 2)
  if (ema8 > ema21) {
    bullishVotes += 2;
    reasons.push('EMA 8 > 21');
  } else if (ema8 < ema21) {
    bearishVotes += 2;
    reasons.push('EMA 8 < 21');
  }

  // Price vs VWAP (weight 1)
  if (vwap !== null) {
    if (lastBar.close > vwap) {
      bullishVotes++;
      reasons.push('price above VWAP');
    } else if (lastBar.close < vwap) {
      bearishVotes++;
      reasons.push('price below VWAP');
    }
  }

  // Candle body direction (weight 1)
  if (lastBar.close > lastBar.open) {
    bullishVotes++;
  } else if (lastBar.close < lastBar.open) {
    bearishVotes++;
  }

  const total     = bullishVotes + bearishVotes;
  const bullRatio = total > 0 ? bullishVotes / total : 0.5;

  let playDirection: PlayDirection;
  if (bullRatio >= 0.65)       playDirection = 'calls';
  else if (bullRatio <= 0.35)  playDirection = 'puts';
  else                         playDirection = 'consolidating';

  return {
    playDirection,
    playDirectionReason: reasons.join(', '),
  };
}

interface SessionBiasResult {
  bias:   SessionBias;
  reason: string;
}

function _computeSessionBias(
  lastBar: { close: number },
  ctx:     { gexRegime: string; flipLevel: number; walls: { callWall: number; putWall: number } },
  vwap:    number | null,
  closes:  number[],
): SessionBiasResult {
  const reasons: string[] = [];
  let bullishVotes = 0;
  let bearishVotes = 0;

  // GEX regime (weight 2)
  if (ctx.gexRegime === 'negative') {
    // Negative GEX = dealers short gamma = trending environment
    // Direction is determined by price relative to flip level
    if (lastBar.close < ctx.flipLevel) {
      bearishVotes += 2;
      reasons.push('NEG GEX below flip');
    } else {
      bullishVotes += 2;
      reasons.push('NEG GEX above flip');
    }
  } else if (ctx.gexRegime === 'positive') {
    reasons.push(`POS GEX (flip: $${ctx.flipLevel.toFixed(2)})`);
    // POS GEX is regime-neutral; price location within walls determines direction
  }

  // Price vs VWAP (weight 2 — strong macro indicator)
  if (vwap !== null) {
    if (lastBar.close > vwap) {
      bullishVotes += 2;
      reasons.push('above VWAP');
    } else {
      bearishVotes += 2;
      reasons.push('below VWAP');
    }
  }

  // Medium-term EMA trend (EMA 55, weight 1)
  if (closes.length >= 55) {
    const ema55 = computeEma(closes, 55);
    if (lastBar.close > ema55) {
      bullishVotes++;
      reasons.push('above EMA55');
    } else {
      bearishVotes++;
      reasons.push('below EMA55');
    }
  }

  let bias: SessionBias;
  const net = bullishVotes - bearishVotes;
  if      (net >= 2)  bias = 'bullish';
  else if (net <= -2) bias = 'bearish';
  else                bias = 'neutral';

  return { bias, reason: reasons.join(' + ') };
}

// ── Session VWAP computation ───────────────────────────────────────────────────

/**
 * Compute VWAP from bars that have a vwap field, or approximate from close/volume.
 * Returns null if not enough data.
 */
function _computeSessionVwap(bars: { close: number; volume: number; vwap?: number }[]): number | null {
  if (bars.length === 0) return null;

  // If bars carry their own vwap field (Massive provides this), use cumulative
  const withVwap = bars.filter(b => b.vwap !== undefined);
  if (withVwap.length > 0) {
    const totalVol = withVwap.reduce((s, b) => s + b.volume, 0);
    if (totalVol === 0) return null;
    return withVwap.reduce((s, b) => s + (b.vwap! * b.volume), 0) / totalVol;
  }

  // Fallback: close-weighted VWAP from OHLC bars
  const totalVol = bars.reduce((s, b) => s + b.volume, 0);
  if (totalVol === 0) return null;
  return bars.reduce((s, b) => s + (b.close * b.volume), 0) / totalVol;
}

// ── Conviction score utilities ────────────────────────────────────────────────

/**
 * Regime multiplier for the conviction score.
 * NEG GEX on ticker AND its leader index = ×1.25
 * NEG GEX on ticker only = ×1.0
 * POS GEX = ×0.75
 */
export function regimeMultiplier(
  tickerRegime: string,
  leaderRegime: string,
): number {
  if (tickerRegime === 'negative' && leaderRegime === 'negative') return 1.25;
  if (tickerRegime === 'negative') return 1.0;
  if (tickerRegime === 'positive') return 0.75;
  return 0.9; // neutral
}

/**
 * Beta alignment multiplier for the conviction score.
 *
 * beta_multiplier = 1.0 + (leader_cvd_alignment_pct × ticker_beta × 0.05)
 *
 * Where leader_cvd_alignment_pct = (leader CVD in signal direction − 50) / 50,
 * ranging −1.0 to +1.0.
 *
 * @param leaderCvdPct  The relevant CVD pct on the leader (callPct for bullish, putPct for bearish)
 * @param ticker        The ticker being scored
 */
export function betaAlignmentMultiplier(
  leaderCvdPct: number,
  ticker:       string,
): number {
  const entry = TICKER_BETA_TABLE[ticker];
  if (!entry) return 1.0;

  const alignmentPct = (leaderCvdPct - 50) / 50; // −1.0 to +1.0
  return 1.0 + (alignmentPct * entry.beta * 0.05);
}

// ── Notify ────────────────────────────────────────────────────────────────────

function _notify(ticker: string, state: DirectionState) {
  for (const fn of _listeners) {
    try { fn(ticker, state); }
    catch (e) { console.error(`[directionState] Listener error: ${formatError(e)}`); }
  }
}
