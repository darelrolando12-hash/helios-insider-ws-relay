/**
 * Layer 4 — DashboardCockpit
 *
 * Market-wide overview. One tile per FEED_TICKER showing live GEX regime,
 * CVD skew, direction state, price, and wall distances. A brain leaderboard
 * column shows the top base-rate setups. A halt-alert strip appears whenever
 * any ticker has an active LULD halt.
 *
 * Data reads (zero outbound calls):
 *   barsStore       — live price, candle count
 *   marketStore     — GEX regime, walls, flip, netGex, pcRatio
 *   cvdStore        — callPct, putPct, classification
 *   luldStore       — isCurrentlyHalted
 *   directionState  — sessionBias, playDirection (per-ticker + global badges)
 *   brainStore      — leaderboard of top base-rate setups
 *
 * Layout:
 *   ┌─────────────────────────────────────────────────┐
 *   │  TOP BAR: global direction badges + halt strip  │
 *   ├──────────────────────────┬──────────────────────┤
 *   │  TICKER GRID (23 tiles)  │  BRAIN LEADERBOARD   │
 *   └──────────────────────────┴──────────────────────┘
 *
 * Rules enforced:
 *   - CONTEXT_ONLY_TICKERS never appear in the tile grid
 *   - SPX / NDX tiles carry a CASH SETTLED label
 *   - All three Result<T> states handled per tile and per panel
 *   - sessionBias + playDirection always visible at top
 */

import {
  useCallback,
  useEffect,
  useState,
} from 'react';

import * as barsStore    from '../stores/barsStore';
import * as marketStore  from '../stores/marketStore';
import * as cvdStore     from '../stores/cvdStore';
import * as luldStore    from '../stores/luldStore';
import * as brainStore   from '../ledger/brainStore';
import {
  getAllDirectionStates,
  getDirectionState,
  subscribe as subscribeDirection,
  FEED_TICKERS,
  CONTEXT_ONLY_TICKERS,
  CASH_SETTLED_TICKERS,
  TICKER_BETA_TABLE,
} from '../state/directionState';
import type { MarketContext }  from '../stores/marketStore';
import type { CvdState }       from '../stores/cvdStore';
import type { DirectionState } from '../state/directionState';
import type { BaseRate }       from '../ledger/brainStore';

// ── Local types ────────────────────────────────────────────────────────────────

interface TileData {
  ticker:      string;
  price:       number | null;
  prevClose:   number | null;
  mkt:         MarketContext | null;
  mktStatus:   'loading' | 'ready' | 'error';
  mktError:    string;
  cvd:         CvdState | null;
  cvdStatus:   'loading' | 'ready' | 'error';
  dir:         DirectionState | null;
  isHalted:    boolean | null;
}

// ── Constants ─────────────────────────────────────────────────────────────────

/** Tickers shown in the grid (excludes context-only tickers) */
const GRID_TICKERS = FEED_TICKERS.filter(t => !CONTEXT_ONLY_TICKERS.has(t));

/** Leaderboard — show top N statistically valid setups by win rate */
const LEADERBOARD_SIZE = 10;

// ── Helpers ───────────────────────────────────────────────────────────────────

function _livePriceAndPrev(ticker: string): { price: number | null; prevClose: number | null } {
  const r = barsStore.getResult(ticker);
  if (r.status !== 'ready' || r.data.length === 0) return { price: null, prevClose: null };
  const bars = r.data;
  const price    = bars[bars.length - 1].close;
  const prevClose = bars.length >= 2 ? bars[0].open : null;
  return { price, prevClose };
}

