/**
 * Layer 4 — IndexesCockpit
 *
 * Macro context panel. Always-visible read of the six structural tickers:
 *   SPY · QQQ · IWM  — the three tradeable index ETFs
 *   TLT · HYG        — bond / credit context (CONTEXT_ONLY)
 *   I:VIX            — implied volatility regime (CONTEXT_ONLY)
 *
 * Each tile shows:
 *   - Last close + % change from previous bar's close
 *   - Session bias pill (bearish / neutral / bullish)
 *   - Play direction arrow
 *   - CVD call/put split bar
 *   - GEX regime badge + flip level
 *   - Key price levels: VWAP, EMA8, EMA21, call wall, put wall, flip
 *   - Active halt strip when luldStore.isHalted() === true
 *
 * Rules:
 *   - Zero outbound calls — all data from local stores
 *   - All Result<T> states handled (loading skeleton, error strip)
 *   - VIX uses barsStore only (no CVD, no GEX)
 *   - TLT/HYG skip signal direction pills; show CVD only
 *   - Correlation matrix at bottom: SPY/QQQ/IWM 20-bar rolling correlation
 */

import { useEffect, useState } from 'react';

import * as barsStore    from '../stores/barsStore';
import * as cvdStore     from '../stores/cvdStore';
import * as marketStore  from '../stores/marketStore';
import * as luldStore    from '../stores/luldStore';
import {
  getDirectionState,
  subscribe as subscribeDirection,
  CONTEXT_ONLY_TICKERS,
} from '../state/directionState';
import type { DirectionState, SessionBias } from '../state/directionState';
import type { CvdState }    from '../stores/cvdStore';
import type { MarketContext } from '../stores/marketStore';
import type { Bar }         from '../stores/types';
import { computeEma }       from '../engines/confluenceEngine';
import { toCentralTime }    from '../lib/time';

// ── Constants ──────────────────────────────────────────────────────────────────

/** Primary index tiles — full data */
const INDEX_TICKERS = ['SPY', 'QQQ', 'IWM'] as const;

/** Context-only tiles — shown with reduced info (no GEX, no direction pills) */
const CONTEXT_TICKERS = ['TLT', 'HYG', 'I:VIX'] as const;

/** All tickers this cockpit subscribes to */
const ALL_TICKERS = [...INDEX_TICKERS, ...CONTEXT_TICKERS] as string[];

/** Rolling window for correlation matrix */
const CORR_WINDOW = 20;

// ── Derived tile state ─────────────────────────────────────────────────────────

