'use strict';

/**
 * Chatly Real-Time WebSocket Manager
 * Provides 100% Full-Duplex Bi-Directional Communication
 * Broadcasts QR codes, live chat messages, delivery receipts (ticks), and campaign progress.
 */

const { WebSocketServer } = require('ws');

class WebSocketManager {
  constructor() {
    this.wss = null;
    this.clients = new Set(); // Set of active ws connections
  }

  initialize(server) {
    this.wss = new WebSocketServer({ server, path: '/ws' });

    this.wss.on('connection', (ws, req) => {
      this.clients.add(ws);
      ws.isAlive = true;
      ws.closerId = null;

      ws.on('pong', () => {
        ws.isAlive = true;
      });

      ws.on('message', (raw) => {
        try {
          const data = JSON.parse(raw.toString());
          // Handle client subscription
          if (data.type === 'subscribe') {
            ws.closerId = data.closerId || null;
            ws.role = data.role || 'closer';
            ws.send(JSON.stringify({ type: 'subscribed', closerId: ws.closerId }));
          }
        } catch (_) {}
      });

      ws.on('close', () => {
        this.clients.delete(ws);
      });

      ws.on('error', () => {
        this.clients.delete(ws);
      });

      // Send initial welcome
      ws.send(JSON.stringify({ type: 'connected', timestamp: Date.now() }));
    });

    // Heartbeat interval to clean up dead sockets
    this.heartbeat = setInterval(() => {
      for (const ws of this.clients) {
        if (!ws.isAlive) {
          ws.terminate();
          this.clients.delete(ws);
          continue;
        }
        ws.isAlive = false;
        ws.ping();
      }
    }, 30000);
  }

  // Broadcast to all connected browsers (e.g. admin dashboard)
  broadcast(type, payload) {
    const message = JSON.stringify({ type, payload, timestamp: Date.now() });
    for (const ws of this.clients) {
      if (ws.readyState === ws.OPEN) {
        try {
          ws.send(message);
        } catch (_) {}
      }
    }
  }

  // Send event specifically to a closer or to admins
  sendToCloser(closerId, type, payload) {
    const message = JSON.stringify({ type, payload, timestamp: Date.now() });
    for (const ws of this.clients) {
      if (ws.readyState === ws.OPEN) {
        // Send to targeted closer OR to any company admin monitoring the platform
        if (ws.closerId === closerId || ws.role === 'admin' || !ws.closerId) {
          try {
            ws.send(message);
          } catch (_) {}
        }
      }
    }
  }

  close() {
    if (this.heartbeat) clearInterval(this.heartbeat);
    if (this.wss) {
      for (const ws of this.clients) {
        try { ws.close(); } catch (_) {}
      }
      this.wss.close();
    }
  }
}

const wsManager = new WebSocketManager();
module.exports = wsManager;
