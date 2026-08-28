import http from 'http';
import { WebSocketServer, WebSocket } from 'ws';

// ─── Config ──────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 8080;
const MASSIVE_API_KEY = process.env.MASSIVE_API_KEY || '';

const UPSTREAM_URLS = {
  stocks:  'wss://socket.massive.com/stocks',
  options: 'wss://socket.massive.com/options',
  indices: 'wss://socket.massive.com/indices',
};

// Channel prefix → upstream name
function upstreamForChannel(channel) {
  if (/^(T|Q|A|AM)\.O:/i.test(channel)) return 'options';
  if (/^(V|AM)\.I:/i.test(channel))      return 'indices';
  // LULD halt events are an equities mechanism served on the stocks cluster.
  // Without this branch LULD.* channels resolve to null and are silently
  // dropped by the subscribe handler — halt data can never arrive.
  if (/^LULD\./i.test(channel))          return 'stocks';
  if (/^(T|Q|A|AM)\./i.test(channel))    return 'stocks';
  return null;
}

// ─── Reconnect backoff ────────────────────────────────────────────────────────

// Kyle (Massive support) confirmed: WS is a buffered protocol — server-side
// cleanup after a dropped connection takes 10-30 seconds. Reconnect timing
// must respect this window to avoid hitting max_connections immediately.
const BACKOFF_STEPS = [30, 60, 120, 120, 120]; // seconds — minimum 30s per Kyle

function backoffMs(attempt) {
  const step = Math.min(attempt, BACKOFF_STEPS.length - 1);
  return BACKOFF_STEPS[step] * 1000;
}

// ─── State ────────────────────────────────────────────────────────────────────

const clients = new Set();

const upstream = {
  stocks:  makeUpstreamState('stocks'),
  options: makeUpstreamState('options'),
  indices: makeUpstreamState('indices'),
};

function makeUpstreamState(name) {
  return {
    name,
    ws: null,
    _state: 'disconnected',    // 'connecting' | 'connected' | 'disconnected'
    _authConfirmed: false,
    reconnectAttempt: 0,
    reconnectTimer: null,
    subscriptions: new Set(),
    sendQueue: [],
  };
}

// ─── In-process listener registry ────────────────────────────────────────────
// How the engine receives market data: it registers a listener here and is
// called with each already-parsed frame. No WebSocket, no network hop, no
// second upstream connection.
//
// This registry is deliberately one-directional: index.js knows nothing about
// the engine and never imports it. The relay holds the market-data connection,
// which is the scarce, slow-to-recover resource (one per cluster per account,
// 10-30s server-side cleanup). An engine crash must never be able to take that
// down, so nothing engine-side is on this file's import graph.
//
// Note the shape difference from broadcast(): browsers receive the raw frame
// STRING (unchanged wire format), while listeners receive the PARSED array,
// once per frame. Listeners get the whole frame rather than a message at a
// time because the engine's quote-before-trade ordering guarantee is
// frame-scoped and cannot be reconstructed from a flat message stream.

const frameListeners = new Set();

/** Register an in-process consumer of upstream frames. Returns an unsubscribe. */
export function onFrame(listener) {
  frameListeners.add(listener);
  return () => frameListeners.delete(listener);
}

/** Register a consumer notified when an upstream re-authenticates. */
const reconnectListeners = new Set();
export function onUpstreamReconnect(listener) {
  reconnectListeners.add(listener);
  return () => reconnectListeners.delete(listener);
}

function emitFrame(messages) {
  for (const listener of frameListeners) {
    // Per-listener isolation. A throwing listener must not break this loop —
    // the same loop's caller also feeds every browser client.
    try {
      listener(messages);
    } catch (err) {
      console.error('[relay] frame listener error:', err && err.message ? err.message : err);
    }
  }
}

function emitUpstreamReconnect(name) {
  for (const listener of reconnectListeners) {
    try {
      listener(name);
    } catch (err) {
      console.error('[relay] reconnect listener error:', err && err.message ? err.message : err);
    }
  }
}

/**
 * Channel subscription surface handed to the engine at boot.
 *
 * Routes through the same per-upstream subscriptions Set and safeSend() path
 * the browser clients use, so engine and browser share one subscription
 * registry rather than competing over it.
 */
