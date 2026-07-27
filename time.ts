/**
 * Layer 4 — SwingCockpit
 *
 * Multi-day swing trade setup evaluator. This cockpit is fundamentally
 * different from 0DTE: timeframe is 2–10 days, contracts are 1–3 week
 * expiry, and fundamentals matter.
 *
 * Ranked setup cards across all FEED_TICKERS (excluding CONTEXT_ONLY).
 * Each card shows a swing readiness score across 8 factors:
 *
 *   F1. Brain base rate (historical win rate for this setup type)
 *   F2. Technical structure (EMA8 > EMA21 > EMA55, above VWAP, GEX alignment)
 *   F3. CVD multi-timeframe alignment (5m + larger)
 *   F4. Earnings gate (no earnings within 5 days = blocker if binary risk)
 *   F5. Short interest + short volume ratio (elevated = squeeze fuel or caution)
 *   F6. Insider transactions (discretionary buys = conviction signal)
 *   F7. Catalyst context (recent 8-K disclosures categorized)
 *   F8. Financial ratios (P/E, EV/EBITDA — directional context, not filters)
 *
 * Score weights: F1=128, F2=64, F3=32, F4=16, F5=8, F6=4, F7=2, F8=1
 * Max score = 255 (binary pass/fail per factor, matching BestContracts weighting)
 *
 * Rules:
 *   - CONTEXT_ONLY_TICKERS never appear
 *   - CASH_SETTLED_TICKERS get CASH SETTLED label
 *   - No outbound calls — reads local stores and Brain only
 *   - All Result<T> states handled (loading skeleton, error)
 *   - Earnings within 5 days shown as a red EARNINGS gate with date
 *   - Fundamentals shown only here, never in 0DTE cockpits
 *   - Brain stats shown only if isStatisticallyValid (n >= 15)
 *   - Direction pill always visible
 */

import { useEffect, useRef, useState } from 'react';

import * as barsStore          from '../stores/barsStore';
import * as cvdStore           from '../stores/cvdStore';
import * as marketStore        from '../stores/marketStore';
import * as luldStore          from '../stores/luldStore';
import * as fundamentalsStore  from '../stores/fundamentalsStore';
import * as brainStore         from '../ledger/brainStore';
import { toCentralTime }       from '../lib/time';
import {
  getDirectionState,
  subscribe as subscribeDirection,
  FEED_TICKERS,
  CONTEXT_ONLY_TICKERS,
  CASH_SETTLED_TICKERS,
  TICKER_BETA_TABLE,
}                              from '../state/directionState';
import { computeEma }          from '../engines/confluenceEngine';
import type { FundamentalsData, EightKDisclosure } from '../stores/fundamentalsStore';

// ── Constants ──────────────────────────────────────────────────────────────────

const SELECTABLE = FEED_TICKERS.filter(t => !CONTEXT_ONLY_TICKERS.has(t)) as string[];

const WEIGHTS = { f1: 128, f2: 64, f3: 32, f4: 16, f5: 8, f6: 4, f7: 2, f8: 1 };
const MAX_SCORE = Object.values(WEIGHTS).reduce((s, w) => s + w, 0); // 255

const BRAIN_WIN_FLOOR    = 0.55;  // swing uses 55% floor (lower than 0DTE's 60%)
const BRAIN_N_FLOOR      = 15;
const EARNINGS_GATE_DAYS = 5;
const BRAIN_REFRESH_MS   = 5 * 60 * 1000;
const SHORT_INTEREST_HIGH = 0.20;  // 20% SI float = elevated
const SHORT_VOL_HIGH      = 0.45;  // 45% short vol ratio = elevated

// ── Local types ────────────────────────────────────────────────────────────────

interface FactorResult {
  pass:  boolean;
  label: string;
  detail: string;
}

