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
import { toCentralTime, toCTMidnight } from '../lib/time';
import { aggregateBars, INTERVAL_MINUTES, type ChartInterval } from '../lib/aggregateBars';
import { fetchBackfilledBars } from '../lib/chartBarsBackfill';
import { computeChartBackfillWindow } from '../lib/chartWindow';
import { clusterMarkersForDisplay } from '../lib/markerClustering';
import type { Bar, Result } from '../stores/types';
import type { MarketContext } from '../stores/marketStore';

// Real backfill lookback, per selected interval — 1m/5m never need it (the
// live barsStore buffer alone comfortably seeds even an EMA55 at those
// resolutions); 15m uses the real, already-validated 7-trading-day default;
// 1h needs the documented upper bound (10 days) specifically to seed a real
// 55-period EMA (7 days -> ~45 real 1h bars, short of 55; 10 days -> ~65,
// real margin). See this session's own multi-timeframe design work for the
// full real derivation.
const BACKFILL_LOOKBACK_TRADING_DAYS: Partial<Record<ChartInterval, number>> = {
  '15m': 7,
  '1h': 10,
};

// ── Colour tokens ──────────────────────────────────────────────────────────────

// ── Helios spec hex values (must match index.css --col-g / --col-r / --amb) ──────
// Single source of truth for canvas draw calls. Tailwind bridge can't reach canvas.
const H = {
  g:   '#00d97e',   // --col-g  rgb(0 217 126)
  r:   '#f04c5a',   // --col-r  rgb(240 76 90)
  amb: '#f5a623',   // --amb    rgb(245 166 35)
} as const;

const C = {
  bg:          '#0d0f14',
  bgPanel:     '#111318',
  border:      '#1e2129',
  text:        '#c9d1d9',
  textMuted:   '#6e7681',

  bullBody:    H.g,
  bullWick:    H.g,
  bearBody:    H.r,
  bearWick:    H.r,

  // GEX levels — primary walls at full opacity, secondary at reduced
  callWall:          H.g,
  callWallSecondary: 'rgba(0, 217, 126, 0.45)',
  putWall:           H.r,
  putWallSecondary:  'rgba(240, 76, 90, 0.45)',
  flip:              H.amb,
  maxPain:           H.amb,   // was #a855f7 (purple) — no purple in spec
  vwap:              '#ffffff',
  pdh:               '#4b5563',
  pdl:               '#4b5563',

  ema8:        H.g,            // was #22d3ee (cyan) — no cyan in spec
  ema21:       '#94a3b8',
  ema55:       H.amb,

  bullTint:    'rgba(0, 217, 126, 0.04)',
  bearTint:    'rgba(240, 76, 90, 0.04)',
  neutralTint: 'rgba(100, 116, 139, 0.04)',

  cvdRising:   H.g,
  cvdFalling:  H.r,
  cvdZero:     '#374151',

  aggrBull:    H.g,
  aggrBear:    H.r,

  callSignal:  H.g,
  putSignal:   H.r,
  dumpRip:     H.amb,
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
  /**
   * Set by markerClustering.ts's clusterMarkersForDisplay when this marker
   * represents N real markers collapsed into one at a coarser interval —
   * never set by any real producer (chartSignalMarkers.ts, ZeroDteCockpit).
   * Absent/undefined means "one real marker, not a cluster."
   */
  clusterCount?: number;
}

export interface HeliosChartProps {
  ticker:         string;
  markers?:       ChartSignalMarker[];
  onMarkerClick?: (markerId: string) => void;
  height?:        number;
  className?:     string;
  /**
   * Candle/EMA/marker-clustering interval. Defaults to '1m' — the exact,
   * unchanged behavior every existing caller (ZeroDteCockpit's embedded
   * mini-chart included) already gets without passing this prop at all.
   * VWAP is deliberately NOT affected by this — see _computeVwapSeries's
   * real header comment for why it stays interval-invariant.
   */
  interval?: ChartInterval;
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
      borderColor:        C.border,
      timeVisible:        opts.showTimeAxis,
      secondsVisible:     false,
      tickMarkFormatter: (timeAsSeconds: number) => {
        // Always show HH:mm regardless of how many calendar days the data spans.
        // Without this, Lightweight Charts defaults to repeating date strings for
        // intraday data that crosses midnight (e.g. after backfill includes yesterday).
        const ct = toCentralTime(timeAsSeconds * 1000);
        return `${String(ct.hour).padStart(2, '0')}:${String(ct.minute).padStart(2, '0')}`;
      },
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
  interval    = '1m',
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

