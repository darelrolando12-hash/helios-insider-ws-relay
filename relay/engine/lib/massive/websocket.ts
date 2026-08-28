import { toCentralTime, isFeedScheduleActive } from '../time';
import { OptionSubscriptionBudgetManager } from './budgetManager';
import { RELAY_WS_URL } from '../../config';

// ── Staleness watchdog thresholds ────────────────────────────────────────────
// A socket can be technically OPEN while Massive has silently stopped sending
// data (half-open failure) — onclose/onerror never fire in that case. This
// watchdog tracks the last time a real data message actually arrived and
// force-closes the sockets if too much time passes, letting the existing
// onclose reconnect logic take over.
const STALE_THRESHOLD_MS_MARKET_HOURS = 90_000;
const STALE_THRESHOLD_MS_OFF_HOURS    = 180_000;
const WATCHDOG_INTERVAL_MS            = 60_000;

// ── Reconnect backoff ────────────────────────────────────────────────────────
// Flat 5s retry forever hammers the connection at a fixed rate. Step up the
// delay on repeated failures, capping (and repeating) at 30s. Resets to 0 on
// a successful onopen. Stocks and options are tracked independently — they
// can fail and recover on different schedules.
const RECONNECT_DELAYS_MS = [5_000, 10_000, 15_000, 20_000, 30_000];

function _nextReconnectDelay(attempt: number): number {
  return RECONNECT_DELAYS_MS[Math.min(attempt, RECONNECT_DELAYS_MS.length - 1)];
}

// ── Diagnostic: tab visibility correlation ──────────────────────────────────
// Temporary instrumentation to correlate WS lifecycle events against
// document.visibilityState — used to confirm/deny whether Chrome's background
// tab timer throttling is causing delayed pong responses / delayed onclose
// firing. Read-only logging, does not alter any connection behavior.

function _visibility(): string {
  return typeof document !== 'undefined' ? document.visibilityState : 'unknown';
}

if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    console.log(`[MassiveWS:DIAG] ${new Date().toISOString()} VISIBILITY_CHANGE state=${document.visibilityState}`);
  });
}

// ── Message types ────────────────────────────────────────────────────────────

export interface BaseWSMessage {
  ev:  string;  // 'AM' | 'A' | 'T' | 'Q' | 'LULD'
  sym: string;  // ticker symbol
  t?:  number;  // Massive timestamp (UTC ms) — present on most event types
  [key: string]: unknown;
}

/**
 * Every message dispatched to handlers has _ct injected by processSingleMessage.
 * This is the ONLY place in the app that calls toCentralTime — all downstream
 * consumers read msg._ct and never do their own UTC math.
 */
export interface WSMessageWithCT extends BaseWSMessage {
  _ct: ReturnType<typeof toCentralTime>;
}

export type WSMessageHandler = (msg: WSMessageWithCT) => void;

type StockChannel  = 'AM' | 'A' | 'T' | 'Q' | 'LULD';
type OptionChannel = 'AM' | 'A' | 'T' | 'Q';

// ── Redundant dual-connection types ─────────────────────────────────────────
// Each feed (stocks, options) maintains TWO independent browser↔relay
// connections ("A" and "B"), staggered on startup so Railway's periodic
// connection-cycling never has a good chance of dropping both at once. When
// one is quiet or closed, the other keeps delivering — no visible data gap.
type SourceKey = 'stocks' | 'options';
type ConnId = 'stocksA' | 'stocksB' | 'optionsA' | 'optionsB';

const CONN_IDS: ConnId[] = ['stocksA', 'stocksB', 'optionsA', 'optionsB'];

// ── MassiveWebSocketBus ──────────────────────────────────────────────────────

export class MassiveWebSocketBus {
  private _sockets: Record<ConnId, WebSocket | null> = {
    stocksA: null, stocksB: null, optionsA: null, optionsB: null,
  };

  private readonly _apiKey:      string;
  private readonly _stocksUrl:  string;
  private readonly _optionsUrl: string;

  // Subscription registries — shared by both connections in a pair, rebuilt
  // on each connection's own reconnect via its own onopen.
  private readonly _stocksSubs  = new Set<string>();
  private readonly _optionsSubs = new Set<string>();

  // Q-channel budget manager (1,000-contract cap)
  public readonly budgetManager = new OptionSubscriptionBudgetManager(1000);

  // Event handlers keyed by ev type, plus a catch-all set
  private readonly _handlers      = new Map<string, Set<WSMessageHandler>>();
  private readonly _globalHandlers = new Set<WSMessageHandler>();

