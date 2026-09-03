/**
 * BrainCockpit — engine history vs your live trading performance.
 *
 * Two clearly-labelled sections:
 *   ENGINE HISTORY — backtested base rates per setup fingerprint (brainStore)
 *   YOUR TRADES    — live signals from the signals / signal_outcomes DB tables
 *
 * Additional panels:
 *   - Execution quality: live win rate vs engine base rate per setup
 *   - MAE analysis: stop-loss calibration from live outcomes
 *   - Ticker leaderboard: SELECT from ticker_win_rates DB view
 *   - Pattern insights: auto-generated weekly observations
 *
 * Zero additional API calls beyond the supabase reads already in brainStore.
 */

import { useState, useEffect, useCallback } from 'react';
import * as brainStore          from '../ledger/brainStore';
import { supabase }             from '../lib/supabase';
import {
  getDirectionState,
  subscribe as subscribeDirection,
} from '../state/directionState';
import { toCentralTime }        from '../lib/time';
import type { BaseRate }        from '../ledger/brainStore';

// ── Types ──────────────────────────────────────────────────────────────────────

interface LiveSignalRow {
  id:          string;
  ticker:      string;
  direction:   'call' | 'put';
  conviction:  number;
  entry_price: number;
  entry_tct:   number;
  status:      string;
  factors: {
    gexRegime: string | null;
  };
}

interface LiveOutcomeRow {
  signal_id: string;
  window_ms: number;
  pnl_pct:   number;
  result:    'win' | 'loss' | 'scratch';
  mae_pct?:  number | null;
}

interface TickerWinRateRow {
  ticker:        string;
  total_signals: number;
  win_rate_pct:  number;
  avg_pnl_pct:   number;
}