  // ── Real backfill for coarser intervals ─────────────────────────────────────
  //
  // 1m/5m never trigger this — the live barsStore buffer alone comfortably
  // seeds them (see BACKFILL_LOOKBACK_TRADING_DAYS's real header comment).
  // 15m/1h fetch real persisted history from bars_1m, sized per interval.
  // Result<Bar[]> throughout — a fetch failure is distinguishable from a
  // genuine empty range, same discipline as chartSignals.ts.

  const [backfillResult, setBackfillResult] = useState<Result<Bar[]>>({ status: 'ready', data: [], asOf: 0 });

  useEffect(() => {
    const lookbackDays = BACKFILL_LOOKBACK_TRADING_DAYS[interval];
    if (lookbackDays === undefined) {
      // 1m/5m — no backfill needed, real live buffer suffices.
      setBackfillResult({ status: 'ready', data: [], asOf: Date.now() });
      return;
    }

    let cancelled = false;
    setBackfillResult({ status: 'loading' });

    const { fromMs, toMs } = computeChartBackfillWindow(Date.now(), lookbackDays);
    fetchBackfilledBars(ticker, fromMs, toMs).then((result) => {
      // Guard against a slow fetch for a previously-selected ticker/interval
      // landing after the user has already switched — same pattern as
      // ChartScreen's marker fetch (Home/index.tsx).
      if (!cancelled) setBackfillResult(result);
    });

    return () => { cancelled = true; };
  }, [ticker, interval]);

  // ── Store data → chart ────────────────────────────────────────────────────────

  const updateChartData = useCallback(() => {
    const barsResult   = barsStore.getResult(ticker);
    const cvdResult    = cvdStore.getResult(ticker);
    const marketResult = marketStore.getResult(ticker);

    if (barsResult.status !== 'ready') return;
    const liveBars = barsResult.data;
    if (liveBars.length === 0) return;

    // Real, finest-grain 1-minute series: backfilled history (when the
    // selected interval needs it) merged with the live buffer's tail.
    // VWAP is always computed from THIS, never from displayBars below —
    // see _computeVwapSeries's own header for why.
    const backfilled = backfillResult.status === 'ready' ? backfillResult.data : [];
    const rawBars1m  = backfilled.length > 0 ? _mergeBarHistory(backfilled, liveBars) : liveBars;

    // Real candle/EMA series: aggregated to the selected interval. '1m' is
    // a real, tested identity passthrough inside aggregateBars.
    const displayBars = aggregateBars(rawBars1m, interval);
    if (displayBars.length === 0) return;

    _updatePriceData(displayBars, rawBars1m, candleSeriesRef.current, ema8Ref.current, ema21Ref.current, ema55Ref.current, vwapRef.current);

    // FIX 4: CVD line built from per-bar snapshots using current cvdStore state.
    // cvdStore holds callPct/putPct (not a ticks array). We project the current
    // directional skew value across all bar timestamps to build the chart line,
    // and compute aggressor ROC from the same synthetic per-bar series.
    // Uses displayBars — the CVD/aggressor panels stay time-aligned with the
    // candle panel above them, same as before this change.
    if (cvdResult.status === 'ready') {
      _updateCvdFromBars(displayBars, cvdResult.data, cvdLineRef.current, aggrHistRef.current);
    }

    if (marketResult.status === 'ready') {
      _applyGexLevelsInternal(candleSeriesRef.current, marketResult.data);
    }
  }, [ticker, interval, backfillResult]);

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
  //
  // Clustered at the currently-displayed interval's own bucket width —
  // real no-op at 1m (bucket width == a marker's own native resolution),
  // real collapsing at 5m/15m/1h. See markerClustering.ts.

  useEffect(() => {
    if (!markersPluginRef.current) return;
    const bucketMs = INTERVAL_MINUTES[interval] * 60_000;
    const clustered = clusterMarkersForDisplay(markers, bucketMs);
    markersPluginRef.current.setMarkers(_buildLtwMarkers(clustered));
  }, [markers, interval]);

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
          <p className="text-col-r font-mono text-sm">
            {(barsStore.getResult(ticker) as { status: 'error'; reason: string }).reason}
          </p>
        </div>
      )}
    </div>
  );
});