export const relayControl = {
  subscribe(channels) {
    routeChannels(channels, (state, chans) => {
      const fresh = chans.filter((c) => !state.subscriptions.has(c));
      if (fresh.length === 0) return;
      for (const c of fresh) state.subscriptions.add(c);
      safeSend(state, JSON.stringify({ action: 'subscribe', params: fresh.join(',') }));
      console.log(`[relay] engine subscribed ${fresh.length} channel(s) on ${state.name}`);
    });
  },
  unsubscribe(channels) {
    routeChannels(channels, (state, chans) => {
      const known = chans.filter((c) => state.subscriptions.has(c));
      if (known.length === 0) return;
      for (const c of known) state.subscriptions.delete(c);
      safeSend(state, JSON.stringify({ action: 'unsubscribe', params: known.join(',') }));
      console.log(`[relay] engine unsubscribed ${known.length} channel(s) on ${state.name}`);
    });
  },
};

function routeChannels(channels, fn) {
  const grouped = { stocks: [], options: [], indices: [] };
  for (const ch of channels) {
    const name = upstreamForChannel(ch);
    if (name) grouped[name].push(ch);
  }
  for (const [name, chans] of Object.entries(grouped)) {
    if (chans.length > 0) fn(upstream[name], chans);
  }
}

// ─── Upstream management ──────────────────────────────────────────────────────

function connectUpstream(state) {
  // ── CRITICAL GUARD (Kyle / Massive support diagnosis) ──────────────────────
  // 1 connection per asset class is allowed. The server-side cleanup after a
  // dropped connection takes 10-30s (buffered protocol). If a reconnect fires
  // while the prior TCP session is still alive server-side, a second connection
  // is created, max_connections is hit, and the new one is killed with 1006 —
  // creating an infinite loop. Guard against BOTH connecting AND connected states.
  if (state.ws && (
    state.ws.readyState === WebSocket.CONNECTING ||
    state.ws.readyState === WebSocket.OPEN
  )) {
    console.log(`[relay] upstream ${state.name} already ${state._state} — skipping`);
    return;
  }
  // ──────────────────────────────────────────────────────────────────────────

  if (state.reconnectTimer) {
    clearTimeout(state.reconnectTimer);
    state.reconnectTimer = null;
  }

  state._state = 'connecting';
  state._authConfirmed = false;
  state.sendQueue = [];

  console.log(`[relay] upstream ${state.name} connecting...`);

  const ws = new WebSocket(UPSTREAM_URLS[state.name]);
  state.ws = ws;

  ws.on('open', () => {
    state._state = 'connected';
    state.reconnectAttempt = 0;
    console.log(`[relay] upstream ${state.name} connected`);

    ws.send(JSON.stringify({ action: 'auth', params: MASSIVE_API_KEY }));

    state._authConfirmed = false;
    const authTimeout = setTimeout(() => {
      if (!state._authConfirmed) {
        console.log(`[relay] upstream ${state.name} auth timeout — closing`);
        ws.close();
      }
    }, 10000);

    ws.once('close', () => clearTimeout(authTimeout));
  });

  ws.on('message', (data) => {
    const raw = data.toString();

    let messages;
    try { messages = JSON.parse(raw); } catch (err) {
      console.error(`[relay] upstream ${state.name} JSON parse error:`, err.message, 'raw:', raw.slice(0, 200));
      return;
    }

    const arr = Array.isArray(messages) ? messages : [messages];

    // Whether this frame should be forwarded to browser clients at all.
    // A frame consisting solely of the auth-confirmation status is consumed
    // here and never forwarded — same as before.
    let forwardFrame = false;

    for (const msg of arr) {
      if (
        !state._authConfirmed &&
        msg.ev === 'status' &&
        typeof msg.message === 'string' &&
        msg.message.toLowerCase().includes('authenticated')
      ) {
        state._authConfirmed = true;
        console.log(`[relay] auth confirmed: ${state.name}`);
        // Engine-side gap-fill hook (barsStore backfills tickers whose last
        // bar is stale). Fires after every re-auth, not just the first.
        emitUpstreamReconnect(state.name);

        for (const queued of state.sendQueue) {
          if (ws.readyState === WebSocket.OPEN) ws.send(queued);
        }
        state.sendQueue = [];

        if (state.subscriptions.size > 0) {
          const params = [...state.subscriptions].join(',');
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ action: 'subscribe', params }));
          }
        }
        continue;
      }

      // Log any status messages for visibility (catches max_connections etc.)
      if (msg.ev === 'status') {
        console.log(`[relay] upstream ${state.name} status:`, msg.message || JSON.stringify(msg));
      }

      forwardFrame = true;
    }

    // ── Broadcast ONCE per upstream frame ────────────────────────────────────
    // This call used to sit inside the loop above, passing `raw` — the ENTIRE
    // frame — once per message in that frame. A frame of N messages was
    // therefore delivered N times, each copy containing all N: browsers
    // received N² messages (N=10 → 100, N=20 → 400, N=50 → 2,500).
    //
    // It was invisible because the browser bus dedupes on `ev:sym:t` within a
    // 2s window — every duplicate was discarded, but only AFTER paying full
    // network and JSON.parse cost. That load is a direct cause of browser
    // clients failing to answer the relay's 30s heartbeat ping (81% of all
    // measured disconnects), and is a plausible trigger for Massive's
    // slow-consumer disconnects upstream.
    //
    // The wire format is unchanged: browsers still receive exactly the raw
    // frame string, just once instead of N times. Nothing frontend-side needs
    // to change.
    if (forwardFrame) broadcast(raw);

    // In-process engine delivery. Runs after the browser fan-out so a slow or
    // throwing engine listener can never delay a browser's frame, and gets the
    // PARSED array rather than the raw string (see the registry above).
    if (forwardFrame && frameListeners.size > 0) emitFrame(arr);
  });

  ws.on('close', (code, reason) => {
    const prevState = state._state;
    state._state = 'disconnected';
    state._authConfirmed = false;
    state.ws = null;

    const delay = backoffMs(state.reconnectAttempt);
    state.reconnectAttempt++;
    console.log(`[relay] upstream ${state.name} disconnected (code ${code}, was ${prevState}) — reconnecting in ${delay / 1000}s`);
    if (reason && reason.length > 0) {
      console.log(`[relay] upstream ${state.name} close reason:`, reason.toString());
    }

    state.reconnectTimer = setTimeout(() => connectUpstream(state), delay);
  });

  ws.on('error', (err) => {
    console.error(`[relay] upstream ${state.name} error:`, err.message);
    // 'close' will follow
  });
}