interface TileData {
  ticker:      string;
  price:       number | null;
  changePct:   number | null;
  vwap:        number | null;
  ema8:        number | null;
  ema21:       number | null;
  cvd:         CvdState | null;
  gex:         MarketContext | null;
  direction:   DirectionState | null;
  halted:      boolean;
  /** False when this ticker's exchange never publishes LULD halt/resume data (see luldStore.hasHaltCoverage). */
  hasHaltCoverage: boolean;
  asOf:        string;       // last bar time formatted
  loading:     boolean;
  error:       string | null;
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function _sessionVwap(bars: Bar[]): number | null {
  if (bars.length === 0) return null;
  let cumPV = 0;
  let cumV  = 0;
  for (const b of bars) {
    const v = b.volume;
    const p = b.vwap ?? (b.high + b.low + b.close) / 3;
    cumPV += p * v;
    cumV  += v;
  }
  return cumV > 0 ? cumPV / cumV : null;
}

function _buildTile(ticker: string): TileData {
  const barsR  = barsStore.getResult(ticker);
  const cvdR   = cvdStore.getResult(ticker);
  const mktR   = marketStore.getResult(ticker);
  const halted = luldStore.isHalted(ticker) === true;
  const haltCoverage = luldStore.hasHaltCoverage(ticker);
  const dir    = getDirectionState(ticker);

  if (barsR.status === 'loading') {
    return {
      ticker, price: null, changePct: null, vwap: null, ema8: null,
      ema21: null, cvd: null, gex: null, direction: null, halted,
      hasHaltCoverage: haltCoverage,
      asOf: '', loading: true, error: null,
    };
  }

  if (barsR.status === 'error') {
    return {
      ticker, price: null, changePct: null, vwap: null, ema8: null,
      ema21: null, cvd: null, gex: null, direction: null, halted,
      hasHaltCoverage: haltCoverage,
      asOf: '', loading: false, error: barsR.reason,
    };
  }

  const bars   = barsR.data;
  const last   = bars[bars.length - 1];
  const prev   = bars.length >= 2 ? bars[bars.length - 2] : null;
  const closes = bars.map(b => b.close);

  const price     = last?.close ?? null;
  const changePct = last && prev ? ((last.close - prev.close) / prev.close) * 100 : null;
  const vwap      = _sessionVwap(bars);
  const ema8      = closes.length >= 1 ? computeEma(closes, 8)  : null;
  const ema21     = closes.length >= 1 ? computeEma(closes, 21) : null;
  const _ct = last ? toCentralTime(last.tCT) : null;
  const asOf = _ct
    ? `${String(_ct.hour).padStart(2, '0')}:${String(_ct.minute).padStart(2, '0')}`
    : '';

  return {
    ticker,
    price,
    changePct,
    vwap,
    ema8,
    ema21,
    cvd:       cvdR.status === 'ready'  ? cvdR.data   : null,
    gex:       mktR.status === 'ready'  ? mktR.data   : null,
    direction: dir,
    halted,
    hasHaltCoverage: haltCoverage,
    asOf,
    loading:   false,
    error:     null,
  };
}

function _rollingCorr(a: number[], b: number[], n: number): number | null {
  const len = Math.min(a.length, b.length, n);
  if (len < 4) return null;
  const sa = a.slice(-len);
  const sb = b.slice(-len);
  const ma = sa.reduce((s, v) => s + v, 0) / len;
  const mb = sb.reduce((s, v) => s + v, 0) / len;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < len; i++) {
    const ea = sa[i] - ma;
    const eb = sb[i] - mb;
    num += ea * eb;
    da  += ea * ea;
    db  += eb * eb;
  }
  const denom = Math.sqrt(da * db);
  return denom === 0 ? null : num / denom;
}

// ── Sub-components ─────────────────────────────────────────────────────────────

function BiasPill({ bias }: { bias: SessionBias }) {
  const cfg: Record<SessionBias, { label: string; cls: string }> = {
    bullish: { label: 'BULLISH',  cls: 'bg-col-g/15 text-col-g border border-col-g/30' },
    bearish: { label: 'BEARISH',  cls: 'bg-col-r/15 text-col-r border border-col-r/30' },
    neutral: { label: 'NEUTRAL',  cls: 'bg-white/5 text-white/40 border border-white/10' },
  };
  const { label, cls } = cfg[bias];
  return (
    <span className={`text-[9px] font-bold tracking-widest px-1.5 py-0.5 rounded ${cls}`}>
      {label}
    </span>
  );
}

function PlayArrow({ dir }: { dir: string }) {
  if (dir === 'calls')         return <span className="text-col-g text-xs font-bold">▲ CALLS</span>;
  if (dir === 'puts')          return <span className="text-col-r text-xs font-bold">▼ PUTS</span>;
  if (dir === 'consolidating') return <span className="text-amb  text-xs font-bold">◆ COIL</span>;
  return                              <span className="text-white/25   text-xs">— NONE</span>;
}

function CvdBar({ cvd }: { cvd: CvdState }) {
  const callW = Math.round(cvd.callPct);
  const putW  = 100 - callW;
  const bull  = cvd.classification === 'bullish';
  const bear  = cvd.classification === 'bearish';
  return (
    <div className="w-full">
      <div className="flex justify-between text-[9px] font-mono mb-0.5">
        <span className={bull ? 'text-col-g' : 'text-white/20'}>C {callW}%</span>
        <span className={bear ? 'text-col-r'     : 'text-white/20'}>P {putW}%</span>
      </div>
      <div className="flex h-1.5 rounded overflow-hidden">
        <div
          className={`transition-all duration-500 ${bull ? 'bg-col-g' : 'bg-col-g/20'}`}
          style={{ width: `${callW}%` }}
        />
        <div
          className={`transition-all duration-500 flex-1 ${bear ? 'bg-col-r' : 'bg-col-r/20'}`}
        />
      </div>
    </div>
  );
}