function _buildTile(ticker: string): TileData {
  const { price, prevClose } = _livePriceAndPrev(ticker);

  const mktResult = marketStore.getResult(ticker);
  const mkt       = mktResult.status === 'ready' ? mktResult.data : null;
  const mktStatus = mktResult.status;
  const mktError  = mktResult.status === 'error' ? mktResult.reason : '';

  const cvdResult = cvdStore.getResult(ticker);
  const cvd       = cvdResult.status === 'ready' ? cvdResult.data : null;
  const cvdStatus = cvdResult.status;

  const dir      = getDirectionState(ticker);
  const isHalted = luldStore.isHalted(ticker);

  return {
    ticker, price, prevClose,
    mkt, mktStatus, mktError,
    cvd, cvdStatus,
    dir, isHalted,
  };
}

function _fmtPrice(p: number): string {
  return p >= 1000 ? p.toFixed(0) : p >= 100 ? p.toFixed(2) : p.toFixed(2);
}

function _changePct(price: number, prev: number): number {
  return ((price - prev) / prev) * 100;
}

function _wallDist(price: number, wall: number): string {
  const pct = ((wall - price) / price) * 100;
  return (pct >= 0 ? '+' : '') + pct.toFixed(1) + '%';
}

function _gexColor(regime: MarketContext['gexRegime']): string {
  if (regime === 'positive') return 'text-emerald-400';
  if (regime === 'negative') return 'text-rose-400';
  return 'text-white/40';
}

function _gexBadge(regime: MarketContext['gexRegime']): string {
  if (regime === 'positive') return 'POS GEX';
  if (regime === 'negative') return 'NEG GEX';
  return 'NEUTRAL';
}

const BIAS_STYLE: Record<string, string> = {
  bullish: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/25',
  bearish: 'bg-rose-500/15 text-rose-400 border-rose-500/25',
  neutral: 'bg-white/8 text-white/40 border-white/15',
};

const PLAY_STYLE: Record<string, string> = {
  calls:        'bg-sky-500/15 text-sky-300 border-sky-500/25',
  puts:         'bg-orange-500/15 text-orange-400 border-orange-500/25',
  consolidating:'bg-amber-500/10 text-amber-400/70 border-amber-500/20',
  none:         'bg-white/5 text-white/25 border-white/10',
};

const CVD_STYLE: Record<CvdState['classification'], string> = {
  bullish: 'text-emerald-400',
  bearish: 'text-rose-400',
  neutral: 'text-white/35',
};

// ── Sub-components ────────────────────────────────────────────────────────────

function CashSettledTag({ ticker }: { ticker: string }) {
  if (!CASH_SETTLED_TICKERS.has(ticker)) return null;
  return (
    <span className="px-1 py-px text-[8px] font-bold tracking-wider rounded
      bg-amber-500/20 text-amber-300 border border-amber-500/30 uppercase leading-none">
      CASH SETTLED
    </span>
  );
}

