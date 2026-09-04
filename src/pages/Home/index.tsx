import { useState, useEffect, useCallback, useRef } from 'react';
import React from 'react';
import ZeroDteCockpit    from '@/cockpits/ZeroDteCockpit';
import ChainCockpit      from '@/cockpits/ChainCockpit';
import BestContractsCockpit from '@/cockpits/BestContractsCockpit';
import InsidersCockpit   from '@/cockpits/InsidersCockpit';
import NewsCockpit       from '@/cockpits/NewsCockpit';
import BrainCockpit      from '@/cockpits/BrainCockpit';
import SwingCockpit      from '@/cockpits/SwingCockpit';
import IndexesCockpit    from '@/cockpits/IndexesCockpit';
import ScannerCockpit    from '@/cockpits/ScannerCockpit';
import DashboardCockpit  from '@/cockpits/DashboardCockpit';
import { HeliosChart, type ChartSignalMarker } from '@/components/HeliosChart';
import { ErrorBoundary }     from '@/components/ErrorBoundary';
import { supabase }      from '@/lib/supabase';
import { massiveBus }    from '@/lib/massive/websocket';
import * as barsStore    from '@/stores/barsStore';
import { isFeedScheduleActive } from '@/lib/time';
import { fetchChartSignalMarkers } from '@/lib/chartSignals';
import { computeChartBackfillWindow } from '@/lib/chartWindow';
import type { Result } from '@/stores/types';

// ── Session ID — client-generated UUID, persisted in localStorage ─────────────
// Security model: obscurity-based, not cryptographic. RLS scopes rows to this ID.
// Anyone with the UUID in devtools can read/delete this session's watchlist rows.
// Acceptable exposure for a sole-user app with no auth system.
function getSessionId(): string {
  const key = 'helios_session_id';
  let id = localStorage.getItem(key);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(key, id);
  }
  return id;
}

const SESSION_ID = getSessionId();

// ── Screen identifiers ────────────────────────────────────────────────────────
type Screen =
  | 'home'      // Dashboard / opportunity overview
  | 'chain'     // Options chain
  | 'best'      // Best contracts ranked
  | 'cockpit'   // 0DTE live trading floor
  | 'insiders'  // Form 4 insider flow
  | 'news'      // News feed
  | 'chart'     // HeliosChart for a selected ticker
  | 'brain'     // Base rates + trade quality
  | 'swing'     // Multi-day swing evaluator
  | 'indexes'   // Macro context (SPY/QQQ/IWM/VIX)
  | 'scanner'   // Signal scanner
  | 'more';     // Overflow screen

// ── Bottom nav definition ─────────────────────────────────────────────────────
interface NavItem {
  id: Screen;
  label: string;
  icon: (active: boolean) => React.ReactNode;
}