function GexBadge({ regime }: { regime: string }) {
  if (regime === 'positive') return <span className="text-[9px] font-bold px-1.5 py-0.5 rounded bg-col-g/15 text-col-g border border-col-g/30">+GEX</span>;
  if (regime === 'negative') return <span className="text-[9px] font-bold px-1.5 py-0.5 rounded bg-col-r/15 text-col-r border border-col-r/30">−GEX</span>;
  return                            <span className="text-[9px] font-bold px-1.5 py-0.5 rounded bg-white/5  text-white/40 border border-white/10">NEU</span>;
}

function PriceLevel({ label, value, highlight }: { label: string; value: number; highlight?: 'green' | 'red' | 'amber' }) {
  const cls = highlight === 'green' ? 'text-col-g'
            : highlight === 'red'   ? 'text-col-r'
            : highlight === 'amber' ? 'text-amb'
            : 'text-white/40';
  return (
    <div className="flex justify-between items-center">
      <span className="text-[9px] text-white/25 uppercase tracking-wider">{label}</span>
      <span className={`text-[11px] font-mono font-semibold ${cls}`}>{value.toFixed(2)}</span>
    </div>
  );
}

function SkeletonTile() {
  return (
    <div className="bg-panel border border-line p-4 animate-pulse space-y-2">
      <div className="h-3 w-20 bg-white/8 rounded" />
      <div className="h-6 w-28 bg-white/8 rounded" />
      <div className="h-2 w-full bg-white/8 rounded" />
      <div className="h-2 w-3/4 bg-white/8 rounded" />
    </div>
  );
}

function IndexTile({ tile }: { tile: TileData }) {
  const isContext = CONTEXT_ONLY_TICKERS.has(tile.ticker);
  const isVix     = tile.ticker === 'I:VIX';

  if (tile.loading) return <SkeletonTile />;

  const priceColor = tile.changePct === null ? 'text-white/60'
    : tile.changePct > 0  ? 'text-col-g'
    : tile.changePct < 0  ? 'text-col-r'
    : 'text-white/60';

  const changeSign = tile.changePct === null ? '' : tile.changePct >= 0 ? '+' : '';

  // Determine if price is above/below key levels for highlighting
  const aboveVwap = tile.price !== null && tile.vwap !== null && tile.price > tile.vwap;
  const aboveEma8 = tile.price !== null && tile.ema8  !== null && tile.price > tile.ema8;

  return (
    <div className={`
      relative bg-panel border p-4 flex flex-col gap-3 min-h-[220px]
      transition-colors duration-300
      ${tile.halted
        ? 'border-amb/40 shadow-[0_0_12px_rgba(var(--amb),0.15)]'
        : 'border-line hover:border-white/15'}
    `}>
      {/* Halt strip */}
      {tile.halted && (
        <div className="absolute top-0 left-0 right-0 h-1 bg-amb animate-pulse" />
      )}

      {/* Header row */}
      <div className="flex items-start justify-between gap-2">
        <div>
          <div className="flex items-center gap-2">
            <span className="text-sm font-bold text-white tracking-wide">{tile.ticker}</span>
            {tile.halted && (
              <span className="text-[9px] font-bold px-1.5 py-0.5 bg-amb/15 text-amb border border-amb/30 rounded tracking-widest">HALT</span>
            )}
            {!tile.hasHaltCoverage && (
              <span
                className="text-[9px] text-white/25 border border-white/10 px-1.5 py-0.5 rounded"
                title="This exchange doesn't publish halt data — not the same as confirmed trading"
              >
                NO HALT DATA
              </span>
            )}
            {isContext && (
              <span className="text-[9px] text-white/25 border border-white/10 px-1.5 py-0.5 rounded">CTX</span>
            )}
          </div>
          <div className="flex items-baseline gap-2 mt-0.5">
            <span className={`text-xl font-mono font-bold ${priceColor}`}>
              {tile.price !== null ? tile.price.toFixed(isVix ? 2 : 2) : '—'}
            </span>
            {tile.changePct !== null && (
              <span className={`text-xs font-mono ${priceColor}`}>
                {changeSign}{tile.changePct.toFixed(2)}%
              </span>
            )}
          </div>
          {tile.asOf && (
            <div className="text-[9px] text-white/20 mt-0.5">{tile.asOf} CT</div>
          )}
        </div>

        <div className="flex flex-col items-end gap-1.5">
          {!isContext && tile.direction && (
            <BiasPill bias={tile.direction.sessionBias} />
          )}
          {tile.gex && !isContext && <GexBadge regime={tile.gex.gexRegime} />}
        </div>
      </div>

      {/* Play direction — index tickers only */}
      {!isContext && tile.direction && (
        <div className="flex items-center gap-2">
          <PlayArrow dir={tile.direction.playDirection} />
          <span className="text-[9px] text-white/25 truncate max-w-[140px]" title={tile.direction.playDirectionReason}>
            {tile.direction.playDirectionReason}
          </span>
        </div>
      )}

      {/* CVD bar — skip VIX */}
      {!isVix && tile.cvd && (
        <CvdBar cvd={tile.cvd} />
      )}

      {/* Price levels */}
      <div className="space-y-0.5 flex-1">
        {tile.vwap  !== null && (
          <PriceLevel label="VWAP"  value={tile.vwap}  highlight={aboveVwap ? 'green' : 'red'} />
        )}
        {tile.ema8  !== null && (
          <PriceLevel label="EMA8"  value={tile.ema8}  highlight={aboveEma8 ? 'green' : undefined} />
        )}
        {tile.ema21 !== null && (
          <PriceLevel label="EMA21" value={tile.ema21} />
        )}
        {tile.gex && !isContext && (
          <>
            <PriceLevel label="FLIP"  value={tile.gex.flipLevel}    highlight="amber" />
            <PriceLevel label="CALL↑" value={tile.gex.walls.callWall} highlight="green" />
            <PriceLevel label="PUT↓"  value={tile.gex.walls.putWall}  highlight="red" />
          </>
        )}
      </div>

      {/* Error strip */}
      {tile.error && (
        <div className="text-[9px] text-col-r border border-col-r/20 rounded px-2 py-1 bg-col-r/5">
          {tile.error}
        </div>
      )}
    </div>
  );
}

