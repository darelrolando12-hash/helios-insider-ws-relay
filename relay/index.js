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
    _state: 'disconnected',    // 'connecting' | 'connected' | 'disconnected'
    _authConfirmed: false,
    reconnectAttempt: 0,
    reconnectTimer: null,
    subscriptions: new Set(),  // active channel strings for this socket
    sendQueue: [],              // messages queued before auth confirmed
  };
}

// ─── Upstream management ──────────────────────────────────────────────────────

function connectUpstream(state) {
  if (state.reconnectTimer) {
    clearTimeout(state.reconnectTimer);
    state.reconnectTimer = null;
  }

  state._state = 'connecting';
  state._authConfirmed = false;
  state.sendQueue = [];

  const ws = new WebSocket(UPSTREAM_URLS[state.name]);
  state.ws = ws;

  ws.on('open', () => {
    state._state = 'connected';
    state.reconnectAttempt = 0;
    console.log(`[relay] upstream ${state.name} connected`);

    // Send auth immediately on open — do NOT send before this event
    ws.send(JSON.stringify({ action: 'auth', params: MASSIVE_API_KEY }));

    // Auth timeout guard — if auth not confirmed within 10s, close and reconnect
    state._authConfirmed = false;
    const authTimeout = setTimeout(() => {
      if (!state._authConfirmed) {
        console.log(`[relay] upstream ${state.name} auth timeout — reconnecting`);
        ws.close();
      }
    }, 10000);

    ws.once('close', () => clearTimeout(authTimeout));
  });

  ws.on('message', (data) => {
    const raw = data.toString();
    let messages;
    try { messages = JSON.parse(raw); } catch { return; }

    // Massive sends arrays
    const arr = Array.isArray(messages) ? messages : [messages];

    for (const msg of arr) {
      // Auth confirmation: ev === 'status' with message containing 'authenticated'
      if (
        !state._authConfirmed &&
        msg.ev === 'status' &&
        typeof msg.message === 'string' &&
        msg.message.toLowerCase().includes('authenticated')
      ) {
        state._authConfirmed = true;
        console.log(`[relay] auth confirmed: ${state.name}`);

        // Flush subscriptions queued before auth
        for (const queued of state.sendQueue) {
          if (ws.readyState === WebSocket.OPEN) ws.send(queued);
        }
        state.sendQueue = [];

        // Reconnect replay — re-subscribe to all active subscriptions
        if (state.subscriptions.size > 0) {
          const params = [...state.subscriptions].join(',');
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ action: 'subscribe', params }));
          }
        }
        continue;
      }

      // Forward all data to all browser clients
      broadcast(raw);
    }
  });

  ws.on('close', () => {
    state._state = 'disconnected';
    state._authConfirmed = false;
    state.ws = null;

    const delay = backoffMs(state.reconnectAttempt);
    state.reconnectAttempt++;
    console.log(`[relay] upstream ${state.name} disconnected — reconnecting in ${delay / 1000}s`);

    state.reconnectTimer = setTimeout(() => connectUpstream(state), delay);
  });

  ws.on('error', (err) => {
    console.error(`[relay] upstream ${state.name} error:`, err.message);
    // 'close' will follow — handled above
  });
}

function safeSend(state, message) {
  if (!state.ws) {
    state.sendQueue.push(message);
    return;
  }
  const rs = state.ws.readyState;
  if (rs === WebSocket.CONNECTING) {
    // Queue until 'open' + auth
    state.sendQueue.push(message);
  } else if (rs === WebSocket.OPEN) {
    if (!state._authConfirmed) {
      // Queue until auth confirmation
      state.sendQueue.push(message);
    } else {
      state.ws.send(message);
    }
  }
  // CLOSING or CLOSED — drop, reconnect will replay subscriptions
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
  res.writeHead(404);
  res.end();
});

// ─── WebSocket server (browser clients) ──────────────────────────────────────

const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  clients.add(ws);
  console.log(`[relay] browser client connected (total: ${clients.size})`);

  // Greet client
  ws.send(JSON.stringify({
    type: 'connected',
    streams: ['stocks', 'options', 'indices'],
  }));

  ws.on('message', (data) => {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }

    if (msg.action === 'subscribe' && typeof msg.params === 'string') {
      const channels = msg.params.split(',').map(c => c.trim()).filter(Boolean);

      // Group channels by upstream
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