const NAV_ITEMS: NavItem[] = [
  {
    id: 'home',
    label: 'Home',
    icon: (a) => (
      <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
        <path d="M3 8.5L10 3l7 5.5V17a1 1 0 01-1 1H4a1 1 0 01-1-1V8.5z"
          stroke="currentColor" strokeWidth="1.5"
          fill={a ? 'currentColor' : 'none'} fillOpacity={a ? 0.15 : 0} />
        <path d="M7.5 18V13h5v5" stroke="currentColor" strokeWidth="1.5"
          strokeLinecap="round" />
      </svg>
    ),
  },
  {
    id: 'chain',
    label: 'Chain',
    icon: (a) => (
      <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
        <rect x="2" y="4" width="16" height="2.5" rx="1"
          fill={a ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.4" fillOpacity={0.2} />
        <rect x="2" y="8.75" width="16" height="2.5" rx="1"
          fill={a ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.4" fillOpacity={0.2} />
        <rect x="2" y="13.5" width="16" height="2.5" rx="1"
          fill={a ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.4" fillOpacity={0.2} />
      </svg>
    ),
  },
  {
    id: 'best',
    label: 'Best',
    icon: (a) => (
      <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
        <path d="M10 2l2.09 4.26L17 7.27l-3.5 3.41.83 4.82L10 13.27l-4.33 2.23.83-4.82L3 7.27l4.91-.71L10 2z"
          stroke="currentColor" strokeWidth="1.4"
          fill={a ? 'currentColor' : 'none'} fillOpacity={a ? 0.2 : 0} />
      </svg>
    ),
  },
  {
    id: 'cockpit',
    label: 'Cockpit',
    icon: (a) => (
      <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
        <circle cx="10" cy="10" r="7" stroke="currentColor" strokeWidth="1.4"
          fill={a ? 'currentColor' : 'none'} fillOpacity={a ? 0.1 : 0} />
        <circle cx="10" cy="10" r="2.5"
          fill={a ? 'currentColor' : 'rgba(255,255,255,0.4)'} />
        <path d="M10 3v2M10 15v2M3 10h2M15 10h2" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      </svg>
    ),
  },
  {
    id: 'insiders',
    label: 'Insiders',
    icon: (a) => (
      <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
        <circle cx="10" cy="7" r="3" stroke="currentColor" strokeWidth="1.4"
          fill={a ? 'currentColor' : 'none'} fillOpacity={a ? 0.15 : 0} />
        <path d="M4 17c0-3.314 2.686-6 6-6s6 2.686 6 6"
          stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      </svg>
    ),
  },
  {
    id: 'news',
    label: 'News',
    icon: (a) => (
      <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
        <rect x="2" y="4" width="16" height="12" rx="1.5"
          stroke="currentColor" strokeWidth="1.4"
          fill={a ? 'currentColor' : 'none'} fillOpacity={a ? 0.1 : 0} />
        <path d="M5 8h10M5 11h7M5 14h5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      </svg>
    ),
  },
];

// More-screen overflow items
type MoreItem = { id: Screen; label: string; description: string };
const MORE_ITEMS: MoreItem[] = [
  { id: 'chart',   label: 'Chart',    description: 'Price · CVD · Aggressor' },
  { id: 'brain',   label: 'Brain',    description: 'Base rates · trade quality' },
  { id: 'scanner', label: 'Scanner',  description: 'Signal FORMING / TRIGGERING' },
];

// ── Watchlist hook ────────────────────────────────────────────────────────────
function useWatchlist() {
  const [tickers, setTickers]   = useState<string[]>([]);

  const load = useCallback(async () => {
    const { data } = await supabase
      .from('user_watchlist')
      .select('ticker')
      .eq('session_id', SESSION_ID)
      .order('added_at', { ascending: true });
    if (data) setTickers(data.map((r: { ticker: string }) => r.ticker));
  }, []);

  useEffect(() => { load(); }, [load]);

  const add = useCallback(async (ticker: string) => {
    const t = ticker.toUpperCase().trim();
    if (!t || tickers.includes(t)) return;
    setTickers(prev => [...prev, t]);
    await supabase.from('user_watchlist').insert({ session_id: SESSION_ID, ticker: t });
  }, [tickers]);

  const remove = useCallback(async (ticker: string) => {
    setTickers(prev => prev.filter(t => t !== ticker));
    await supabase.from('user_watchlist').delete()
      .eq('session_id', SESSION_ID).eq('ticker', ticker);
  }, []);

  return { tickers, add, remove };
}

// ── Helios wordmark ───────────────────────────────────────────────────────────
function HeliosWordmark() {
  return (
    <div className="flex items-center gap-2">
      {/* H mark */}
      <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
        <rect width="18" height="18" fill="var(--amb-solid)" />
        <path d="M4 4v10M14 4v10M4 9h10" stroke="var(--void)" strokeWidth="2.2" strokeLinecap="round" />
      </svg>
      <span style={{
        fontFamily: 'Inter, system-ui, sans-serif',
        fontWeight: 800,
        fontSize: '15px',
        letterSpacing: '-0.02em',
        color: 'var(--text-primary)',
      }}>
        HELIOS
      </span>
    </div>
  );
}

// ── Connection status hook ────────────────────────────────────────────────────
type ConnStatus = 'connecting' | 'connected' | 'disconnected';

function useConnectionStatus(): ConnStatus {
  const [status, setStatus] = useState<ConnStatus>(() => massiveBus.getConnectionStatus());
  useEffect(() => {
    // Re-read immediately on mount — auth_success may have fired before this
    // effect registered, so the initial useState snapshot could be stale.
    setStatus(massiveBus.getConnectionStatus());

    const unsub = massiveBus.onStatusChange(() => setStatus(massiveBus.getConnectionStatus()));

    // Poll every 2s as a safety net for any missed notifications
    const interval = setInterval(() => setStatus(massiveBus.getConnectionStatus()), 2000);

    return () => { unsub(); clearInterval(interval); };
  }, []);
  return status;
}

// ── Stale data hook ───────────────────────────────────────────────────────────
// Returns true if any watched ticker's bars are stale (status === 'error')
// AND the feed is supposed to be active right now.
// During the 7 PM–3 AM CT window the feed is intentionally offline —
// showing a stale banner then is misleading, so we suppress it entirely.
const STALE_WATCH = ['SPY', 'QQQ', 'IWM'];

type FeedState = 'ok' | 'stale' | 'market_closed';

function useFeedState(): FeedState {
  const [state, setState] = useState<FeedState>('ok');
  useEffect(() => {
    function check() {
      const feedActive = isFeedScheduleActive();
      if (!feedActive) {
        setState('market_closed');
        return;
      }
      const anyStale = STALE_WATCH.some(t => barsStore.getResult(t).status === 'error');
      setState(anyStale ? 'stale' : 'ok');
    }
    check();
    const interval = setInterval(check, 10_000);
    const unsub    = barsStore.subscribe(check);
    return () => { clearInterval(interval); unsub(); };
  }, []);
  return state;
}



// ── Connection pulse dot ──────────────────────────────────────────────────────
function PulseDot({ status }: { status: ConnStatus }) {
  // Use legacy --g / --r aliases (rgb() wrappers) not the raw channel tokens
  const bg = status === 'connected'
    ? 'var(--g)'
    : status === 'connecting'
      ? 'var(--amb-solid)'
      : 'var(--r)';

  return (
    <div
      className={status === 'connected' ? 'helios-pulse' : ''}
      style={{ width: 7, height: 7, borderRadius: '50%', flexShrink: 0, background: bg }}
      title={`Feed: ${status}`}
    />
  );
}

// ── Header ────────────────────────────────────────────────────────────────────
interface HeaderProps {
  screen: Screen;
  onSettings: () => void;
  onMore: () => void;
  connStatus: ConnStatus;
  feedState: FeedState;
}

function HeliosHeader({ screen, onSettings, onMore, connStatus, feedState }: HeaderProps) {
  const screenLabel: Partial<Record<Screen, string>> = {
    home:     'HOME',
    chain:    'CHAIN',
    best:     'BEST CONTRACTS',
    cockpit:  'COCKPIT',
    insiders: 'INSIDERS',
    news:     'NEWS',
    chart:    'CHART',
    brain:    'BRAIN',
    swing:    'SWING',
    indexes:  'INDEXES',
    scanner:  'SCANNER',
    more:     'MORE',
  };

  return (
    <>
      <header className="helios-header">
        <HeliosWordmark />
        <PulseDot status={connStatus} />
        {/* Screen label — only on non-home screens */}
        {screen !== 'home' && (
          <span style={{
            fontSize: '10px',
            fontWeight: 700,
            letterSpacing: '0.12em',
            color: 'var(--text-tertiary)',
            textTransform: 'uppercase',
            marginLeft: '2px',
          }}>
            {screenLabel[screen]}
          </span>
        )}
        <div style={{ flex: 1 }} />
        <button
          onClick={onMore}
          style={{
            background: 'none', border: 'none', cursor: 'pointer',
            color: 'var(--text-tertiary)', padding: '8px', lineHeight: 0,
          }}
          aria-label="More screens"
        >
          <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
            <circle cx="4" cy="9" r="1.5" fill="currentColor" />
            <circle cx="9" cy="9" r="1.5" fill="currentColor" />
            <circle cx="14" cy="9" r="1.5" fill="currentColor" />
          </svg>
        </button>
        <button
          onClick={onSettings}
          style={{
            background: 'none', border: 'none', cursor: 'pointer',
            color: 'var(--text-tertiary)', padding: '8px', lineHeight: 0,
          }}
          aria-label="Settings"
        >
          <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
            <circle cx="9" cy="9" r="2.5" stroke="currentColor" strokeWidth="1.4" />
            <path d="M9 2v1.5M9 14.5V16M2 9h1.5M14.5 9H16M3.93 3.93l1.06 1.06M13.01 13.01l1.06 1.06M3.93 14.07l1.06-1.06M13.01 4.99l1.06-1.06"
              stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
          </svg>
        </button>
      </header>
      {/* Global data state banner */}
      {feedState === 'stale' && connStatus === 'connected' && (
        <div style={{
          background: 'var(--amb-solid)',
          color: 'var(--void)',
          fontSize: '10px',
          fontWeight: 700,
          letterSpacing: '0.08em',
          textAlign: 'center',
          padding: '4px 12px',
          textTransform: 'uppercase',
        }}>
          DATA STALE — reconnecting feed…
        </div>
      )}
      {feedState === 'market_closed' && (
        <div style={{
          background: '#1a1a24',
          color: 'var(--dim)',
          fontSize: '10px',
          fontWeight: 700,
          letterSpacing: '0.08em',
          textAlign: 'center',
          padding: '4px 12px',
          textTransform: 'uppercase',
          borderBottom: '1px solid var(--line)',
        }}>
          Market closed — feed resumes ~3:00 AM CT
        </div>
      )}
      {connStatus === 'disconnected' && (
        <div style={{
          background: 'var(--col-r)',
          color: '#fff',
          fontSize: '10px',
          fontWeight: 700,
          letterSpacing: '0.08em',
          textAlign: 'center',
          padding: '4px 12px',
          textTransform: 'uppercase',
        }}>
          FEED DISCONNECTED — retrying in 5s…
        </div>
      )}
    </>
  );
}

// ── Bottom nav ────────────────────────────────────────────────────────────────
interface BottomNavProps {
  active: Screen;
  onNavigate: (s: Screen) => void;
}

function BottomNav({ active, onNavigate }: BottomNavProps) {
  return (
    <nav className="helios-nav" role="navigation" aria-label="Main navigation">
      {NAV_ITEMS.map(item => (
        <button
          key={item.id}
          className={`helios-nav-item${active === item.id ? ' active' : ''}`}
          onClick={() => onNavigate(item.id)}
          aria-label={item.label}
          aria-current={active === item.id ? 'page' : undefined}
        >
          {item.icon(active === item.id)}
          <span className="helios-nav-label">{item.label}</span>
        </button>
      ))}
    </nav>
  );
}

// ── More overlay ──────────────────────────────────────────────────────────────
interface MoreOverlayProps {
  onNavigate: (s: Screen) => void;
  onClose: () => void;
}

function MoreOverlay({ onNavigate, onClose }: MoreOverlayProps) {
  return (
    <div
      style={{
        position: 'absolute', inset: 0, zIndex: 100,
        background: 'rgba(2,3,4,0.92)',
        display: 'flex', flexDirection: 'column',
        justifyContent: 'flex-end',
      }}
      onClick={onClose}
    >
      <div
        style={{
          background: 'var(--panel)',
          borderTop: '1px solid var(--border-mid)',
          padding: '8px 0 calc(env(safe-area-inset-bottom, 0px) + 8px)',
        }}
        onClick={e => e.stopPropagation()}
      >
        <div style={{
          padding: '10px 16px 6px',
          fontSize: '9px', fontWeight: 700, letterSpacing: '0.1em',
          textTransform: 'uppercase', color: 'var(--text-tertiary)',
        }}>
          More Screens
        </div>
        {MORE_ITEMS.map(item => (
          <button
            key={item.id}
            onClick={() => { onNavigate(item.id); onClose(); }}
            style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              width: '100%', padding: '13px 16px',
              background: 'none', border: 'none', cursor: 'pointer',
              borderBottom: '1px solid var(--border-dim)',
            }}
          >
            <span style={{ fontSize: '14px', fontWeight: 600, color: 'var(--text-primary)' }}>
              {item.label}
            </span>
            <span style={{ fontSize: '11px', color: 'var(--text-tertiary)' }}>
              {item.description}
            </span>
          </button>
        ))}
        <button
          onClick={onClose}
          style={{
            display: 'block', width: '100%', padding: '14px 16px',
            background: 'none', border: 'none', cursor: 'pointer',
            fontSize: '13px', fontWeight: 600, color: 'var(--amb-solid)',
            textAlign: 'center',
          }}
        >
          Close
        </button>
      </div>
    </div>
  );
}

function ApiHealthRows() {
  const relayUrl    = (import.meta.env.VITE_RELAY_URL as string | undefined) ?? '';

  // ── Relay WebSocket — sourced from massiveBus connection state ────────────
  const [wsStatus, setWsStatus] = useState<'connecting' | 'connected' | 'disconnected'>(
    massiveBus.getConnectionStatus()
  );
  useEffect(() => {
    // Sync on mount in case state changed between render and effect
    setWsStatus(massiveBus.getConnectionStatus());
    const unsub = massiveBus.onStatusChange(() => setWsStatus(massiveBus.getConnectionStatus()));
    return unsub;
  }, []);

  // ── Relay HTTP health ─────────────────────────────────────────────────────
  const [relayHttp, setRelayHttp]       = useState<'checking' | 'ok' | 'error'>('checking');
  const [relayLatency, setRelayLatency] = useState<number | null>(null);
  useEffect(() => {
    if (!relayUrl) { setRelayHttp('error'); return; }
    const t0 = Date.now();
    fetch(`${relayUrl}/health`, { signal: AbortSignal.timeout(4000) })
      .then(r => r.ok ? r.json() : Promise.reject(r.status))
      .then(() => { setRelayHttp('ok'); setRelayLatency(Date.now() - t0); })
      .catch(() => setRelayHttp('error'));
  }, [relayUrl]);

  // ── Massive API REST ping ────────────────────────────────────────────────
  const [massiveStatus, setMassiveStatus]   = useState<'checking' | 'ok' | 'error'>('checking');
  const [massiveLatency, setMassiveLatency] = useState<number | null>(null);
  useEffect(() => {
    if (!relayUrl) { setMassiveStatus('error'); return; }
    const t0 = Date.now();
    fetch(`${relayUrl}/rest/v1/marketstatus/now`, {
      signal: AbortSignal.timeout(5000),
    })
      .then(r => r.ok ? r.json() : Promise.reject(r.status))
      .then(() => { setMassiveStatus('ok'); setMassiveLatency(Date.now() - t0); })
      .catch(() => setMassiveStatus('error'));
  }, [relayUrl]);

  const rows: { label: string; value: string; color: string }[] = [
    {
      label: 'Relay WS',
      value: wsStatus === 'connected' ? 'CONNECTED' : wsStatus === 'connecting' ? 'CONNECTING…' : 'DISCONNECTED',
      color: wsStatus === 'connected' ? 'var(--g)' : wsStatus === 'connecting' ? 'var(--amb-solid)' : 'var(--r)',
    },
    {
      label: 'Relay HTTP',
      value: relayHttp === 'checking' ? '…' : relayHttp === 'ok' ? `OK · ${relayLatency}ms` : 'NO CONN',
      color: relayHttp === 'ok' ? 'var(--g)' : relayHttp === 'error' ? 'var(--r)' : 'var(--text-tertiary)',
    },
    {
      label: 'Massive API',
      value: massiveStatus === 'checking' ? '…' : massiveStatus === 'ok' ? `OK · ${massiveLatency}ms` : 'NO CONN',
      color: massiveStatus === 'ok' ? 'var(--g)' : massiveStatus === 'error' ? 'var(--r)' : 'var(--text-tertiary)',
    },
  ];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
      {rows.map(row => (
        <div key={row.label} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ fontSize: '11px', color: 'var(--text-tertiary)', fontFamily: 'JetBrains Mono, monospace' }}>
            {row.label}
          </span>
          <span style={{ fontSize: '11px', fontWeight: 700, color: row.color, fontFamily: 'JetBrains Mono, monospace' }}>
            {row.value}
          </span>
        </div>
      ))}
      {!relayUrl && (
        <p style={{ fontSize: '10px', color: 'var(--text-disabled)', marginTop: '2px' }}>
          Set VITE_RELAY_URL in .env to enable live data.
        </p>
      )}
    </div>
  );
}