function CorrCell({ corr }: { corr: number | null }) {
  if (corr === null) return <td className="px-3 py-2 text-center text-white/20 text-xs">—</td>;
  const pct = Math.round(corr * 100);
  const cls = corr >  0.7 ? 'text-col-g'
            : corr >  0.3 ? 'text-col-g/60'
            : corr < -0.7 ? 'text-col-r'
            : corr < -0.3 ? 'text-col-r/60'
            : 'text-white/40';
  return (
    <td className={`px-3 py-2 text-center text-xs font-mono ${cls}`}>{pct}%</td>
  );
}

// ── Net Market GEX ────────────────────────────────────────────────────────────

function _formatGex(n: number): string {
  const abs = Math.abs(n);
  const sign = n >= 0 ? '+' : '−';
  if (abs >= 1e9)  return `${sign}${(abs / 1e9).toFixed(2)}B`;
  if (abs >= 1e6)  return `${sign}${(abs / 1e6).toFixed(1)}M`;
  if (abs >= 1e3)  return `${sign}${(abs / 1e3).toFixed(0)}K`;
  return `${sign}${abs.toFixed(0)}`;
}

function NetMarketGex() {
  const spyR = marketStore.getResult('SPY');
  const qqqR = marketStore.getResult('QQQ');
  const iwmR = marketStore.getResult('IWM');

  const spyGex = spyR.status === 'ready' ? spyR.data.netGex : null;
  const qqqGex = qqqR.status === 'ready' ? qqqR.data.netGex : null;
  const iwmGex = iwmR.status === 'ready' ? iwmR.data.netGex : null;

  const allReady = spyGex !== null && qqqGex !== null && iwmGex !== null;
  const net = allReady ? spyGex + qqqGex + iwmGex : null;

  const allNeg = allReady && spyGex < 0 && qqqGex < 0 && iwmGex < 0;
  const allPos = allReady && spyGex > 0 && qqqGex > 0 && iwmGex > 0;

  return (
    <div className={`
      border p-4 space-y-2
      ${allNeg ? 'bg-col-r/10 border-col-r/30' : allPos ? 'bg-col-g/10 border-col-g/20' : 'bg-panel border-line'}
    `}>
      <div className="flex items-center justify-between">
        <span className="text-[10px] text-white/25 uppercase tracking-widest font-semibold">Net Market GEX</span>
        {net !== null && (
          <span className={`text-2xl font-mono font-bold ${allNeg ? 'text-col-r' : allPos ? 'text-col-g' : 'text-ink'}`}>
            {_formatGex(net)}
          </span>
        )}
        {net === null && <span className="text-white/20 text-sm">—</span>}
      </div>

      {/* Per-index breakdown */}
      <div className="flex gap-4">
        {(['SPY', 'QQQ', 'IWM'] as const).map((t, i) => {
          const g = [spyGex, qqqGex, iwmGex][i];
          return (
            <div key={t} className="flex items-center gap-1.5">
              <span className="text-[9px] text-white/25">{t}</span>
              <span className={`text-[11px] font-mono font-semibold ${g === null ? 'text-white/20' : g < 0 ? 'text-col-r' : 'text-col-g'}`}>
                {g !== null ? _formatGex(g) : '—'}
              </span>
            </div>
          );
        })}
      </div>

      {/* Regime label */}
      {allNeg && (
        <p className="text-xs text-col-r font-semibold leading-snug">
          ALL THREE NEG GEX — DEALERS SHORT GAMMA MARKET-WIDE. Every move amplifies. Best 0DTE environment.
        </p>
      )}
      {allPos && (
        <p className="text-xs text-col-g font-semibold leading-snug">
          POSITIVE GAMMA MARKET-WIDE — moves dampened, pin risk elevated.
        </p>
      )}
      {!allNeg && !allPos && net !== null && (
        <p className="text-[10px] text-white/25">Mixed GEX regime — sector divergence present.</p>
      )}
      {net === null && (
        <p className="text-[10px] text-white/20">Waiting for GEX engine data…</p>
      )}
    </div>
  );
}