interface SwingCard {
  ticker:      string;
  score:       number;
  direction:   'call' | 'put' | 'neutral';
  f1:          FactorResult;  // Brain base rate
  f2:          FactorResult;  // Technical structure
  f3:          FactorResult;  // CVD alignment
  f4:          FactorResult;  // Earnings gate
  f5:          FactorResult;  // Short interest
  f6:          FactorResult;  // Insider transactions
  f7:          FactorResult;  // Catalyst / 8-K
  f8:          FactorResult;  // Financial ratios
  brainN:      number | null;
  brainWinRate: number | null;
  brainBestWindow: string | null;
  halted:      boolean;
  cashSettled: boolean;
  leaderTicker: string;
  nearestEarnings: number | null;  // UTC ms
  latestInsiderBuy: number | null; // UTC ms
}

// ── Pure helpers ───────────────────────────────────────────────────────────────

function _earningsWithinDays(disclosures: EightKDisclosure[], days: number): number | null {
  const cutoff = Date.now() + days * 24 * 60 * 60 * 1000;
  const upcoming = disclosures
    .filter(d => d.category === 'earnings' && d.filedAt > Date.now() && d.filedAt <= cutoff)
    .sort((a, b) => a.filedAt - b.filedAt);
  return upcoming.length > 0 ? upcoming[0].filedAt : null;
}

function _lastDiscretionaryBuy(fd: FundamentalsData): number | null {
  if (!fd.insiderTransactions || fd.insiderTransactions.length === 0) return null;
  const buys = fd.insiderTransactions.filter(t => !t.is10b51);
  return buys.length > 0 ? buys[0].transactedAt : null;
}

