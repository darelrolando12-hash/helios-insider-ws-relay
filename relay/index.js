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

    for (const msg of arr) {
      if (
        !state._authConfirmed &&
        msg.ev === 'status' &&
        typeof msg.message === 'string' &&
        msg.message.toLowerCase().includes('authenticated')
      ) {
        state._authConfirmed = true;
        console.log(`[relay] auth confirmed: ${state.name}`);

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

      broadcast(raw);
    }
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

const HEARTBEAT_INTERVAL_MS = 15000; // 15s — no external constraint on this, just detecting dead browser clients fast

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

  // options — connect after 5s (clear prior session server-side)
  setTimeout(() => connectUpstream(upstream.options), 5000);

  // indices — connect after 10s
  setTimeout(() => connectUpstream(upstream.indices), 10000);
});
