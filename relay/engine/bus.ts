/**
 * In-process message bus — the engine's replacement for lib/massive/websocket.ts.
 *
 * The browser bus opened FOUR outbound WebSockets to the relay
 * (stocksA/B, optionsA/B) at wss://relay.helios-insiders.com. Server-side that
 * would be the relay dialling itself, and it would open a second connection
 * per cluster against an account limited to one. This module instead
 * subscribes to the relay's broadcast fan-out in-process: no socket, no
 * network hop, no second connection.
 *
 * ── Carried over from the browser bus (both load-bearing) ───────────────────
 *
 *  1. Q-before-T ordering within a frame. cvdEngine._handleTrade classifies
 *     each trade against cvdStore.getSpread(). If a trade is processed before
 *     the quote from its own frame, every tick in that frame classifies
 *     against a stale spread. This is correctness, not optimisation.
 *
 *  2. _ct stamping at the boundary. Every downstream consumer reads msg._ct
 *     and never does its own UTC math — the discipline that keeps the
 *     UTC-vs-Central bug class contained. This module is now the single
 *     conversion point.
 *
 * ── Deliberately NOT carried over ──────────────────────────────────────────
 *
 *  - The four sockets and the 45s pair stagger: redundancy against a network
 *    hop that no longer exists.
 *  - The staleness watchdog: it force-closed sockets there are none of. Feed
 *    health is the relay's concern, and it already owns reconnect/backoff.
 *  - document.visibilityState diagnostics: no DOM here.
 *  - The 2s ev:sym:t dedup window: this one would be actively HARMFUL. It
 *    existed because both connections in a redundant pair received identical
 *    broadcasts. With a single in-process source there are no duplicate
 *    deliveries, so the only thing it could still do is silently discard
 *    legitimate distinct trades that happen to share ev+sym+timestamp — a
 *    real occurrence at tick granularity, and an invisible one.
 */

import { toCentralTime } from './lib/time.ts';

// ── Message types ────────────────────────────────────────────────────────────
// Re-declared here (rather than imported from lib/massive/websocket.ts) so the
// engine has no dependency on the browser module, which imports a
// browser-only config and touches `document` at import time.

export interface BaseWSMessage {
  ev:  string;   // 'AM' | 'A' | 'T' | 'Q' | 'LULD' | 'status'
  sym: string;   // ticker symbol
  t?:  number;   // Massive timestamp (UTC ms)
  [key: string]: unknown;
}

export interface WSMessageWithCT extends BaseWSMessage {
  _ct: ReturnType<typeof toCentralTime>;
}

export type WSMessageHandler = (msg: WSMessageWithCT) => void;

type StockChannel  = 'AM' | 'A' | 'T' | 'Q' | 'LULD';
type OptionChannel = 'AM' | 'A' | 'T' | 'Q';

/**
 * The subscribe/unsubscribe surface the engine needs from the relay.
 * relay/index.js supplies this at boot (see engine/index.ts). Keeping it as an
 * injected interface — rather than importing relay/index.js — preserves the
 * one-directional rule: the relay must never depend on engine code.
 */
export interface RelayControl {
  subscribe(channels: string[]): void;
  unsubscribe(channels: string[]): void;
}

// ── EngineBus ────────────────────────────────────────────────────────────────

export class EngineBus {
  private readonly _handlers       = new Map<string, Set<WSMessageHandler>>();
  private readonly _globalHandlers = new Set<WSMessageHandler>();
  private readonly _reconnectListeners = new Set<() => void>();
  private readonly _statusListeners    = new Set<() => void>();

  private readonly _stockSubs  = new Set<string>();
  private readonly _optionSubs = new Set<string>();

  private _relay: RelayControl | null = null;
  private _connected = false;

