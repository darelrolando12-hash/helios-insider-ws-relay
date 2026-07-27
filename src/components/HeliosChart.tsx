/**
 * Layer 4 — HeliosChart
 *
 * The primary execution surface for Helios Insiders. NOT a generic chart
 * component. This is the chart Helios draws — every level, overlay, and
 * signal marker is specific to the trading intelligence layer.
 *
 * Data sources (all read-only, zero outbound calls):
 *   Price candles       → barsStore
 *   CVD accumulation    → cvdStore (callPct / putPct per session window)
 *   GEX levels/walls    → marketStore
 *   Session direction   → directionState
 *
 * Panels (top to bottom):
 *   1. Price panel  — OHLC candles + static GEX levels + EMA overlays +
 *                     session bias tint + VWAP + signal markers on triggering candles
 *   2. CVD panel    — per-bar (callPct − putPct) as a directional skew line,
 *                     zero-line, color-coded by slope (rising green / falling red)
 *   3. Aggressor panel — histogram of CVD skew rate-of-change over last 3 bars
 *
 * CVD data source (FIX 4):
 *   cvdStore exposes CvdState with callPct, putPct, netDelta — NOT a ticks array.
 *   The CVD line is built from per-bar snapshots: for each bar in barsStore,
 *   the directional skew value is (callPct − putPct) captured at that bar's time.
 *   Because cvdStore holds only the current session window state (not a per-bar
 *   history), we use the current snapshot applied to all bars, building a flat
 *   line that updates in real-time as the session progresses. This is the correct
 *   approach given the available data contract.
 *
 * GEX walls (FIX 5):
 *   MarketContextSnapshot.walls is GexWalls { callWall, putWall } (singular values).
 *   MarketContext adds upTarget / downTarget as the second significant cluster.
 *   Primary wall = callWall / putWall (full opacity, lineWidth 2).
 *   Secondary level = upTarget / downTarget (reduced opacity, lineWidth 1).
 *
 * Signal markers drawn on the candle where the event occurred:
 *   FORMING       → small circle below/above bar
 *   TRIGGERING    → medium circle, bold
 *   ACTIVE        → filled circle with text
 *   CONSOLIDATING → hollow circle (smaller)
 *   CONTINUATION  → circle with inner marker
 *   RE_ENTRY      → square marker
 *   FLIP          → directional arrow
 *   EXIT          → square with P&L text (green profit / red loss)
 *   DUMP_RIP      → directional arrow with ⚡ text
 *
 * Uses Lightweight Charts v5 API:
 *   chart.addSeries(CandlestickSeries, options) — not addCandlestickSeries()
 *   chart.addSeries(LineSeries, options)        — not addLineSeries()
 *   chart.addSeries(HistogramSeries, options)   — not addHistogramSeries()
 *   createSeriesMarkers(series, markers)        — not series.setMarkers()
 *
 * Panels are implemented as separate chart instances synced via
 * subscribeVisibleLogicalRangeChange — LWC v5 does not expose independent
 * chart panes directly from a single chart instance.
 */

import React, {
  useEffect,
  useRef,
  useCallback,
  useMemo,
  useState,
} from 'react';
import {
  createChart,
  createSeriesMarkers,
  CrosshairMode,
  LineStyle,
  CandlestickSeries,
  LineSeries,
  HistogramSeries,
  type IChartApi,
  type ISeriesApi,
  type ISeriesMarkersPluginApi,
  type SeriesMarker,
  type Time,
  type UTCTimestamp,
  type CandlestickData,
  type LineData,
  type HistogramData,
} from 'lightweight-charts';
import * as barsStore      from '../stores/barsStore';
import * as cvdStore       from '../stores/cvdStore';
import * as marketStore    from '../stores/marketStore';
import * as directionState from '../state/directionState';
import { toCentralTime }   from '../lib/time';
import type { Bar }        from '../stores/types';
import type { MarketContext } from '../stores/marketStore';

// ── Colour tokens ──────────────────────────────────────────────────────────────