  // Listeners notified after successful re-auth (used by barStore reconnect logic)
  private readonly _reconnectListeners = new Set<() => void>();

  // Listeners notified on any connection state change
  private readonly _statusListeners = new Set<() => void>();

  // Per-connection auth flag — each of the four sockets authenticates with
  // the relay independently.
  private _authenticated: Record<ConnId, boolean> = {
    stocksA: false, stocksB: false, optionsA: false, optionsB: false,
  };

  // Reconnect backoff attempt counters — independent per connection, reset on
  // that connection's own onopen. A cycle on stocksA never affects stocksB.
  private _reconnectAttempt: Record<ConnId, number> = {
    stocksA: 0, stocksB: 0, optionsA: 0, optionsB: 0,
  };

  // Per-connection last-data-received time. The watchdog uses this to isolate
  // exactly which socket in a redundant pair has gone stale, so a healthy
  // partner covering for a quiet one is never mistaken for a dead feed.
  private _connLastMessageTime: Record<ConnId, number> = {
    stocksA: Date.now(), stocksB: Date.now(), optionsA: Date.now(), optionsB: Date.now(),
  };

  private _watchdogHandle: ReturnType<typeof setInterval> | null = null;

  // Message dedup — both connections in a pair receive identical broadcasts
  // from the relay. This collapses the duplicate before it reaches any
  // handler. Rolling 2s window, swept on every incoming message so the map
  // never grows unbounded.
  private readonly _recentMessageKeys = new Map<string, number>();
  private static readonly DEDUP_WINDOW_MS = 2_000;

  // Delay before starting the "B" connection in each pair. Long enough that
  // Railway's cycling window is unlikely to catch both A and B close
  // together, without meaningfully delaying full redundancy coming online.
  private static readonly PAIR_STAGGER_MS = 45_000;

  constructor(apiKey: string, baseUrl = 'wss://socket.massive.com') {
    this._apiKey      = apiKey;
    this._stocksUrl  = `${baseUrl}/stocks`;
    this._optionsUrl = `${baseUrl}/options`;
  }

  private _sourceOf(connId: ConnId): SourceKey {
    return connId.startsWith('stocks') ? 'stocks' : 'options';
  }

  // ── Connection lifecycle ─────────────────────────────────────────────────

  public connect() {
    this._connect('stocksA');
    this._connect('optionsA');
    setTimeout(() => this._connect('stocksB'),  MassiveWebSocketBus.PAIR_STAGGER_MS);
    setTimeout(() => this._connect('optionsB'), MassiveWebSocketBus.PAIR_STAGGER_MS);
    this._startWatchdog();
  }

  public disconnect() {
    for (const connId of CONN_IDS) {
      this._sockets[connId]?.close();
      this._sockets[connId] = null;
    }
    if (this._watchdogHandle) {
      clearInterval(this._watchdogHandle);
      this._watchdogHandle = null;
    }
    console.log('[MassiveWS] Disconnected.');
  }

  // ── Staleness watchdog ───────────────────────────────────────────────────

  private _startWatchdog() {
    if (this._watchdogHandle) return; // already running
    this._watchdogHandle = setInterval(() => {
      const threshold = isFeedScheduleActive()
        ? STALE_THRESHOLD_MS_MARKET_HOURS
        : STALE_THRESHOLD_MS_OFF_HOURS;
      const now = Date.now();

      // Check each connection independently — only close the one that's
      // actually silent. If its pair partner is still delivering data, that's
      // the redundancy working as intended, not a failure to act on.
      for (const connId of CONN_IDS) {
        const ws = this._sockets[connId];
        if (!ws || ws.readyState !== WebSocket.OPEN) continue; // reconnect logic already owns this case

        const silentFor = now - this._connLastMessageTime[connId];
        if (silentFor > threshold) {
          console.warn(
            `[MassiveWS] ${connId} silent for ${Math.round(silentFor / 1000)}s despite open connection — forcing reconnect (its pair partner may still be covering the feed).`
          );
          ws.close();
        }
      }
    }, WATCHDOG_INTERVAL_MS);
  }

  /**
   * StrictMode-safe guard: checks the actual WebSocket readyState, not a
   * boolean flag. A stale boolean can be wrong between StrictMode's first
   * unmount and second mount; readyState is authoritative.
   *
   * Returns true when a new connection should be created (socket is absent,
   * or is fully CLOSED). Returns false when a connection is already
   * CONNECTING or OPEN — creating another would open a duplicate stream.
   */
  private _shouldConnect(ws: WebSocket | null): boolean {
    if (ws === null) return true;
    return (
      ws.readyState !== WebSocket.CONNECTING &&
      ws.readyState !== WebSocket.OPEN
    );
  }