// ── SPY Candle Pattern Classifier ─────────────────────────────────────────────

type CandlePattern = 'TRENDING_BULLISH' | 'TRENDING_BEARISH' | 'CONSOLIDATING' | 'FALSE_BREAK' | 'REVERSAL' | 'INSUFFICIENT_DATA';

function _classifySpyCandles(bars: Bar[], cvdCallPct: number | null): CandlePattern {
  if (bars.length < 8) return 'INSUFFICIENT_DATA';

  const last8  = bars.slice(-8);
  const vol20  = bars.slice(-20).reduce((s, b) => s + b.volume, 0) / Math.min(bars.length, 20);

  const lastBar = last8[last8.length - 1];
  const lastVol = lastBar.volume;

  // REVERSAL: last candle has significantly above-avg volume AND closes against the prior 6-bar trend
  const prior6Closes = last8.slice(0, 7).map(b => b.close);
  const prior6Trend  = prior6Closes[prior6Closes.length - 1] - prior6Closes[0]; // + = up, - = down
  const reversalClose = (prior6Trend > 0 && lastBar.close < last8[6].close) ||
                        (prior6Trend < 0 && lastBar.close > last8[6].close);
  if (lastVol > vol20 * 1.5 && reversalClose) return 'REVERSAL';

  // TRENDING: closes each progressively higher/lower AND volume increasing candle-on-candle
  const closesAscending  = last8.every((b, i) => i === 0 || b.close > last8[i - 1].close);
  const closesDescending = last8.every((b, i) => i === 0 || b.close < last8[i - 1].close);
  const volIncreasing    = last8.every((b, i) => i === 0 || b.volume >= last8[i - 1].volume * 0.9);
  const cvdBullish       = cvdCallPct !== null && cvdCallPct > 52;
  const cvdBearish       = cvdCallPct !== null && cvdCallPct < 48;

  if (closesAscending  && volIncreasing && cvdBullish) return 'TRENDING_BULLISH';
  if (closesDescending && volIncreasing && cvdBearish) return 'TRENDING_BEARISH';

  // FALSE BREAK: price broke a recent high/low, CVD did not confirm, volume below avg
  const recentHigh = Math.max(...last8.slice(0, 7).map(b => b.high));
  const recentLow  = Math.min(...last8.slice(0, 7).map(b => b.low));
  const brokeHigh  = lastBar.high > recentHigh;
  const brokeLow   = lastBar.low  < recentLow;
  const cvdNotConfirm = cvdCallPct === null || (cvdCallPct >= 48 && cvdCallPct <= 52);
  if ((brokeHigh || brokeLow) && cvdNotConfirm && lastVol < vol20) return 'FALSE_BREAK';

  // CONSOLIDATING: every bar overlaps prior bar's range, volume declining vs 20-bar avg
  const overlapping = last8.every((b, i) => {
    if (i === 0) return true;
    const prev = last8[i - 1];
    return b.low < prev.high && b.high > prev.low;
  });
  const avgVol8 = last8.reduce((s, b) => s + b.volume, 0) / 8;
  if (overlapping && avgVol8 < vol20) return 'CONSOLIDATING';

  // Default to the directional trend without strict volume requirement
  if (closesAscending)  return 'TRENDING_BULLISH';
  if (closesDescending) return 'TRENDING_BEARISH';

  return 'CONSOLIDATING';
}