/** Single ticker tile — the core unit of the dashboard grid */
function TickerTile({ data, onClick }: { data: TileData; onClick: (ticker: string) => void }) {
  const { ticker, price, prevClose, mkt, mktStatus, mktError, cvd, dir, isHalted } = data;

  const changePct = price != null && prevClose != null ? _changePct(price, prevClose) : null;
  const isUp      = changePct != null ? changePct >= 0 : null;

  const betaInfo = TICKER_BETA_TABLE[ticker];

  return (
    <button
      onClick={() => onClick(ticker)}
      className={`relative flex flex-col gap-1.5 p-3 rounded-xl border text-left
        transition-all duration-200 w-full group
        ${isHalted
          ? 'border-rose-500/60 bg-rose-500/8 hover:border-rose-400/70'
          : 'border-white/8 bg-white/[0.025] hover:border-white/18 hover:bg-white/[0.04]'
        }`}
    >
      {/* Halt badge */}
      {isHalted && (
        <div className="absolute top-2 right-2 px-1.5 py-0.5 rounded text-[9px] font-bold
          bg-rose-500/30 text-rose-300 border border-rose-500/40 tracking-widest animate-pulse">
          HALTED
        </div>
      )}

      {/* Row 1 — ticker + cash-settled tag */}
      <div className="flex items-center gap-1.5 flex-wrap pr-12">
        <span className="text-sm font-bold text-white tracking-wide leading-none">{ticker}</span>
        <CashSettledTag ticker={ticker} />
        {betaInfo && (
          <span className="text-[9px] text-white/25 leading-none">
            β{betaInfo.beta}
          </span>
        )}
      </div>

      {/* Row 2 — price + change */}
      <div className="flex items-baseline gap-1.5">
        {price != null ? (
          <>
            <span className="text-base font-bold text-white tabular-nums leading-none">
              ${_fmtPrice(price)}
            </span>
            {changePct != null && (
              <span className={`text-[10px] font-semibold tabular-nums ${
                isUp ? 'text-emerald-400' : 'text-rose-400'
              }`}>
                {isUp ? '+' : ''}{changePct.toFixed(2)}%
              </span>
            )}
          </>
        ) : (
          <span className="text-xs text-white/20 italic">loading…</span>
        )}
      </div>

      {/* Row 3 — GEX regime + CVD */}
      <div className="flex items-center gap-2">
        {mktStatus === 'loading' && (
          <span className="text-[10px] text-white/20 italic">GEX…</span>
        )}
        {mktStatus === 'error' && (
          <span className="text-[10px] text-rose-400/60 truncate" title={mktError}>
            GEX stale
          </span>
        )}
        {mkt && (
          <span className={`text-[10px] font-bold ${_gexColor(mkt.gexRegime)}`}>
            {_gexBadge(mkt.gexRegime)}
          </span>
        )}
        {cvd && (
          <span className={`text-[10px] font-semibold ${CVD_STYLE[cvd.classification]}`}>
            CVD {cvd.callPct.toFixed(0)}%↑
          </span>
        )}
        {!cvd && (
          <span className="text-[10px] text-white/15 italic">cvd…</span>
        )}
      </div>

      {/* Row 4 — walls distance */}
      {mkt != null && price != null && (
        <div className="flex items-center gap-2 text-[10px]">
          <span className="text-emerald-400/70">
            C {_wallDist(price, mkt.walls.callWall)}
          </span>
          <span className="text-white/20">·</span>
          <span className="text-rose-400/70">
            P {_wallDist(price, mkt.walls.putWall)}
          </span>
          <span className="text-white/20">·</span>
          <span className="text-white/30">
            Flip ${mkt.flipLevel.toFixed(0)}
          </span>
        </div>
      )}

      {/* Row 5 — direction state */}
      {dir && (
        <div className="flex items-center gap-1.5 flex-wrap">
          <span className={`px-1.5 py-px rounded border text-[9px] font-bold
            tracking-wide leading-none ${BIAS_STYLE[dir.sessionBias]}`}>
            {dir.sessionBias.toUpperCase()}
          </span>
          <span className={`px-1.5 py-px rounded border text-[9px] font-bold
            tracking-wide leading-none ${PLAY_STYLE[dir.playDirection]}`}>
            {dir.playDirection.toUpperCase()}
          </span>
        </div>
      )}
    </button>
  );
}

/** Skeleton tile shown while initial data arrives */
function TileSkeleton() {
  return (
    <div className="rounded-xl border border-white/8 bg-white/[0.02] p-3 animate-pulse">
      <div className="h-3.5 bg-white/10 rounded w-12 mb-2" />
      <div className="h-5 bg-white/8 rounded w-20 mb-2" />
      <div className="h-3 bg-white/5 rounded w-16 mb-1.5" />
      <div className="h-3 bg-white/5 rounded w-24" />
    </div>
  );
}

