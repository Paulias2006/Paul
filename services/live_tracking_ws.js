const WebSocket = require('ws');
const jwt = require('jsonwebtoken');

const clientsByDelivery = new Map(); // deliveryId -> Set<WebSocket>

function addClient(deliveryId, socket) {
  if (!clientsByDelivery.has(deliveryId)) {
    clientsByDelivery.set(deliveryId, new Set());
  }
  clientsByDelivery.get(deliveryId).add(socket);
}

function removeClient(deliveryId, socket) {
  const set = clientsByDelivery.get(deliveryId);
  if (!set) return;
  set.delete(socket);
  if (set.size === 0) {
    clientsByDelivery.delete(deliveryId);
  }
}

function broadcast(deliveryId, payload) {
  const set = clientsByDelivery.get(deliveryId);
  if (!set || set.size === 0) return;
  const message = JSON.stringify(payload);
  for (const client of set) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  }
}

function init(server) {
  const wss = new WebSocket.Server({ server, path: '/ws/tracking' });

  wss.on('connection', (socket) => {
    let subscribedDeliveryId = null;

    socket.on('message', (raw) => {
      try {
        const data = JSON.parse(raw.toString());
        if (data.type === 'subscribe') {
          const { deliveryId, token } = data;
          if (!deliveryId || !token) {
            socket.send(JSON.stringify({ ok: false, error: 'missing_fields' }));
            return;
          }

          jwt.verify(token, process.env.JWT_SECRET || 'your-secret-key', (err) => {
            if (err) {
              socket.send(JSON.stringify({ ok: false, error: 'invalid_token' }));
              return;
            }

            subscribedDeliveryId = String(deliveryId);
            addClient(subscribedDeliveryId, socket);
            socket.send(JSON.stringify({ ok: true, type: 'subscribed', deliveryId: subscribedDeliveryId }));
          });
        }
      } catch (_) {
        socket.send(JSON.stringify({ ok: false, error: 'invalid_payload' }));
      }
    });

    socket.on('close', () => {
      if (subscribedDeliveryId) {
        removeClient(subscribedDeliveryId, socket);
      }
    });
  });

  return wss;
}

module.exports = {
  init,
  broadcast,
};