// ── Price data update ──────────────────────────────────────────────────────────

/**
 * `displayBars` — the currently-selected interval's aggregated candles
 * (via aggregateBars). Feeds the candlestick series and all three EMAs:
 * the full, real, unmodified 8/21/55 stack is used at every interval — the
 * real backfill sizing in HeliosChart's own component body (7 real trading
 * days for 15m, 10 for 1h) guarantees enough real bars to seed EMA55 at
 * every one of them. This is deliberately NOT the two-period shrink
 * confluenceEngine's live scoring uses — that shrink exists because the
 * scoring engine's own bar source is a permanent, unbackfilled, in-memory
 * 500-bar cap; the chart's ceiling is solvable (this real backfill IS the
 * solve), so it gets the real, full stack instead.
 *
 * `rawBars1m` — the real, un-aggregated 1-minute series (backfilled
 * history merged with the live buffer). Feeds ONLY VWAP, deliberately
 * never displayBars — see _computeVwapSeries's own header for why VWAP
 * must never be recomputed at the aggregated interval.
 */
function _updatePriceData(
  displayBars: Bar[],
  rawBars1m:   Bar[],
  candles:     ISeriesApi<'Candlestick'> | null,
  ema8Series:  ISeriesApi<'Line'> | null,
  ema21Series: ISeriesApi<'Line'> | null,
  ema55Series: ISeriesApi<'Line'> | null,
  vwapSeries:  ISeriesApi<'Line'> | null,
) {
  if (!candles) return;

  const candleData: CandlestickData<Time>[] = displayBars.map(b => ({
    time:  Math.floor(b.tCT / 1000) as UTCTimestamp,
    open:  b.open,
    high:  b.high,
    low:   b.low,
    close: b.close,
  }));
  candles.setData(candleData);

  const closes = displayBars.map(b => b.close);
  if (ema8Series)  _setEmaData(ema8Series,  displayBars, closes, 8);
  if (ema21Series) _setEmaData(ema21Series, displayBars, closes, 21);
  if (ema55Series) _setEmaData(ema55Series, displayBars, closes, 55);

  if (vwapSeries) vwapSeries.setData(_computeVwapSeries(rawBars1m));
}

/**
 * Merge real backfilled history with the live barsStore buffer's tail into
 * one real, time-ascending 1-minute series. Dedupes by tUtc, preferring the
 * live value on overlap (freshest for whatever tail both sources share) —
 * unlike chartBars.ts's mergeLiveBar (which appends ONE new live bar to an
 * already-merged history), this combines two whole READ-ONLY arrays from
 * two independent sources HeliosChart doesn't own the storage of, so it's
 * a real, distinct merge rather than a reuse of that exact function.
 */