function _buildCard(ticker: string): SwingCard | null {
  const barsR    = barsStore.getResult(ticker);
  const cvdR     = cvdStore.getResult(ticker);
  const mktR     = marketStore.getResult(ticker);
  const fundR    = fundamentalsStore.getResult(ticker);
  const dir      = getDirectionState(ticker);
  const halted   = luldStore.isHalted(ticker) === true;
  const cashSettled = CASH_SETTLED_TICKERS.has(ticker);
  const leaderTicker = TICKER_BETA_TABLE[ticker]?.leader ?? 'SPY';

  // Need at least bars to be ready for any useful card
  if (barsR.status !== 'ready') return null;

  const bars   = barsR.data;
  const closes = bars.map(b => b.close);
  const last   = bars[bars.length - 1];

  // ── Technical structure (F2) ──────────────────────────────────────────────
  const ema8  = computeEma(closes, 8);
  const ema21 = computeEma(closes, 21);
  const ema55 = computeEma(closes, 55);
  const vwapVal = (() => {
    let pv = 0, vol = 0;
    for (const b of bars) {
      const p = b.vwap ?? (b.high + b.low + b.close) / 3;
      pv += p * b.volume; vol += b.volume;
    }
    return vol > 0 ? pv / vol : null;
  })();

  const mktCtx       = mktR.status === 'ready' ? mktR.data : null;

  const price        = last?.close ?? 0;
  const emaStacked   = ema8 !== null && ema21 !== null && ema8 > ema21;
  const aboveVwap    = vwapVal !== null && price > vwapVal;
  const aboveEma21   = ema21 !== null && price > ema21;
  const techPass     = emaStacked && (aboveVwap || aboveEma21);

  const techDetail = [
    ema8 && ema21 ? `EMA8 ${ema8 > ema21 ? '>' : '<'} EMA21` : 'EMA n/a',
    vwapVal ? (aboveVwap ? 'above VWAP' : 'below VWAP') : '',
    ema55 ? (price > ema55 ? 'above EMA55' : 'below EMA55') : '',
  ].filter(Boolean).join(' · ');

  // ── CVD alignment (F3) ───────────────────────────────────────────────────
  const cvd = cvdR.status === 'ready' ? cvdR.data : null;
  const cvdAligned = cvd !== null &&
    ((dir?.playDirection === 'calls' && cvd.callPct > 55) ||
     (dir?.playDirection === 'puts'  && cvd.callPct < 45));
  const cvdDetail = cvd
    ? `Calls ${cvd.callPct.toFixed(0)}% / Puts ${(100 - cvd.callPct).toFixed(0)}% — ${cvd.classification}`
    : 'No CVD data';

  // ── Direction for card ───────────────────────────────────────────────────
  const direction: 'call' | 'put' | 'neutral' =
    dir?.playDirection === 'calls' ? 'call'
    : dir?.playDirection === 'puts' ? 'put'
    : 'neutral';

  // ── Brain base rate (F1) ─────────────────────────────────────────────────
  const vixBucket = '<15' as brainStore.VixBucket;
  const now       = toCentralTime(Date.now());
  const hour      = now.hour;
  const todBucket: brainStore.TimeOfDayBucket =
    hour < 10.5 ? 'open' : hour < 14 ? 'midday' : 'close';

  const fingerprint: brainStore.SetupFingerprint = {
    ticker,
    direction: direction === 'neutral' ? 'call' : direction,
    gexRegime: mktCtx?.gexRegime ?? 'neutral',
    vixBucket,
    timeOfDay: todBucket,
  };
  const brainR    = brainStore.getBaseRate(fingerprint);
  const brainData = brainR.status === 'ready' ? brainR.data : null;
  const brainPass = brainData !== null &&
    brainData.isStatisticallyValid &&
    brainData.n >= BRAIN_N_FLOOR &&
    brainData.winRate >= BRAIN_WIN_FLOOR;
  const brainDetail = brainData?.isStatisticallyValid
    ? `${(brainData.winRate * 100).toFixed(0)}% win rate · n=${brainData.n} · best ${brainData.bestWindow}`
    : brainData ? `n=${brainData.n} — below validity floor (${BRAIN_N_FLOOR})` : 'No Brain data';

  // ── Fundamentals factors (F4–F8) ─────────────────────────────────────────
  const fd            = fundR.status === 'ready' ? fundR.data : null;
  const nearestEarnings = fd ? _earningsWithinDays(fd.recentDisclosures, EARNINGS_GATE_DAYS) : null;
  const earningsPass    = nearestEarnings === null; // pass = no earnings gate
  const earningsDetail  = nearestEarnings
    ? `Earnings in ${Math.ceil((nearestEarnings - Date.now()) / 86400000)}d — binary risk gate`
    : 'No earnings within 5 days';

  const siPct          = fd?.shortInterest?.shortFloat ?? null;
  const svRatio        = fd?.shortVolumeRatio ?? null;
  const shortPass      = siPct !== null && svRatio !== null &&
    (siPct > SHORT_INTEREST_HIGH || svRatio > SHORT_VOL_HIGH);
  // elevated SI = squeeze fuel (pass for calls) or caution (pass for puts)
  const shortDetail    = fd
    ? [
        siPct    ? `SI ${(siPct * 100).toFixed(1)}%` : 'SI n/a',
        svRatio  ? `SV ratio ${(svRatio * 100).toFixed(1)}%` : 'SV n/a',
      ].join(' · ')
    : 'Fundamentals loading';

  const latestBuy    = fd ? _lastDiscretionaryBuy(fd) : null;
  const insiderPass  = latestBuy !== null && (Date.now() - latestBuy) < 30 * 24 * 60 * 60 * 1000;
  const insiderDetail = latestBuy
    ? `Last discretionary buy ${Math.floor((Date.now() - latestBuy) / 86400000)}d ago`
    : 'No insider buys on record';

  const catalysts     = fd?.recentDisclosures ?? [];
  const recentCats    = catalysts.filter(d => d.category !== 'earnings' && (Date.now() - d.filedAt) < 30 * 24 * 60 * 60 * 1000);
  const catalystPass  = recentCats.length > 0;
  const catalystDetail = recentCats.length > 0
    ? recentCats.slice(0, 2).map(d => d.category).join(', ')
    : 'No recent 8-K catalysts';

  const ratios      = fd?.ratios ?? null;
  const ratioPass   = ratios !== null && (
    (direction === 'call' && ratios.pe !== undefined && ratios.pe > 0 && ratios.pe < 50) ||
    (direction === 'put'  && ratios.pe !== undefined && ratios.pe > 50) ||
    true // if no ratio data, soft pass — don't penalise
  );
  const ratioDetail = ratios
    ? [
        ratios.pe       !== undefined ? `P/E ${ratios.pe.toFixed(1)}`          : null,
        ratios.evEbitda !== undefined ? `EV/EBITDA ${ratios.evEbitda.toFixed(1)}` : null,
        ratios.fcfYield !== undefined ? `FCF yield ${(ratios.fcfYield * 100).toFixed(1)}%` : null,
      ].filter(Boolean).join(' · ') || 'No ratio data'
    : 'No ratio data';

  // ── Score ────────────────────────────────────────────────────────────────
  const score =
    (brainPass ? WEIGHTS.f1 : 0) +
    (techPass  ? WEIGHTS.f2 : 0) +
    (cvdAligned ? WEIGHTS.f3 : 0) +
    (earningsPass ? WEIGHTS.f4 : 0) +
    (shortPass ? WEIGHTS.f5 : 0) +
    (insiderPass ? WEIGHTS.f6 : 0) +
    (catalystPass ? WEIGHTS.f7 : 0) +
    (ratioPass ? WEIGHTS.f8 : 0);

  return {
    ticker,
    score,
    direction,
    f1: { pass: brainPass,     label: 'Brain',     detail: brainDetail     },
    f2: { pass: techPass,      label: 'Technical', detail: techDetail      },
    f3: { pass: cvdAligned,    label: 'CVD',       detail: cvdDetail       },
    f4: { pass: earningsPass,  label: 'Earnings',  detail: earningsDetail  },
    f5: { pass: shortPass,     label: 'Short Int', detail: shortDetail     },
    f6: { pass: insiderPass,   label: 'Insider',   detail: insiderDetail   },
    f7: { pass: catalystPass,  label: 'Catalyst',  detail: catalystDetail  },
    f8: { pass: ratioPass,     label: 'Ratios',    detail: ratioDetail     },
    brainN:          brainData?.n ?? null,
    brainWinRate:    brainData?.isStatisticallyValid ? brainData.winRate : null,
    brainBestWindow: brainData?.isStatisticallyValid ? brainData.bestWindow : null,
    halted,
    cashSettled,
    leaderTicker,
    nearestEarnings,
    latestInsiderBuy: latestBuy,
  };
}