// ── Settings overlay ─────────────────────────────────────────────────────────
interface SettingsOverlayProps {
  watchlist: string[];
  onAdd: (t: string) => void;
  onRemove: (t: string) => void;
  onClose: () => void;
}

function SettingsOverlay({ watchlist, onAdd, onRemove, onClose }: SettingsOverlayProps) {
  const [input, setInput] = useState('');

  const commit = () => {
    const t = input.toUpperCase().trim();
    if (t) { onAdd(t); setInput(''); }
  };

  return (
    <div
      style={{
        position: 'absolute', inset: 0, zIndex: 100,
        background: 'rgba(2,3,4,0.92)',
        display: 'flex', flexDirection: 'column',
        justifyContent: 'flex-end',
      }}
      onClick={onClose}
    >
      <div
        style={{
          background: 'var(--panel)',
          borderTop: '1px solid var(--border-mid)',
          maxHeight: '75vh', overflowY: 'auto',
          padding: '0 0 calc(env(safe-area-inset-bottom, 0px) + 8px)',
        }}
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '14px 16px',
          borderBottom: '1px solid var(--border-dim)',
        }}>
          <span style={{ fontSize: '13px', fontWeight: 700, color: 'var(--text-primary)' }}>
            Settings
          </span>
          <button onClick={onClose} style={{
            background: 'none', border: 'none', cursor: 'pointer',
            fontSize: '13px', color: 'var(--amb-solid)', fontWeight: 600,
          }}>Done</button>
        </div>

        {/* Watchlist section */}
        <div style={{ padding: '12px 16px 6px' }}>
          <div style={{
            fontSize: '9px', fontWeight: 700, letterSpacing: '0.1em',
            textTransform: 'uppercase', color: 'var(--text-tertiary)',
            marginBottom: '10px',
          }}>
            Watchlist
          </div>
          <div style={{ display: 'flex', gap: '8px', marginBottom: '10px' }}>
            <input
              value={input}
              onChange={e => setInput(e.target.value.toUpperCase())}
              onKeyDown={e => { if (e.key === 'Enter') commit(); }}
              placeholder="Add ticker…"
              maxLength={8}
              style={{
                flex: 1, background: 'var(--surface-2)',
                border: '1px solid var(--border-mid)',
                borderRadius: '2px', padding: '8px 10px',
                fontSize: '12px', color: 'var(--text-primary)',
                fontFamily: 'JetBrains Mono, monospace',
                outline: 'none',
              }}
            />
            <button
              onClick={commit}
              style={{
                padding: '8px 14px',
                background: 'var(--amb-solid)', border: 'none',
                borderRadius: '2px', cursor: 'pointer',
                fontSize: '11px', fontWeight: 700,
                color: 'var(--void)',
              }}
            >
              ADD
            </button>
          </div>
          {watchlist.length === 0 ? (
            <p style={{ fontSize: '11px', color: 'var(--text-tertiary)', padding: '4px 0' }}>
              No tickers in watchlist
            </p>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '1px' }}>
              {watchlist.map(t => (
                <div key={t} style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                  padding: '9px 0',
                  borderBottom: '1px solid var(--border-dim)',
                }}>
                  <span style={{
                    fontSize: '13px', fontWeight: 600,
                    fontFamily: 'JetBrains Mono, monospace',
                    color: 'var(--text-primary)',
                  }}>
                    {t}
                  </span>
                  <button
                    onClick={() => onRemove(t)}
                    style={{
                      background: 'none', border: 'none', cursor: 'pointer',
                      fontSize: '11px', color: 'var(--r)', fontWeight: 600,
                    }}
                  >
                    Remove
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Session info */}
        <div style={{ padding: '12px 16px', borderTop: '1px solid var(--border-dim)' }}>
          <div style={{
            fontSize: '9px', fontWeight: 700, letterSpacing: '0.1em',
            textTransform: 'uppercase', color: 'var(--text-tertiary)',
            marginBottom: '6px',
          }}>
            Session
          </div>
          <p style={{ fontSize: '10px', color: 'var(--text-tertiary)', fontFamily: 'monospace', wordBreak: 'break-all' }}>
            {SESSION_ID}
          </p>
          <p style={{ fontSize: '10px', color: 'var(--text-disabled)', marginTop: '4px' }}>
            Watchlist is scoped to this device session.
          </p>
        </div>

        {/* API / connection health */}
        <div style={{ padding: '12px 16px', borderTop: '1px solid var(--border-dim)' }}>
          <div style={{
            fontSize: '9px', fontWeight: 700, letterSpacing: '0.1em',
            textTransform: 'uppercase', color: 'var(--text-tertiary)',
            marginBottom: '8px',
          }}>
            Data Connection
          </div>
          <ApiHealthRows />
        </div>
      </div>
    </div>
  );
}