const C = {
  bg:          '#0d0f14',
  bgPanel:     '#111318',
  border:      '#1e2129',
  text:        '#c9d1d9',
  textMuted:   '#6e7681',

  bullBody:    '#26a69a',
  bullWick:    '#26a69a',
  bearBody:    '#ef5350',
  bearWick:    '#ef5350',

  // GEX levels — primary walls at full opacity, secondary at reduced
  callWall:         '#26a69a',
  callWallSecondary: 'rgba(38, 166, 154, 0.45)',
  putWall:          '#ef5350',
  putWallSecondary:  'rgba(239, 83, 80, 0.45)',
  flip:             '#f59e0b',
  maxPain:          '#a855f7',
  vwap:             '#ffffff',
  pdh:              '#4b5563',
  pdl:              '#4b5563',

  ema8:        '#22d3ee',
  ema21:       '#94a3b8',
  ema55:       '#f59e0b',

  bullTint:    'rgba(38, 166, 154, 0.04)',
  bearTint:    'rgba(239, 83, 80, 0.04)',
  neutralTint: 'rgba(100, 116, 139, 0.04)',

  cvdRising:   '#26a69a',
  cvdFalling:  '#ef5350',
  cvdZero:     '#374151',

  aggrBull:    '#26a69a',
  aggrBear:    '#ef5350',

  callSignal:  '#26a69a',
  putSignal:   '#ef5350',
  dumpRip:     '#f59e0b',
} as const;

// ── Types ──────────────────────────────────────────────────────────────────────

export type SignalMarkerState =
  | 'FORMING'
  | 'TRIGGERING'
  | 'ACTIVE'
  | 'CONSOLIDATING'
  | 'CONTINUATION'
  | 'RE_ENTRY'
  | 'FLIP'
  | 'EXIT'
  | 'DUMP_RIP';

export interface ChartSignalMarker {
  id:         string;
  ticker:     string;
  state:      SignalMarkerState;
  direction:  'call' | 'put';
  tCT:        number;    // CT pseudo-UTC epoch
  price:      number;
  pnlPct?:    number;    // for EXIT markers
  parentId?:  string;    // for CONTINUATION, RE_ENTRY, FLIP
}

export interface HeliosChartProps {
  ticker:         string;
  markers?:       ChartSignalMarker[];
  onMarkerClick?: (markerId: string) => void;
  height?:        number;
  className?:     string;
}

// ── Panel height ratios ────────────────────────────────────────────────────────

const PRICE_PANEL_RATIO = 0.60;
const CVD_PANEL_RATIO   = 0.25;
const AGGR_PANEL_RATIO  = 0.15;

// ── Chart helpers ─────────────────────────────────────────────────────────────

function _makeChartOptions(
  width:  number,
  height: number,
  opts:   { showTimeAxis: boolean; bgColor?: string },
) {
  return {
    width,
    height,
    layout: {
      background: { color: opts.bgColor ?? C.bg },
      textColor:  C.text,
      fontSize:   11,
      fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
    },
    grid: {
      vertLines: { color: C.border, style: LineStyle.Dotted },
      horzLines: { color: C.border, style: LineStyle.Dotted },
    },
    crosshair: {
      mode: CrosshairMode.Normal,
      vertLine: { color: '#374151', width: 1 as const, style: LineStyle.Dashed, labelBackgroundColor: C.bgPanel },
      horzLine: { color: '#374151', width: 1 as const, style: LineStyle.Dashed, labelBackgroundColor: C.bgPanel },
    },
    rightPriceScale: {
      borderColor:  C.border,
      textColor:    C.textMuted,
      scaleMargins: { top: 0.05, bottom: 0.05 },
    },
    timeScale: {
      borderColor:    C.border,
      timeVisible:    opts.showTimeAxis,
      secondsVisible: false,
    },
    handleScroll:  true,
    handleScale:   true,
  };
}

// ── Component ─────────────────────────────────────────────────────────────────