export function _mergeBarHistory(historical: Bar[], live: Bar[]): Bar[] {
  const byTUtc = new Map<number, Bar>();
  for (const b of historical) byTUtc.set(b.tUtc, b);
  for (const b of live) byTUtc.set(b.tUtc, b); // live wins on overlap
  return Array.from(byTUtc.values()).sort((a, b) => a.tUtc - b.tUtc);
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

/**
 * VWAP is a real, session-level indicator — cumulative volume-weighted
 * price since the most recent session's open, resetting to zero at every
 * new session boundary. This function must always receive the real,
 * finest-grain 1-minute series (never displayBars, the aggregated
 * candles) — see _updatePriceData's own header for why.
 *
 * Real bug found and fixed here (2026-09-03): this function previously
 * accumulated across the ENTIRE bars array with no session-reset at all.
 * That looked correct only by accident — barsStore's live buffer rarely
 * held more than ~1.3 sessions, so the drift was invisible. The moment
 * multi-day backfilled data flows through here (which the interval toggle
 * requires), an unreset accumulator would silently compute a nonsensical
 * multi-day-cumulative line and mislabel it VWAP — a real, latent bug that
 * had simply never been triggered yet. Fixed via toCTMidnight (lib/time.ts)
 * detecting a new real CT calendar day within the array and resetting the
 * accumulator there, regardless of what candle interval is displayed.
 */
export function _computeVwapSeries(bars: Bar[]): LineData<Time>[] {
  let cumPV  = 0;
  let cumVol = 0;
  let sessionStart: number | null = null;

  return bars.map(b => {
    const barSession = toCTMidnight(b.tUtc);
    if (sessionStart === null || barSession !== sessionStart) {
      sessionStart = barSession;
      cumPV  = 0;
      cumVol = 0;
    }
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

/**
 * Appends a real cluster-count suffix to a marker's text when
 * markerClustering.ts collapsed multiple real markers into this one
 * (clusterCount > 1). No-op for any real, uncollapsed marker.
 */
function _withClusterSuffix(text: string, m: ChartSignalMarker): string {
  if (!m.clusterCount || m.clusterCount <= 1) return text;
  return `${text}×${m.clusterCount}`;
}

function _buildLtwMarkers(markers: ChartSignalMarker[]): SeriesMarker<Time>[] {
  return markers.map(m => {
    const time   = Math.floor(m.tCT / 1000) as UTCTimestamp;
    const isCall = m.direction === 'call';

    switch (m.state) {
      case 'FORMING':
        return { id: m.id, time, position: isCall ? 'belowBar' : 'aboveBar', color: isCall ? C.callSignal : C.putSignal, shape: 'circle', text: _withClusterSuffix('○', m), size: 1 };

      case 'TRIGGERING':
        return { id: m.id, time, position: isCall ? 'belowBar' : 'aboveBar', color: isCall ? C.callSignal : C.putSignal, shape: 'circle', text: _withClusterSuffix('●', m), size: 2 };

      case 'ACTIVE':
        return { id: m.id, time, position: isCall ? 'belowBar' : 'aboveBar', color: isCall ? C.callSignal : C.putSignal, shape: 'circle', text: _withClusterSuffix('⊙', m), size: 2 };

      case 'CONSOLIDATING':
        return { id: m.id, time, position: isCall ? 'belowBar' : 'aboveBar', color: isCall ? C.callSignal : C.putSignal, shape: 'circle', text: _withClusterSuffix('◌', m), size: 1 };

      case 'CONTINUATION':
        return { id: m.id, time, position: isCall ? 'belowBar' : 'aboveBar', color: isCall ? C.callSignal : C.putSignal, shape: 'circle', text: _withClusterSuffix('⊕', m), size: 1 };

      case 'RE_ENTRY':
        return { id: m.id, time, position: isCall ? 'belowBar' : 'aboveBar', color: isCall ? C.callSignal : C.putSignal, shape: 'square', text: _withClusterSuffix('◇', m), size: 1 };

      case 'FLIP':
        return { id: m.id, time, position: isCall ? 'belowBar' : 'aboveBar', color: isCall ? C.callSignal : C.putSignal, shape: isCall ? 'arrowUp' : 'arrowDown', text: _withClusterSuffix('', m), size: 2 };

      case 'EXIT': {
        // Never clustered — markerClustering.ts excludes any bucket
        // containing an EXIT from collapse, so clusterCount is never set
        // here. No suffix logic needed.
        const isProfit = (m.pnlPct ?? 0) >= 0;
        return { id: m.id, time, position: 'inBar' as const, color: isProfit ? C.callSignal : C.putSignal, shape: 'square' as const, text: `${isProfit ? '+' : ''}${(m.pnlPct ?? 0).toFixed(1)}%`, size: 1 };
      }

      case 'DUMP_RIP':
        return { id: m.id, time, position: 'aboveBar' as const, color: C.dumpRip, shape: isCall ? 'arrowUp' : 'arrowDown', text: _withClusterSuffix('⚡', m), size: 2 };

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
    bull:    'bg-col-g/15 text-col-g border-col-g/30',
    bear:    'bg-col-r/15 text-col-r border-col-r/30',
    neutral: 'bg-white/5 text-white/40 border-white/10',
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
            className="w-3 bg-white/20 rounded-sm animate-pulse"
            style={{ height: `${h * 4}px`, animationDelay: `${i * 80}ms` }}
          />
        ))}
      </div>
      <p className="text-xs text-white/25 font-mono">Waiting for bars...</p>
    </div>
  );
}
