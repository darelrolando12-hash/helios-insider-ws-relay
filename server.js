/**
 * Helios Insiders WebSocket Relay
 * Independent service — separate Railway deployment from v4.0's relay.
 * Forked from v4.0 relay/server.js. Log prefix changed to [insiders-relay].
 *
 * ENV VARS (set in Railway dashboard):
 *   MASSIVE_API_KEY  — Insiders Massive API key (can be same key as v4.0 — see Phase 1 notes)
 *   PORT             — set automatically by Railway
 */

const { WebSocket, WebSocketServer } = require('ws');
const http = require('http');

const MASSIVE_API_KEY  = process.env.MASSIVE_API_KEY;
const STOCKS_WS_URL    = 'wss://socket.massive.com/stocks';
const OPTIONS_WS_URL   = 'wss://socket.massive.com/options';
const PORT             = parseInt(process.env.PORT ?? '8080', 10);

const RECONNECT_DELAYS = [15_000, 20_000, 30_000, 45_000, 60_000];

if (!MASSIVE_API_KEY) {
  console.error('[insiders-relay] FATAL: MASSIVE_API_KEY not set — exiting');
  process.exit(1);
}

const stocksConn  = { ws: null, authenticated: false, reconnectAttempt: 0, reconnectTimer: null, closed: false };
const optionsConn = { ws: null, authenticated: false, reconnectAttempt: 0, reconnectTimer: null, closed: false };

const stocksClients  = new Set();
const optionsClients = new Set();
const upstreamStocksSubs  = new Set();
const upstreamOptionsSubs = new Set();

function getDelay(conn) {
  return RECONNECT_DELAYS[Math.min(conn.reconnectAttempt, RECONNECT_DELAYS.length - 1)];
}

function broadcast(clients, raw) {
  for (const c of clients) {
    if (c.readyState === WebSocket.OPEN) {
      try { c.send(raw); } catch { clients.delete(c); }
    } else {
      clients.delete(c);
    }
  }
}

// ── HTTP server for Railway health check ──────────────────────────────────────

const httpServer = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ok: true,
      stocks:  { authenticated: stocksConn.authenticated,  clients: stocksClients.size },
      options: { authenticated: optionsConn.authenticated, clients: optionsClients.size },
    }));
    return;
  }
  res.writeHead(404);
  res.end();
});

// ── WebSocket servers for browser clients ─────────────────────────────────────

const stocksWSSServer  = new WebSocketServer({ noServer: true });
const optionsWSSServer = new WebSocketServer({ noServer: true });

httpServer.on('upgrade', (req, socket, head) => {
  if (req.url === '/stocks') {
    stocksWSSServer.handleUpgrade(req, socket, head, ws => stocksWSSServer.emit('connection', ws, req));
  } else if (req.url === '/options') {
    optionsWSSServer.handleUpgrade(req, socket, head, ws => optionsWSSServer.emit('connection', ws, req));
  } else {
    socket.destroy();
  }
});

// ── Stocks upstream ────────────────────────────────────────────────────────────

function connectStocksUpstream() {
  if (stocksConn.closed) return;
  if (stocksConn.ws && (
    stocksConn.ws.readyState === WebSocket.OPEN ||
    stocksConn.ws.readyState === WebSocket.CONNECTING
  )) {
    console.log('[insiders-relay/stocks] Already connecting or open — skipping');
    return;
  }

  console.log('[insiders-relay/stocks] Connecting upstream...');
  const ws = new WebSocket(STOCKS_WS_URL);
  stocksConn.ws = ws;
  stocksConn.authenticated = false;

  ws.on('open', () => {
    console.log('[insiders-relay/stocks] Upstream connected — authenticating...');
    ws.send(JSON.stringify({ action: 'auth', params: MASSIVE_API_KEY }));
  });

  ws.on('message', (data) => {
    const raw = data.toString();
    try {
      const messages = JSON.parse(raw);
      let successCount = 0;
      for (const msg of (Array.isArray(messages) ? messages : [messages])) {
        if (msg.ev === 'status') {
          if (msg.status === 'auth_success') {
            console.log('[insiders-relay/stocks] Upstream authenticated ✅');
            stocksConn.authenticated = true;
            stocksConn.reconnectAttempt = 0;
            if (upstreamStocksSubs.size > 0) {
              const params = [...upstreamStocksSubs].join(',');
              stocksConn.ws.send(JSON.stringify({ action: 'subscribe', params }));
              console.log(`[insiders-relay/stocks] Re-subscribed ${upstreamStocksSubs.size} params`);
            }
          } else if (msg.status === 'auth_failed') {
            console.error('[insiders-relay/stocks] Auth FAILED — check MASSIVE_API_KEY');
            stocksConn.closed = true;
          } else if (msg.status === 'success') {
            successCount++;
          } else if (msg.status !== 'connected') {
            console.warn('[insiders-relay/stocks] Status:', msg.status, msg.message ?? '');
          }
        }
      }
      if (successCount > 0) {
        console.log(`[insiders-relay/stocks] Confirmed ${successCount} subscription(s)`);
      }
    } catch (err) {
      console.error('[insiders-relay/stocks] Parse error:', err.message, '| raw:', raw.slice(0, 200));
    }
    broadcast(stocksClients, raw);
  });

  ws.on('close', (code, reason) => {
    stocksConn.authenticated = false;
    if (stocksConn.closed) return;
    const delay = getDelay(stocksConn);
    stocksConn.reconnectAttempt++;
    console.warn(`[insiders-relay/stocks] Upstream closed (${code}) reason="${reason?.toString() || 'none'}" — reconnecting in ${delay / 1000}s`);
    stocksConn.reconnectTimer = setTimeout(connectStocksUpstream, delay);
  });

  ws.on('error', (err) => {
    console.error('[insiders-relay/stocks] Upstream error:', err.message);
  });
}