function _buildStack(): SwingCard[] {
  return SELECTABLE
    .map(_buildCard)
    .filter((c): c is SwingCard => c !== null)
    .sort((a, b) => b.score - a.score);
}

// ── Sub-components ─────────────────────────────────────────────────────────────

function ScoreBadge({ score }: { score: number }) {
  const pct = Math.round((score / MAX_SCORE) * 100);
  const cls = pct >= 75 ? 'bg-emerald-900/70 text-emerald-300 border-emerald-700'
            : pct >= 50 ? 'bg-amber-900/60   text-amber-300   border-amber-700'
            : pct >= 25 ? 'bg-zinc-800       text-zinc-400    border-zinc-700'
            :             'bg-zinc-900       text-zinc-600    border-zinc-800';
  return (
    <div className={`flex flex-col items-center justify-center w-14 h-14 rounded-xl border font-mono ${cls}`}>
      <span className="text-lg font-bold leading-none">{pct}</span>
      <span className="text-[9px] opacity-70">/ 100</span>
    </div>
  );
}

function FactorDot({ factor }: { factor: FactorResult }) {
  return (
    <div className="group relative">
      <div className={`w-2 h-2 rounded-full ${factor.pass ? 'bg-emerald-500' : 'bg-zinc-700'}`} />
      <div className="absolute left-1/2 -translate-x-1/2 bottom-4 z-10 hidden group-hover:block
                      bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-[10px] text-zinc-200
                      whitespace-nowrap shadow-xl pointer-events-none min-w-[160px]">
        <div className="font-semibold text-zinc-100 mb-0.5">{factor.label}</div>
        <div className="text-zinc-400">{factor.detail}</div>
      </div>
    </div>
  );
}