function safeSend(state, message) {
  if (!state.ws) {
    state.sendQueue.push(message);
    return;
  }
  const rs = state.ws.readyState;
  if (rs === WebSocket.CONNECTING) {
    state.sendQueue.push(message);
  } else if (rs === WebSocket.OPEN) {
    if (!state._authConfirmed) {
      state.sendQueue.push(message);
    } else {
      state.ws.send(message);
    }
  }
}

function broadcast(raw) {
  for (const client of clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(raw);
    }
  }
}

// ─── HTTP + WebSocket server ──────────────────────────────────────────────────

const server = http.createServer();

server.on('request', (req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    const body = JSON.stringify({
      status: 'ok',
      upstreams: {
        stocks:  upstream.stocks._state,
        options: upstream.options._state,
        indices: upstream.indices._state
      }
    });
    res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
    res.end(body);
    return;
  }

  if (req.method === 'OPTIONS' && req.url && req.url.startsWith('/rest/')) {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Accept',
    });
    res.end();
    return;
  }

  if (req.method === 'GET' && req.url && req.url.startsWith('/rest/')) {
    handleRestProxy(req, res);
    return;
  }

  res.writeHead(404);
  res.end();
});

// ─── REST proxy (browser → relay → Massive) ──────────────────────────────────
// Everything after /rest/ is forwarded as-is to api.massive.com, with the
// apiKey attached server-side. The browser never sends or sees the key.
// This does NOT touch wss/upgrade handling — that runs on a separate event.
// Browser-side fetch calls give up after 25s. Without its own timeout, a
// slow/hung upstream call here keeps running orphaned past that point — the
// browser has already moved on, but the relay is still waiting. A 20s timeout
// (inside the browser's 25s) makes the relay give up first and return a real
// error response instead of leaving the request dangling.
const REST_PROXY_TIMEOUT_MS = 20_000;