// ── Chart screen ──────────────────────────────────────────────────────────────
// Wraps HeliosChart with a ticker selector from the fixed FEED_TICKERS universe.
// Import FEED_TICKERS + CONTEXT_ONLY_TICKERS from directionState
import { FEED_TICKERS } from '@/state/directionState';
import type { ChartInterval } from '@/lib/aggregateBars';

const NON_CHARTABLE = new Set(['SPX', 'NDX', 'I:VIX', 'HYG', 'TLT']);
const CHART_TICKERS = FEED_TICKERS.filter(t => !NON_CHARTABLE.has(t));

const INTERVAL_OPTIONS: { value: ChartInterval; label: string }[] = [
  { value: '1m',  label: '1m'  },
  { value: '5m',  label: '5m'  },
  { value: '15m', label: '15m' },
  { value: '1h',  label: '1H'  },
];

/** Real trading-day lookback for signal markers — matches chartBars.ts's own
 * live-verified default (computeChartBackfillWindow), so signal history
 * covers the same real range bar history does. */
const SIGNAL_LOOKBACK_TRADING_DAYS = 7;

interface ChartScreenProps { initialTickerRef: React.MutableRefObject<string>; watchlistTickers?: string[]; }
function ChartScreen({ initialTickerRef, watchlistTickers = [] }: ChartScreenProps) {
  // Read ref directly at render time — no useState initializer race.
  // key={chartNavCount} on the parent guarantees a fresh mount for every navigation.
  const resolvedInitial = (initialTickerRef.current && !NON_CHARTABLE.has(initialTickerRef.current))
    ? initialTickerRef.current
    : (CHART_TICKERS[0] ?? 'SPY');

  const pillTickers = Array.from(new Set([
    resolvedInitial,
    ...watchlistTickers.filter(t => !NON_CHARTABLE.has(t)),
    ...CHART_TICKERS,
  ]));

  const [ticker, setTicker] = useState<string>(resolvedInitial);
  // Named setChartInterval, not setInterval — the obvious name shadows the
  // real global window.setInterval within this component's scope, a real
  // footgun for any future code here that needs a real polling timer.
  const [interval, setChartInterval] = useState<ChartInterval>('1m');

  // ── Real signal markers — entries + exits over the same real window
  // bar history uses (chartBars.ts's computeChartBackfillWindow). Result<T>
  // throughout, same discriminated union every store in this codebase uses,
  // so a real fetch failure never silently renders as "no signals fired."
  const [markersResult, setMarkersResult] = useState<Result<ChartSignalMarker[]>>({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;
    setMarkersResult({ status: 'loading' });

    const { fromMs, toMs } = computeChartBackfillWindow(Date.now(), SIGNAL_LOOKBACK_TRADING_DAYS);
    fetchChartSignalMarkers(ticker, fromMs, toMs).then((result) => {
      // Guard against a stale response landing after the user has already
      // switched tickers again — without this, a slow fetch for the
      // PREVIOUS ticker could overwrite the current ticker's real markers.
      if (!cancelled) setMarkersResult(result);
    });

    return () => { cancelled = true; };
  }, [ticker]);

  const markers = markersResult.status === 'ready' ? markersResult.data : [];

  return (
    <section id="chart" style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* Ticker selector row */}
      <div style={{
        display: 'flex', gap: '6px', padding: '10px 12px',
        overflowX: 'auto', flexShrink: 0,
        borderBottom: '1px solid var(--border-dim)',
      }}>
        {pillTickers.map(t => {
          const active = t === ticker;
          return (
            <button
              key={t}
              onClick={() => setTicker(t)}
              style={{
                padding: active ? '5px 12px' : '5px 10px', flexShrink: 0,
                background: active ? 'var(--amb-solid)' : 'transparent',
                border: `1.5px solid ${active ? 'var(--amb-solid)' : 'rgba(255,255,255,0.12)'}`,
                borderRadius: '3px', cursor: 'pointer',
                fontSize: active ? '12px' : '11px',
                fontWeight: active ? 800 : 500,
                fontFamily: 'JetBrains Mono, monospace',
                color: active ? '#000' : 'rgba(255,255,255,0.38)',
                letterSpacing: active ? '-0.01em' : '0',
                transition: 'all 0.1s',
              }}
            >
              {t}
            </button>
          );
        })}
      </div>
      {/* Interval toggle row — candles/EMA re-aggregate real, backfilled
          data at 15m/1h (see HeliosChart's own real backfill wiring);
          VWAP/GEX are deliberately interval-invariant and unaffected. */}
      <div style={{
        display: 'flex', gap: '4px', padding: '6px 12px',
        borderBottom: '1px solid var(--border-dim)',
      }}>
        {INTERVAL_OPTIONS.map(opt => {
          const active = opt.value === interval;
          return (
            <button
              key={opt.value}
              onClick={() => setChartInterval(opt.value)}
              style={{
                padding: '3px 10px',
                background: active ? 'rgba(255,255,255,0.10)' : 'transparent',
                border: `1px solid ${active ? 'rgba(255,255,255,0.25)' : 'rgba(255,255,255,0.08)'}`,
                borderRadius: '3px', cursor: 'pointer',
                fontSize: '10px',
                fontWeight: active ? 700 : 500,
                fontFamily: 'JetBrains Mono, monospace',
                color: active ? 'var(--text-primary)' : 'rgba(255,255,255,0.35)',
              }}
            >
              {opt.label}
            </button>
          );
        })}
      </div>
      {/* Signal history fetch failure — distinct from "genuinely no signals
          fired", never conflated. Candles/VWAP/EMA/GEX still render fine
          below; this failure is scoped to markers only. */}
      {markersResult.status === 'error' && (
        <div style={{
          padding: '4px 12px',
          fontSize: '10px',
          fontWeight: 700,
          letterSpacing: '0.06em',
          textAlign: 'center',
          color: 'var(--r)',
          background: 'rgba(239, 68, 68, 0.08)',
          textTransform: 'uppercase',
          flexShrink: 0,
        }}>
          Signal history unavailable
        </div>
      )}
      {/* Chart */}
      <div style={{ flex: 1, overflow: 'hidden' }}>
        <HeliosChart ticker={ticker} markers={markers} interval={interval} />
      </div>
    </section>
  );
}