  /**
   * Opens one connection (one of stocksA/stocksB/optionsA/optionsB). Each
   * connection independently auths, subscribes, and reconnects — a cycle on
   * one member of a pair never touches the other's state.
   */
  private _connect(connId: ConnId) {
    if (!this._shouldConnect(this._sockets[connId])) return;

    const source = this._sourceOf(connId);
    const url    = source === 'stocks' ? this._stocksUrl : this._optionsUrl;
    const subs   = source === 'stocks' ? this._stocksSubs : this._optionsSubs;

    console.log(`[MassiveWS:DIAG] ${new Date().toISOString()} CONNECT_START ${connId} -> ${url} visibility=${_visibility()}`);
    const ws = new WebSocket(url);
    this._sockets[connId] = ws;
    const openedAt = Date.now();

    ws.onopen = () => {
      console.log(`[MassiveWS:DIAG] ${new Date().toISOString()} OPEN ${connId} visibility=${_visibility()}`);
      this._reconnectAttempt[connId] = 0;
      ws.send(JSON.stringify({ action: 'auth', params: this._apiKey }));
      this._resubscribeAll(ws, subs);
      if (source === 'stocks') this._notifyStatusListeners();
    };

    ws.onmessage = (event) => this._onRawMessage(event.data, connId);

    ws.onclose = (ev) => {
      const upMs = Date.now() - openedAt;
      console.log(`[MassiveWS:DIAG] ${new Date().toISOString()} CLOSE ${connId} code=${ev.code} reason="${ev.reason}" wasClean=${ev.wasClean} uptime=${upMs}ms visibility=${_visibility()}`);
      this._authenticated[connId] = false;
      if (source === 'stocks') this._notifyStatusListeners();
      const delay = _nextReconnectDelay(this._reconnectAttempt[connId]++);
      setTimeout(() => {
        this._sockets[connId] = null;
        console.log(`[MassiveWS:DIAG] ${new Date().toISOString()} RECONNECT_START ${connId} reason=closed delay=${delay}ms visibility=${_visibility()}`);
        this._connect(connId);
      }, delay);
    };

    ws.onerror = (err) => {
      const upMs = Date.now() - openedAt;
      console.error(`[MassiveWS:DIAG] ${new Date().toISOString()} ERROR ${connId} uptime=${upMs}ms`, err);
    };
  }

  // ── Message processing ───────────────────────────────────────────────────

  private _dedupeKey(msg: BaseWSMessage): string {
    return `${msg.ev}:${msg.sym}:${msg.t ?? ''}`;
  }

  /**
   * Returns true if this exact message was already dispatched very recently
   * by the connection's pair partner (both connections in a pair receive
   * identical broadcasts from the relay). Sweeps expired entries on every
   * call so the map never grows unbounded — same discipline as the
   * cvdStore tick cap.
   */
  private _isDuplicateMessage(msg: BaseWSMessage): boolean {
    const now = Date.now();
    for (const [key, seenAt] of this._recentMessageKeys) {
      if (now - seenAt > MassiveWebSocketBus.DEDUP_WINDOW_MS) {
        this._recentMessageKeys.delete(key);
      }
    }
    const key = this._dedupeKey(msg);
    if (this._recentMessageKeys.has(key)) return true;
    this._recentMessageKeys.set(key, now);
    return false;
  }