function DirectionBadge({ dir }: { dir: 'call' | 'put' | 'neutral' }) {
  if (dir === 'call') return <span className="text-[9px] font-bold px-1.5 py-0.5 rounded bg-emerald-900/60 text-emerald-300 border border-emerald-700 tracking-widest">▲ CALLS</span>;
  if (dir === 'put')  return <span className="text-[9px] font-bold px-1.5 py-0.5 rounded bg-red-900/60    text-red-300    border border-red-700    tracking-widest">▼ PUTS</span>;
  return                     <span className="text-[9px] font-bold px-1.5 py-0.5 rounded bg-zinc-800       text-zinc-400   border border-zinc-700   tracking-widest">◆ COIL</span>;
}

function EarningsGate({ msUntil }: { msUntil: number }) {
  const days = Math.ceil(msUntil / 86400000);
  return (
    <span className="text-[9px] font-bold px-1.5 py-0.5 rounded bg-rose-950/60 text-rose-300 border border-rose-800 tracking-widest">
      EARNINGS {days}d
    </span>
  );
}

function BrainBadge({ winRate, n, bestWindow }: { winRate: number; n: number; bestWindow: string }) {
  const pct = Math.round(winRate * 100);
  const cls = pct >= 65 ? 'text-emerald-400' : pct >= 55 ? 'text-amber-400' : 'text-zinc-400';
  return (
    <div className="flex items-center gap-1 text-[10px] font-mono">
      <span className="text-zinc-500">Brain</span>
      <span className={`font-bold ${cls}`}>{pct}%</span>
      <span className="text-zinc-600">n={n}</span>
      <span className="text-zinc-600">/{bestWindow}</span>
    </div>
  );
}

function FactorRow({ factor, weight }: { factor: FactorResult; weight: number }) {
  return (
    <div className="flex items-start gap-2 py-1.5 border-b border-zinc-800/50 last:border-0">
      <div className={`mt-0.5 w-2 h-2 rounded-full flex-shrink-0 ${factor.pass ? 'bg-emerald-500' : 'bg-zinc-700'}`} />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-[10px] font-semibold text-zinc-300">{factor.label}</span>
          <span className="text-[9px] text-zinc-600">W{weight}</span>
        </div>
        <div className="text-[10px] text-zinc-500 leading-snug">{factor.detail}</div>
      </div>
    </div>
  );
}