/** Top bar with global session badges */
function TopBar({ dirStates }: { dirStates: Map<string, DirectionState> }) {
  const states = Array.from(dirStates.values());
  const total   = states.length;
  const bullish = states.filter(s => s.sessionBias === 'bullish').length;
  const bearish = states.filter(s => s.sessionBias === 'bearish').length;
  const callPlay = states.filter(s => s.playDirection === 'calls').length;
  const putPlay  = states.filter(s => s.playDirection === 'puts').length;

  const dominant = bullish > bearish ? 'BULL' : bearish > bullish ? 'BEAR' : 'NEUTRAL';
  const playDom  = callPlay > putPlay ? 'CALLS' : putPlay > callPlay ? 'PUTS' : 'MIXED';

  const biasColor: Record<string, string> = {
    BULL:    'bg-emerald-500/20 text-emerald-300 border-emerald-500/30',
    BEAR:    'bg-rose-500/20 text-rose-300 border-rose-500/30',
    NEUTRAL: 'bg-white/10 text-white/50 border-white/20',
  };
  const playColor: Record<string, string> = {
    CALLS: 'bg-sky-500/20 text-sky-300 border-sky-500/30',
    PUTS:  'bg-orange-500/20 text-orange-300 border-orange-500/30',
    MIXED: 'bg-white/10 text-white/50 border-white/20',
  };

  return (
    <div className="flex items-center gap-2 flex-wrap">
      <span className={`px-2.5 py-0.5 rounded border text-xs font-semibold tracking-wide ${biasColor[dominant]}`}>
        SESSION {dominant} {total > 0 ? `(${bullish}/${total})` : ''}
      </span>
      <span className={`px-2.5 py-0.5 rounded border text-xs font-semibold tracking-wide ${playColor[playDom]}`}>
        PLAY {playDom} {total > 0 ? `(${Math.max(callPlay, putPlay)}/${total})` : ''}
      </span>
      {total === 0 && (
        <span className="text-xs text-white/25 italic">Awaiting direction data…</span>
      )}
    </div>
  );
}

/** Halt alert strip — only shown when at least one ticker is halted */
function HaltStrip({ tiles }: { tiles: TileData[] }) {
  const halted = tiles.filter(t => t.isHalted === true);
  if (halted.length === 0) return null;
  return (
    <div className="flex items-center gap-2 px-4 py-2 bg-rose-500/12
      border border-rose-500/30 rounded-lg animate-pulse">
      <span className="text-[10px] font-bold text-rose-400 tracking-widest">HALT ALERT</span>
      <span className="text-[10px] text-rose-300/80">
        {halted.map(t => t.ticker).join(', ')} — trading suspended
      </span>
    </div>
  );
}