// ── Cockpit screen — 0DTE / SWING / INDEXES unified tabs ─────────────────────
type CockpitTab = '0dte' | 'swing' | 'indexes';

const COCKPIT_TABS: { id: CockpitTab; label: string }[] = [
  { id: '0dte',    label: '0DTE'    },
  { id: 'swing',   label: 'SWING'   },
  { id: 'indexes', label: 'INDEXES' },
];

function CockpitScreen() {
  const [tab, setTab] = useState<CockpitTab>('0dte');
  return (
    <section id="cockpit" style={{ display: 'flex', flexDirection: 'column', minHeight: '100%' }}>
      {/* Tab strip */}
      <div style={{
        display: 'flex', borderBottom: '1px solid var(--border-dim)',
        background: 'var(--void)', flexShrink: 0,
      }}>
        {COCKPIT_TABS.map(t => {
          const active = tab === t.id;
          return (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              style={{
                flex: 1, padding: '10px 0',
                background: 'none', border: 'none', cursor: 'pointer',
                fontSize: '11px', fontWeight: active ? 700 : 500,
                letterSpacing: '0.08em',
                color: active ? 'var(--amb-solid)' : 'var(--text-tertiary)',
                borderBottom: active ? '2px solid var(--amb-solid)' : '2px solid transparent',
                transition: 'color 0.15s, border-color 0.15s',
              }}
            >
              {t.label}
            </button>
          );
        })}
      </div>
      {/* Tab content */}
      <div style={{ flex: 1, overflow: 'auto' }}>
        {tab === '0dte'    && <ErrorBoundary label="0DTE"><ZeroDteCockpit /></ErrorBoundary>}
        {tab === 'swing'   && <ErrorBoundary label="Swing"><SwingCockpit /></ErrorBoundary>}
        {tab === 'indexes' && <ErrorBoundary label="Indexes"><IndexesCockpit /></ErrorBoundary>}
      </div>
    </section>
  );
}