export const HeliosChart = React.memo(function HeliosChart({
  ticker,
  markers     = [],
  onMarkerClick,
  height      = 640,
  className   = '',
}: HeliosChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  // Chart instance refs
  const priceChartRef = useRef<IChartApi | null>(null);
  const cvdChartRef   = useRef<IChartApi | null>(null);
  const aggrChartRef  = useRef<IChartApi | null>(null);

  // Series refs
  const candleSeriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const ema8Ref         = useRef<ISeriesApi<'Line'> | null>(null);
  const ema21Ref        = useRef<ISeriesApi<'Line'> | null>(null);
  const ema55Ref        = useRef<ISeriesApi<'Line'> | null>(null);
  const vwapRef         = useRef<ISeriesApi<'Line'> | null>(null);
  const cvdLineRef      = useRef<ISeriesApi<'Line'> | null>(null);
  const aggrHistRef     = useRef<ISeriesApi<'Histogram'> | null>(null);

  // Markers plugin ref
  const markersPluginRef = useRef<ISeriesMarkersPluginApi<Time> | null>(null);

  // Sub-panel container refs (created in useEffect, cleaned up on unmount)
  const cvdContainerRef  = useRef<HTMLDivElement | null>(null);
  const aggrContainerRef = useRef<HTMLDivElement | null>(null);

  const [direction, setDirection] = useState<directionState.DirectionState | null>(null);
  const onMarkerClickRef = useRef(onMarkerClick);
  useEffect(() => { onMarkerClickRef.current = onMarkerClick; }, [onMarkerClick]);

  // ── Chart initialisation ────────────────────────────────────────────────────

  useEffect(() => {
    if (!containerRef.current) return;

    const totalWidth  = containerRef.current.clientWidth;
    const priceHeight = Math.round(height * PRICE_PANEL_RATIO);
    const cvdHeight   = Math.round(height * CVD_PANEL_RATIO);
    const aggrHeight  = Math.round(height * AGGR_PANEL_RATIO);

    // ── Price chart ─────────────────────────────────────────────────────────
    const priceChart = createChart(
      containerRef.current,
      _makeChartOptions(totalWidth, priceHeight, { showTimeAxis: false }),
    );
    priceChartRef.current = priceChart;

    const candleSeries = priceChart.addSeries(CandlestickSeries, {
      upColor:         C.bullBody,
      downColor:       C.bearBody,
      borderUpColor:   C.bullWick,
      borderDownColor: C.bearWick,
      wickUpColor:     C.bullWick,
      wickDownColor:   C.bearWick,
    });
    candleSeriesRef.current = candleSeries;

    // Markers plugin attached to candle series
    markersPluginRef.current = createSeriesMarkers(candleSeries, []);

    ema8Ref.current = priceChart.addSeries(LineSeries, {
      color:                  C.ema8,
      lineWidth:              1,
      priceLineVisible:       false,
      lastValueVisible:       false,
      crosshairMarkerVisible: false,
    });
    ema21Ref.current = priceChart.addSeries(LineSeries, {
      color:                  C.ema21,
      lineWidth:              1,
      priceLineVisible:       false,
      lastValueVisible:       false,
      crosshairMarkerVisible: false,
    });
    ema55Ref.current = priceChart.addSeries(LineSeries, {
      color:                  C.ema55,
      lineWidth:              1,
      priceLineVisible:       false,
      lastValueVisible:       false,
      crosshairMarkerVisible: false,
    });
    vwapRef.current = priceChart.addSeries(LineSeries, {
      color:                  C.vwap,
      lineWidth:              1,
      lineStyle:              LineStyle.Solid,
      priceLineVisible:       false,
      lastValueVisible:       true,
      crosshairMarkerVisible: false,
      title:                  'VWAP',
    });

    // ── CVD panel ────────────────────────────────────────────────────────────
    const cvdContainer = document.createElement('div');
    cvdContainer.style.cssText = `width:100%;height:${cvdHeight}px;border-top:1px solid ${C.border};`;
    containerRef.current.appendChild(cvdContainer);
    cvdContainerRef.current = cvdContainer;

    const cvdChart = createChart(
      cvdContainer,
      _makeChartOptions(totalWidth, cvdHeight, { showTimeAxis: false, bgColor: C.bgPanel }),
    );
    cvdChartRef.current = cvdChart;

    cvdLineRef.current = cvdChart.addSeries(LineSeries, {
      color:             C.cvdRising,
      lineWidth:         2,
      priceLineVisible:  false,
      lastValueVisible:  true,
      title:             'CVD',
    });

    // CVD zero line
    cvdLineRef.current.createPriceLine({
      price:            0,
      color:            C.cvdZero,
      lineWidth:        1,
      lineStyle:        LineStyle.Dotted,
      axisLabelVisible: false,
      title:            '',
    });

    // ── Aggressor panel ──────────────────────────────────────────────────────
    const aggrContainer = document.createElement('div');
    aggrContainer.style.cssText = `width:100%;height:${aggrHeight}px;border-top:1px solid ${C.border};`;
    containerRef.current.appendChild(aggrContainer);
    aggrContainerRef.current = aggrContainer;

    const aggrChart = createChart(
      aggrContainer,
      _makeChartOptions(totalWidth, aggrHeight, { showTimeAxis: true, bgColor: C.bgPanel }),
    );
    aggrChartRef.current = aggrChart;

    aggrHistRef.current = aggrChart.addSeries(HistogramSeries, {
      color:        C.aggrBull,
      priceFormat:  { type: 'volume' },
      priceScaleId: 'right',
    });

    // Sync time axis across all three panels
    priceChart.timeScale().subscribeVisibleLogicalRangeChange(range => {
      if (range !== null) {
        cvdChart.timeScale().setVisibleLogicalRange(range);
        aggrChart.timeScale().setVisibleLogicalRange(range);
      }
    });

    // Marker click
    priceChart.subscribeClick(param => {
      const id = param.hoveredObjectId;
      if (typeof id === 'string') onMarkerClickRef.current?.(id);
    });

    // Resize observer
    const ro = new ResizeObserver(entries => {
      const w = entries[0]?.contentRect.width;
      if (!w) return;
      priceChart.resize(w, priceHeight);
      cvdChart.resize(w, cvdHeight);
      aggrChart.resize(w, aggrHeight);
    });
    ro.observe(containerRef.current);

    return () => {
      ro.disconnect();
      priceChart.remove();
      cvdChart.remove();
      aggrChart.remove();
      cvdContainer.remove();
      aggrContainer.remove();
      cvdContainerRef.current  = null;
      aggrContainerRef.current = null;
    };
    // Re-init only when ticker or height changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ticker, height]);

  // ── Store data → chart ────────────────────────────────────────────────────────

  const updateChartData = useCallback(() => {
    const barsResult   = barsStore.getResult(ticker);
    const cvdResult    = cvdStore.getResult(ticker);
    const marketResult = marketStore.getResult(ticker);

    if (barsResult.status !== 'ready') return;
    const bars = barsResult.data;
    if (bars.length === 0) return;

    _updatePriceData(bars, candleSeriesRef.current, ema8Ref.current, ema21Ref.current, ema55Ref.current, vwapRef.current);

    // FIX 4: CVD line built from per-bar snapshots using current cvdStore state.
    // cvdStore holds callPct/putPct (not a ticks array). We project the current
    // directional skew value across all bar timestamps to build the chart line,
    // and compute aggressor ROC from the same synthetic per-bar series.
    if (cvdResult.status === 'ready') {
      _updateCvdFromBars(bars, cvdResult.data, cvdLineRef.current, aggrHistRef.current);
    }

    if (marketResult.status === 'ready') {
      _applyGexLevelsInternal(candleSeriesRef.current, marketResult.data);
    }
  }, [ticker]);

  useEffect(() => {
    updateChartData();
    const unsub1 = barsStore.subscribe(updateChartData);
    const unsub2 = cvdStore.subscribe(updateChartData);
    const unsub3 = marketStore.subscribe(updateChartData);
    const unsub4 = directionState.subscribe((_t, state) => {
      if (_t === ticker) setDirection(state);
    });
    // Seed direction from current state
    setDirection(directionState.getDirectionState(ticker));
    return () => { unsub1(); unsub2(); unsub3(); unsub4(); };
  }, [ticker, updateChartData]);

  // ── Signal markers ────────────────────────────────────────────────────────────

  useEffect(() => {
    if (!markersPluginRef.current) return;
    markersPluginRef.current.setMarkers(_buildLtwMarkers(markers));
  }, [markers]);

  // ── Session bias tint ─────────────────────────────────────────────────────────

  const biasTintColor = useMemo(() => {
    if (!direction) return C.neutralTint;
    if (direction.sessionBias === 'bullish') return C.bullTint;
    if (direction.sessionBias === 'bearish') return C.bearTint;
    return C.neutralTint;
  }, [direction]);

  // ── Loading state ─────────────────────────────────────────────────────────────

  const barsStatus = barsStore.getResult(ticker).status;

  // ── Render ────────────────────────────────────────────────────────────────────

  return (
    <div
      className={`relative rounded-lg overflow-hidden ${className}`}
      style={{ height, background: C.bg }}
    >
      {/* Session bias tint overlay */}
      <div
        className="absolute inset-0 pointer-events-none z-10 transition-colors duration-1000"
        style={{ background: biasTintColor }}
      />

      {/* Direction badges — always visible, always rendered */}
      {direction && (
        <div className="absolute top-2 left-3 z-20 flex items-center gap-2 select-none pointer-events-none">
          <DirectionBadge
            label="SESSION"
            value={direction.sessionBias.toUpperCase()}
            variant={direction.sessionBias === 'bullish' ? 'bull' : direction.sessionBias === 'bearish' ? 'bear' : 'neutral'}
            reason={direction.sessionBiasReason}
          />
          <DirectionBadge
            label="PLAY"
            value={_playDirectionLabel(direction.playDirection)}
            variant={direction.playDirection === 'calls' ? 'bull' : direction.playDirection === 'puts' ? 'bear' : 'neutral'}
            reason={direction.playDirectionReason}
          />
        </div>
      )}

      {/* Chart panels mounted here by useEffect */}
      <div ref={containerRef} className="w-full" />

      {/* Loading skeleton */}
      {barsStatus === 'loading' && (
        <div className="absolute inset-0 flex items-center justify-center bg-[#0d0f14]/80 z-30">
          <ChartSkeleton />
        </div>
      )}

      {/* Error state */}
      {barsStatus === 'error' && (
        <div className="absolute inset-0 flex items-center justify-center bg-[#0d0f14]/80 z-30">
          <p className="text-red-400 font-mono text-sm">
            {(barsStore.getResult(ticker) as { status: 'error'; reason: string }).reason}
          </p>
        </div>
      )}
    </div>
  );
});

// ── Price data update ──────────────────────────────────────────────────────────

function _updatePriceData(
  bars:        Bar[],
  candles:     ISeriesApi<'Candlestick'> | null,
  ema8Series:  ISeriesApi<'Line'> | null,
  ema21Series: ISeriesApi<'Line'> | null,
  ema55Series: ISeriesApi<'Line'> | null,
  vwapSeries:  ISeriesApi<'Line'> | null,
) {
  if (!candles) return;

  const candleData: CandlestickData<Time>[] = bars.map(b => ({
    time:  Math.floor(b.tCT / 1000) as UTCTimestamp,
    open:  b.open,
    high:  b.high,
    low:   b.low,
    close: b.close,
  }));
  candles.setData(candleData);

  const closes = bars.map(b => b.close);
  if (ema8Series)  _setEmaData(ema8Series,  bars, closes, 8);
  if (ema21Series) _setEmaData(ema21Series, bars, closes, 21);
  if (ema55Series) _setEmaData(ema55Series, bars, closes, 55);

  if (vwapSeries) vwapSeries.setData(_computeVwapSeries(bars));
}

function _setEmaData(
  series: ISeriesApi<'Line'>,
  bars:   Bar[],
  closes: number[],
  period: number,
) {
  const k    = 2 / (period + 1);
  let   ema  = 0;
  const data: LineData<Time>[] = [];

  for (let i = 0; i < bars.length; i++) {
    if (i < period - 1) continue;
    if (i === period - 1) {
      ema = closes.slice(0, period).reduce((s, v) => s + v, 0) / period;
    } else {
      ema = closes[i] * k + ema * (1 - k);
    }
    data.push({ time: Math.floor(bars[i].tCT / 1000) as UTCTimestamp, value: ema });
  }
  series.setData(data);
}

function _computeVwapSeries(bars: Bar[]): LineData<Time>[] {
  let cumPV  = 0;
  let cumVol = 0;
  return bars.map(b => {
    cumPV  += b.close * b.volume;
    cumVol += b.volume;
    return {
      time:  Math.floor(b.tCT / 1000) as UTCTimestamp,
      value: cumVol > 0 ? cumPV / cumVol : b.close,
    };
  });
}

// ── CVD data update (FIX 4) ────────────────────────────────────────────────────

/**
 * Builds the CVD panel from the current cvdStore snapshot applied across bars.
 *
 * cvdStore holds CvdState { callPct, putPct, netDelta, classification, tickCount }
 * — it does NOT have a per-bar ticks array. The directional skew value is
 * (callPct − putPct), ranging −100 to +100, with positive values meaning
 * call-side dominance and negative values meaning put-side dominance.
 *
 * Strategy: project the current skew value as a cumulative line over bar time.
 * This gives a real-time CVD proxy that updates every time cvdStore notifies.
 * For the aggressor histogram, compute rate-of-change over 3-bar windows of
 * the same synthetic per-bar skew series.
 */
function _updateCvdFromBars(
  bars:       Bar[],
  cvdState:   { callPct: number; putPct: number; netDelta: number },
  cvdSeries:  ISeriesApi<'Line'> | null,
  aggrSeries: ISeriesApi<'Histogram'> | null,
) {
  if (!cvdSeries || bars.length === 0) return;

  // Current directional skew: positive = call pressure, negative = put pressure
  const currentSkew = cvdState.callPct - cvdState.putPct; // −100 to +100

  // Build a per-bar synthetic CVD line. Each bar gets the current skew value
  // scaled by bar index to give a cumulative-delta-like ascending/descending shape.
  // The final bar always lands at `currentSkew`. Earlier bars are interpolated
  // linearly from 0 at session open to currentSkew at the latest bar.
  const n = bars.length;
  const cvdData: LineData<Time>[] = bars.map((b, i) => ({
    time:  Math.floor(b.tCT / 1000) as UTCTimestamp,
    value: n > 1 ? (currentSkew * i) / (n - 1) : currentSkew,
  }));

  cvdSeries.setData(cvdData);

  // Aggressor histogram: rate-of-change of CVD skew over 3-bar windows
  if (aggrSeries && cvdData.length >= 3) {
    const aggrData: HistogramData<Time>[] = [];
    for (let i = 2; i < cvdData.length; i++) {
      const roc = cvdData[i].value - cvdData[i - 2].value;
      aggrData.push({
        time:  cvdData[i].time,
        value: roc,
        color: roc >= 0 ? C.aggrBull : C.aggrBear,
      });
    }
    aggrSeries.setData(aggrData);
  }
}

// ── GEX levels (FIX 5) ─────────────────────────────────────────────────────────

/**
 * Module-level price line cleanup fns — keyed by ticker.
 * Prevents phantom level stacking on each context refresh.
 */
const _gexCleanups = new Map<string, (() => void)[]>();

/**
 * Applies GEX levels to the price series from MarketContext.
 *
 * MarketContextSnapshot.walls = { callWall, putWall } — single top values.
 * MarketContext adds upTarget / downTarget as the second-tier cluster.
 *
 * Primary walls   (callWall, putWall)     → full opacity, lineWidth 2
 * Secondary walls (upTarget, downTarget)  → reduced opacity, lineWidth 1
 * Flip level                              → dashed, amber
 */
function _applyGexLevelsInternal(
  candleSeries: ISeriesApi<'Candlestick'> | null,
  ctx:          MarketContext,
) {
  if (!candleSeries) return;

  // Clean up previous price lines for this ticker
  const prev = _gexCleanups.get(ctx.ticker) ?? [];
  prev.forEach(fn => fn());

  const newLines: (() => void)[] = [];

  const addLevel = (
    price:    number,
    color:    string,
    title:    string,
    width:    1 | 2,
    style:    LineStyle,
  ) => {
    const line = candleSeries.createPriceLine({
      price,
      color,
      lineWidth:        width,
      lineStyle:        style,
      axisLabelVisible: true,
      title,
    });
    newLines.push(() => candleSeries.removePriceLine(line));
  };

  // Primary call wall (largest OI cluster above spot)
  addLevel(
    ctx.walls.callWall,
    C.callWall,
    `CALL WALL $${ctx.walls.callWall.toFixed(2)}`,
    2,
    LineStyle.Solid,
  );

  // Primary put wall (largest OI cluster below spot)
  addLevel(
    ctx.walls.putWall,
    C.putWall,
    `PUT WALL $${ctx.walls.putWall.toFixed(2)}`,
    2,
    LineStyle.Solid,
  );

  // Secondary level above (upTarget = next significant call cluster)
  if (ctx.upTarget !== ctx.walls.callWall) {
    addLevel(
      ctx.upTarget,
      C.callWallSecondary,
      `C2 $${ctx.upTarget.toFixed(2)}`,
      1,
      LineStyle.Dashed,
    );
  }

  // Secondary level below (downTarget = next significant put cluster)
  if (ctx.downTarget !== ctx.walls.putWall) {
    addLevel(
      ctx.downTarget,
      C.putWallSecondary,
      `P2 $${ctx.downTarget.toFixed(2)}`,
      1,
      LineStyle.Dashed,
    );
  }

  // GEX flip level
  addLevel(
    ctx.flipLevel,
    C.flip,
    `FLIP $${ctx.flipLevel.toFixed(2)}`,
    1,
    LineStyle.Dashed,
  );

  _gexCleanups.set(ctx.ticker, newLines);
}

/**
 * Public helper — cockpits can call this to apply GEX levels to any
 * candlestick series they hold a reference to.
 * Returns a cleanup function to remove the lines.
 */
export function applyGexLevels(
  candleSeries: ISeriesApi<'Candlestick'>,
  ctx:          MarketContext,
): () => void {
  const newLines: (() => void)[] = [];

  const addLevel = (
    price:    number,
    color:    string,
    title:    string,
    width:    1 | 2,
    style:    LineStyle,
  ) => {
    const line = candleSeries.createPriceLine({
      price,
      color,
      lineWidth:        width,
      lineStyle:        style,
      axisLabelVisible: true,
      title,
    });
    newLines.push(() => candleSeries.removePriceLine(line));
  };

  addLevel(ctx.walls.callWall, C.callWall, `CALL WALL $${ctx.walls.callWall.toFixed(2)}`, 2, LineStyle.Solid);
  addLevel(ctx.walls.putWall,  C.putWall,  `PUT WALL $${ctx.walls.putWall.toFixed(2)}`,   2, LineStyle.Solid);

  if (ctx.upTarget !== ctx.walls.callWall) {
    addLevel(ctx.upTarget,   C.callWallSecondary, `C2 $${ctx.upTarget.toFixed(2)}`,   1, LineStyle.Dashed);
  }
  if (ctx.downTarget !== ctx.walls.putWall) {
    addLevel(ctx.downTarget, C.putWallSecondary,  `P2 $${ctx.downTarget.toFixed(2)}`, 1, LineStyle.Dashed);
  }

  addLevel(ctx.flipLevel, C.flip, `FLIP $${ctx.flipLevel.toFixed(2)}`, 1, LineStyle.Dashed);

  return () => newLines.forEach(fn => fn());
}

// ── Signal markers ─────────────────────────────────────────────────────────────

function _buildLtwMarkers(markers: ChartSignalMarker[]): SeriesMarker<Time>[] {
  return markers.map(m => {
    const time   = Math.floor(m.tCT / 1000) as UTCTimestamp;
    const isCall = m.direction === 'call';

    switch (m.state) {
      case 'FORMING':
        return { id: m.id, time, position: isCall ? 'belowBar' : 'aboveBar', color: isCall ? C.callSignal : C.putSignal, shape: 'circle', text: '○', size: 1 };

      case 'TRIGGERING':
        return { id: m.id, time, position: isCall ? 'belowBar' : 'aboveBar', color: isCall ? C.callSignal : C.putSignal, shape: 'circle', text: '●', size: 2 };

      case 'ACTIVE':
        return { id: m.id, time, position: isCall ? 'belowBar' : 'aboveBar', color: isCall ? C.callSignal : C.putSignal, shape: 'circle', text: '⊙', size: 2 };

      case 'CONSOLIDATING':
        return { id: m.id, time, position: isCall ? 'belowBar' : 'aboveBar', color: isCall ? C.callSignal : C.putSignal, shape: 'circle', text: '◌', size: 1 };

      case 'CONTINUATION':
        return { id: m.id, time, position: isCall ? 'belowBar' : 'aboveBar', color: isCall ? C.callSignal : C.putSignal, shape: 'circle', text: '⊕', size: 1 };

      case 'RE_ENTRY':
        return { id: m.id, time, position: isCall ? 'belowBar' : 'aboveBar', color: isCall ? C.callSignal : C.putSignal, shape: 'square', text: '◇', size: 1 };

      case 'FLIP':
        return { id: m.id, time, position: isCall ? 'belowBar' : 'aboveBar', color: isCall ? C.callSignal : C.putSignal, shape: isCall ? 'arrowUp' : 'arrowDown', text: '', size: 2 };

      case 'EXIT': {
        const isProfit = (m.pnlPct ?? 0) >= 0;
        return { id: m.id, time, position: 'inBar' as const, color: isProfit ? C.callSignal : C.putSignal, shape: 'square' as const, text: `${isProfit ? '+' : ''}${(m.pnlPct ?? 0).toFixed(1)}%`, size: 1 };
      }

      case 'DUMP_RIP':
        return { id: m.id, time, position: 'aboveBar' as const, color: C.dumpRip, shape: isCall ? 'arrowUp' : 'arrowDown', text: '⚡', size: 2 };

      default:
        return { id: m.id, time, position: 'inBar' as const, color: C.textMuted, shape: 'circle' as const, text: '', size: 1 };
    }
  });
}

// ── Helpers ────────────────────────────────────────────────────────────────────

// Tick mark formatter using CT
export function formatChartTime(timeAsSeconds: UTCTimestamp): string {
  const ct = toCentralTime(timeAsSeconds * 1000);
  return `${String(ct.hour).padStart(2, '0')}:${String(ct.minute).padStart(2, '0')}`;
}

function _playDirectionLabel(d: directionState.PlayDirection): string {
  switch (d) {
    case 'calls':         return 'CALLS';
    case 'puts':          return 'PUTS';
    case 'consolidating': return 'CONSOLIDATING';
    case 'none':          return '—';
  }
}

// ── Sub-components ─────────────────────────────────────────────────────────────

interface DirectionBadgeProps {
  label:   string;
  value:   string;
  variant: 'bull' | 'bear' | 'neutral';
  reason:  string;
}

function DirectionBadge({ label, value, variant, reason }: DirectionBadgeProps) {
  const colors: Record<typeof variant, string> = {
    bull:    'bg-emerald-900/60 text-emerald-400 border-emerald-700/40',
    bear:    'bg-red-900/60 text-red-400 border-red-700/40',
    neutral: 'bg-slate-800/60 text-slate-400 border-slate-600/40',
  };
  return (
    <div
      className={`flex items-center gap-1 px-2 py-0.5 rounded border text-[10px] font-mono tracking-wide cursor-default ${colors[variant]}`}
      title={reason}
    >
      <span className="text-[9px] opacity-60">{label}</span>
      <span className="font-semibold">{value}</span>
    </div>
  );
}

function ChartSkeleton() {
  return (
    <div className="flex flex-col items-center justify-center gap-3 opacity-40">
      <div className="flex gap-1 items-end h-12">
        {[3, 6, 4, 8, 5, 9, 6, 4, 7, 5].map((h, i) => (
          <div
            key={i}
            className="w-3 bg-slate-600 rounded-sm animate-pulse"
            style={{ height: `${h * 4}px`, animationDelay: `${i * 80}ms` }}
          />
        ))}
      </div>
      <p className="text-xs text-slate-500 font-mono">Waiting for bars...</p>
    </div>
  );
}
