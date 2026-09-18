// Realtime fan-out. The object carries notification only: it never stores
// board data and never sends a delta, so a missed message can never corrupt
// what a client displays.
//
// The WebSocket Hibernation API is mandatory here. Accepting a socket the
// standard way would bill wall-clock duration for as long as a phone keeps the
// page open, which on the free plan is roughly 10,800 GB-s per day against a
// 13,000 GB-s daily allowance.

export class Lobby {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
  }

  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === '/notify') {
      let payload = null;
      try {
        payload = await request.json();
      } catch (err) {
        payload = null;
      }
      return new Response(JSON.stringify({ sent: this.broadcast(payload) }), {
        headers: { 'content-type': 'application/json' }
      });
    }

    if ((request.headers.get('Upgrade') || '').toLowerCase() !== 'websocket') {
      return new Response('expected a websocket upgrade', { status: 426 });
    }

    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1]);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  broadcast(payload) {
    const body = JSON.stringify(payload || {});
    let sent = 0;
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(body);
        sent++;
      } catch (err) {
        // A socket that died between hibernation and wake is simply skipped.
      }
    }
    return sent;
  }

  // Clients never send data over the socket. An inbound message is only ever a
  // liveness probe, so the answer is a no-op rather than a data path.
  async webSocketMessage(ws, message) {
    if (message === 'ping') {
      try { ws.send('pong'); } catch (err) { /* ignore */ }
    }
  }

  async webSocketClose(ws, code, reason) {
    try { ws.close(code, reason); } catch (err) { /* already closing */ }
  }

  async webSocketError(ws) {
    try { ws.close(1011, 'error'); } catch (err) { /* already closing */ }
  }
}