// ── Home screen (Dashboard) — props wired from shell ─────────────────────────
// DashboardCockpit owns its own <section id="home"> — no wrapper needed here.
interface HomeScreenProps {
  tickers: string[];
  onAdd: (t: string) => void;
  onRemove: (t: string) => void;
  onOpenChart: (t: string) => void;
  onOpenChain: () => void;
  onOpenInsiders: () => void;
}
function HomeScreen({ tickers, onAdd, onRemove, onOpenChart, onOpenChain, onOpenInsiders }: HomeScreenProps) {
  return (
    <DashboardCockpit
      watchlistTickers={tickers}
      onAddTicker={onAdd}
      onRemoveTicker={onRemove}
      onOpenChart={onOpenChart}
      onOpenChain={onOpenChain}
      onOpenInsiders={onOpenInsiders}
    />
  );
}

// ── Screen renderer ───────────────────────────────────────────────────────────
interface ScreenContentProps {
  screen: Screen;
  tickers: string[];
  onAdd: (t: string) => void;
  onRemove: (t: string) => void;
  onOpenChart: (t: string) => void;
  chartTickerRef: React.MutableRefObject<string>;
  chartNavCount: number;
  navigate: (s: Screen) => void;
}
function ScreenContent({ screen, tickers, onAdd, onRemove, onOpenChart, chartTickerRef, chartNavCount, navigate }: ScreenContentProps) {
  switch (screen) {
    case 'home':     return (
      <ErrorBoundary label="Dashboard">
        <HomeScreen
          tickers={tickers}
          onAdd={onAdd}
          onRemove={onRemove}
          onOpenChart={onOpenChart}
          onOpenChain={() => navigate('chain')}
          onOpenInsiders={() => navigate('insiders')}
        />
      </ErrorBoundary>
    );
    case 'chain':    return <section id="chain"><ErrorBoundary label="Chain"><ChainCockpit onOpenChart={onOpenChart} /></ErrorBoundary></section>;
    case 'best':     return <section id="best"><ErrorBoundary label="Best Contracts"><BestContractsCockpit onOpenCockpit={(_t) => navigate('cockpit')} /></ErrorBoundary></section>;
    case 'cockpit':  return <CockpitScreen />;
    case 'insiders': return <section id="insiders"><ErrorBoundary label="Insiders"><InsidersCockpit /></ErrorBoundary></section>;
    case 'news':     return <section id="news"><ErrorBoundary label="News"><NewsCockpit /></ErrorBoundary></section>;
    case 'chart':    return <ErrorBoundary label="Chart"><ChartScreen key={chartNavCount} initialTickerRef={chartTickerRef} watchlistTickers={tickers} /></ErrorBoundary>;
    case 'brain':    return <section id="brain"><ErrorBoundary label="Brain"><BrainCockpit /></ErrorBoundary></section>;
    case 'swing':    return <section id="swing"><ErrorBoundary label="Swing"><SwingCockpit /></ErrorBoundary></section>;
    case 'indexes':  return <section id="indexes"><ErrorBoundary label="Indexes"><IndexesCockpit /></ErrorBoundary></section>;
    case 'scanner':  return <section id="scanner"><ErrorBoundary label="Scanner"><ScannerCockpit /></ErrorBoundary></section>;
    default:         return null;
  }
}

