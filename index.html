import { toCentralTime } from '../time';
import { OptionSubscriptionBudgetManager } from './budgetManager';

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

// ── MassiveWebSocketBus ──────────────────────────────────────────────────────

export class MassiveWebSocketBus {
  private _stocksWs:  WebSocket | null = null;
  private _optionsWs: WebSocket | null = null;

  private readonly _apiKey:      string;
  private readonly _stocksUrl:  string;
  private readonly _optionsUrl: string;

  // Subscription registries — rebuilt on reconnect
  private readonly _stocksSubs  = new Set<string>();
  private readonly _optionsSubs = new Set<string>();

  // Q-channel budget manager (1,000-contract cap)
  public readonly budgetManager = new OptionSubscriptionBudgetManager(1000);

  // Event handlers keyed by ev type, plus a catch-all set
  private readonly _handlers      = new Map<string, Set<WSMessageHandler>>();
  private readonly _globalHandlers = new Set<WSMessageHandler>();

  // Listeners notified after successful re-auth (used by barStore reconnect logic)
  private readonly _reconnectListeners = new Set<() => void>();

  constructor(apiKey: string, baseUrl = 'wss://socket.massive.com') {
    this._apiKey      = apiKey;
    this._stocksUrl  = `${baseUrl}/stocks`;
    this._optionsUrl = `${baseUrl}/options`;
  }

  // ── Connection lifecycle ─────────────────────────────────────────────────

  public connect() {
    this._connectStocks();
    this._connectOptions();
  }

  public disconnect() {
    this._stocksWs?.close();
    this._optionsWs?.close();
    this._stocksWs  = null;
    this._optionsWs = null;
    console.log('[MassiveWS] Disconnected.');
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

  private _connectStocks() {
    if (!this._shouldConnect(this._stocksWs)) return;

    console.log('[MassiveWS] Opening Stocks WS…');
    const ws = new WebSocket(this._stocksUrl);
    this._stocksWs = ws;

    ws.onopen = () => {
      console.log('[MassiveWS] Stocks open — authenticating…');
      ws.send(JSON.stringify({ action: 'auth', params: this._apiKey }));
    };

    ws.onmessage = (event) => this._onRawMessage(event.data, 'stocks');

    ws.onclose = () => {
      console.log('[MassiveWS] Stocks WS closed — retrying in 5 s…');
      // Keep the reference until we decide to reconnect so _shouldConnect
      // can inspect the CLOSED state during any StrictMode re-run.
      setTimeout(() => {
        this._stocksWs = null;
        this._connectStocks();
      }, 5000);
    };

    ws.onerror = (err) => console.error('[MassiveWS] Stocks error:', err);
  }

  private _connectOptions() {
    if (!this._shouldConnect(this._optionsWs)) return;

    console.log('[MassiveWS] Opening Options WS…');
    const ws = new WebSocket(this._optionsUrl);
    this._optionsWs = ws;

    ws.onopen = () => {
      console.log('[MassiveWS] Options open — authenticating…');
      ws.send(JSON.stringify({ action: 'auth', params: this._apiKey }));
    };

    ws.onmessage = (event) => this._onRawMessage(event.data, 'options');

    ws.onclose = () => {
      console.log('[MassiveWS] Options WS closed — retrying in 5 s…');
      setTimeout(() => {
        this._optionsWs = null;
        this._connectOptions();
      }, 5000);
    };

    ws.onerror = (err) => console.error('[MassiveWS] Options error:', err);
  }

  // ── Message processing ───────────────────────────────────────────────────

  private _onRawMessage(data: string, source: 'stocks' | 'options') {
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      console.error('[MassiveWS] JSON parse failure:', data);
      return;
    }

    const messages: BaseWSMessage[] = Array.isArray(parsed) ? parsed : [parsed as BaseWSMessage];

    // Handle auth_success / connected status messages before dispatching
    for (const msg of messages) {
      if (msg.ev === 'status') {
        if ((msg as any).status === 'auth_success') {
          console.log(`[MassiveWS] ${source} authenticated.`);
          const subs = source === 'stocks' ? this._stocksSubs : this._optionsSubs;
          const ws   = source === 'stocks' ? this._stocksWs   : this._optionsWs;
          if (ws) this._resubscribeAll(ws, subs);
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
      this._dispatchMessage(msg);
    }
  }

  private _dispatchMessage(raw: BaseWSMessage) {
    if (!raw.ev) return;

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

  // ── Subscription API ─────────────────────────────────────────────────────

  public subscribeStock(channel: StockChannel, ticker: string) {
    const key = `${channel}.${ticker}`;
    this._stocksSubs.add(key);
    if (this._stocksWs?.readyState === WebSocket.OPEN) {
      this._stocksWs.send(JSON.stringify({ action: 'subscribe', params: key }));
    }
  }

  public unsubscribeStock(channel: StockChannel, ticker: string) {
    const key = `${channel}.${ticker}`;
    this._stocksSubs.delete(key);
    if (this._stocksWs?.readyState === WebSocket.OPEN) {
      this._stocksWs.send(JSON.stringify({ action: 'unsubscribe', params: key }));
    }
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
        if (this._optionsWs?.readyState === WebSocket.OPEN) {
          this._optionsWs.send(JSON.stringify({
            action: 'unsubscribe',
            params: evictedKey,
          }));
        }
        console.log(`[MassiveWS] Budget eviction — unsubscribed Q: ${result.evicted}`);
      }
    }

    const key = `${channel}.${ticker}`;
    this._optionsSubs.add(key);
    if (this._optionsWs?.readyState === WebSocket.OPEN) {
      this._optionsWs.send(JSON.stringify({ action: 'subscribe', params: key }));
    }
  }

  public unsubscribeOption(channel: OptionChannel, ticker: string) {
    const key = `${channel}.${ticker}`;
    this._optionsSubs.delete(key);
    if (channel === 'Q') this.budgetManager.evict(ticker);
    if (this._optionsWs?.readyState === WebSocket.OPEN) {
      this._optionsWs.send(JSON.stringify({ action: 'unsubscribe', params: key }));
    }
  }

  // ── Reconnect listener API ───────────────────────────────────────────────

  public onReconnect(fn: () => void)  { this._reconnectListeners.add(fn); }
  public offReconnect(fn: () => void) { this._reconnectListeners.delete(fn); }

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
  import.meta.env.VITE_RELAY_WS_URL    ?? 'wss://socket.massive.com',
);