/** Brain leaderboard — top statistically valid setups by win rate */
function BrainLeaderboard({ rates }: { rates: BaseRate[] }) {
  if (rates.length === 0) {
    return (
      <div className="text-[11px] text-white/20 italic pt-2">
        No statistically valid setups yet (need n≥15)
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1.5">
      {rates.map((rate, i) => {
        const fp        = rate.fingerprint;
        const winPct    = (rate.winRate * 100).toFixed(0);
        const isCall    = fp.direction === 'call';
        const winColor  = rate.winRate >= 0.65 ? 'text-emerald-400'
                        : rate.winRate >= 0.5  ? 'text-amber-400'
                        : 'text-rose-400';

        return (
          <div key={i}
            className="flex items-center gap-2 px-2.5 py-1.5 rounded-lg border
              border-white/8 bg-white/[0.02] hover:border-white/15 transition-colors">

            {/* Rank */}
            <span className="text-[10px] text-white/20 tabular-nums w-4 flex-shrink-0">
              {i + 1}
            </span>

            {/* Ticker + direction */}
            <div className="flex items-center gap-1 flex-1 min-w-0">
              <span className="text-[11px] font-bold text-white">{fp.ticker}</span>
              <span className={`text-[9px] font-bold px-1 py-px rounded
                ${isCall
                  ? 'bg-sky-500/15 text-sky-300 border border-sky-500/25'
                  : 'bg-orange-500/15 text-orange-300 border border-orange-500/25'
                }`}>
                {fp.direction.toUpperCase()}
              </span>
              <span className="text-[9px] text-white/25 truncate">
                {fp.gexRegime} · {fp.timeOfDay}
              </span>
            </div>

            {/* Win rate + n */}
            <div className="flex items-baseline gap-1 flex-shrink-0">
              <span className={`text-xs font-bold tabular-nums ${winColor}`}>{winPct}%</span>
              <span className="text-[9px] text-white/25">({rate.n}n)</span>
            </div>

            {/* Best window */}
            <span className="text-[9px] text-white/30 flex-shrink-0">{rate.bestWindow}</span>
          </div>
        );
      })}
    </div>
  );
}

/** Section header used in the leaderboard column */
function SectionHeader({ title, count }: { title: string; count?: number }) {
  return (
    <div className="flex items-center gap-2 mb-3">
      <span className="text-xs font-bold tracking-widest text-white/50 uppercase">{title}</span>
      {count != null && (
        <span className="text-xs text-white/25 tabular-nums">({count})</span>
      )}
    </div>
  );
}

// ── Main cockpit ───────────────────────────────────────────────────────────────

export default function DashboardCockpit() {
  const [tiles, setTiles]           = useState<TileData[]>([]);
  const [dirStates, setDirStates]   = useState<Map<string, DirectionState>>(new Map());
  const [leaderboard, setLeaderboard] = useState<BaseRate[]>([]);
  const [brainStatus, setBrainStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [brainError, setBrainError]   = useState('');
  const [initialising, setInitialising] = useState(true);

  // ── Rebuild all tile data from stores ────────────────────────────────────────
  const rebuildTiles = useCallback(() => {
    setTiles(GRID_TICKERS.map(_buildTile));
  }, []);

  // ── Rebuild brain leaderboard ─────────────────────────────────────────────────
  const rebuildLeaderboard = useCallback(() => {
    const r = brainStore.getAllBaseRates();
    if (r.status === 'loading') {
      setBrainStatus('loading');
      return;
    }
    if (r.status === 'error') {
      setBrainStatus('error');
      setBrainError(r.reason);
      return;
    }
    const valid = r.data
      .filter(b => b.isStatisticallyValid)
      .sort((a, b) => b.winRate - a.winRate)
      .slice(0, LEADERBOARD_SIZE);
    setLeaderboard(valid);
    setBrainStatus('ready');
  }, []);

  // ── Mount / unmount ───────────────────────────────────────────────────────────
  useEffect(() => {
    // Seed direction states
    setDirStates(getAllDirectionStates());

    // Subscribe to direction state changes
    const unsubDir = subscribeDirection((ticker, state) => {
      setDirStates(prev => new Map(prev).set(ticker, state));
      rebuildTiles();
    });

    // Subscribe to market + CVD store changes
    const unsubMkt = marketStore.subscribe(rebuildTiles);
    const unsubCvd = cvdStore.subscribe(rebuildTiles);

    // Subscribe to bars changes
    const unsubBars = barsStore.subscribe(rebuildTiles);

    // Subscribe to LULD changes
    const unsubLuld = luldStore.subscribe(rebuildTiles);

    // Subscribe to brain store
    const unsubBrain = brainStore.subscribe(rebuildLeaderboard);
    brainStore.refreshBrainStore().catch(e => {
      setBrainStatus('error');
      setBrainError(String(e));
    });

    // Initial tile build
    rebuildTiles();
    rebuildLeaderboard();
    setInitialising(false);

    return () => {
      unsubDir();
      unsubMkt();
      unsubCvd();
      unsubBars();
      unsubLuld();
      unsubBrain();
    };
  }, [rebuildTiles, rebuildLeaderboard]);

  // Keep dirStates in sync with tiles (direction state badge in top bar)
  useEffect(() => {
    const unsub = subscribeDirection((ticker, state) => {
      setDirStates(prev => new Map(prev).set(ticker, state));
    });
    return unsub;
  }, []);

  // ── Render ────────────────────────────────────────────────────────────────────
  return (
    <section id="dashboard" className="min-h-screen bg-[#0a0b0e] text-white flex flex-col">

      {/* ── Top bar ─────────────────────────────────────────────────────────── */}
      <div className="sticky top-0 z-20 bg-[#0c0d10] border-b border-white/8 px-5 py-3
        flex flex-col gap-2">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-3">
            <span className="text-xs font-bold tracking-[0.2em] text-white/50 uppercase">
              Dashboard
            </span>
            <span className="w-px h-3 bg-white/15" />
            <TopBar dirStates={dirStates} />
          </div>
          <span className="text-[10px] text-white/20 tabular-nums">
            {GRID_TICKERS.length} tickers
          </span>
        </div>

        {/* Halt alert strip — conditionally rendered */}
        {tiles.some(t => t.isHalted === true) && (
          <HaltStrip tiles={tiles} />
        )}
      </div>

      {/* ── Main body ───────────────────────────────────────────────────────── */}
      <div className="flex-1 flex gap-0 min-h-0 overflow-hidden">

        {/* ── Ticker grid ───────────────────────────────────────────────────── */}
        <div className="flex-1 overflow-y-auto px-5 py-4 dashboard-grid-scroll">
          {initialising ? (
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-2.5">
              {GRID_TICKERS.map(t => <TileSkeleton key={t} />)}
            </div>
          ) : (
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-2.5">
              {tiles.map(tile => (
                <TickerTile
                  key={tile.ticker}
                  data={tile}
                  onClick={ticker => {
                    // Navigate to ZeroDteCockpit when it exists — no-op for now
                    console.debug('[DashboardCockpit] tile click:', ticker);
                  }}
                />
              ))}
            </div>
          )}
        </div>

        {/* ── Brain leaderboard sidebar ─────────────────────────────────────── */}
        <div className="w-72 flex-shrink-0 border-l border-white/8 bg-[#0c0d10]
          overflow-y-auto px-4 py-4 dashboard-sidebar-scroll hidden lg:block">
          <SectionHeader title="Brain Leaderboard" />

          {brainStatus === 'loading' && (
            <div className="flex flex-col gap-1.5">
              {[0,1,2,3,4].map(i => (
                <div key={i}
                  className="h-9 rounded-lg bg-white/5 border border-white/8 animate-pulse" />
              ))}
            </div>
          )}

          {brainStatus === 'error' && (
            <div className="rounded-lg border border-rose-500/30 bg-rose-500/8
              px-3 py-2 text-rose-300 text-[11px]">
              Brain error: {brainError}
            </div>
          )}

          {brainStatus === 'ready' && (
            <BrainLeaderboard rates={leaderboard} />
          )}

          {/* Per-ticker direction summary */}
          <div className="mt-6">
            <SectionHeader title="Direction Summary" count={GRID_TICKERS.length} />
            <div className="flex flex-col gap-1">
              {tiles.map(tile => {
                const dir = tile.dir;
                if (!dir) return null;
                return (
                  <div key={tile.ticker}
                    className="flex items-center gap-2 px-2 py-1 rounded
                      hover:bg-white/5 transition-colors duration-150">
                    <span className="text-[11px] font-bold text-white w-12 flex-shrink-0">
                      {tile.ticker}
                    </span>
                    <span className={`text-[9px] font-bold px-1 py-px rounded border
                      leading-none flex-shrink-0 ${BIAS_STYLE[dir.sessionBias]}`}>
                      {dir.sessionBias.slice(0, 4).toUpperCase()}
                    </span>
                    <span className={`text-[9px] font-bold px-1 py-px rounded border
                      leading-none truncate ${PLAY_STYLE[dir.playDirection]}`}>
                      {dir.playDirection.toUpperCase()}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