// ── Root shell ────────────────────────────────────────────────────────────────
export default function HomePage() {
  const [screen, setScreen]       = useState<Screen>('home');
  const [showMore, setShowMore]   = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [chartNavCount, setChartNavCount] = useState(0);
  const chartTickerRef = useRef<string>(CHART_TICKERS[0] ?? 'SPY');
  const screenRef = useRef<HTMLDivElement>(null);

  const { tickers, add, remove } = useWatchlist();

  const connStatus = useConnectionStatus();
  const feedState  = useFeedState();

  // Restore last screen from sessionStorage
  useEffect(() => {
    const saved = sessionStorage.getItem('helios_screen') as Screen | null;
    if (saved) setScreen(saved);
  }, []);

  const navigate = useCallback((s: Screen) => {
    setScreen(s);
    setShowMore(false);
    sessionStorage.setItem('helios_screen', s);
    // Scroll screen area back to top on navigation
    if (screenRef.current) screenRef.current.scrollTop = 0;
  }, []);

  return (
    <div className="helios-shell">
      <HeliosHeader
        screen={screen}
        onSettings={() => setShowSettings(true)}
        onMore={() => setShowMore(true)}
        connStatus={connStatus}
        feedState={feedState}
      />

      <main
        ref={screenRef}
        className="helios-screen"
        role="main"
        style={{ width: '100%', display: 'block' }}
      >
        <ScreenContent
          screen={screen}
          tickers={tickers}
          onAdd={add}
          onRemove={remove}
          onOpenChart={(t) => { chartTickerRef.current = t; setChartNavCount(c => c + 1); navigate('chart'); }}
          chartTickerRef={chartTickerRef}
          chartNavCount={chartNavCount}
          navigate={navigate}
        />
      </main>

      <BottomNav active={screen} onNavigate={navigate} />

      {/* Overlays */}
      {showMore && (
        <MoreOverlay
          onNavigate={navigate}
          onClose={() => setShowMore(false)}
        />
      )}
      {showSettings && (
        <SettingsOverlay
          watchlist={tickers}
          onAdd={add}
          onRemove={remove}
          onClose={() => setShowSettings(false)}
        />
      )}
    </div>
  );
}