async function handleRestProxy(req, res) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REST_PROXY_TIMEOUT_MS);

  try {
    const incoming = new URL(req.url, 'http://internal');
    const forwardPath = incoming.pathname.slice('/rest'.length); // keep leading '/'
    const target = new URL(forwardPath, 'https://api.massive.com');
    for (const [key, value] of incoming.searchParams) {
      target.searchParams.append(key, value);
    }
    target.searchParams.set('apiKey', MASSIVE_API_KEY);

    const upstreamRes = await fetch(target.toString(), { method: 'GET', signal: controller.signal });
    const bodyText = await upstreamRes.text();

    res.writeHead(upstreamRes.status, {
      'Content-Type': upstreamRes.headers.get('content-type') || 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Accept',
    });
    res.end(bodyText);
  } catch (err) {
    const timedOut = err.name === 'AbortError';
    console.error('[relay] REST proxy error:', timedOut ? `timed out after ${REST_PROXY_TIMEOUT_MS / 1000}s` : err.message);
    res.writeHead(timedOut ? 504 : 502, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Accept',
    });
    res.end(JSON.stringify({ error: 'relay proxy failed', message: timedOut ? 'upstream request timed out' : err.message }));
  } finally {
    clearTimeout(timeout);
  }
}

// ─── WebSocket server (browser clients) ──────────────────────────────────────

const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  clients.add(ws);
  console.log(`[relay] browser client connected (total: ${clients.size})`);

  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.send(JSON.stringify({
    type: 'connected',
    streams: ['stocks', 'options', 'indices'],
  }));

  ws.on('message', (data) => {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }

    if (msg.action === 'subscribe' && typeof msg.params === 'string') {
      const channels = msg.params.split(',').map(c => c.trim()).filter(Boolean);

      const grouped = { stocks: [], options: [], indices: [] };
      for (const ch of channels) {
        const name = upstreamForChannel(ch);
        if (name) grouped[name].push(ch);
      }

      for (const [name, chans] of Object.entries(grouped)) {
        if (chans.length === 0) continue;
        const state = upstream[name];

        const newChans = chans.filter((ch) => !state.subscriptions.has(ch));
        if (newChans.length === 0) {
          console.log(`[relay] ${name}: all ${chans.length} requested channel(s) already subscribed — skipping resubscribe`);
          continue;
        }

        for (const ch of newChans) state.subscriptions.add(ch);
        safeSend(state, JSON.stringify({ action: 'subscribe', params: newChans.join(',') }));
        console.log(`[relay] ${name}: forwarded ${newChans.length} new channel(s), skipped ${chans.length - newChans.length} already-subscribed`);
      }
    }
  });

  ws.on('close', (code, reason) => {
    clients.delete(ws);
    console.log(`[relay] browser client disconnected code=${code} reason="${reason}" (total: ${clients.size})`);
  });

  ws.on('error', (err) => {
    console.error('[relay] browser client error:', err.message);
    clients.delete(ws);
  });
});

// ─── Heartbeat (reap dead browser clients) ───────────────────────────────────

// 30s (was 15s): under full data load (100+ channels, engines computing on the
// same thread), the browser's main thread can stall long enough that pong
// frames queue behind pending work and miss a 15s window even though the
// connection itself is healthy. Confirmed live — 81% of browser disconnects in
// one measured window were heartbeat terminations, not real network drops.
// 30s gives roughly a 60s grace period before termination. This is a stopgap;
// the real fix is moving engines server-side so the browser stops consuming
// the full stream on its own thread.
const HEARTBEAT_INTERVAL_MS = 30000;