// ── Options upstream ───────────────────────────────────────────────────────────

function connectOptionsUpstream() {
  if (optionsConn.closed) return;
  if (optionsConn.ws && (
    optionsConn.ws.readyState === WebSocket.OPEN ||
    optionsConn.ws.readyState === WebSocket.CONNECTING
  )) {
    console.log('[insiders-relay/options] Already connecting or open — skipping');
    return;
  }

  console.log('[insiders-relay/options] Connecting upstream...');
  const ws = new WebSocket(OPTIONS_WS_URL);
  optionsConn.ws = ws;
  optionsConn.authenticated = false;

  ws.on('open', () => {
    console.log('[insiders-relay/options] Upstream connected — authenticating...');
    ws.send(JSON.stringify({ action: 'auth', params: MASSIVE_API_KEY }));
  });

  ws.on('message', (data) => {
    const raw = data.toString();
    try {
      const messages = JSON.parse(raw);
      let successCount = 0;
      for (const msg of (Array.isArray(messages) ? messages : [messages])) {
        if (msg.ev === 'status') {
          if (msg.status === 'auth_success') {
            console.log('[insiders-relay/options] Upstream authenticated ✅');
            optionsConn.authenticated = true;
            optionsConn.reconnectAttempt = 0;
            if (upstreamOptionsSubs.size > 0) {
              const params = [...upstreamOptionsSubs].join(',');
              optionsConn.ws.send(JSON.stringify({ action: 'subscribe', params }));
              console.log(`[insiders-relay/options] Re-subscribed ${upstreamOptionsSubs.size} params`);
            }
          } else if (msg.status === 'auth_failed') {
            console.error('[insiders-relay/options] Auth FAILED — check MASSIVE_API_KEY');
            optionsConn.closed = true;
          } else if (msg.status === 'success') {
            successCount++;
          } else if (msg.status !== 'connected') {
            console.warn('[insiders-relay/options] Status:', msg.status, msg.message ?? '');
          }
        }
      }
      if (successCount > 0) {
        console.log(`[insiders-relay/options] Confirmed ${successCount} subscription(s)`);
      }
    } catch (err) {
      console.error('[insiders-relay/options] Parse error:', err.message, '| raw:', raw.slice(0, 200));
    }
    broadcast(optionsClients, raw);
  });

  ws.on('close', (code, reason) => {
    optionsConn.authenticated = false;
    if (optionsConn.closed) return;
    const delay = getDelay(optionsConn);
    optionsConn.reconnectAttempt++;
    console.warn(`[insiders-relay/options] Upstream closed (${code}) — reconnecting in ${delay / 1000}s`);
    optionsConn.reconnectTimer = setTimeout(connectOptionsUpstream, delay);
  });

  ws.on('error', (err) => {
    console.error('[insiders-relay/options] Upstream error:', err.message);
  });
}

// ── Browser client: /stocks ────────────────────────────────────────────────────