function SpyCandlePattern({ bars, cvdCallPct }: { bars: Bar[]; cvdCallPct: number | null }) {
  const pattern = _classifySpyCandles(bars, cvdCallPct);

  type PatternCfg = { label: string; sub: string; border: string; bg: string; text: string };
  const cfg: Record<CandlePattern, PatternCfg> = {
    TRENDING_BULLISH:    { label: 'TRENDING BULLISH',   sub: 'Closes escalating, volume increasing, CVD confirming.',           border: 'border-col-g/30',  bg: 'bg-col-g/10',   text: 'text-col-g'   },
    TRENDING_BEARISH:    { label: 'TRENDING BEARISH',   sub: 'Closes cascading, volume increasing, CVD confirming.',            border: 'border-col-r/30',  bg: 'bg-col-r/10',   text: 'text-col-r'   },
    CONSOLIDATING:       { label: 'CONSOLIDATING',      sub: 'Wait for the break.',                                             border: 'border-amb/30',    bg: 'bg-amb/10',     text: 'text-amb'     },
    FALSE_BREAK:         { label: 'FALSE BREAK',        sub: 'CVD not confirming. High false-positive rate.',                   border: 'border-amb/20',    bg: 'bg-amb/5',      text: 'text-amb/70'  },
    REVERSAL:            { label: 'REVERSAL CANDLE DETECTED', sub: 'Thesis reassessment required.',                             border: 'border-col-r/40',  bg: 'bg-col-r/10',   text: 'text-col-r'   },
    INSUFFICIENT_DATA:   { label: 'INSUFFICIENT DATA',  sub: 'Waiting for 8 bars.',                                             border: 'border-line',      bg: 'bg-panel',      text: 'text-white/25'},
  };

  const { label, sub, border, bg, text } = cfg[pattern];

  return (
    <div className={`border p-4 space-y-1 ${border} ${bg}`}>
      <div className="text-[10px] text-white/25 uppercase tracking-widest font-semibold mb-1">SPY 5m — Last 8 Candles</div>
      <div className={`text-sm font-bold ${text}`}>{label}</div>
      <div className="text-[11px] text-white/40">{sub}</div>
    </div>
  );
}

// ── Main component ─────────────────────────────────────────────────────────────

