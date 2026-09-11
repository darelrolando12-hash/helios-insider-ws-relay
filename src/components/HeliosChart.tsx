/**
 * Layer 4 — HeliosChart
 *
 * The primary execution surface for Helios Insiders. NOT a generic chart
 * component. This is the chart Helios draws — every level, overlay, and
 * signal marker is specific to the trading intelligence layer.
 *
 * Data sources (all read-only, zero outbound calls):
 *   Price candles       → barsStore
 *   Delta (CVD)         → the relay engine's per-minute delta series (lib/serverDelta)
 *   GEX levels/walls    → marketStore
 *   Session direction   → directionState
 *
 * Panels (top to bottom):
 *   1. Price panel  — OHLC candles + static GEX levels + EMA overlays +
 *                     session bias tint + VWAP + signal markers on triggering candles
 *   2. CVD panel    — cumulative delta (classified buy − sell volume) from the
 *                     session's first classified minute, at each candle's close
 *   3. Aggressor panel — each candle's own delta, green buying / red selling;
 *                     also hosts the chart's only visible time axis
 *
 * CVD data source (rebuilt 2026-09-11):
 *   These panels used to be a PROJECTION ("FIX 4"): browser cvdStore holds one
 *   session-level call/put skew, not a series, so the CVD line was a straight
 *   ramp from 0 to the current skew drawn across every bar, and the aggressor
 *   histogram was that ramp's constant slope. It read as order-flow history
 *   and was not. The real per-minute series is built in the relay engine,
 *   which holds the trade stream from the session open, and read here. When
 *   the engine can't supply it the panels are empty and say why.
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
  TickMarkType,
  CandlestickSeries,
  LineSeries,
  HistogramSeries,
  type IChartApi,
  type IRange,
  type ISeriesApi,
  type ISeriesMarkersPluginApi,
  type SeriesMarker,
  type Time,
  type UTCTimestamp,
  type CandlestickData,
  type LineData,
} from 'lightweight-charts';
import * as barsStore      from '../stores/barsStore';
import { fetchDeltaSeries, bucketDelta, type DeltaSeries } from '../lib/serverDelta';
import * as marketStore    from '../stores/marketStore';
import * as directionState from '../state/directionState';
import { toCentralTime } from '../lib/time';
import { sessionVwapSeries } from '../lib/sessionVwap';
import { aggregateBars, INTERVAL_MINUTES, type ChartInterval } from '../lib/aggregateBars';
import {
  fetchChartBackfill,
  regularSessionOnly,
  REGULAR_OPEN_CT_MIN,
  REGULAR_CLOSE_CT_MIN,
  type ChartBackfill,
} from '../lib/chartBarsBackfill';
import { computeChartBackfillWindow } from '../lib/chartWindow';
import { clusterMarkersForDisplay, summariseMarkersByDay } from '../lib/markerClustering';
import * as marketStatusStore from '../stores/marketStatusStore';
import { formatAge } from '../stores/marketStatusStore';
import type { Bar, Result } from '../stores/types';
import type { MarketContext } from '../stores/marketStore';

/**
 * Real backfill lookback per interval, in TRADING days.
 *
 * 1m has no lookback in trading days: it fetches the latest session (see
 * chartBarsBackfill's 1m branch) and the live buffer carries it forward.
 *
 * ── Corrected against real data (2026-09-05) ──────────────────────────────
 * The previous derivation here assumed a 6.5-hour regular session and
 * concluded "7 days -> ~45 real 1h bars, short of 55". That was wrong:
 * Massive's aggregates cover EXTENDED hours. Live-verified SPY, 2026-09-03
 * to 2026-09-04 (2 trading days), first bar 08:00Z = 03:00 CT, last 23:59Z
 * = 18:59 CT — about 16 real trading hours a day, not 6.5:
 *
 *   5m  -> 384 bars / 2 days = ~192 per trading day
 *   15m -> 128 bars / 2 days =  ~64 per trading day
 *   1h  ->  32 bars / 2 days =  ~16 per trading day
 *
 * So EMA55 (55 bars) is seeded with real margin everywhere:
 *   5m  @ 7 days  -> ~1344 bars   (24x)
 *   15m @ 7 days  ->  ~448 bars   (8x)
 *   1h  @ 10 days ->  ~160 bars   (3x)
 *
 * 5m gets the same 7 days as 15m deliberately — matching 15m's real
 * multi-day depth rather than shrinking to a number that merely clears the
 * EMA55 floor, which one trading day alone would already do. 1h keeps 10
 * days: more than the corrected math strictly requires, but it is the
 * already-shipped, already-verified value and 3x margin on a 55-period EMA
 * is not worth churning.
 *
 * 1d @ 250 days -> ~250 daily bars: about one trading year, the span a
 * daily chart is read over, and 4.5x EMA55's seeding period. One request —
 * the daily endpoint returns a year in a single page.
 */
const BACKFILL_LOOKBACK_TRADING_DAYS: Partial<Record<ChartInterval, number>> = {
  '5m':  7,
  '15m': 7,
  '1h': 10,
  '1d': 250,
};

/**
 * Real root cause, confirmed against this file's own math above (2026-09-09):
 * fitContent() forces the ENTIRE fetched backfill into whatever width the
 * chart container happens to have. 5m @ 7 days is ~1344 bars (this file's own
 * comment, line ~114); a real mobile chart container is ~245-350px wide.
 * lightweight-charts' default minBarSpacing is 0.5px, so fitContent() was
 * cramming ~1344 bars into ~300px — a bar spacing at or below the floor,
 * rendering bodies as sub-pixel slivers indistinguishable from wicks. This
 * is a DIFFERENT, additional mechanism from the stale-viewport bug fixed
 * 2026-09-08 (ae8edf7) — that fix made fitContent() actually run; it did not
 * change what fitContent() does with a dataset this large.
 *
 * Fix: show only the most recent N bars that fit at a readable width,
 * computed from the chart's own real rendered width (timeScale().width()),
 * not a hardcoded container size — see the fitContent() call site below.
 * The full backfill stays loaded (EMA55 continuity, scroll-back); only the
 * INITIAL visible window is narrowed.
 */
const TARGET_PX_PER_BAR = 6;

/** Used only when neither the time scale nor the container has a real width
 *  yet. Deliberately a bar COUNT, not "show everything" — falling back to
 *  fitContent() here is what silently reintroduces the crowding bug. */
const DEFAULT_VISIBLE_BARS = 60;

/**
 * Real bug found and fixed live (2026-09-08): switching ticker or interval
 * calls candles.setData() with a completely different-sized array (e.g.
 * 1m's live buffer can hold hundreds of dense bars; a fresh 1h fetch might
 * hand back 174 sparser ones) on the SAME, already-mounted chart/series —
 * HeliosChart never calls setData() for the first time on a fresh series,
 * so Lightweight Charts never auto-fits. It instead keeps whatever visible
 * LOGICAL range was left over from the previous dataset. Reproduced
 * exactly live: NVDA 1h showed real, complete, correctly-backfilled data
 * (verified via a diagnostic dump: 174 bars, 2026-08-24 through
 * 2026-09-08) — but the chart rendered only the single rightmost candle,
 * because the leftover visible range from the prior view didn't overlap
 * the new, much-shorter series at all.
 *
 * INVESTIGATING (2026-09-08): a first fix attempt computed a manual
 * setVisibleLogicalRange({from: total-100, to: total-1}) — this reads back
 * as applied via getVisibleLogicalRange(), but getVisibleRange() (the
 * TIME-based range for those same logical indices) reports real dates from
 * 2026-08-24, not the expected recent window — i.e. logical index 173 of a
 * freshly-set 174-bar array is NOT resolving to that array's own last
 * element. Trying fitContent() instead to isolate whether this is a real
 * misunderstanding of Lightweight Charts' logical-index semantics across
 * successive setData() calls, before trying to hand-compute a "last N
 * bars" window again.
 */

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
  /**
   * The latest session's VWAP, as of the newest 1-minute bar — the same
   * number the intraday VWAP line ends on, and identical at every interval
   * (it is read from the minute series, never the candles). Null when there
   * is no minute data at all. Fired only when the value changes at cent
   * resolution, not on every redraw.
   */
  onSessionVwap?: (vwap: number | null) => void;
}

/**
 * The overlay series exactly as drawn, handed back by _updatePriceData so
 * the live legend reports the same numbers the lines show.
 */
interface OverlayData {
  ema8:  LineData<Time>[];
  ema21: LineData<Time>[];
  ema55: LineData<Time>[];
  vwap:  LineData<Time>[];
  /** Last point of the un-aligned minute VWAP — see onSessionVwap. */
  sessionVwap: number | null;
}