interface PatternInsight {
  label:       string;
  observation: string;
  strength:    'strong' | 'moderate' | 'weak';
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function _pct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

function _formatPnl(n: number): string {
  const sign = n >= 0 ? '+' : '';
  return `${sign}${(n * 100).toFixed(2)}%`;
}

function _formatDate(ctMs: number): string {
  const ct  = toCentralTime(ctMs);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${ct.year}-${pad(ct.month)}-${pad(ct.day)}`;
}

function _winRateColor(wr: number): string {
  if (wr >= 0.65) return 'text-col-g';
  if (wr >= 0.50) return 'text-amb';
  return 'text-col-r';
}

function _pnlColor(pnl: number): string {
  if (pnl > 0)  return 'text-col-g';
  if (pnl < 0)  return 'text-col-r';
  return 'text-white/40';
}

/** Build auto-generated pattern insights from live outcomes. */
function _buildInsights(
  signals:  LiveSignalRow[],
  outcomes: LiveOutcomeRow[],
): PatternInsight[] {
  const insights: PatternInsight[] = [];
  if (signals.length < 5) return insights;

  // Group outcomes by window
  const outcomeMap = new Map<string, LiveOutcomeRow[]>();
  for (const o of outcomes) {
    const list = outcomeMap.get(o.signal_id) ?? [];
    list.push(o);
    outcomeMap.set(o.signal_id, list);
  }

  // Time-of-day win rates
  const buckets: Record<string, { wins: number; total: number }> = {
    open:   { wins: 0, total: 0 },
    midday: { wins: 0, total: 0 },
    close:  { wins: 0, total: 0 },
  };

  for (const sig of signals) {
    const ct   = toCentralTime(sig.entry_tct);
    const mins = ct.hour * 60 + ct.minute;
    const bucket = mins < 630 ? 'open' : mins < 840 ? 'midday' : 'close';

    const sigOutcomes = outcomeMap.get(sig.id) ?? [];
    for (const o of sigOutcomes) {
      buckets[bucket].total++;
      if (o.result === 'win') buckets[bucket].wins++;
    }
  }

  for (const [bucket, data] of Object.entries(buckets)) {
    if (data.total < 3) continue;
    const wr = data.wins / data.total;
    const label = bucket === 'open' ? '9:30–10:30 CT' : bucket === 'midday' ? '10:30–14:00 CT' : '14:00–16:00 CT';
    insights.push({
      label:       `${label} window`,
      observation: `${data.total} signals · win rate ${_pct(wr)}`,
      strength:    wr >= 0.65 ? 'strong' : wr >= 0.50 ? 'moderate' : 'weak',
    });
  }

  // Trade count vs loss rate
  const resolved = signals.filter(s => s.status === 'resolved');
  const totalOutcomes = outcomes.length;
  const totalWins     = outcomes.filter(o => o.result === 'win').length;
  if (totalOutcomes >= 10) {
    const lossRate = 1 - (totalWins / totalOutcomes);
    if (lossRate > 0.6) {
      insights.push({
        label:       'High loss rate detected',
        observation: `${_pct(lossRate)} loss rate across ${resolved.length} resolved trades. Review entry timing.`,
        strength:    'weak',
      });
    }
  }

  return insights;
}

// ── Sub-components ─────────────────────────────────────────────────────────────

function HeaderBar() {
  const tickers = ['SPY', 'QQQ', 'IWM'];
  return (
    <div className="sticky top-0 z-20 bg-void border-b" style={{ borderColor: 'var(--line)' }}>
      <div className="flex items-center gap-4 px-4 py-2 flex-wrap">
        <span className="text-xs text-mut uppercase tracking-wider font-bold">BRAIN</span>
        {tickers.map(t => {
          const ds = getDirectionState(t);
          if (!ds) return null;
          const bc = ds.sessionBias === 'bullish'
            ? 'bg-col-g/15 text-col-g border-col-g/30'
            : ds.sessionBias === 'bearish'
            ? 'bg-col-r/15 text-col-r border-col-r/30'
            : 'bg-white/5 text-white/40 border-white/10';
          const pc = ds.playDirection === 'calls'
            ? 'bg-col-g/15 text-col-g border-col-g/30'
            : ds.playDirection === 'puts'
            ? 'bg-col-r/15 text-col-r border-col-r/30'
            : 'bg-white/5 text-white/40 border-white/10';
          return (
            <div key={t} className="flex items-center gap-1">
              <span className="text-xs text-mut font-mono">{t}</span>
              <span className={`text-[10px] px-1.5 py-0.5 rounded font-bold uppercase border ${bc}`}>{ds.sessionBias}</span>
              <span className={`text-[10px] px-1.5 py-0.5 rounded font-bold uppercase border ${pc}`}>{ds.playDirection}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-3 mb-3">
      <span className="text-[10px] font-bold uppercase tracking-widest text-mut">
        {children}
      </span>
      <div className="flex-1 border-t" style={{ borderColor: 'var(--line)' }} />
    </div>
  );
}

/** Per-window win rate bar chart (horizontal bars) */
function WindowBars({ windowWinRates }: { windowWinRates: Record<string, number> }) {
  const windows = ['5m', '15m', '30m', '60m'];
  return (
    <div className="space-y-1 mt-2">
      {windows.map(w => {
        const wr  = windowWinRates[w];
        if (wr === undefined) return null;
        const pct = Math.round(wr * 100);
        const fill = wr >= 0.65 ? 'bg-col-g' : wr >= 0.50 ? 'bg-amb' : 'bg-col-r';
        return (
          <div key={w} className="flex items-center gap-2">
            <span className="text-[10px] text-mut w-6 shrink-0">{w}</span>
            <div className="flex-1 h-1.5 bg-white/8 rounded-full overflow-hidden">
              <div className={`h-full ${fill} rounded-full`} style={{ width: `${pct}%` }} />
            </div>
            <span className={`text-[10px] w-8 text-right ${_winRateColor(wr)}`}>{pct}%</span>
          </div>
        );
      })}
    </div>
  );
}

/** Engine base rate card (single SetupFingerprint) */
function BaseRateCard({ rate }: { rate: BaseRate }) {
  const [expanded, setExpanded] = useState(false);
  const fp = rate.fingerprint;
  const excluded = !rate.isStatisticallyValid;

  const dirColor   = fp.direction === 'call' ? 'text-col-g' : 'text-col-r';
  const regimeBadge = fp.gexRegime === 'negative'
    ? 'bg-col-r/15 text-col-r border-col-r/30'
    : fp.gexRegime === 'positive'
    ? 'bg-col-g/15 text-col-g border-col-g/30'
    : 'bg-white/5 text-white/40 border-white/10';

  return (
    <div className={`bg-panel border rounded-xl p-4 transition-opacity ${excluded ? 'opacity-40' : ''}`} style={{ borderColor: 'var(--line)' }}>
      <div className="flex items-start justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-mono text-sm font-bold text-ink">{fp.ticker}</span>
          <span className={`text-xs font-bold uppercase ${dirColor}`}>{fp.direction}</span>
          <span className={`text-[10px] px-1.5 py-0.5 rounded border ${regimeBadge}`}>
            {fp.gexRegime} GEX
          </span>
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-white/5 border border-white/10 text-mut">
            {fp.timeOfDay}
          </span>
          {excluded && (
            <span className="text-[9px] font-bold uppercase tracking-widest text-white/25 border border-white/10 rounded px-1.5 py-0.5">
              EXCLUDED · n={rate.n}
            </span>
          )}
        </div>

        <div className="flex items-center gap-4">
          {!rate.isStatisticallyValid && (
            <span className="text-[10px] text-amb border border-amb/30 rounded px-1.5 py-0.5">
              n={rate.n} · insuff.
            </span>
          )}
          <button
            onClick={() => setExpanded(e => !e)}
            className="text-mut hover:text-ink transition-colors"
          >
            <svg className={`w-4 h-4 transition-transform ${expanded ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
            </svg>
          </button>
        </div>
      </div>

      {/* Key metrics row */}
      <div className="mt-3 flex gap-6 flex-wrap">
        <div>
          <div className={`text-2xl font-extrabold tabular-nums ${_winRateColor(rate.winRate)}`}>
            {rate.isStatisticallyValid ? _pct(rate.winRate) : '—'}
          </div>
          <div className="text-[10px] text-mut mt-0.5">win rate</div>
        </div>
        <div>
          <div className={`text-lg font-bold tabular-nums ${_pnlColor(rate.avgPnl)}`}>
            {rate.isStatisticallyValid ? _formatPnl(rate.avgPnl) : '—'}
          </div>
          <div className="text-[10px] text-mut mt-0.5">avg P&L</div>
        </div>
        <div>
          <div className="text-lg font-bold text-ink">{rate.n}</div>
          <div className="text-[10px] text-mut mt-0.5">signals</div>
        </div>
        <div>
          <div className="text-lg font-bold text-amb">{rate.bestWindow}</div>
          <div className="text-[10px] text-mut mt-0.5">best window</div>
        </div>
      </div>

      {expanded && (
        <div className="mt-3 border-t pt-3" style={{ borderColor: 'var(--line)' }}>
          <div className="text-[10px] text-mut uppercase mb-1">Win rate by window</div>
          <WindowBars windowWinRates={rate.windowWinRates} />
        </div>
      )}
    </div>
  );
}

/** Compact live trade row */
function LiveTradeRow({
  signal,
  outcomes,
}: {
  signal:   LiveSignalRow;
  outcomes: LiveOutcomeRow[];
}) {
  const [expanded, setExpanded] = useState(false);
  const dirColor = signal.direction === 'call' ? 'text-col-g' : 'text-col-r';

  // Best outcome across windows
  const bestOutcome = outcomes.reduce<LiveOutcomeRow | null>((best, o) => {
    if (!best) return o;
    return o.pnl_pct > best.pnl_pct ? o : best;
  }, null);

  const statusColor = signal.status === 'resolved'
    ? 'text-white/40'
    : signal.status === 'pending'
    ? 'text-amb'
    : 'text-white/20';

  return (
    <div className="bg-panel border rounded-lg px-3 py-2" style={{ borderColor: 'var(--line)' }}>
      <div className="flex items-center gap-2 flex-wrap justify-between">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-mono text-xs font-bold text-ink">{signal.ticker}</span>
          <span className={`text-xs font-bold uppercase ${dirColor}`}>{signal.direction}</span>
          <span className="text-xs text-mut">${signal.entry_price.toFixed(2)}</span>
          <span className="text-[10px] text-dim">{_formatDate(signal.entry_tct)}</span>
        </div>
        <div className="flex items-center gap-2">
          <span className={`text-[10px] font-semibold uppercase ${statusColor}`}>{signal.status}</span>
          {bestOutcome && (
            <span className={`text-xs font-bold tabular-nums ${_pnlColor(bestOutcome.pnl_pct)}`}>
              {_formatPnl(bestOutcome.pnl_pct)}
            </span>
          )}
          {outcomes.length > 0 && (
            <button
              onClick={() => setExpanded(e => !e)}
              className="text-mut hover:text-ink transition-colors"
            >
              <svg className={`w-3.5 h-3.5 transition-transform ${expanded ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
              </svg>
            </button>
          )}
        </div>
      </div>

      {expanded && outcomes.length > 0 && (
        <div className="mt-2 border-t pt-2 space-y-1" style={{ borderColor: 'var(--line)' }}>
          {outcomes.sort((a, b) => a.window_ms - b.window_ms).map((o, i) => {
            const wLabel = o.window_ms >= 3600000 ? '60m'
              : o.window_ms >= 1800000 ? '30m'
              : o.window_ms >= 900000  ? '15m'
              : '5m';
            return (
              <div key={i} className="flex items-center gap-3 text-[10px]">
                <span className="text-mut w-6">{wLabel}</span>
                <span className={o.result === 'win' ? 'text-col-g' : o.result === 'loss' ? 'text-col-r' : 'text-white/40'}>
                  {o.result.toUpperCase()}
                </span>
                <span className={`tabular-nums ${_pnlColor(o.pnl_pct)}`}>{_formatPnl(o.pnl_pct)}</span>
                {o.mae_pct != null && (
                  <span className="text-col-r tabular-nums">MAE {_formatPnl(o.mae_pct)}</span>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** Execution quality comparison row */
function ExecQualityRow({
  ticker,
  liveWr,
  liveN,
  engineWr,
  engineN,
}: {
  ticker:   string;
  liveWr:   number;
  liveN:    number;
  engineWr: number;
  engineN:  number;
}) {
  const delta = liveWr - engineWr;
  const deltaColor = delta >= 0 ? 'text-col-g' : 'text-col-r';
  const sign = delta >= 0 ? '+' : '';

  return (
    <div className="flex items-center gap-3 py-1.5 border-b last:border-0 flex-wrap" style={{ borderColor: 'var(--line)' }}>
      <span className="font-mono text-xs font-bold text-ink w-12 shrink-0">{ticker}</span>
      <div className="flex gap-4 text-xs flex-wrap">
        <span>
          <span className="text-mut">Live </span>
          <span className={`font-bold ${_winRateColor(liveWr)}`}>{_pct(liveWr)}</span>
          <span className="text-dim ml-1">n={liveN}</span>
        </span>
        <span>
          <span className="text-mut">Engine </span>
          <span className="font-bold text-ink/70">{_pct(engineWr)}</span>
          <span className="text-dim ml-1">n={engineN}</span>
        </span>
        <span className={`font-bold ${deltaColor}`}>
          {sign}{(delta * 100).toFixed(1)}pp
        </span>
      </div>
    </div>
  );
}

/** MAE panel — stop calibration guidance */
function MaePanel({ outcomes }: { outcomes: LiveOutcomeRow[] }) {
  const maeValues = outcomes
    .filter(o => o.mae_pct != null && o.mae_pct !== 0)
    .map(o => Math.abs(o.mae_pct!));

  if (maeValues.length < 3) {
    return (
      <div className="text-xs text-dim py-2">
        Need at least 3 resolved trades with MAE data for stop calibration.
      </div>
    );
  }

  maeValues.sort((a, b) => a - b);
  const p50 = maeValues[Math.floor(maeValues.length * 0.50)];
  const p75 = maeValues[Math.floor(maeValues.length * 0.75)];
  const p90 = maeValues[Math.floor(maeValues.length * 0.90)];

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-3 gap-3">
        {[
          { label: 'p50 MAE', value: p50, note: 'Tight stop' },
          { label: 'p75 MAE', value: p75, note: 'Moderate stop' },
          { label: 'p90 MAE', value: p90, note: 'Wide stop' },
        ].map(({ label, value, note }) => (
          <div key={label} className="bg-panel2 rounded-lg px-3 py-2">
            <div className="text-col-r text-lg font-extrabold tabular-nums">
              {(value * 100).toFixed(2)}%
            </div>
            <div className="text-[10px] text-mut mt-0.5">{label}</div>
            <div className="text-[10px] text-dim">{note}</div>
          </div>
        ))}
      </div>
      <p className="text-[10px] text-mut">
        Based on {maeValues.length} resolved outcomes. Set your hard stop at p75 MAE ({(p75 * 100).toFixed(2)}%) to avoid the typical adverse excursion while staying in winning trades.
      </p>
    </div>
  );
}

/** Ticker win rate leaderboard from DB view */
function TickerLeaderboard({ rows }: { rows: TickerWinRateRow[] }) {
  if (rows.length === 0) {
    return <div className="text-xs text-dim py-2">No ticker win rate data yet.</div>;
  }

  const sorted = [...rows].sort((a, b) => b.win_rate_pct - a.win_rate_pct);

  return (
    <div className="space-y-0">
      {sorted.map((row, i) => (
        <div
          key={row.ticker}
          className="flex items-center gap-3 py-2 border-b last:border-0"
          style={{ borderColor: 'var(--line)' }}
        >
          <span className="text-[10px] text-dim w-4 shrink-0">{i + 1}</span>
          <span className="font-mono text-xs font-bold text-ink w-14 shrink-0">{row.ticker}</span>
          <div className="flex-1 h-1.5 bg-white/8 rounded-full overflow-hidden">
            <div
              className={`h-full rounded-full ${row.win_rate_pct >= 0.65 ? 'bg-col-g' : row.win_rate_pct >= 0.50 ? 'bg-amb' : 'bg-col-r'}`}
              style={{ width: `${Math.round(row.win_rate_pct * 100)}%` }}
            />
          </div>
          <span className={`text-xs font-bold tabular-nums w-12 text-right ${_winRateColor(row.win_rate_pct)}`}>
            {_pct(row.win_rate_pct)}
          </span>
          <span className="text-[10px] text-mut w-8 text-right">n={row.total_signals}</span>
          <span className={`text-[10px] tabular-nums w-14 text-right ${_pnlColor(row.avg_pnl_pct)}`}>
            {_formatPnl(row.avg_pnl_pct)}
          </span>
        </div>
      ))}
    </div>
  );
}

function PatternInsightCard({ insight }: { insight: PatternInsight }) {
  const color = insight.strength === 'strong'
    ? 'border-col-g/30 bg-col-g/8'
    : insight.strength === 'moderate'
    ? 'border-amb/30 bg-amb/8'
    : 'border-col-r/20 bg-col-r/8';

  return (
    <div className={`border rounded-lg px-3 py-2 ${color}`}>
      <div className="text-xs font-semibold text-ink">{insight.label}</div>
      <div className="text-xs text-mut mt-0.5">{insight.observation}</div>
    </div>
  );
}

// ── Main Component ─────────────────────────────────────────────────────────────

export default function BrainCockpit() {
  const [baseRates,    setBaseRates]    = useState<BaseRate[]>([]);
  const [brainStatus,  setBrainStatus]  = useState<'loading' | 'ready' | 'error'>('loading');
  const [brainError,   setBrainError]   = useState('');

  const [liveSignals,  setLiveSignals]  = useState<LiveSignalRow[]>([]);
  const [liveOutcomes, setLiveOutcomes] = useState<LiveOutcomeRow[]>([]);
  const [leaderboard,  setLeaderboard]  = useState<TickerWinRateRow[]>([]);
  const [dbLoading,    setDbLoading]    = useState(true);

  const [activeTab,    setActiveTab]    = useState<'engine' | 'trades' | 'exec' | 'mae' | 'board' | 'insights'>('engine');
  const [, forceRender]                = useState(0);

  // ── Brain store refresh ──
  const refreshBrain = useCallback(() => {
    const res = brainStore.getAllBaseRates();
    if (res.status === 'ready') {
      setBaseRates(res.data); // show all — invalid ones are dimmed in BaseRateCard
      setBrainStatus('ready');
    } else if (res.status === 'error') {
      setBrainError(res.reason);
      setBrainStatus('error');
    } else {
      setBrainStatus('loading');
    }
  }, []);

  // ── DB fetch for live signals + outcomes + leaderboard ──
  const fetchLiveData = useCallback(async () => {
    setDbLoading(true);
    try {
      const { data: sigs } = await supabase
        .from('signals')
        .select('id, ticker, direction, conviction, entry_price, entry_tct, status, factors')
        .order('entry_tct', { ascending: false })
        .limit(200);

      const { data: outs } = await supabase
        .from('signal_outcomes')
        .select('signal_id, window_ms, pnl_pct, result, mae_pct')
        .limit(1000);

      const { data: board } = await supabase
        .from('ticker_win_rates')
        .select('ticker, total_signals, win_rate_pct, avg_pnl_pct');

      setLiveSignals((sigs ?? []) as LiveSignalRow[]);
      setLiveOutcomes((outs ?? []) as LiveOutcomeRow[]);
      setLeaderboard((board ?? []) as TickerWinRateRow[]);
    } catch (e) {
      console.error('[BrainCockpit] DB fetch failed:', e);
    } finally {
      setDbLoading(false);
    }
  }, []);

  useEffect(() => {
    void brainStore.refreshBrainStore();
    void fetchLiveData();

    const unsubBrain = brainStore.subscribe(refreshBrain);
    const unsubDir   = subscribeDirection(() => forceRender(n => n + 1));

    refreshBrain();

    const interval = setInterval(() => {
      void brainStore.refreshBrainStore();
      void fetchLiveData();
    }, 5 * 60 * 1000);

    return () => {
      unsubBrain();
      unsubDir();
      clearInterval(interval);
    };
  }, [refreshBrain, fetchLiveData]);

  // ── Execution quality computation ──
  const outcomesBySignal = new Map<string, LiveOutcomeRow[]>();
  for (const o of liveOutcomes) {
    const list = outcomesBySignal.get(o.signal_id) ?? [];
    list.push(o);
    outcomesBySignal.set(o.signal_id, list);
  }

  // Live win rate per ticker
  interface TickerLiveStat { wins: number; total: number }
  const liveByTicker = new Map<string, TickerLiveStat>();
  for (const sig of liveSignals) {
    if (sig.status !== 'resolved') continue;
    const outs = outcomesBySignal.get(sig.id) ?? [];
    for (const o of outs) {
      const stat = liveByTicker.get(sig.ticker) ?? { wins: 0, total: 0 };
      stat.total++;
      if (o.result === 'win') stat.wins++;
      liveByTicker.set(sig.ticker, stat);
    }
  }

  // Match against engine base rates for exec quality rows
  const execRows: Array<{
    ticker: string;
    liveWr: number; liveN: number;
    engineWr: number; engineN: number;
  }> = [];

  for (const [ticker, stat] of liveByTicker) {
    const engineRates = baseRates.filter(r => r.fingerprint.ticker === ticker);
    if (engineRates.length === 0) continue;
    const avgEngineWr = engineRates.reduce((s, r) => s + r.winRate, 0) / engineRates.length;
    const totalEngineN = engineRates.reduce((s, r) => s + r.n, 0);
    execRows.push({
      ticker,
      liveWr: stat.wins / stat.total,
      liveN: stat.total,
      engineWr: avgEngineWr,
      engineN: totalEngineN,
    });
  }

  const insights = _buildInsights(liveSignals, liveOutcomes);
  const resolvedOutcomes = liveOutcomes.filter(o =>
    liveSignals.find(s => s.id === o.signal_id && s.status === 'resolved')
  );

  const tabs: { id: typeof activeTab; label: string }[] = [
    { id: 'engine',   label: 'Engine History' },
    { id: 'trades',   label: 'Your Trades'    },
    { id: 'exec',     label: 'Exec Quality'   },
    { id: 'mae',      label: 'MAE / Stops'    },
    { id: 'board',    label: 'Leaderboard'    },
    { id: 'insights', label: 'Insights'       },
  ];

  return (
    <div className="flex flex-col min-h-screen bg-void text-ink font-mono">
      <HeaderBar />

      <div className="flex-1 max-w-5xl w-full mx-auto px-4 py-4 space-y-4">

        {/* Tab bar */}
        <section id="brain-tabs">
          <div className="flex gap-1 overflow-x-auto scrollbar-none pb-1">
            {tabs.map(tab => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`flex-shrink-0 px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors ${
                  activeTab === tab.id
                    ? 'bg-amb text-void'
                    : 'bg-white/5 text-mut hover:bg-white/8'
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>
        </section>

        {/* ── ENGINE HISTORY ── */}
        {activeTab === 'engine' && (
          <section id="engine-history" className="space-y-3">
            <SectionLabel>Engine History — Backtested Base Rates</SectionLabel>

            {brainStatus === 'loading' && (
              <div className="text-center py-10 text-dim text-sm animate-pulse">
                Loading engine base rates...
              </div>
            )}

            {brainStatus === 'error' && (
              <div className="text-center py-6 text-col-r text-sm">
                Failed to load engine data: {brainError}
              </div>
            )}

            {brainStatus === 'ready' && baseRates.length === 0 && (
              <div className="text-center py-12 text-dim text-sm">
                No statistically valid setups yet (need n ≥ 15 per fingerprint).
              </div>
            )}

            {brainStatus === 'ready' && baseRates
              .sort((a, b) => b.winRate - a.winRate)
              .map((rate, i) => (
                <BaseRateCard key={i} rate={rate} />
              ))
            }
          </section>
        )}

        {/* ── YOUR TRADES ── */}
        {activeTab === 'trades' && (
          <section id="your-trades" className="space-y-2">
            <SectionLabel>Your Trades — Live Signal History</SectionLabel>

            {dbLoading && (
              <div className="text-center py-8 text-dim text-sm animate-pulse">
                Loading trades...
              </div>
            )}

            {!dbLoading && liveSignals.length === 0 && (
              <div className="text-center py-12 text-dim text-sm">
                No live signals recorded yet. Signals are logged automatically when confluenceEngine fires.
              </div>
            )}

            {liveSignals.map(sig => (
              <LiveTradeRow
                key={sig.id}
                signal={sig}
                outcomes={outcomesBySignal.get(sig.id) ?? []}
              />
            ))}
          </section>
        )}

        {/* ── EXECUTION QUALITY ── */}
        {activeTab === 'exec' && (
          <section id="exec-quality">
            <SectionLabel>Execution Quality — Live vs Engine</SectionLabel>

            {execRows.length === 0 && (
              <div className="text-center py-10 text-dim text-sm">
                Need resolved live trades that match engine fingerprints to compare.
              </div>
            )}

            <div className="bg-panel border rounded-xl px-4 py-3" style={{ borderColor: 'var(--line)' }}>
              {execRows
                .sort((a, b) => (b.liveWr - b.engineWr) - (a.liveWr - a.engineWr))
                .map(row => (
                  <ExecQualityRow
                    key={row.ticker}
                    ticker={row.ticker}
                    liveWr={row.liveWr}
                    liveN={row.liveN}
                    engineWr={row.engineWr}
                    engineN={row.engineN}
                  />
                ))
              }
            </div>

            {execRows.length > 0 && (
              <p className="text-[10px] text-dim mt-2">
                Positive pp = you are outperforming the backtested base rate for this setup.
                Negative pp = entry timing or discipline is below the engine expectation.
              </p>
            )}
          </section>
        )}

        {/* ── MAE / STOPS ── */}
        {activeTab === 'mae' && (
          <section id="mae-stops">
            <SectionLabel>MAE Analysis — Stop Loss Calibration</SectionLabel>
            <div className="bg-panel border rounded-xl p-4" style={{ borderColor: 'var(--line)' }}>
              <MaePanel outcomes={resolvedOutcomes} />
            </div>
          </section>
        )}

        {/* ── LEADERBOARD ── */}
        {activeTab === 'board' && (
          <section id="ticker-leaderboard">
            <SectionLabel>Ticker Win Rate Leaderboard</SectionLabel>

            {dbLoading ? (
              <div className="text-center py-8 text-dim text-sm animate-pulse">Loading...</div>
            ) : (
              <div className="bg-panel border rounded-xl px-4 py-2" style={{ borderColor: 'var(--line)' }}>
                <TickerLeaderboard rows={leaderboard} />
              </div>
            )}

            <p className="text-[10px] text-dim mt-2">
              Source: ticker_win_rates DB view. Includes all resolved signals.
            </p>
          </section>
        )}

        {/* ── PATTERN INSIGHTS ── */}
        {activeTab === 'insights' && (
          <section id="pattern-insights" className="space-y-2">
            <SectionLabel>Pattern Insights</SectionLabel>

            {insights.length === 0 && (
              <div className="text-center py-10 text-dim text-sm">
                {liveSignals.length < 5
                  ? 'Need at least 5 live signals to generate insights.'
                  : 'No significant patterns detected yet in this dataset.'}
              </div>
            )}

            {insights.map((ins, i) => (
              <PatternInsightCard key={i} insight={ins} />
            ))}

            {insights.length > 0 && (
              <p className="text-[10px] text-dim">
                Auto-generated from live trade history. Updated on each Brain refresh.
              </p>
            )}
          </section>
        )}

      </div>
    </div>
  );
}