export default function IndexesCockpit() {
  const [tiles,     setTiles]     = useState<TileData[]>(() => ALL_TICKERS.map(_buildTile));
  const [corrSPY,   setCorrSPY]   = useState<[number | null, number | null]>([null, null]);
  const [corrQQQIWM, setCorrQQQIWM] = useState<number | null>(null);
  const [lastRefresh, setLastRefresh] = useState<string>('');

  // Subscribe all tickers on mount
  useEffect(() => {
    for (const t of ALL_TICKERS) {
      barsStore.subscribeTicker(t);
    }

    function rebuild() {
      setTiles(ALL_TICKERS.map(_buildTile));

      // Correlation matrix: SPY vs QQQ, SPY vs IWM
      const spyR = barsStore.getResult('SPY');
      const qqqR = barsStore.getResult('QQQ');
      const iwmR = barsStore.getResult('IWM');

      const spyC = spyR.status === 'ready' ? spyR.data.map(b => b.close) : [];
      const qqqC = qqqR.status === 'ready' ? qqqR.data.map(b => b.close) : [];
      const iwmC = iwmR.status === 'ready' ? iwmR.data.map(b => b.close) : [];

      setCorrSPY([
        _rollingCorr(spyC, qqqC, CORR_WINDOW),
        _rollingCorr(spyC, iwmC, CORR_WINDOW),
      ]);
      setCorrQQQIWM(_rollingCorr(qqqC, iwmC, CORR_WINDOW));

      const _now = toCentralTime(Date.now());
      const _pad = (n: number) => String(n).padStart(2, '0');
      setLastRefresh(`${_pad(_now.hour)}:${_pad(_now.minute)}:${_pad(_now.second)} CT`);
    }

    const unsubBars  = barsStore.subscribe(rebuild);
    const unsubCvd   = cvdStore.subscribe(rebuild);
    const unsubMkt   = marketStore.subscribe(rebuild);
    const unsubLuld  = luldStore.subscribe(rebuild);
    const unsubDir   = subscribeDirection(rebuild);

    rebuild();

    return () => {
      unsubBars();
      unsubCvd();
      unsubMkt();
      unsubLuld();
      unsubDir();
    };
  }, []);

  const indexTiles   = tiles.filter(t => INDEX_TICKERS.includes(t.ticker as typeof INDEX_TICKERS[number]));
  const contextTiles = tiles.filter(t => CONTEXT_TICKERS.includes(t.ticker as typeof CONTEXT_TICKERS[number]));

  const [corrQQQ, corrIWM] = corrSPY;

  // SPY bars + CVD for candle pattern
  const spyBarsR = barsStore.getResult('SPY');
  const spyCvdR  = cvdStore.getResult('SPY');
  const spyBars  = spyBarsR.status === 'ready' ? spyBarsR.data : [];
  const spyCvdPct = spyCvdR.status === 'ready' ? spyCvdR.data.callPct : null;

  return (
    <section id="indexes" className="min-h-screen bg-void text-ink p-4 space-y-6">

      {/* Page header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-bold tracking-wide text-white">Indexes</h1>
          <p className="text-xs text-mut mt-0.5">Macro context · Session structure · Flow</p>
        </div>
        {lastRefresh && (
          <span className="text-[10px] text-dim font-mono">Updated {lastRefresh}</span>
        )}
      </div>

      {/* Primary index tiles — SPY / QQQ / IWM */}
      <div>
        <div className="text-[10px] text-dim uppercase tracking-widest mb-2">Tradeable Indexes</div>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          {indexTiles.map(t => <IndexTile key={t.ticker} tile={t} />)}
        </div>
      </div>

      {/* Net Market GEX */}
      <NetMarketGex />

      {/* SPY candle pattern */}
      <SpyCandlePattern bars={spyBars} cvdCallPct={spyCvdPct} />

      {/* Context tiles — TLT / HYG / VIX */}
      <div>
        <div className="text-[10px] text-dim uppercase tracking-widest mb-2">Macro Context</div>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          {contextTiles.map(t => <IndexTile key={t.ticker} tile={t} />)}
        </div>
      </div>

      {/* Correlation matrix */}
      <div>
        <div className="text-[10px] text-dim uppercase tracking-widest mb-2">
          20-Bar Rolling Correlation
        </div>
        <div className="bg-panel border border-line overflow-hidden">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-line">
                <th className="px-3 py-2 text-left text-white/25 font-normal"></th>
                <th className="px-3 py-2 text-center text-white/40 font-semibold">SPY</th>
                <th className="px-3 py-2 text-center text-white/40 font-semibold">QQQ</th>
                <th className="px-3 py-2 text-center text-white/40 font-semibold">IWM</th>
              </tr>
            </thead>
            <tbody>
              <tr className="border-b border-line/50">
                <td className="px-3 py-2 text-white/40 font-semibold">SPY</td>
                <td className="px-3 py-2 text-center text-white/15 text-xs">100%</td>
                <CorrCell corr={corrQQQ} />
                <CorrCell corr={corrIWM} />
              </tr>
              <tr className="border-b border-line/50">
                <td className="px-3 py-2 text-white/40 font-semibold">QQQ</td>
                <CorrCell corr={corrQQQ} />
                <td className="px-3 py-2 text-center text-white/15 text-xs">100%</td>
                <CorrCell corr={corrQQQIWM} />
              </tr>
              <tr>
                <td className="px-3 py-2 text-white/40 font-semibold">IWM</td>
                <CorrCell corr={corrIWM} />
                <CorrCell corr={corrQQQIWM} />
                <td className="px-3 py-2 text-center text-white/15 text-xs">100%</td>
              </tr>
            </tbody>
          </table>
        </div>
        <p className="text-[9px] text-white/15 mt-1.5">
          Rolling {CORR_WINDOW}-bar Pearson correlation of close prices. Green = moving together, Red = diverging.
        </p>
      </div>

    </section>
  );
}