stocksWSSServer.on('connection', (client) => {
  stocksClients.add(client);
  console.log(`[insiders-relay/stocks] Browser connected (total: ${stocksClients.size})`);

  if (client.readyState === WebSocket.OPEN) {
    client.send(JSON.stringify([{ ev: 'status', status: 'connected', message: 'Connected via Insiders relay' }]));
    if (stocksConn.authenticated) {
      client.send(JSON.stringify([{ ev: 'status', status: 'auth_success', message: 'Authenticated via Insiders relay' }]));
    }
  }

  client.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());
      const { action, params = '' } = msg;

      if (action === 'subscribe') {
        const toAdd = params.split(',').map((p) => p.trim()).filter(Boolean);
        const newSubs = toAdd.filter(p => !upstreamStocksSubs.has(p));
        toAdd.forEach(p => upstreamStocksSubs.add(p));
        if (newSubs.length > 0 && stocksConn.ws?.readyState === WebSocket.OPEN && stocksConn.authenticated) {
          const BATCH = 100;
          for (let i = 0; i < newSubs.length; i += BATCH) {
            stocksConn.ws.send(JSON.stringify({ action: 'subscribe', params: newSubs.slice(i, i + BATCH).join(',') }));
          }
          console.log(`[insiders-relay/stocks] Forwarded ${newSubs.length} new subscription(s)`);
        }
      } else if (action === 'auth') {
        if (client.readyState === WebSocket.OPEN) {
          client.send(JSON.stringify([{ ev: 'status', status: 'auth_success', message: 'Auth handled by relay' }]));
        }
      }
    } catch (err) {
      console.error('[insiders-relay/stocks] Browser message error:', err.message);
    }
  });

  client.on('close', (code) => {
    stocksClients.delete(client);
    console.log(`[insiders-relay/stocks] Browser disconnected (${code}) — ${stocksClients.size} remaining`);
  });

  client.on('error', (err) => {
    console.error('[insiders-relay/stocks] Browser client error:', err.message);
    stocksClients.delete(client);
  });
});

// ── Browser client: /options ──────────────────────────────────────────────────

optionsWSSServer.on('connection', (client) => {
  optionsClients.add(client);
  console.log(`[insiders-relay/options] Browser connected (total: ${optionsClients.size})`);

  if (client.readyState === WebSocket.OPEN) {
    client.send(JSON.stringify([{ ev: 'status', status: 'connected', message: 'Connected via Insiders relay' }]));
    if (optionsConn.authenticated) {
      client.send(JSON.stringify([{ ev: 'status', status: 'auth_success', message: 'Authenticated via Insiders relay' }]));
    }
  }

  client.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());
      const { action, params = '' } = msg;

      if (action === 'subscribe') {
        const toAdd = params.split(',').map(p => p.trim()).filter(Boolean);
        const newSubs = toAdd.filter(p => !upstreamOptionsSubs.has(p));
        toAdd.forEach(p => upstreamOptionsSubs.add(p));
        if (newSubs.length > 0 && optionsConn.ws?.readyState === WebSocket.OPEN && optionsConn.authenticated) {
          const BATCH = 100;
          for (let i = 0; i < newSubs.length; i += BATCH) {
            optionsConn.ws.send(JSON.stringify({ action: 'subscribe', params: newSubs.slice(i, i + BATCH).join(',') }));
          }
          console.log(`[insiders-relay/options] Forwarded ${newSubs.length} new subscription(s)`);
        }
      } else if (action === 'auth') {
        if (client.readyState === WebSocket.OPEN) {
          client.send(JSON.stringify([{ ev: 'status', status: 'auth_success', message: 'Auth handled by relay' }]));
        }
      }
    } catch (err) {
      console.error('[insiders-relay/options] Browser message error:', err.message);
    }
  });

  client.on('close', (code) => {
    optionsClients.delete(client);
    console.log(`[insiders-relay/options] Browser disconnected (${code}) — ${optionsClients.size} remaining`);
  });

  client.on('error', (err) => {
    console.error('[insiders-relay/options] Browser client error:', err.message);
    optionsClients.delete(client);
  });
});

// ── Start ─────────────────────────────────────────────────────────────────────

httpServer.listen(PORT, () => {
  console.log(`[insiders-relay] Listening on port ${PORT}`);
  console.log(`[insiders-relay] Health: GET /health`);
  console.log(`[insiders-relay] Stocks:  wss://<host>/stocks`);
  console.log(`[insiders-relay] Options: wss://<host>/options`);
});

connectStocksUpstream();
connectOptionsUpstream();

process.on('SIGTERM', () => {
  console.log('[insiders-relay] SIGTERM — closing');
  stocksConn.closed = true;
  optionsConn.closed = true;
  if (stocksConn.ws)  stocksConn.ws.close();
  if (optionsConn.ws) optionsConn.ws.close();
  httpServer.close(() => process.exit(0));
});