const heartbeatInterval = setInterval(() => {
  for (const ws of clients) {
    if (ws.isAlive === false) {
      console.log('[relay] browser client failed heartbeat — terminating');
      clients.delete(ws);
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}, HEARTBEAT_INTERVAL_MS);

// ─── Boot ─────────────────────────────────────────────────────────────────────

// Staggered startup: each asset class connection is offset by 5 seconds.
// This prevents simultaneous connection attempts from creating a race condition
// against any lingering server-side sessions from a prior deployment.
// Kyle (Massive support) confirmed server cleanup takes 10-30s after a close.
server.listen(PORT, () => {
  console.log(`[relay] listening on port ${PORT}`);
  console.log(`[relay] node ${process.version} | ESM | engine mode: ${process.env.ENGINE_MODE ?? 'none'}`);

  // stocks — connect immediately
  connectUpstream(upstream.stocks);

  // options — 20s. The prior 5s was INSIDE Kyle's documented 10-30s cleanup
  // window and lost the race at a real deploy: "Maximum number of websocket
  // connections exceeded", then a 30s backoff before it succeeded. 20s clears
  // the window with margin and is still faster than the failure path.
  setTimeout(() => connectUpstream(upstream.options), 20000);

  // indices — 30s
  setTimeout(() => connectUpstream(upstream.indices), 30000);

  maybeStartEngine();
});

// ─── Engine startup (ENGINE_MODE-gated) ──────────────────────────────────────
//
// Three states:
//   unset / 'off'  engine is not imported at all — this file behaves exactly
//                  as it did before the engine existed.
//   'shadow'       engine runs and computes, every DB write intercepted.
//   'live'         engine runs and owns writes.
//
// The import is DYNAMIC and inside the enabled branch on purpose: with the
// engine off, none of its modules are on this file's import graph, so an
// engine-side import error cannot affect the relay. Turning the engine on is
// then a Railway environment-variable change, not a code deploy.

let engineModule = null;

/** Resolves the first time any upstream authenticates. */
let _resolveUpstreamReady;
const upstreamReady = new Promise((resolve) => { _resolveUpstreamReady = resolve; });
onUpstreamReconnect(() => { if (_resolveUpstreamReady) { _resolveUpstreamReady(); _resolveUpstreamReady = null; } });

async function maybeStartEngine() {
  const mode = (process.env.ENGINE_MODE ?? '').trim().toLowerCase();
  if (mode === '' || mode === 'off' || mode === 'none') {
    console.log('[relay] ENGINE_MODE not set — engine disabled, relay-only mode.');
    return;
  }

  try {
    engineModule = await import('./engine/index.ts');

    // Frames reach the engine only once it is loaded. Registered here rather
    // than inside the engine so the relay owns the subscription lifetime.
    onFrame((messages) => engineModule.__bus.ingestFrame(messages));
    onUpstreamReconnect(() => engineModule.__bus.notifyReconnected());

    await engineModule.startEngine(relayControl, { waitForUpstream: upstreamReady });
  } catch (err) {
    // An engine failure must never take down the relay: the relay holds the
    // market-data connection, which is the scarce, slow-to-recover resource.
    console.error('[relay] ENGINE FAILED TO START — continuing in relay-only mode:', err);
    engineModule = null;
  }
}

// ─── Graceful shutdown ───────────────────────────────────────────────────────
//
// Railway's SIGTERM→SIGKILL buffer defaults to 0 seconds (configurable only
// via the RAILWAY_DEPLOYMENT_DRAINING_SECONDS service variable), so this
// handler may not get to run at all. Nothing here is load-bearing for
// correctness — ingestion jobs never advance a watermark for unfinished work,
// and each is resumable — this only makes a clean exit cleaner when a drain
// budget exists.
//
// Order: stop engine work FIRST, so nothing is left computing against a feed
// that has already gone away. Then close upstreams deliberately, because
// Massive's server-side cleanup takes 10-30s and a clean close makes the next
// boot's 0/20/30s stagger far more likely to win its race.

let _shuttingDown = false;

async function shutdown(signal) {
  if (_shuttingDown) return;
  _shuttingDown = true;
  console.log(`[relay] ${signal} received — shutting down.`);

  clearInterval(heartbeatInterval);

  if (engineModule) {
    try { await engineModule.stopEngine(signal); }
    catch (err) { console.error('[relay] engine shutdown error:', err); }
  }

  for (const state of Object.values(upstream)) {
    if (state.reconnectTimer) clearTimeout(state.reconnectTimer);
    if (state.ws) {
      try { state.ws.close(1001, 'relay shutting down'); }
      catch { /* already closing */ }
    }
  }
  console.log('[relay] Upstream sockets closed.');

  for (const client of clients) {
    try { client.close(1001, 'relay restarting'); } catch { /* ignore */ }
  }

  server.close(() => {
    console.log('[relay] Shutdown complete.');
    process.exit(0);
  });
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT',  () => void shutdown('SIGINT'));