  // Subscription batching. cvdEngine/luldStore/barsStore each call
  // subscribeStock once per channel per ticker, so a 23-ticker boot issues
  // ~75 separate calls. Sending a WS frame for each one is needless pressure
  // in exactly the window the relay is most fragile — the browser path already
  // batches (one frame, all new channels joined). These queues coalesce a
  // burst of calls into a single subscribe/unsubscribe frame per microtask.
  private _pendingSubscribe   = new Set<string>();
  private _pendingUnsubscribe = new Set<string>();
  private _flushQueued = false;

  private _queueFlush() {
    if (this._flushQueued) return;
    this._flushQueued = true;
    queueMicrotask(() => {
      this._flushQueued = false;
      if (!this._relay) return;   // attach() flushes whatever accumulated
      if (this._pendingSubscribe.size > 0) {
        const batch = [...this._pendingSubscribe];
        this._pendingSubscribe.clear();
        this._relay.subscribe(batch);
      }
      if (this._pendingUnsubscribe.size > 0) {
        const batch = [...this._pendingUnsubscribe];
        this._pendingUnsubscribe.clear();
        this._relay.unsubscribe(batch);
      }
    });
  }

  /**
   * Attach to the relay's in-process fan-out.
   *
   * `control` lets the engine register channel subscriptions; the relay owns
   * the actual upstream sockets and their subscription registry.
   */
  public attach(control: RelayControl) {
    this._relay = control;

    // Anything subscribed before attach (engines initialise before the relay
    // reports ready) is flushed now, so no subscription is silently lost.
    const pending = [...this._stockSubs, ...this._optionSubs];
    if (pending.length > 0) {
      control.subscribe(pending);
      console.log(`[engineBus] Flushed ${pending.length} pre-attach subscription(s).`);
    }
  }

  /**
   * Called by the relay for every upstream frame, already parsed.
   *
   * Takes the whole frame rather than one message at a time because the
   * Q-before-T ordering guarantee is frame-scoped — it cannot be reconstructed
   * from a stream of individual messages.
   */
  public ingestFrame(messages: BaseWSMessage[]) {
    if (!Array.isArray(messages) || messages.length === 0) return;

    if (!this._connected) {
      this._connected = true;
      this._notifyStatusListeners();
    }

    // Quotes first, so a trade never classifies against a stale spread.
    const sorted = [...messages].sort((a, b) => {
      if (a.ev === 'Q' && b.ev !== 'Q') return -1;
      if (a.ev !== 'Q' && b.ev === 'Q') return  1;
      return 0;
    });

    for (const msg of sorted) {
      if (!msg || !msg.ev || msg.ev === 'status') continue;
      this._dispatch(msg);
    }
  }

  private _dispatch(raw: BaseWSMessage) {
    // Single CT conversion point for the entire engine.
    const _ct = toCentralTime(typeof raw.t === 'number' ? raw.t : Date.now());
    const msg: WSMessageWithCT = { ...raw, _ct };

    const evHandlers = this._handlers.get(msg.ev);
    if (evHandlers) {
      for (const h of evHandlers) {
        // Per-handler isolation: one throwing engine handler must not stop
        // the others, and must not propagate into the relay's frame loop.
        try { h(msg); } catch (e) { console.error(`[engineBus] Handler error (${msg.ev}):`, e); }
      }
    }

    for (const h of this._globalHandlers) {
      try { h(msg); } catch (e) { console.error('[engineBus] Global handler error:', e); }
    }
  }

  /**
   * Called by the relay when an upstream reconnects and re-authenticates.
   * barsStore listens for this to gap-fill tickers whose last bar is stale.
   */
  public notifyReconnected() {
    this._connected = true;
    for (const fn of this._reconnectListeners) {
      try { fn(); } catch (e) { console.error('[engineBus] Reconnect listener error:', e); }
    }
    this._notifyStatusListeners();
  }

  private _notifyStatusListeners() {
    for (const fn of this._statusListeners) {
      try { fn(); } catch (e) { console.error('[engineBus] Status listener error:', e); }
    }
  }

  // ── Subscription API (same shape the browser bus exposed) ─────────────────