/** One rendered row of the live legend — the hovered or newest candle. */
interface LegendSnapshot {
  timeLabel: string;
  open:  number;
  high:  number;
  low:   number;
  close: number;
  isUp:  boolean;
  ema8:  number | null;
  ema21: number | null;
  ema55: number | null;
  vwap:  number | null;
  /** True when pinned to a hovered candle rather than tracking the newest. */
  hovered: boolean;
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
      // Real bug found and fixed live (2026-09-09): `timeVisible` only
      // controls whether the DEFAULT (non-custom) formatter includes a
      // time-of-day portion — it does NOT hide the axis row itself. The
      // actual row-visibility option is the separate `visible` flag
      // (default true). Only setting timeVisible left the price and CVD
      // panels' own time-axis rows fully rendered — each computing its
      // OWN, uncoordinated tick placement independent of the aggressor
      // panel's real, intended single shared axis. That is the real
      // mechanism behind three separate, inconsistent-looking date/time
      // rows stacking on top of each other (repeated/malformed date
      // labels, a floating disconnected time label) — not three different
      // formatting bugs, one visibility bug with three visible symptoms.
      visible:            opts.showTimeAxis,
      timeVisible:        opts.showTimeAxis,
      secondsVisible:     false,
      // Real bug found and fixed live (2026-09-09): `ticksVisible` docs only
      // describe it as drawing the small vertical dash next to each label
      // ("Draw small vertical line on time axis labels") — but in this LWC
      // version it gates the LABEL TEXT itself, not just the dash. Default
      // is `false`. With it unset, the aggressor panel's shared axis (the
      // only panel with `visible:true` after the fix above) called
      // tickMarkFormatter with real, correctly-formatted, non-empty HH:mm/
      // MM/DD strings every time (confirmed live via console
      // instrumentation) yet painted zero non-background pixels — verified
      // directly via canvas.getImageData on its dedicated axis canvas,
      // ruling out a formatter bug, a stale-paint timing issue (a real
      // ResizeObserver-driven resize() didn't fix it either), and a
      // text-colour issue. Setting this to `true` is what actually made the
      // real glyph pixels (matching C.text, #c9d1d9) appear.
      ticksVisible:       true,
      tickMarkFormatter: (timeAsSeconds: number, tickMarkType: TickMarkType) => {
        // `timeAsSeconds` is already a CT pseudo-UTC epoch (every series feeds
        // the chart Math.floor(b.tCT / 1000) — see _buildLtwMarkers and the
        // candle/EMA/VWAP series builders below). tCT is a real UTC epoch
        // already SHIFTED by the CT offset at construction time (toCentralTime
        // in massiveAggToBar / chartBarsBackfill / chartSignalMarkers), so it
        // must be read back with UTC methods only. Passing it through
        // toCentralTime() again here applied the CT offset a SECOND time —
        // real bug, found 2026-09-04: an 08:30 CT bar rendered as if it were
        // several hours off. Read the pseudo-epoch directly, never re-convert.
        const d = new Date(timeAsSeconds * 1000);
        const hhmm = `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;

        // Real gap found and fixed live (2026-09-08): with 5m/15m/1h now
        // backfilling up to 10 real trading days, panning back genuinely
        // crosses real day boundaries with zero visual indication — every
        // tick showed only HH:mm, so a scrolled-back view of an entirely
        // different calendar day looked identical to today except for the
        // real price level itself, easy to mistake for "today, earlier."
        // Real chart libraries (TradingView included) show a date exactly
        // at day/month/year boundaries and time everywhere else — that is
        // precisely what tickMarkType already tells us, computed by LWC's
        // own real tick-placement logic. Using it here (rather than
        // re-deriving day-boundary detection ourselves) means this can
        // never disagree with where LWC actually puts the tick.
        if (tickMarkType === TickMarkType.Time || tickMarkType === TickMarkType.TimeWithSeconds) {
          return hhmm;
        }
        // The 1D view spans a year, so it genuinely crosses a year boundary;
        // "01/02" there would not say which year the axis just entered.
        if (tickMarkType === TickMarkType.Year) {
          return String(d.getUTCFullYear());
        }
        // Year/Month/DayOfMonth tick — a real day boundary. Show the CT
        // calendar date (UTC methods on the pseudo-epoch, same rule as
        // above) so a scrolled-back multi-day view is unambiguous, without
        // reintroducing the original problem this formatter was written to
        // avoid: a date repeated on EVERY tick. This only fires at the
        // boundary itself.
        const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
        const dd = String(d.getUTCDate()).padStart(2, '0');
        return `${mm}/${dd}`;
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
  onSessionVwap,
}: HeliosChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  // Same stable-indirection pattern as onMarkerClickRef: updateChartData
  // must not be re-created (and the chart re-subscribed) because a parent
  // passed a new callback identity.
  const onSessionVwapRef = useRef(onSessionVwap);
  useEffect(() => { onSessionVwapRef.current = onSessionVwap; }, [onSessionVwap]);
  const lastSessionVwapRef = useRef<string | null | undefined>(undefined);

  // What the CVD/aggressor panels are actually showing — see its render site.
  const [cvdPanelLabel, setCvdPanelLabel] = useState<string | null>(null);
  const cvdPanelLabelRef = useRef<string | null>(null);

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

  // ── Live legend state ───────────────────────────────────────────────────────
  // Refs, not state, for the source data: the crosshair handler is registered
  // once at chart-init and must always read the CURRENT bars/overlays without
  // being torn down and re-subscribed on every data tick.

  const [legend, setLegend] = useState<LegendSnapshot | null>(null);
  const displayBarsRef = useRef<Bar[]>([]);
  const overlayRef     = useRef<OverlayData>({ ema8: [], ema21: [], ema55: [], vwap: [], sessionVwap: null });
  const hoverTimeRef   = useRef<number | null>(null);

  /**
   * True whenever the visible time-scale range needs resetting to a sane
   * default before the next successful render. Set on ticker/interval
   * change, AND re-armed whenever backfilled.displayBars flips from empty
   * to populated (see hadBackfillRef below) — a real, two-phase data
   * arrival, not a one-time event: updateChartData first fires with only
   * the small live-edge (before the interval's backfill fetch resolves),
   * consuming a naive one-shot reset on that tiny dataset; when the real,
   * much larger backfill then arrives, the leftover visible-range indices
   * from the tiny dataset point at completely different bars (often the
   * OLDEST ones) in the new, larger array. Reproduced exactly live: NVDA
   * 1h first rendered ~9 live-only bars (reset fired, fine), then the real
   * 174-bar backfill landed and the chart kept showing indices [0,8] —
   * the first 9 bars of history (2026-08-24), not the recent ones — with
   * a real but wrong-for-"now" VWAP value and garbage-looking early-August
   * time labels next to a legend correctly reporting today's real time.
   * See DEFAULT_VISIBLE_BARS below for the sizing.
   */
  const needsViewResetRef = useRef(true);
  const hadBackfillRef    = useRef(false);

  /**
   * Real bug found and fixed here (2026-09-08), live, on real data:
   * updateChartData returns early whenever the selected ticker's bars
   * aren't ready (loading, or genuinely stale — see barsStore's own
   * staleness gate), which meant _refreshLegend() was simply never called
   * for the new ticker. React state doesn't clear itself, so the legend
   * kept rendering the PREVIOUS ticker's real numbers under the NEW
   * ticker's name — reproduced exactly: switching to QQQ while QQQ was
   * stale showed "QQQ" with SPY's real O/H/L/C/EMA/VWAP values, byte-
   * identical to the prior SPY reading. A mislabeled real number is worse
   * than a blank legend, so this clears the legend (and the refs it reads
   * from) the instant ticker or interval changes, rather than trusting
   * updateChartData to get around to it — it may never do so for a
   * ticker whose feed is currently down.
   */
  useEffect(() => {
    displayBarsRef.current = [];
    overlayRef.current     = { ema8: [], ema21: [], ema55: [], vwap: [], sessionVwap: null };
    hoverTimeRef.current   = null;
    setLegend(null);
    // Same reasoning for the parent's VWAP: the previous ticker's number
    // must not sit under the new ticker's name until the next redraw.
    lastSessionVwapRef.current = null;
    onSessionVwapRef.current?.(null);
    needsViewResetRef.current = true;
    hadBackfillRef.current    = false;
  }, [ticker, interval]);

  const _refreshLegend = useCallback(() => {
    const bars = displayBarsRef.current;
    if (bars.length === 0) { setLegend(null); return; }

    const hoverT = hoverTimeRef.current;
    const bar = hoverT === null
      ? bars[bars.length - 1]
      : bars.find(b => Math.floor(b.tCT / 1000) === hoverT) ?? bars[bars.length - 1];

    const at = Math.floor(bar.tCT / 1000);


    // EMAs are computed ON displayBars, so their points land exactly on bar
    // times. Exact match only, never nearest: an EMA genuinely has no value
    // before its own seeding period (EMA55's first 54 bars), and borrowing a
    // neighbouring bar's number there would be a quiet lie.
    const emaAt = (series: LineData<Time>[]): number | null =>
      series.find(p => p.time === at)?.value ?? null;

    // VWAP is deliberately computed at a fixed 1-minute resolution (that is
    // what makes it interval-invariant), so on a 15m/1h candle its points do
    // NOT align with bar times. Take the last value inside the candle — VWAP
    // as of the end of the bar being shown. An exact-match lookup here would
    // report VWAP from the bar's opening minute, up to 59 minutes stale on a
    // 1h chart.
    const bucketSec = (INTERVAL_MINUTES[interval] * 60_000) / 1000;
    let vwapVal: number | null = null;
    for (const p of overlayRef.current.vwap) {
      const t = p.time as number;
      if (t >= at && t < at + bucketSec) vwapVal = p.value;
      else if (t >= at + bucketSec) break;
    }

    setLegend({
      // Show the DATE too whenever the bar being read is not from the same CT
      // calendar day as the newest bar on the chart.
      //
      // Real gap (2026-09-10): the legend correctly follows the crosshair —
      // verified live, hovering different candles returns their own real
      // O/H/L/C — but it only ever rendered HH:mm. A 1h chart shows ~70 bars
      // at its default zoom, which is 3+ calendar days, and the backfill
      // behind it spans 13. So hovering a bar from another day produced a
      // bare "05:30" with nothing to say WHICH 05:30 — the timestamp was
      // there and still unreadable. Same-day hovering stays clean.
      //
      // At 1D every bar is a whole day keyed at midnight, so a time of day
      // would always read "00:00" — show the date alone, with the year,
      // because the 1D view spans one.
      timeLabel: interval === '1d'
        ? `${_formatChartDate(bar.tCT)}/${String(new Date(bar.tCT).getUTCFullYear()).slice(2)}`
        : _isSameCTDay(bar.tCT, bars[bars.length - 1].tCT)
          ? formatChartTime(at as UTCTimestamp)
          : `${_formatChartDate(bar.tCT)} ${formatChartTime(at as UTCTimestamp)}`,
      open:  bar.open,
      high:  bar.high,
      low:   bar.low,
      close: bar.close,
      isUp:  bar.close >= bar.open,
      ema8:  emaAt(overlayRef.current.ema8),
      ema21: emaAt(overlayRef.current.ema21),
      ema55: emaAt(overlayRef.current.ema55),
      vwap:  vwapVal,
      hovered: hoverT !== null,
    });
  }, [interval]);

  // Stable indirection so the once-registered crosshair handler always calls
  // the current _refreshLegend without needing to re-subscribe.
  const _refreshLegendRef = useRef(_refreshLegend);
  useEffect(() => { _refreshLegendRef.current = _refreshLegend; }, [_refreshLegend]);

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

    // ── Live legend wiring ───────────────────────────────────────────────────
    // Hovering pins the legend to the crosshair's candle; moving off the
    // chart (param.time undefined) releases it back to the newest bar, so
    // the legend is never blank and never stale. The handler only records
    // WHICH bar to show — the values themselves come from the same computed
    // series the lines were drawn from (see _refreshLegend).
    priceChart.subscribeCrosshairMove((param) => {
      const t = typeof param.time === 'number' ? param.time : null;
      if (t !== hoverTimeRef.current) {
        hoverTimeRef.current = t;
        _refreshLegendRef.current();
      }
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

    // Sync the three panels by ABSOLUTE TIME, not logical index.
    //
    // Logical indices address each CHART's own merged time-point array, and
    // the three charts genuinely hold different numbers of points — the
    // price chart carries the always-1-minute VWAP series (10,350 points on
    // a real QQQ 1h view) alongside 183 candles, while the CVD and
    // aggressor charts carry only their own series. Pushing the price
    // chart's logical range onto them therefore addressed completely
    // different bars, which is what left the shared time axis with nothing
    // in range to draw. See the setVisibleRange call in updateChartData for
    // the instrumented proof.
    // The one real cost of moving off logical ranges: a timestamp can only
    // be resolved against data that already exists, so setVisibleRange
    // throws LWC's own "Value is null" assertion on a chart that has no
    // points yet — and the price chart's range genuinely does change before
    // the CVD/aggressor series have been populated (reproduced live). A
    // logical range never hit this because it is just a number LWC will
    // happily extrapolate. getVisibleRange() is documented to return null
    // in exactly that "no data at all" state, so it is the real guard.
    priceChart.timeScale().subscribeVisibleTimeRangeChange(range => {
      if (range !== null) {
        _syncPanelRange(cvdChart, range);
        _syncPanelRange(aggrChart, range);
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

  // ── Real backfill from Massive's native aggregates ──────────────────────────
  //
  // 1m fetches the latest session. 5m/15m/1h fetch real, natively pre-aggregated
  // bars at the selected interval (plus a fixed 1-minute series for VWAP) —
  // see chartBarsBackfill.ts for the two-source split and the real seam
  // handling. Result<T> throughout: a fetch failure stays distinguishable
  // from a genuine empty range, same discipline as chartSignals.ts.

  const EMPTY_BACKFILL: ChartBackfill = useMemo(() => ({ displayBars: [], minuteBars: [] }), []);
  const [backfillResult, setBackfillResult] = useState<Result<ChartBackfill>>(
    { status: 'ready', data: { displayBars: [], minuteBars: [] }, asOf: 0 },
  );

  // The engine's per-minute delta series for the CVD/aggressor panels (see
  // the header). One request per 30 s for the ticker on screen — cheap, and
  // the series only grows by a minute at a time.
  const [deltaResult, setDeltaResult] = useState<Result<DeltaSeries>>({ status: 'loading' });
  useEffect(() => {
    let cancelled = false;
    setDeltaResult({ status: 'loading' });
    const load = () => { void fetchDeltaSeries(ticker).then((r) => { if (!cancelled) setDeltaResult(r); }); };
    load();
    const id = setInterval(load, 30_000);
    return () => { cancelled = true; clearInterval(id); };
  }, [ticker]);

  useEffect(() => {
    // 1m has no lookback in trading days, but it does fetch: the latest
    // session's minutes, for its candles and its VWAP. It used to skip the
    // fetch, drawing only the live buffer and computing VWAP over the
    // 500-bar buffer alone (measured wrong by 7 cents on SPY; see
    // _fetchLatestSessionMinutes). fetchChartBackfill's 1m branch ignores
    // the window below.
    const lookbackDays = BACKFILL_LOOKBACK_TRADING_DAYS[interval] ?? 0;

    let cancelled = false;
    setBackfillResult({ status: 'loading' });

    const { fromMs, toMs } = computeChartBackfillWindow(Date.now(), lookbackDays);
    fetchChartBackfill(ticker, interval, fromMs, toMs).then((result) => {
      // Guard against a slow fetch for a previously-selected ticker/interval
      // landing after the user has already switched — same pattern as
      // ChartScreen's marker fetch (Home/index.tsx).
      if (cancelled) return;
      // A failed fetch is otherwise indistinguishable from a thin chart:
      // updateChartData folds any non-'ready' result into EMPTY_BACKFILL and
      // renders the live buffer alone, which looks like a real (if short)
      // chart. That is exactly the silent-zero shape CLAUDE.md documents, so
      // say so out loud rather than letting "data unavailable" render as
      // "genuinely nothing".
      if (result.status === 'error') {
        console.error(`[HeliosChart] backfill FAILED for ${ticker} @ ${interval} — falling back to the live buffer alone, so the chart will be short and the EMA stack may not seed: ${result.reason}`);
      }
      setBackfillResult(result);
    });

    return () => { cancelled = true; };
  }, [ticker, interval, EMPTY_BACKFILL]);

  // ── Store data → chart ────────────────────────────────────────────────────────

  const updateChartData = useCallback(() => {
    const barsResult   = barsStore.getResult(ticker);
    const marketResult = marketStore.getResult(ticker);

    // Real bug found and fixed live (2026-09-09): this used to be a bare
    // `if (barsResult.status !== 'ready') return;`. barsStore reports a
    // ticker as `error` once its newest bar is older than 2 minutes
    // (STALE_THRESHOLD_MS) — so during any stale/reconnecting window this
    // returned before drawing ANYTHING. Switching interval while stale
    // therefore did nothing at all: the toolbar highlighted the new
    // interval while the canvas kept the PREVIOUS interval's candles, EMAs
    // and legend. Reproduced live on QQQ — the toolbar read 15m while the
    // trace confirmed updateChartData had last run with interval '1h'.
    //
    // Showing one timeframe's candles under another timeframe's label is
    // far worse than showing old data: the bars themselves are real and
    // still correct, only their freshness is in question, and the staleness
    // banner already says so explicitly. getBarsRaw exists for exactly this
    // ("valid on stale data" — see its own doc comment), so render what we
    // genuinely have and let the banner carry the freshness signal.
    const liveBars = barsResult.status === 'ready'
      ? barsResult.data
      : barsStore.getBarsRaw(ticker);

    const backfilled = backfillResult.status === 'ready'
      ? backfillResult.data
      : EMPTY_BACKFILL;

    // An empty LIVE buffer is not the same as having nothing to draw. On a
    // cold start, and on any closed market, barsStore can legitimately hold
    // zero bars for a ticker while this interval's own multi-day backfill is
    // fully loaded — this used to `return` on the live buffer alone and
    // leave "Waiting for bars…" over a chart that had days of real history
    // ready to render. Reproduced live on a closed market with SPY.
    // Only bail when BOTH sources are genuinely empty.
    if (liveBars.length === 0 && backfilled.displayBars.length === 0) return;

    // Real, finest-grain 1-minute series: backfilled 1-minute history merged
    // with the live buffer's tail. VWAP is always computed from THIS, never
    // from displayBars below — a fixed 1-minute source is precisely what
    // makes VWAP identical at every interval (see chartBarsBackfill.ts's
    // header and _computeVwapSeries's own).
    const rawBars1m = backfilled.minuteBars.length > 0
      ? _mergeBarHistory(backfilled.minuteBars, liveBars)
      : liveBars;

    // Real candle/EMA series. The historical portion is Massive's own native
    // aggregation at this interval; only the live edge — the currently-
    // forming candle and any bucket that completed since the fetch — is
    // rolled up client-side from the live 1-minute stream. '1m' is a real,
    // tested identity passthrough inside aggregateBars.
    //
    // 1D differs in two ways, both from measured data (chartBarsBackfill.ts,
    // "Daily bars"): Massive's daily OHLC is the regular session only, so the
    // live day is rolled from regular-session minutes only; and it is rolled
    // from rawBars1m (today's fetched minutes + the live tail), not the live
    // buffer alone — the fetched session is the one source guaranteed to
    // reach the 08:30 open, and a day candle missing its morning would show
    // the wrong open, high and low.
    const liveEdge = interval === '1d'
      ? aggregateBars(regularSessionOnly(rawBars1m), '1d')
      : aggregateBars(liveBars, interval);
    const displayBars = backfilled.displayBars.length > 0
      ? _mergeDisplayBars(backfilled.displayBars, liveEdge)
      : liveEdge;
    if (displayBars.length === 0) return;

    // No VWAP line at 1D. VWAP is a session indicator and at 1D a session is
    // one candle, so there is no path to draw — only one number per day, and
    // no consistent source for it. The obvious one, Massive's daily `vw`, is
    // a DIFFERENT definition from the close-weighted VWAP this chart draws
    // intraday: it includes prints that never update a bar's OHLC (measured
    // 2026-09-10 — SPY minute bars with vw above the bar's own high, e.g.
    // 14:59 CT h 758.03 / vw 758.98), and on 09-10 it came out 758.86
    // against the intraday line's 758.30. A 1D line of daily `vw` points
    // ending on today's close-weighted value would jump 56¢ at the last bar.
    // Computing close-weighted per day instead needs a year of minute bars.
    // Today's session VWAP stays on screen at every interval via the Key
    // Levels card.
    const plotVwap = interval !== '1d';


    // Real bug found and fixed live (2026-09-08): switching ticker or
    // interval hands the SAME long-lived series objects a completely
    // different-sized/different-range array via setData(). Lightweight
    // Charts' visible-range/logical-index state does not reset itself on
    // that call — confirmed live: even an explicit setVisibleLogicalRange
    // and fitContent() (deferred to the next animation frame, ruling out
    // a timing issue) kept resolving against a STALE internal range (an
    // 8.35-hour/500-logical-unit window matching the PREVIOUS dataset,
    // not the new, verified-correct 174-bar/10-day one just supplied).
    // Clearing each series to empty before handing it the real new data
    // forces Lightweight Charts to treat this as a genuinely fresh
    // dataset rather than a replacement of the previous one, which is
    // what actually resolves it.
    const hasBackfillNow = backfilled.displayBars.length > 0;
    if (hasBackfillNow !== hadBackfillRef.current) {
      // Backfill just arrived (or, on a re-subscribe, just went away) —
      // the dataset size just changed in a way a one-shot flag can't
      // catch. Re-arm the reset so the check below fires against the
      // real, final-shape dataset instead of the transitional live-only
      // one. See needsViewResetRef's own comment for why this two-phase
      // arrival is real, not hypothetical.
      needsViewResetRef.current = true;
      hadBackfillRef.current    = hasBackfillNow;
    }
    if (needsViewResetRef.current) {
      candleSeriesRef.current?.setData([]);
      ema8Ref.current?.setData([]);
      ema21Ref.current?.setData([]);
      ema55Ref.current?.setData([]);
      vwapRef.current?.setData([]);
    }

    const overlays = _updatePriceData(displayBars, rawBars1m, INTERVAL_MINUTES[interval] * 60_000, candleSeriesRef.current, ema8Ref.current, ema21Ref.current, ema55Ref.current, vwapRef.current, plotVwap);

    if (needsViewResetRef.current && priceChartRef.current) {
      needsViewResetRef.current = false;
      const chart      = priceChartRef.current;
      const container  = containerRef.current;
      const windowBars = displayBars;
      requestAnimationFrame(() => {
        const ts = chart.timeScale();
        // ts.width() genuinely returns 0 on a fresh mount at this point in
        // the frame (observed live 2026-09-09), so fall back to the real
        // container width, then to a fixed count rather than to "show
        // everything" — which is the crowding bug this window exists to fix.
        const widthPx     = ts.width() || container?.clientWidth || 0;
        const total       = windowBars.length;
        const wanted      = widthPx > 0
          ? Math.floor(widthPx / TARGET_PX_PER_BAR)
          : DEFAULT_VISIBLE_BARS;
        const visibleBars = Math.max(1, Math.min(total, wanted));

        if (visibleBars >= total) {
          ts.fitContent();
        } else {
          // Set the window by ABSOLUTE TIME, never by logical index.
          //
          // Real root cause, proven live 2026-09-09 — this is the bug the
          // 2026-09-08 note above ran into and could not explain ("logical
          // index 173 of a freshly-set 174-bar array is NOT resolving to
          // that array's own last element"). Logical indices address the
          // CHART's merged time-point array, not any one series' array. The
          // price chart carries the VWAP line, which is deliberately always
          // 1-MINUTE data (see chartBarsBackfill.ts's header) — so at 1h a
          // 183-bar candle series shares its chart with 10,350 VWAP points,
          // and the logical axis runs 0..10,355. Instrumented read-back on
          // real QQQ 1h data: asking for logical {0..182} came back as
          // {9981..10355}, a 6.5-hour window over 16 days of candles.
          //
          // That single mismatch produced three separate reported symptoms:
          // 1h "renders as a white line with two tiny candles" (the line is
          // VWAP, which has a point every minute; the candles are the two
          // that happen to fall in the wrong window), EMA8/21/55 all reading
          // blank at 1h (the window sits where those series have no points),
          // and the shared time axis going blank (the same out-of-range
          // logical range was being pushed onto the CVD/aggressor charts,
          // whose point counts differ again).
          //
          // Timestamps are absolute and identical across all three panels,
          // so they cannot drift with series length.
          ts.setVisibleRange({
            from: Math.floor(windowBars[total - visibleBars].tCT / 1000) as UTCTimestamp,
            to:   Math.floor(windowBars[total - 1].tCT / 1000) as UTCTimestamp,
          });
        }
        _syncPanelsTo(chart, [cvdChartRef.current, aggrChartRef.current]);
      });
    }

    // Feed the live legend from the exact series just drawn.
    displayBarsRef.current = displayBars;
    overlayRef.current     = overlays;
    _refreshLegend();

    // Only on a change the parent could display (cents) — this runs up to
    // once per animation frame.
    const vwapKey = overlays.sessionVwap === null ? null : overlays.sessionVwap.toFixed(2);
    if (vwapKey !== lastSessionVwapRef.current) {
      lastSessionVwapRef.current = vwapKey;
      onSessionVwapRef.current?.(overlays.sessionVwap);
    }

    // ── CVD + aggressor panels: the engine's real per-minute delta ─────────
    // (see the header's "CVD data source"). Rolled into this interval's
    // buckets; plotted only where classified trades exist.
    //
    // Every display bar still gets a point on the aggressor panel — real
    // delta where there is some, a zero-height transparent bar elsewhere —
    // because that panel hosts the chart's only visible time axis. Measured
    // 2026-09-10: with whitespace-only data lightweight-charts draws labels
    // but treats the time scale as empty for positioning (setVisibleRange is
    // ignored; the axis showed Sep–Dec 2025 under Jun–Sep 2026 candles).
    // The CVD panel has no axis, so it takes plain whitespace where there is
    // no data — a transparent 0 there would put a "0.00" CVD label on it.
    const bucketMs = INTERVAL_MINUTES[interval] * 60_000;
    const buckets = interval !== '1d' && deltaResult.status === 'ready'
      ? bucketDelta(deltaResult.data.bars, bucketMs)
      : [];
    const byTime = new Map(buckets.map(b => [Math.floor(b.tCT / 1000), b]));
    const hasDelta = buckets.length > 0;
    aggrHistRef.current?.applyOptions({ lastValueVisible: hasDelta, priceLineVisible: false });
    // No data: transparent scale text rather than a hidden scale — hiding it
    // would change the panel's plot width and shift its axis off the candles.
    aggrChartRef.current?.priceScale('right').applyOptions({ textColor: hasDelta ? C.textMuted : 'rgba(0,0,0,0)' });
    const times = displayBars.map(b => Math.floor(b.tCT / 1000) as UTCTimestamp);
    cvdLineRef.current?.setData(times.map(time => {
      const b = byTime.get(time);
      return b ? { time, value: b.cumDelta } : { time };
    }));
    aggrHistRef.current?.setData(times.map(time => {
      const b = byTime.get(time);
      return b
        ? { time, value: b.delta, color: b.delta >= 0 ? C.aggrBull : C.aggrBear }
        : { time, value: 0, color: 'rgba(0,0,0,0)' };
    }));

    // Say what the lower panels show, on the panels themselves.
    const fmtCT = (tCT: number) => `${String(new Date(tCT).getUTCHours()).padStart(2, '0')}:${String(new Date(tCT).getUTCMinutes()).padStart(2, '0')}`;
    const panelLabel = interval === '1d'
      ? 'CVD · NO DAILY HISTORY'
      : deltaResult.status === 'error'
        ? `CVD · UNAVAILABLE — ${deltaResult.reason}`
        : deltaResult.status === 'loading'
          ? 'CVD · LOADING'
          : hasDelta
            ? `CVD · CLASSIFIED TRADES SINCE ${fmtCT(deltaResult.data.bars[0].tCT)} CT`
            : 'CVD · NO CLASSIFIED TRADES THIS SESSION';
    if (panelLabel !== cvdPanelLabelRef.current) {
      cvdPanelLabelRef.current = panelLabel;
      setCvdPanelLabel(panelLabel);
    }
    _syncPanelsTo(priceChartRef.current, [cvdChartRef.current, aggrChartRef.current]);

    if (marketResult.status === 'ready') {
      _applyGexLevelsInternal(candleSeriesRef.current, marketResult.data);
    }
  }, [ticker, interval, backfillResult, deltaResult, EMPTY_BACKFILL, _refreshLegend]);

  useEffect(() => {
    // Coalesce store notifications into at most ONE redraw per animation
    // frame.
    //
    // Real, measured problem (2026-09-09), not a speculative optimisation.
    // These three stores were each wired straight to updateChartData, so every
    // notification ran the whole pipeline: merge ~10k one-minute bars, rebuild
    // VWAP, three EMA passes, and setData on five series. Instrumented over a
    // real 47s window on a live feed:
    //
    //   ws.frame            14,705 calls  (~313 WS frames/sec)
    //   chart.update.1m      4,906 calls
    //   chart.update.5m      2,401 calls   → ~155 redraws/sec
    //   main thread blocked  58% of wall clock
    //   worst single task    6,484ms
    //
    // The worst long task, the worst ws.frame and the worst chart.update all
    // came back as the SAME 6,484ms — i.e. the single worst blocking event in
    // the app is a WS frame whose store notification fans out into a full
    // chart redraw. A chart cannot usefully redraw 155 times a second; the
    // display only changes once per paint.
    //
    // This also directly addresses the reconnect-burst shape suspected behind
    // the original Track B incident: a burst that delivers hundreds of frames
    // at once now collapses into one redraw instead of hundreds.
    //
    // And it bounds the cost I knowingly added: the stale-render fix removed
    // an early-return, so this pipeline now also runs during stale windows
    // where it used to bail. Coalescing is what makes that correctness fix
    // affordable.
    let rafId = 0;
    const schedule = () => {
      if (rafId !== 0) return;            // already queued for this frame
      rafId = requestAnimationFrame(() => { rafId = 0; updateChartData(); });
    };

    updateChartData();                    // first paint is immediate, not deferred
    const unsub1 = barsStore.subscribe(schedule);
    const unsub3 = marketStore.subscribe(schedule);
    const unsub4 = directionState.subscribe((_t, state) => {
      if (_t === ticker) setDirection(state);
    });
    // Seed direction from current state
    setDirection(directionState.getDirectionState(ticker));
    return () => {
      if (rafId !== 0) cancelAnimationFrame(rafId);
      unsub1(); unsub3(); unsub4();
    };
  }, [ticker, updateChartData]);

  // ── Signal markers ────────────────────────────────────────────────────────────
  //
  // Clustered at the currently-displayed interval's own bucket width —
  // real no-op at 1m (bucket width == a marker's own native resolution),
  // real collapsing at 5m/15m/1h. See markerClustering.ts.

  useEffect(() => {
    if (!markersPluginRef.current) return;
    const bucketMs = INTERVAL_MINUTES[interval] * 60_000;
    const clustered = interval === '1d'
      ? summariseMarkersByDay(markers, bucketMs)
      : clusterMarkersForDisplay(markers, bucketMs);
    markersPluginRef.current.setMarkers(_buildLtwMarkers(clustered, bucketMs));
  }, [markers, interval]);

  // At 1D the aggressor panel's axis would stamp "00:00" on every crosshair
  // label — every daily bar is keyed at midnight. Dates only there. Re-applied
  // on ticker/height too, because those re-create the chart with defaults.
  useEffect(() => {
    aggrChartRef.current?.applyOptions({ timeScale: { timeVisible: interval !== '1d' } });
  }, [interval, ticker, height]);

  // ── Session bias tint ─────────────────────────────────────────────────────────

  const biasTintColor = useMemo(() => {
    if (!direction) return C.neutralTint;
    if (direction.sessionBias === 'bullish') return C.bullTint;
    if (direction.sessionBias === 'bearish') return C.bearTint;
    return C.neutralTint;
  }, [direction]);

  // ── Loading state ─────────────────────────────────────────────────────────────

  const barsStatus = barsStore.getResult(ticker).status;
  // Whether anything is actually plotted right now — drives the skeleton, so
  // a freshness state can never hide a populated chart. displayBarsRef is set
  // by updateChartData from the exact series handed to the candle series.
  const hasDrawableBars = displayBarsRef.current.length > 0;

  // ── Countdown to bar close ────────────────────────────────────────────────────
  //
  // Time left in the currently-forming candle, matching TradingView's
  // convention: mm:ss, counting down to the bucket boundary for whichever
  // interval is selected (1m from 60s, 1h from up to 3600s).
  //
  // Derived from the wall clock against the interval's own bucket width, not
  // from the newest bar's timestamp. Both agree — aggregateBars buckets on
  // exact multiples of the interval, and Massive's own bucket starts are
  // multiples in the CT frame as well as UTC (the CT offset is a whole number
  // of hours) — but the wall clock keeps ticking during a quiet minute where
  // no bar has arrived yet, which is exactly when a trader is watching this
  // number most closely.
  //
  // PLACEMENT (revised 2026-09-10): on the price scale, directly under the
  // last-price label — where TradingView puts it and where a trader looks.
  // The first version sat in the legend next to the bar time, which had two
  // real problems: "11:00 01:45" reads as a second timestamp rather than a
  // countdown, and it hid whenever the legend was showing a hovered bar —
  // and on touch devices a tap pins the crosshair, so on a phone it vanished
  // after almost any interaction. On the axis it belongs to the LAST bar,
  // not the crosshair, so hovering never affects it.
  const [barCloseCountdown, setBarCloseCountdown] = useState<
    { text: string; top: number; width: number; isUp: boolean } | null
  >(null);
  useEffect(() => {
    const bucketMs = INTERVAL_MINUTES[interval] * 60_000;
    const tick = () => {
      // Meaningless when the venue is closed — nothing is forming.
      if (marketStatusStore.isFeedExpectedLive() === false) { setBarCloseCountdown(null); return; }

      const chart  = priceChartRef.current;
      const series = candleSeriesRef.current;
      const bars   = displayBarsRef.current;
      if (!chart || !series || bars.length === 0) { setBarCloseCountdown(null); return; }

      // Pixel position of the last close on the price pane — the same point
      // lightweight-charts centres its own last-price label on.
      const last = bars[bars.length - 1];
      const y = series.priceToCoordinate(last.close);
      if (y === null) { setBarCloseCountdown(null); return; }

      // 1D: a daily candle closes at the regular-session close, not at a
      // midnight — 15:00 CT (NYSE 4:00 PM ET; see REGULAR_CLOSE_CT_MIN's
      // citation). Outside the regular session no daily candle is forming
      // (Massive's daily bar is regular-session only), so there is nothing to
      // count down to.
      let remainingMs: number;
      if (interval === '1d') {
        const ct = toCentralTime(Date.now());
        const secOfDay = ct.hour * 3600 + ct.minute * 60 + ct.second;
        if (secOfDay < REGULAR_OPEN_CT_MIN * 60 || secOfDay >= REGULAR_CLOSE_CT_MIN * 60) {
          setBarCloseCountdown(null);
          return;
        }
        remainingMs = (REGULAR_CLOSE_CT_MIN * 60 - secOfDay) * 1000 - ct.millisecond;
      } else {
        remainingMs = bucketMs - (Date.now() % bucketMs);
      }
      const total = Math.max(0, Math.ceil(remainingMs / 1000));
      const hh = Math.floor(total / 3600);
      const mm = Math.floor((total % 3600) / 60);
      const ss = total % 60;
      const pad = (n: number) => String(n).padStart(2, '0');
      setBarCloseCountdown({
        // hh:mm:ss only when there are hours to show — up to 6.5h at 1D.
        text:  hh > 0 ? `${pad(hh)}:${pad(mm)}:${pad(ss)}` : `${pad(mm)}:${pad(ss)}`,
        // The last-price label is ~18px tall and centred on y; sit just below it.
        top:   y + 10,
        width: chart.priceScale('right').width(),
        isUp:  last.close >= last.open,
      });
    };
    tick();
    const id = setInterval(tick, 1000);
    const unsub = marketStatusStore.subscribe(tick);
    return () => { clearInterval(id); unsub(); };
  }, [interval]);

  // ── Feed health ───────────────────────────────────────────────────────────────
  //
  // Recomputed on a timer as well as on store changes: 'delayed' and 'down'
  // are functions of elapsed time, so a feed that simply goes quiet produces
  // no store event to react to. Ten seconds matches the Home banner's own
  // cadence.
  const [feedHealth, setFeedHealth] = useState<marketStatusStore.FeedHealth>({ kind: 'unknown' });
  useEffect(() => {
    const recompute = () => {
      const bars = barsStore.getBarsRaw(ticker);
      const newest = bars.length > 0 ? bars[bars.length - 1].tUtc : null;
      const next = marketStatusStore.classifyFeedHealth(newest);
      // classifyFeedHealth returns a fresh object every call, and this runs
      // on every store notification — WS frames arrive at ~313/sec (measured
      // during the Track B work), so setting state unconditionally would
      // re-render the chart on every frame. That is the exact unguarded
      // fan-out shape that caused Track B in the first place. Only commit a
      // change the user could actually see: the kind, or the displayed age,
      // which is rendered at whole-minute resolution.
      setFeedHealth(prev => {
        if (prev.kind !== next.kind) return next;
        const prevMin = 'ageMs' in prev ? Math.floor(prev.ageMs / 60_000) : -1;
        const nextMin = 'ageMs' in next ? Math.floor(next.ageMs / 60_000) : -1;
        return prevMin === nextMin ? prev : next;
      });
    };
    recompute();
    const timer = setInterval(recompute, 10_000);
    const unsubBars   = barsStore.subscribe(recompute);
    const unsubMarket = marketStatusStore.subscribe(recompute);
    return () => { clearInterval(timer); unsubBars(); unsubMarket(); };
  }, [ticker]);

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

      {/* Live legend — the hovered candle, or the newest one when not
          hovering. Sits below the direction badges when those are present.
          pointer-events-none so it never intercepts chart interaction. */}
      {legend && (
        <div
          className="absolute left-3 z-20 pointer-events-none select-none"
          style={{ top: direction ? 36 : 8 }}
        >
          <div
            style={{
              background:    'rgba(13, 15, 20, 0.78)',
              border:        `1px solid ${C.border}`,
              borderRadius:  '4px',
              padding:       '5px 9px',
              fontFamily:    "'JetBrains Mono', 'Fira Code', monospace",
              fontSize:      '10.5px',
              lineHeight:    1.6,
              whiteSpace:    'nowrap',
            }}
          >
            <div style={{ display: 'flex', gap: '10px', alignItems: 'baseline' }}>
              <span style={{ color: C.text, fontWeight: 700, letterSpacing: '0.04em' }}>{ticker}</span>
              <span style={{ color: C.textMuted }}>{interval}</span>
              <span style={{ color: legend.hovered ? C.text : C.textMuted }}>{legend.timeLabel}</span>
            </div>

            <div style={{ display: 'flex', gap: '10px' }}>
              {([['O', legend.open], ['H', legend.high], ['L', legend.low], ['C', legend.close]] as const).map(
                ([label, value]) => (
                  <LegendItem
                    key={label}
                    label={label}
                    value={value}
                    color={legend.isUp ? C.bullBody : C.bearBody}
                  />
                ),
              )}
            </div>

            <div style={{ display: 'flex', gap: '10px' }}>
              <LegendItem label="EMA8"  value={legend.ema8}  color={C.ema8}  />
              <LegendItem label="EMA21" value={legend.ema21} color={C.ema21} />
              <LegendItem label="EMA55" value={legend.ema55} color={C.ema55} />
              {/* No VWAP at 1D — see plotVwap in updateChartData. */}
              {interval !== '1d' && <LegendItem label="VWAP"  value={legend.vwap}  color={C.vwap}  />}
            </div>
          </div>
        </div>
      )}

      {/* Chart panels mounted here by useEffect */}
      <div ref={containerRef} className="w-full" />

      {/* Loading skeleton — only when there is genuinely nothing to draw.
          barsStore reports `loading` for a ticker that is stale AND has a
          backfill in flight, and with the market closed EVERY ticker is
          stale, so any retry would otherwise hide a fully-populated chart
          behind "Waiting for bars…". Reproduced live on a closed market:
          real SPY history sat underneath the skeleton for the better part of
          a minute. Same principle as the feed-health rework below — a
          freshness state must never hide real data; only an empty series
          may. */}
      {barsStatus === 'loading' && !hasDrawableBars && (
        <div className="absolute inset-0 flex items-center justify-center bg-[#0d0f14]/80 z-30">
          <ChartSkeleton />
        </div>
      )}

      {/* What the CVD panel is showing — the real series and since when, or
          why there is none. The panel used to draw a projection that read as
          history (see the header's "CVD data source"); a label on the panel
          itself is what keeps an empty or partial one from being misread. */}
      {cvdPanelLabel && (
        <div
          className="absolute left-0 z-20 pointer-events-none select-none px-2"
          style={{
            top:        Math.round(height * PRICE_PANEL_RATIO) + 4,
            fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
            fontSize:   9,
            fontWeight: 700,
            letterSpacing: '0.06em',
            color:      C.textMuted,
          }}
        >
          {cvdPanelLabel}
        </div>
      )}

      {/* Countdown to bar close — on the price scale, under the last-price
          label, TradingView-style. Background follows the last bar's
          direction, matching the price label it sits beneath. pointer-events
          none so it never steals a tap from the chart. */}
      {barCloseCountdown && barCloseCountdown.width > 0 && (
        <div
          className="absolute z-20 pointer-events-none select-none"
          style={{
            top:        barCloseCountdown.top,
            right:      0,
            width:      barCloseCountdown.width,
            textAlign:  'center',
            fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
            fontSize:   10,
            fontWeight: 700,
            lineHeight: '15px',
            color:      '#0d0f14',
            background: barCloseCountdown.isUp ? C.bullBody : C.bearBody,
          }}
        >
          {barCloseCountdown.text}
        </div>
      )}

      {/* Feed health — never blocks the chart.
          This replaced a full-screen dimming overlay driven purely by
          barsStore's "newest bar > 2 minutes old" rule, which had no idea
          whether the market was even open. On a closed market that overlay
          fired on every ticker, all night and all weekend, dimming real and
          correct history behind a second warning while the app ALREADY said
          "MARKET CLOSED" at the top of the screen — hiding exactly the data
          a trader opens a closed-market chart to review.
          Freshness is still reported; it just no longer takes the chart
          hostage, and it now knows what the venue is doing. */}
      {/* 'market-closed' and 'live' both render NOTHING here on purpose.
          The app shell already states market-closed once, at the top of the
          screen; repeating it over the chart was half of the original
          double-warning complaint. The chart speaks only when it knows
          something the banner does not — that the market is genuinely live
          and the bars still are not arriving. */}
      {feedHealth.kind === 'delayed' && (
        <div className="absolute top-0 right-0 z-30 m-1 rounded border border-amb/40 bg-[#0d0f14]/90 px-2 py-1">
          <p className="text-amb font-mono text-[10px] leading-tight">
            DELAYED {formatAge(feedHealth.ageMs)} — last good data shown
          </p>
        </div>
      )}
      {feedHealth.kind === 'down' && (
        <div className="absolute top-0 right-0 z-30 m-1 rounded border border-col-r/50 bg-[#0d0f14]/90 px-2 py-1">
          <p className="text-col-r font-mono text-[10px] leading-tight">
            FEED DOWN {formatAge(feedHealth.ageMs)} — last good data shown
          </p>
        </div>
      )}

      {/* Backfill failure — degraded, NOT dead. The live buffer alone is a
          real but very short series (7 bars at 1h), which silently renders
          as a sparse chart with an unseeded EMA stack and reads as "this
          ticker just has little history" rather than "the history request
          failed". Deliberately a corner notice, not the full-screen overlay
          above: the bars still on screen are real and worth showing. */}
      {backfillResult.status === 'error' && (
        <div className="absolute top-0 right-0 z-30 m-1 rounded border border-col-r/40 bg-[#0d0f14]/90 px-2 py-1">
          <p className="text-col-r font-mono text-[10px] leading-tight">
            HISTORY UNAVAILABLE — showing live buffer only; EMAs may not seed
          </p>
        </div>
      )}

      {/* Backfill in flight. Same corner treatment, and for the same reason
          as the failure notice: until it lands, the chart is honestly drawing
          the live buffer alone — a handful of bars at 1h, with an EMA stack
          that cannot seed yet. Without this, that intermediate state is
          visually indistinguishable from the real, fully-loaded chart and
          reads as a rendering fault. The window is not brief: one relay
          timeout plus the retry can take ~51s (25s + 1.5s + 25s), and the
          timeout is real and observed, not hypothetical. The full-screen
          skeleton above is deliberately not reused — the live bars already
          on screen are real, and hiding them would be a downgrade. */}
      {backfillResult.status === 'loading' && (
        <div className="absolute top-0 right-0 z-30 m-1 rounded border border-amb/40 bg-[#0d0f14]/90 px-2 py-1">
          <p className="text-amb font-mono text-[10px] leading-tight">
            LOADING HISTORY… — live buffer only until it lands
          </p>
        </div>
      )}
    </div>
  );
});

// ── Panel range sync ───────────────────────────────────────────────────────────

/**
 * Put a sub-panel on the price chart's visible time range. See the
 * subscribeVisibleTimeRangeChange wiring for why this is by time, and why
 * getVisibleRange() === null is the "no data at all" guard.
 */
function _syncPanelRange(target: IChartApi, range: IRange<Time>) {
  const current = target.timeScale().getVisibleRange();
  if (current === null) return;
  // Already there — skip. _syncPanelsTo runs on every redraw (up to once a
  // frame), and a no-op setVisibleRange still costs a repaint.
  if (current.from === range.from && current.to === range.to) return;
  target.timeScale().setVisibleRange(range);
}

/**
 * Re-sync the sub-panels to the price chart NOW, without waiting for the
 * price chart to report a range change.
 *
 * The change event alone is not enough — measured 2026-09-10 at 5m: the
 * event fired with the right range (09-10 13:50–18:55), yet the aggressor
 * panel ended up on 08-31 06:45–11:50, so its axis labelled the wrong week
 * under the candles. updateChartData replaces the panels' data AFTER the
 * price series', so the event-driven sync lands on the panel's old data and
 * is lost when ~1,500 new points replace it. Syncing again once the panels
 * hold their new data (end of updateChartData, and after a view reset) put
 * the axis panel on the price chart's exact range at 1m, 5m, 15m, 1H and 1D.
 */
function _syncPanelsTo(price: IChartApi | null, panels: (IChartApi | null)[]) {
  const range = price?.timeScale().getVisibleRange() ?? null;
  if (!range) return;
  for (const p of panels) if (p) _syncPanelRange(p, range);
}

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
  bucketMs:    number,
  candles:     ISeriesApi<'Candlestick'> | null,
  ema8Series:  ISeriesApi<'Line'> | null,
  ema21Series: ISeriesApi<'Line'> | null,
  ema55Series: ISeriesApi<'Line'> | null,
  vwapSeries:  ISeriesApi<'Line'> | null,
  plotVwap:    boolean = true,
): OverlayData {
  const empty: OverlayData = { ema8: [], ema21: [], ema55: [], vwap: [], sessionVwap: null };
  if (!candles) return empty;

  const candleData: CandlestickData<Time>[] = displayBars.map(b => ({
    time:  Math.floor(b.tCT / 1000) as UTCTimestamp,
    open:  b.open,
    high:  b.high,
    low:   b.low,
    close: b.close,
  }));
  candles.setData(candleData);

  const closes = displayBars.map(b => b.close);
  const ema8   = _computeEmaSeries(displayBars, closes, 8);
  const ema21  = _computeEmaSeries(displayBars, closes, 21);
  const ema55  = _computeEmaSeries(displayBars, closes, 55);
  // VWAP's VALUE still comes from the fixed 1-minute series — that is what
  // makes it interval-invariant and must not change. But it is now PLOTTED on
  // the display bars' own timestamps. See _alignSeriesToBars for the real
  // rendering bug that fixes.
  // The session series is computed regardless — it is also what
  // onSessionVwap reports, and that must work at 1D too.
  const sessionSeries = _computeVwapSeries(rawBars1m);
  const vwap = plotVwap ? _alignSeriesToBars(sessionSeries, displayBars, bucketMs) : [];

  if (ema8Series)  ema8Series.setData(ema8);
  if (ema21Series) ema21Series.setData(ema21);
  if (ema55Series) ema55Series.setData(ema55);
  if (vwapSeries)  vwapSeries.setData(vwap);

  // Handed back so the live legend reads the exact values the lines were
  // drawn from, rather than recomputing them and risking a disagreement.
  return {
    ema8, ema21, ema55, vwap,
    sessionVwap: sessionSeries.length > 0 ? sessionSeries[sessionSeries.length - 1].value : null,
  };
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
  // Real root cause found live (2026-09-09) for the crash aggregateBars.ts's
  // _assertAscending documents as "genuinely unidentified":
  //
  //   Assertion failed: data must be asc ordered by time,
  //   index=10886, time=1788949140, prev time=1788949462
  //
  // index=10886 is not the candle series (183 bars at 1h) — it is the VWAP
  // series, which is always 1-MINUTE and so runs to ~10k points. And
  // prev=1788949462 is not minute-aligned (:42s) while the bar after it is.
  //
  // This function used to key AND sort on tUtc, while every series builder
  // emits on tCT (`Math.floor(b.tCT / 1000)`). Sorting on one field and
  // emitting on another is only safe if the two are perfectly monotonically
  // related, and _mergeDisplayBars' own comment below already documents that
  // they are not: for an aggregated bar tUtc is the FIRST SOURCE BAR's
  // timestamp, not the bucket start. One pair ordered differently in the two
  // frames is enough to hand lightweight-charts a descending step and crash
  // the whole chart.
  //
  // That is also exactly why this went unfound: the 2026-09-08 hardening put
  // the dedupe-by-tCT and the strict-ascending guard on the CANDLE path
  // (_mergeDisplayBars + _assertAscending), and the 822 instrumented render
  // cycles watched that path. The violation lives on the minute/VWAP path,
  // which kept the original unguarded tUtc logic. The instrumentation was
  // real and correct; it was simply pointed at the wrong series.
  //
  // Fixed by mirroring the candle path exactly: tCT is the real bar identity
  // (same argument _mergeDisplayBars makes for buckets), so key on it, sort
  // on it, and refuse to emit anything that is not strictly ascending in it.
  const byBucket = new Map<number, Bar>();
  for (const b of historical) {
    if (!Number.isFinite(b.tCT)) {
      console.error('[HeliosChart] _mergeBarHistory: non-finite tCT in HISTORICAL bar, dropped:', JSON.stringify(b));
      continue;
    }
    byBucket.set(b.tCT, b);
  }
  for (const b of live) {
    if (!Number.isFinite(b.tCT)) {
      console.error('[HeliosChart] _mergeBarHistory: non-finite tCT in LIVE bar, dropped:', JSON.stringify(b));
      continue;
    }
    byBucket.set(b.tCT, b); // live wins on overlap — freshest for the shared tail
  }

  const sorted = Array.from(byBucket.values()).sort((a, b) => a.tCT - b.tCT);

  // Dedupe by tCT already removes equal keys, so this can only fire if the
  // sort itself was handed something pathological (a NaN survivor). Kept
  // anyway: a dropped bar is a cosmetic gap in VWAP, an unsorted array is a
  // crashed chart.
  const safe: Bar[] = [];
  for (const bar of sorted) {
    if (safe.length > 0 && bar.tCT <= safe[safe.length - 1].tCT) {
      console.error('[HeliosChart] _mergeBarHistory: order violation, dropped — please report:',
        JSON.stringify({ prev: safe[safe.length - 1], dropped: bar }));
      continue;
    }
    safe.push(bar);
  }
  return safe;
}

/**
 * Join Massive's native historical aggregates to the client-rolled live edge.
 *
 * Two real differences from _mergeBarHistory above, both load-bearing:
 *
 * 1. Keyed on tCT, not tUtc. For an AGGREGATED bar, tUtc is the first
 *    source bar's own timestamp (see _mergeGroup in aggregateBars.ts), so a
 *    1h bucket rolled from a live buffer that happens to start at 14:03
 *    carries tUtc 14:03 — while Massive's native bar for the same bucket
 *    carries 14:00. Keyed on tUtc the two would not dedupe and the chart
 *    would draw the same hour twice. tCT IS the exact bucket start in both
 *    sources (verified live: Massive's bucket starts are exact multiples of
 *    the interval in the CT frame as well as UTC), so it is the real bucket
 *    identity.
 *
 * 2. HISTORICAL wins on overlap — the opposite of _mergeBarHistory's rule,
 *    deliberately. The oldest bucket the live buffer can produce is usually
 *    PARTIAL (the 500-bar buffer starts mid-bucket), so letting live win
 *    would quietly replace a complete native bar with a truncated
 *    reconstruction of the same period. Nothing fresh is lost by preferring
 *    historical: the bucket that was still forming at fetch time was already
 *    removed by dropFormingBucket, and any bucket that completed after the
 *    fetch exists only in the live edge, so it is carried through untouched.
 */
export function _mergeDisplayBars(historical: Bar[], live: Bar[]): Bar[] {
  const byBucket = new Map<number, Bar>();
  for (const b of live) {
    if (!Number.isFinite(b.tCT)) {
      console.error('[HeliosChart] _mergeDisplayBars: non-finite tCT in LIVE bar, dropped:', JSON.stringify(b));
      continue;
    }
    byBucket.set(b.tCT, b);
  }
  for (const b of historical) {
    if (!Number.isFinite(b.tCT)) {
      console.error('[HeliosChart] _mergeDisplayBars: non-finite tCT in HISTORICAL bar, dropped:', JSON.stringify(b));
      continue;
    }
    byBucket.set(b.tCT, b); // historical wins on overlap
  }
  const result = Array.from(byBucket.values()).sort((a, b) => a.tCT - b.tCT);

  // Real defensive backstop (2026-09-08): a live crash — "Assertion failed:
  // data must be asc ordered by time" from lightweight-charts itself — was
  // caught once, live, on real data, and could not be reproduced afterward
  // despite real effort (822 real render cycles instrumented with the
  // non-finite guard above plus a post-sort verification, across multiple
  // tickers/intervals: zero violations). The root cause is genuinely
  // unidentified. Rather than ship a fix for a mechanism that isn't
  // understood, this makes the failure mode itself impossible: dedup by tCT
  // plus a numeric sort on finite values is mathematically guaranteed
  // ascending, so if this loop EVER finds a violation regardless, something
  // is wrong in a way not yet imagined — log it loudly with full data (the
  // next real lead, if it recurs) AND hand lightweight-charts a genuinely
  // safe array either way, rather than let a real chart crash reach a real
  // trader again.
  const safe: Bar[] = [];
  for (const bar of result) {
    if (safe.length > 0 && bar.tCT <= safe[safe.length - 1].tCT) {
      console.error('[HeliosChart] _mergeDisplayBars: order violation survived the sort — dropping bar, please report:',
        JSON.stringify({ prev: safe[safe.length - 1], dropped: bar }));
      continue;
    }
    safe.push(bar);
  }
  return safe;
}

/**
 * Real EMA series over `bars`. Pure and exported — the live legend needs the
 * same computed values the line is drawn from, and recomputing them a second
 * time in the legend would be a real chance for the two to disagree.
 */
export function _computeEmaSeries(bars: Bar[], closes: number[], period: number): LineData<Time>[] {
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
  return data;
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
/**
 * Re-plot a 1-minute-resolution series onto the DISPLAY bars' own timestamps,
 * taking each bar's last value inside its bucket.
 *
 * ── The real rendering bug this fixes (found and measured 2026-09-09) ──────
 * Lightweight Charts allocates horizontal space per TIME-SCALE POINT, and the
 * time scale is the UNION of every series' timestamps on that chart. VWAP is
 * deliberately always 1-minute (see chartBarsBackfill.ts) and used to be
 * plotted at 1-minute resolution, so it dumped ~10,000 points onto a chart
 * whose candle series held a few hundred. Each candle owns exactly ONE slot,
 * so a candle could never be drawn wider than one minute's worth of pixels —
 * no matter how few candles were on screen.
 *
 * Measured on real SPY backfill, 362px-wide chart, market closed:
 *
 *   interval  candles  vwap pts  slots/candle  px per slot  candle width
 *   1m            500       500             1        ~5.2   readable
 *   5m          1,531     6,805             5        1.195  1px hairline
 *   15m           512     6,805            15        0.501  sub-pixel
 *   1h            192    10,271            60        0.501  sub-pixel
 *
 * 15m and 1h both pinned at 0.501px — that is minBarSpacing's 0.5px floor,
 * i.e. the library refusing to compress further. That is also why the
 * "compute a readable window from chart width / 6px per bar" logic could not
 * help: it computes a CANDLE count, but the library was spacing by MINUTE
 * slots, so the window got silently truncated to whatever fit at the floor
 * (1h asked for ~60 candles and got 13). Both fixes were running correctly;
 * their units simply disagreed with the library's.
 *
 * And it explains why 1m always looked right: at 1m the VWAP series and the
 * candle series carry the SAME timestamps, so slots == candles, 1:1.
 *
 * The VALUE is untouched — still cumulative from session open over real
 * 1-minute bars, so VWAP stays identical at every interval by construction,
 * exactly as chartBarsBackfill.ts's header requires. Only the emitted
 * timestamps change. This is also precisely what the live legend already
 * did (_refreshLegend takes the last VWAP inside the hovered candle), so the
 * plotted line and the legend now agree by construction instead of by luck.
 */
export function _alignSeriesToBars(
  src:      LineData<Time>[],
  bars:     Bar[],
  bucketMs: number,
): LineData<Time>[] {
  if (src.length === 0 || bars.length === 0) return [];
  const bucketSec = bucketMs / 1000;
  const out: LineData<Time>[] = [];
  let i = 0;
  // Both inputs are strictly ascending, so this is a single linear pass.
  for (const bar of bars) {
    const start = Math.floor(bar.tCT / 1000);
    const end   = start + bucketSec;
    let value: number | undefined;
    while (i < src.length && (src[i].time as number) < end) {
      if ((src[i].time as number) >= start) value = src[i].value;
      i++;
    }
    // A bucket with no real 1-minute data inside it emits nothing rather than
    // carrying the previous bar's number forward — same discipline as the
    // legend's em dash: absent is not the same as unchanged.
    if (value !== undefined) out.push({ time: start as UTCTimestamp, value });
  }
  return out;
}

export function _computeVwapSeries(bars: Bar[]): LineData<Time>[] {
  // The one VWAP definition — lib/sessionVwap (hlc3 × volume, reset at each
  // CT calendar day). This used to be close × volume; measured on SPY, QQQ
  // and TSLA sessions the two never differed by more than 1.4¢, but the
  // chart must use the same function the engines and cockpits do, or they
  // can disagree about which side of VWAP price is on.
  return sessionVwapSeries(bars).map(p => ({
    time:  Math.floor(p.tCT / 1000) as UTCTimestamp,
    value: p.value,
  }));
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

  // An absent level (null — no wall, no flip) draws nothing. Walls used to
  // fall back to the spot price, which drew a "wall" exactly at the price.
  const addLevel = (
    price:    number | null,
    color:    string,
    label:    string,
    width:    1 | 2,
    style:    LineStyle,
  ) => {
    if (price === null) return;
    const line = candleSeries.createPriceLine({
      price,
      color,
      lineWidth:        width,
      lineStyle:        style,
      axisLabelVisible: true,
      title: `${label} $${price.toFixed(2)}`,
    });
    newLines.push(() => candleSeries.removePriceLine(line));
  };

  // Primary call wall (largest OI cluster above spot)
  addLevel(
    ctx.walls.callWall,
    C.callWall,
    'CALL WALL',
    2,
    LineStyle.Solid,
  );

  // Primary put wall (largest OI cluster below spot)
  addLevel(
    ctx.walls.putWall,
    C.putWall,
    'PUT WALL',
    2,
    LineStyle.Solid,
  );

  // Secondary level above (upTarget = next significant call cluster)
  if (ctx.upTarget !== ctx.walls.callWall) {
    addLevel(
      ctx.upTarget,
      C.callWallSecondary,
      'C2',
      1,
      LineStyle.Dashed,
    );
  }

  // Secondary level below (downTarget = next significant put cluster)
  if (ctx.downTarget !== ctx.walls.putWall) {
    addLevel(
      ctx.downTarget,
      C.putWallSecondary,
      'P2',
      1,
      LineStyle.Dashed,
    );
  }

  // GEX flip level — only when it exists. Absent (null, lib/zeroGamma) draws
  // no line: a line at a stand-in price is worse than no line.
  if (ctx.flipLevel !== null) {
    addLevel(
      ctx.flipLevel,
      C.flip,
      'FLIP',
      1,
      LineStyle.Dashed,
    );
  }

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

  // An absent level (null — no wall, no flip) draws nothing. Walls used to
  // fall back to the spot price, which drew a "wall" exactly at the price.
  const addLevel = (
    price:    number | null,
    color:    string,
    label:    string,
    width:    1 | 2,
    style:    LineStyle,
  ) => {
    if (price === null) return;
    const line = candleSeries.createPriceLine({
      price,
      color,
      lineWidth:        width,
      lineStyle:        style,
      axisLabelVisible: true,
      title: `${label} $${price.toFixed(2)}`,
    });
    newLines.push(() => candleSeries.removePriceLine(line));
  };

  addLevel(ctx.walls.callWall, C.callWall, 'CALL WALL', 2, LineStyle.Solid);
  addLevel(ctx.walls.putWall,  C.putWall,  'PUT WALL',   2, LineStyle.Solid);

  if (ctx.upTarget !== ctx.walls.callWall) {
    addLevel(ctx.upTarget,   C.callWallSecondary, 'C2',   1, LineStyle.Dashed);
  }
  if (ctx.downTarget !== ctx.walls.putWall) {
    addLevel(ctx.downTarget, C.putWallSecondary,  'P2', 1, LineStyle.Dashed);
  }

  if (ctx.flipLevel !== null) {
    addLevel(ctx.flipLevel, C.flip, 'FLIP', 1, LineStyle.Dashed);
  }

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

function _buildLtwMarkers(markers: ChartSignalMarker[], bucketMs: number): SeriesMarker<Time>[] {
  return markers.map(m => {
    // Snap to the start of the candle the signal fired in.
    //
    // lightweight-charts resolves a marker time that is not itself a
    // time-scale point with a LOWER BOUND — the first point at or AFTER it
    // (timeToIndex(time, true) in the markers plugin). So a 10:31 signal on a
    // 5m chart was drawn on the 10:35 candle, and at 1D a 14:00 signal on the
    // 8th was drawn on the 9th. This used to be hidden: the VWAP line carried
    // a point for every minute, so 10:31 WAS a time-scale point and resolved
    // exactly. Aligning VWAP to candle times (_alignSeriesToBars, 2026-09-09)
    // removed those points and exposed it. Snapping here makes placement
    // correct by construction, independent of whatever other series exist.
    const time   = (Math.floor(m.tCT / bucketMs) * bucketMs / 1000) as UTCTimestamp;
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

// Tick mark formatter for the CVD/aggressor sub-panels (separate chart
// instances — see this file's header comment on panel structure).
// `timeAsSeconds` is a CT pseudo-UTC epoch (same convention as the price
// panel's own tickMarkFormatter above) — read with UTC methods only, never
// re-converted through toCentralTime(). See that formatter's comment for
// the real double-conversion bug this shape previously had.
/**
 * Are two tCT values in the same Central-time calendar day?
 *
 * tCT is a CT pseudo-epoch — a real UTC epoch already shifted by the CT
 * offset at construction — so it must be read back with UTC methods only,
 * exactly as the tickMarkFormatter and formatChartTime already do. Passing
 * it through toCentralTime() again would apply the offset a second time
 * (the real 2026-09-04 double-conversion bug).
 */
function _isSameCTDay(aTCT: number, bTCT: number): boolean {
  const a = new Date(aTCT), b = new Date(bTCT);
  return a.getUTCFullYear() === b.getUTCFullYear()
      && a.getUTCMonth()    === b.getUTCMonth()
      && a.getUTCDate()     === b.getUTCDate();
}

/** "09/08" — CT calendar date of a tCT pseudo-epoch. Matches the axis's own
 *  day-boundary format so the legend and the x-axis agree. */
function _formatChartDate(tCT: number): string {
  const d = new Date(tCT);
  return `${String(d.getUTCMonth() + 1).padStart(2, '0')}/${String(d.getUTCDate()).padStart(2, '0')}`;
}

export function formatChartTime(timeAsSeconds: UTCTimestamp): string {
  const d = new Date(timeAsSeconds * 1000);
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
}

/**
 * One label/value pair in the live legend. A null value renders as an em
 * dash, never as 0 or a blank — "this overlay has no value on this bar"
 * (EMA55 before its seeding period, VWAP on a bar with no 1-minute data) is
 * real information and must not read as a real number.
 */
function LegendItem({ label, value, color }: { label: string; value: number | null; color: string }) {
  return (
    <span>
      <span style={{ color: C.textMuted }}>{label} </span>
      <span style={{ color, fontWeight: 600 }}>
        {value === null ? '—' : value.toFixed(2)}
      </span>
    </span>
  );
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
