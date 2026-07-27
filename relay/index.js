'use strict';

const http = require('http');
const { WebSocketServer, WebSocket } = require('ws');

// ─── Config ──────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 8080;
const MASSIVE_API_KEY = process.env.MASSIVE_API_KEY || '';

const UPSTREAM_URLS = {
  stocks:  'wss://socket.massive.com/stocks',
  options: 'wss://socket.massive.com/options',
  indices: 'wss://socket.massive.com/indices',
};

// Channel prefix → upstream name
// Stocks:  T.*  Q.*  A.*  AM.*   (excluding O: variants)
// Options: T.O: Q.O: A.O: AM.O:
// Indices: V.I: AM.I:
function upstreamForChannel(channel) {
  if (/^(T|Q|A|AM)\.O:/i.test(channel)) return 'options';
  if (/^(V|AM)\.I:/i.test(channel))      return 'indices';
  if (/^(T|Q|A|AM)\./i.test(channel))    return 'stocks';
  return null;
}

// ─── Reconnect backoff ────────────────────────────────────────────────────────

const BACKOFF_STEPS = [15, 30, 60, 120, 120]; // seconds

function backoffMs(attempt) {
  const step = Math.min(attempt, BACKOFF_STEPS.length - 1);
  return BACKOFF_STEPS[step] * 1000;
}

// ─── State ────────────────────────────────────────────────────────────────────

// Connected browser clients
const clients = new Set();

// Per-upstream state
const upstream = {
  stocks:  makeUpstreamState('stocks'),
  options: makeUpstreamState('options'),
  indices: makeUpstreamState('indices'),
};

function makeUpstreamState(name) {
  return {
    name,
    ws: null,
    status: 'disconnected',   // 'connecting' | 'connected' | 'disconnected'
    authed: false,
    reconnectAttempt: 0,
    reconnectTimer: null,
    subscriptions: new Set(), // active channel strings for this socket
    sendQueue: [],             // messages queued before OPEN
  };
}

// ─── Upstream management ──────────────────────────────────────────────────────

function connectUpstream(state) {
  if (state.reconnectTimer) {
    clearTimeout(state.reconnectTimer);
    state.reconnectTimer = null;
  }

  state.status = 'connecting';
  state.authed = false;
  state.sendQueue = [];

  const ws = new WebSocket(UPSTREAM_URLS[state.name]);
  state.ws = ws;

  ws.on('open', () => {
    console.log(`[relay] upstream ${state.name} connected`);
    state.status = 'connected';
    state.reconnectAttempt = 0;

    // Authenticate immediately
    ws.send(JSON.stringify({ action: 'auth', params: MASSIVE_API_KEY }));
  });

  ws.on('message', (data) => {
    const raw = data.toString();
    let messages;
    try { messages = JSON.parse(raw); } catch { return; }

    const arr = Array.isArray(messages) ? messages : [messages];

    for (const msg of arr) {
      // Auth confirmation
      if (
        !state.authed &&
        msg.ev === 'status' &&
        typeof msg.message === 'string' &&
        msg.message.toLowerCase().includes('authenticated')
      ) {
        state.authed = true;
        console.log(`[relay] auth confirmed: ${state.name}`);

        // Flush queued subscriptions
        for (const queued of state.sendQueue) {
          safeSend(state, queued);
        }
        state.sendQueue = [];

        // Reconnect replay
        if (state.subscriptions.size > 0) {
          const params = [...state.subscriptions].join(',');
          safeSend(state, JSON.stringify({ action: 'subscribe', params }));
        }
        continue;
      }

      broadcast(raw);
    }
  });

  ws.on('close', () => {
    state.status = 'disconnected';
    state.authed = false;
    state.ws = null;

    const delay = backoffMs(state.reconnectAttempt);
    state.reconnectAttempt++;
    console.log(`[relay] upstream ${state.name} disconnected — reconnecting in ${delay / 1000}s`);

    state.reconnectTimer = setTimeout(() => connectUpstream(state), delay);
  });

  ws.on('error', (err) => {
    console.error(`[relay] upstream ${state.name} error:`, err.message);
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
    if (!state.authed) {
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

// ─── HTTP server (health check + WebSocket upgrade) ──────────────────────────

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    const body = JSON.stringify({
      status: 'ok',
      upstreams: {
        stocks:  upstream.stocks.status,
        options: upstream.options.status,
        indices: upstream.indices.status,
      },
    });
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
    });
    res.end(body);
    return;
  }

  res.writeHead(404);
  res.end();
});

// ─── WebSocket server (browser clients) ──────────────────────────────────────

const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  clients.add(ws);
  console.log(`[relay] browser client connected (total: ${clients.size})`);

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
        for (const ch of chans) state.subscriptions.add(ch);
        safeSend(state, JSON.stringify({ action: 'subscribe', params: chans.join(',') }));
      }
    }
  });

  ws.on('close', () => {
    clients.delete(ws);
    console.log(`[relay] browser client disconnected (total: ${clients.size})`);
  });

  ws.on('error', (err) => {
    console.error('[relay] browser client error:', err.message);
    clients.delete(ws);
  });
});

// ─── Boot ─────────────────────────────────────────────────────────────────────

server.listen(PORT, () => {
  console.log(`[relay] listening on port ${PORT}`);
  connectUpstream(upstream.stocks);
  connectUpstream(upstream.options);
  connectUpstream(upstream.indices);
});