  public subscribeStock(channel: StockChannel, ticker: string) {
    const key = `${channel}.${ticker}`;
    if (this._stockSubs.has(key)) return;
    this._stockSubs.add(key);
    this._pendingSubscribe.add(key);
    this._queueFlush();
  }

  public unsubscribeStock(channel: StockChannel, ticker: string) {
    const key = `${channel}.${ticker}`;
    this._stockSubs.delete(key);
    this._pendingUnsubscribe.add(key);
    this._queueFlush();
  }

  /**
   * Options subscribe.
   *
   * The browser bus consulted an OptionSubscriptionBudgetManager here to
   * enforce Massive's hard 1,000-contract Q cap, evicting the furthest-OTM
   * contract when full. That budget is deliberately NOT wired here, and this
   * is a settled decision rather than a deferral:
   *
   *   - The cap is per-CONNECTION, and the relay owns the connection. Enforcing
   *     a second budget from the engine, while the browser is also subscribing
   *     over the same relay, would double-count the same contracts.
   *   - Layer 1 sources chain data over REST, not the options WebSocket, so
   *     the engine does not depend on holding option Q subscriptions of its
   *     own to compute.
   *   - The relay's subscription set is shared. Option messages the browser
   *     subscribed to are broadcast in-process to the engine anyway, so the
   *     engine receives them without ever subscribing itself.
   *
   * The relay's own subscription set therefore stays the single authority.
   * lib/massive/budgetManager.ts is left in place, but has no importer since
   * lib/massive/websocket.ts was deleted — it is reference material for
   * whenever subscription ownership does move server-side, not live code.
   */
  public subscribeOption(channel: OptionChannel, ticker: string, _underlyingPrice = 0) {
    const key = `${channel}.${ticker}`;
    if (this._optionSubs.has(key)) return;
    this._optionSubs.add(key);
    this._pendingSubscribe.add(key);
    this._queueFlush();
  }

  public unsubscribeOption(channel: OptionChannel, ticker: string) {
    const key = `${channel}.${ticker}`;
    this._optionSubs.delete(key);
    this._pendingUnsubscribe.add(key);
    this._queueFlush();
  }

  // ── Listener APIs ─────────────────────────────────────────────────────────

  public onReconnect(fn: () => void)  { this._reconnectListeners.add(fn); }
  public offReconnect(fn: () => void) { this._reconnectListeners.delete(fn); }

  public onStatusChange(fn: () => void): () => void {
    this._statusListeners.add(fn);
    return () => this._statusListeners.delete(fn);
  }

  public getConnectionStatus(): 'connecting' | 'connected' | 'disconnected' {
    if (this._connected) return 'connected';
    return this._relay ? 'connecting' : 'disconnected';
  }

  public on(event: string, handler: WSMessageHandler) {
    if (!this._handlers.has(event)) this._handlers.set(event, new Set());
    this._handlers.get(event)!.add(handler);
  }

  public off(event: string, handler: WSMessageHandler) {
    this._handlers.get(event)?.delete(handler);
  }

  public onGlobal(handler: WSMessageHandler)  { this._globalHandlers.add(handler); }
  public offGlobal(handler: WSMessageHandler) { this._globalHandlers.delete(handler); }

  /**
   * Present so callers of the browser bus's rolloverExpiredOptions() do not
   * break. A no-op by design: the engine holds no option subscriptions to
   * evict, because it does not own the options budget (see subscribeOption).
   * It logs rather than silently doing nothing, so a reader of the logs never
   * mistakes this for work that happened.
   */
  public rolloverExpiredOptions(_currentUtcMs: number) {
    console.log('[engineBus] rolloverExpiredOptions: no-op by design — the engine holds no option subscriptions (relay owns the budget).');
  }
}

// ── Singleton ────────────────────────────────────────────────────────────────

/**
 * Exported as `massiveBus` so cvdEngine, barsStore and luldStore keep their
 * existing import shape and stay byte-comparable against the frozen src/ copy
 * during shadow-mode diffing.
 */
export const massiveBus = new EngineBus();