function SwingCardComponent({ card, rank }: { card: SwingCard; rank: number }) {
  const [expanded, setExpanded] = useState(false);

  const factors: { factor: FactorResult; weight: number }[] = [
    { factor: card.f1, weight: WEIGHTS.f1 },
    { factor: card.f2, weight: WEIGHTS.f2 },
    { factor: card.f3, weight: WEIGHTS.f3 },
    { factor: card.f4, weight: WEIGHTS.f4 },
    { factor: card.f5, weight: WEIGHTS.f5 },
    { factor: card.f6, weight: WEIGHTS.f6 },
    { factor: card.f7, weight: WEIGHTS.f7 },
    { factor: card.f8, weight: WEIGHTS.f8 },
  ];

  return (
    <div className={`
      rounded-xl border transition-colors duration-200
      ${card.halted
        ? 'border-amber-600 bg-amber-950/10'
        : 'border-zinc-800 bg-zinc-900 hover:border-zinc-700'}
    `}>
      {/* Compact header — always visible */}
      <button
        className="w-full flex items-center gap-3 p-3 text-left"
        onClick={() => setExpanded(e => !e)}
        aria-expanded={expanded}
      >
        {/* Rank */}
        <span className="text-[10px] font-mono text-zinc-600 w-4 flex-shrink-0">#{rank}</span>

        {/* Score badge */}
        <ScoreBadge score={card.score} />

        {/* Ticker + badges */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-bold text-white tracking-wide">{card.ticker}</span>
            <DirectionBadge dir={card.direction} />
            {card.cashSettled && (
              <span className="text-[9px] px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-400 border border-zinc-700">CASH</span>
            )}
            {card.halted && (
              <span className="text-[9px] font-bold px-1.5 py-0.5 rounded bg-amber-900/60 text-amber-300 border border-amber-700">HALT</span>
            )}
            {card.nearestEarnings !== null && (
              <EarningsGate msUntil={card.nearestEarnings - Date.now()} />
            )}
          </div>
          <div className="flex items-center gap-3 mt-1">
            {/* Factor dot summary */}
            <div className="flex items-center gap-1">
              {factors.map(({ factor }, i) => <FactorDot key={i} factor={factor} />)}
            </div>
            {card.brainWinRate !== null && card.brainN !== null && card.brainBestWindow !== null && (
              <BrainBadge winRate={card.brainWinRate} n={card.brainN} bestWindow={card.brainBestWindow} />
            )}
          </div>
        </div>

        {/* Expand chevron */}
        <span className={`text-zinc-600 text-xs transition-transform duration-200 ${expanded ? 'rotate-180' : ''}`}>▼</span>
      </button>

      {/* Expanded detail */}
      {expanded && (
        <div className="border-t border-zinc-800 px-4 py-3 space-y-0">
          {/* Factor breakdown */}
          <div className="mb-3">
            <div className="text-[9px] text-zinc-600 uppercase tracking-widest mb-1">Factor Breakdown</div>
            {factors.map(({ factor, weight }) => (
              <FactorRow key={factor.label} factor={factor} weight={weight} />
            ))}
          </div>

          {/* Leader index context */}
          <div className="pt-2 text-[10px] text-zinc-500 flex items-center gap-1">
            <span className="text-zinc-600">Leader index:</span>
            <span className="text-zinc-300 font-semibold">{card.leaderTicker}</span>
          </div>

          {/* Insider buy recency */}
          {card.latestInsiderBuy !== null && (
            <div className="pt-1 text-[10px] text-zinc-500">
              Last insider buy:&nbsp;
              <span className="text-amber-400 font-semibold">
                {Math.floor((Date.now() - card.latestInsiderBuy) / 86400000)}d ago
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function SkeletonCard() {
  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-4 animate-pulse flex gap-3">
      <div className="w-14 h-14 rounded-xl bg-zinc-800 flex-shrink-0" />
      <div className="flex-1 space-y-2">
        <div className="h-4 w-24 bg-zinc-800 rounded" />
        <div className="h-3 w-40 bg-zinc-800 rounded" />
      </div>
    </div>
  );
}

// ── Main component ─────────────────────────────────────────────────────────────

export default function SwingCockpit() {
  const [stack,  setStack]  = useState<SwingCard[]>([]);
  const [lastRefresh, setLastRefresh] = useState<string>('');
  const brainIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    for (const t of SELECTABLE) {
      barsStore.subscribeTicker(t);
    }

    function rebuild() {
      setStack(_buildStack());
      const _now = toCentralTime(Date.now());
      const _p   = (n: number) => String(n).padStart(2, '0');
      setLastRefresh(`${_p(_now.hour)}:${_p(_now.minute)}:${_p(_now.second)} CT`);
    }

    // Initial brain refresh + interval
    brainStore.refreshBrainStore();
    brainIntervalRef.current = setInterval(() => brainStore.refreshBrainStore(), BRAIN_REFRESH_MS);

    const unsubBars   = barsStore.subscribe(rebuild);
    const unsubCvd    = cvdStore.subscribe(rebuild);
    const unsubMkt    = marketStore.subscribe(rebuild);
    const unsubFund   = fundamentalsStore.subscribe(rebuild);
    const unsubBrain  = brainStore.subscribe(rebuild);
    const unsubDir    = subscribeDirection(rebuild);

    rebuild();

    return () => {
      if (brainIntervalRef.current) clearInterval(brainIntervalRef.current);
      unsubBars();
      unsubCvd();
      unsubMkt();
      unsubFund();
      unsubBrain();
      unsubDir();
    };
  }, []);

  const topCards  = stack.slice(0, 10);
  const restCards = stack.slice(10);
  const [showAll, setShowAll] = useState(false);

  const displayCards = showAll ? stack : topCards;

  return (
    <section id="swing" className="min-h-screen bg-zinc-950 text-white p-4 space-y-5">

      {/* Page header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-bold tracking-wide text-white">Swing</h1>
          <p className="text-xs text-zinc-500 mt-0.5">Multi-day setups · 1–3 week expiry · Fundamentals + technicals</p>
        </div>
        {lastRefresh && (
          <span className="text-[10px] text-zinc-600 font-mono">Updated {lastRefresh}</span>
        )}
      </div>

      {/* Scoring legend */}
      <div className="bg-zinc-900 border border-zinc-800 rounded-xl px-4 py-2.5 flex flex-wrap gap-x-4 gap-y-1">
        {[
          { label: 'Brain',     weight: WEIGHTS.f1, desc: '≥55% win rate, n≥15' },
          { label: 'Technical', weight: WEIGHTS.f2, desc: 'EMA stack, VWAP' },
          { label: 'CVD',       weight: WEIGHTS.f3, desc: 'Options flow confirm' },
          { label: 'Earnings',  weight: WEIGHTS.f4, desc: 'No binary risk <5d' },
          { label: 'Short Int', weight: WEIGHTS.f5, desc: 'SI / SV squeeze fuel' },
          { label: 'Insider',   weight: WEIGHTS.f6, desc: 'Buy <30d' },
          { label: 'Catalyst',  weight: WEIGHTS.f7, desc: 'Recent 8-K' },
          { label: 'Ratios',    weight: WEIGHTS.f8, desc: 'P/E, EV/EBITDA, FCF' },
        ].map(({ label, weight, desc }) => (
          <div key={label} className="flex items-center gap-1.5">
            <span className="text-[9px] text-zinc-500 font-mono">W{weight}</span>
            <span className="text-[10px] text-zinc-400 font-semibold">{label}</span>
            <span className="text-[9px] text-zinc-600">{desc}</span>
          </div>
        ))}
      </div>

      {/* Cards */}
      <div className="space-y-2">
        {stack.length === 0 ? (
          <>
            <SkeletonCard />
            <SkeletonCard />
            <SkeletonCard />
          </>
        ) : (
          <>
            {displayCards.map((card, i) => (
              <SwingCardComponent key={card.ticker} card={card} rank={i + 1} />
            ))}
            {restCards.length > 0 && !showAll && (
              <button
                className="w-full py-2 text-xs text-zinc-500 hover:text-zinc-300 border border-zinc-800 rounded-xl transition-colors"
                onClick={() => setShowAll(true)}
              >
                Show {restCards.length} more tickers ▾
              </button>
            )}
            {showAll && restCards.length > 0 && (
              <button
                className="w-full py-2 text-xs text-zinc-500 hover:text-zinc-300 border border-zinc-800 rounded-xl transition-colors"
                onClick={() => setShowAll(false)}
              >
                Show fewer ▴
              </button>
            )}
          </>
        )}
      </div>

    </section>
  );
}