  private _onRawMessage(data: string, connId: ConnId) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      console.error('[MassiveWS] JSON parse failure:', data);
      return;
    }

    const source = this._sourceOf(connId);
    const messages: BaseWSMessage[] = Array.isArray(parsed) ? parsed : [parsed as BaseWSMessage];

    // Real data arrived (status/auth messages don't count) — reset the
    // per-connection clock so the watchdog knows this specific socket is
    // still alive.
    if (messages.some((m) => m.ev !== 'status')) {
      this._connLastMessageTime[connId] = Date.now();
    }

    // Handle auth_success / connected status messages before dispatching
    for (const msg of messages) {
      if (msg.ev === 'status') {
        // Log every status message so we can see the exact format Massive sends
        console.log(`[MassiveWS] status message (${connId}):`, JSON.stringify(msg));

        // Massive confirms auth via status field ('auth_success') OR
        // via message field containing 'authenticated' — check both.
        const isAuth = (msg as any).status === 'auth_success' ||
          (typeof (msg as any).message === 'string' &&
           ((msg as any).message as string).toLowerCase().includes('authenticated'));

        if (isAuth) {
          console.log(`[MassiveWS] ${connId} authenticated.`);
          const subs = source === 'stocks' ? this._stocksSubs : this._optionsSubs;
          const ws   = this._sockets[connId];
          if (ws) this._resubscribeAll(ws, subs);
          this._authenticated[connId] = true;
          if (source === 'stocks') this._notifyStatusListeners();
          this._notifyReconnectListeners();
        }
        continue;
      }
    }

    // Sort so all Q (quote) messages are processed before T (trade) messages
    // within the same batch. This ensures CVD trade classification always
    // reads the freshest bid/ask spread — never a stale one from earlier
    // in the same batch.
    const sorted = [...messages].sort((a, b) => {
      if (a.ev === 'Q' && b.ev !== 'Q') return -1;
      if (a.ev !== 'Q' && b.ev === 'Q') return  1;
      return 0;
    });

    for (const msg of sorted) {
      if (msg.ev === 'status') continue;
      // Drop the duplicate — both connections in a redundant pair receive
      // the same broadcast from the relay. Still fine that the per-connection
      // clock above already ran for this connection; that's about feed
      // health, not per-message dispatch.
      if (this._isDuplicateMessage(msg)) continue;
      this._dispatchMessage(msg, connId);
    }
  }

  private _dispatchMessage(raw: BaseWSMessage, connId: ConnId) {
    if (!raw.ev) return;

    // If this is a data message (not a status message) and this connection
    // isn't yet marked authenticated, mark it now. When connecting via the
    // relay the auth_success handshake is handled relay-side and never
    // forwarded to the browser — the first data event is the proof auth
    // succeeded.
    if (raw.ev !== 'status' && !this._authenticated[connId]) {
      this._authenticated[connId] = true;
      if (this._sourceOf(connId) === 'stocks') this._notifyStatusListeners();
    }

    // Stamp with CT at the ingestion boundary — single conversion point for
    // the entire app. Every handler receives a fully-stamped message; no
    // handler ever calls toCentralTime itself.
    const _ct = toCentralTime(
      typeof raw.t === 'number' ? raw.t : Date.now()
    );
    const msg: WSMessageWithCT = { ...raw, _ct };

    // Dispatch to event-specific handlers
    const evHandlers = this._handlers.get(msg.ev);
    if (evHandlers) {
      for (const h of evHandlers) {
        try { h(msg); } catch (e) { console.error(`[MassiveWS] Handler error (${msg.ev}):`, e); }
      }
    }

    // Dispatch to global handlers
    for (const h of this._globalHandlers) {
      try { h(msg); } catch (e) { console.error('[MassiveWS] Global handler error:', e); }
    }
  }

  private _resubscribeAll(ws: WebSocket, subs: Set<string>) {
    if (subs.size === 0) return;
    const params = Array.from(subs).join(',');
    console.log(`[MassiveWS] Resubscribing: ${params}`);
    ws.send(JSON.stringify({ action: 'subscribe', params }));
  }

  private _notifyReconnectListeners() {
    for (const fn of this._reconnectListeners) {
      try { fn(); } catch (e) { console.error('[MassiveWS] Reconnect listener error:', e); }
    }
  }

  private _notifyStatusListeners() {
    for (const fn of this._statusListeners) {
      try { fn(); } catch (e) { console.error('[MassiveWS] Status listener error:', e); }
    }
  }

  // ── Subscription API ─────────────────────────────────────────────────────

  public subscribeStock(channel: StockChannel, ticker: string) {
    const key = `${channel}.${ticker}`;
    this._stocksSubs.add(key);
    this._sendToPair('stocks', JSON.stringify({ action: 'subscribe', params: key }));
  }

  public unsubscribeStock(channel: StockChannel, ticker: string) {
    const key = `${channel}.${ticker}`;
    this._stocksSubs.delete(key);
    this._sendToPair('stocks', JSON.stringify({ action: 'unsubscribe', params: key }));
  }

  /**
   * Subscribe to an Options channel.
   * For channel 'Q', the budget manager is consulted first.
   * If at capacity, the furthest-OTM contract is evicted before subscribing.
   *
   * @param underlyingPrice  Current price of the underlying — required for
   *                         correct OTM eviction on Q subscriptions.
   */
  public subscribeOption(channel: OptionChannel, ticker: string, underlyingPrice = 0) {
    if (channel === 'Q') {
      const result = this.budgetManager.subscribe(ticker, underlyingPrice);
      if (!result.allowed) return;
      if (result.evicted) {
        // Remove the evicted contract from our registry and send WS frame
        const evictedKey = `Q.${result.evicted}`;
        this._optionsSubs.delete(evictedKey);
        this._sendToPair('options', JSON.stringify({ action: 'unsubscribe', params: evictedKey }));
        console.log(`[MassiveWS] Budget eviction — unsubscribed Q: ${result.evicted}`);
      }
    }

    const key = `${channel}.${ticker}`;
    this._optionsSubs.add(key);
    this._sendToPair('options', JSON.stringify({ action: 'subscribe', params: key }));
  }

  public unsubscribeOption(channel: OptionChannel, ticker: string) {
    const key = `${channel}.${ticker}`;
    this._optionsSubs.delete(key);
    if (channel === 'Q') this.budgetManager.evict(ticker);
    this._sendToPair('options', JSON.stringify({ action: 'unsubscribe', params: key }));
  }

  /**
   * Sends a frame to both connections in a feed's redundant pair (e.g. both
   * stocksA and stocksB) — each connection maintains its own subscription
   * state on the relay, so a subscribe/unsubscribe call must reach both, not
   * just whichever one happens to be open first.
   */
  private _sendToPair(source: SourceKey, frame: string) {
    const idA: ConnId = source === 'stocks' ? 'stocksA' : 'optionsA';
    const idB: ConnId = source === 'stocks' ? 'stocksB' : 'optionsB';
    for (const connId of [idA, idB]) {
      const ws = this._sockets[connId];
      if (ws?.readyState === WebSocket.OPEN) ws.send(frame);
    }
  }

  // ── Reconnect listener API ───────────────────────────────────────────────

  public onReconnect(fn: () => void)  { this._reconnectListeners.add(fn); }
  public offReconnect(fn: () => void) { this._reconnectListeners.delete(fn); }

  // ── Status listener API ──────────────────────────────────────────────────

  /**
   * Subscribe to connection state changes.
   * Fires on open, close, auth success.
   * Returns unsubscribe function.
   */
  public onStatusChange(fn: () => void): () => void {
    this._statusListeners.add(fn);
    return () => this._statusListeners.delete(fn);
  }

  /**
   * Returns the current connection status for the stocks feed, checking
   * BOTH connections in the redundant pair:
   *   'connected'    — at least one of stocksA/stocksB is open and authenticated
   *   'connecting'   — at least one is open but neither is authenticated yet
   *   'disconnected' — neither connection exists or is open
   */
  public getConnectionStatus(): 'connecting' | 'connected' | 'disconnected' {
    const a = this._sockets.stocksA;
    const b = this._sockets.stocksB;

    const openAuthed = (ws: WebSocket | null, connId: ConnId) =>
      !!ws && ws.readyState === WebSocket.OPEN && this._authenticated[connId];
    const openAny = (ws: WebSocket | null) =>
      !!ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING);

    if (openAuthed(a, 'stocksA') || openAuthed(b, 'stocksB')) return 'connected';
    if (openAny(a) || openAny(b)) return 'connecting';
    return 'disconnected';
  }

  // ── Event handler API ────────────────────────────────────────────────────

  public on(event: string, handler: WSMessageHandler) {
    if (!this._handlers.has(event)) this._handlers.set(event, new Set());
    this._handlers.get(event)!.add(handler);
  }

  public off(event: string, handler: WSMessageHandler) {
    this._handlers.get(event)?.delete(handler);
  }

  public onGlobal(handler: WSMessageHandler)  { this._globalHandlers.add(handler); }
  public offGlobal(handler: WSMessageHandler) { this._globalHandlers.delete(handler); }

  // ── Daily rollover ───────────────────────────────────────────────────────

  /**
   * Evict all expired 0DTE option Q subscriptions. Call once at market close.
   * Engineering Lesson #4: stale 0DTE subscriptions silently eat budget within ~1 week.
   */
  public rolloverExpiredOptions(currentUtcMs: number) {
    const evicted = this.budgetManager.evictExpired(currentUtcMs);
    for (const ticker of evicted) {
      this.unsubscribeOption('Q', ticker);
      console.log(`[MassiveWS] Rollover evicted expired Q: ${ticker}`);
    }
  }
}

// ── Singleton ────────────────────────────────────────────────────────────────

/**
 * Single shared bus instance for the entire app.
 * Layer 0 only — no store or UI file imports this directly except via the stores.
 */
export const massiveBus = new MassiveWebSocketBus(
  import.meta.env.VITE_MASSIVE_API_KEY ?? '',
  RELAY_WS_URL,
);
