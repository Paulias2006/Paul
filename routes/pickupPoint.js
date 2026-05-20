const express = require('express');
const crypto = require('crypto');
const axios = require('axios');

const Message = require('../models/Message');
const User = require('../models/User');
const { authenticateToken } = require('../middleware/auth');

const router = express.Router();

const DELIVERY_VISIBLE_DAYS = 7;
const SYNC_SECRET =
  process.env.WEEDELIVRED_SYNC_SECRET ||
  process.env.PAYGATE_WEBHOOK_SECRET ||
  '';
const WEESHOP_DELIVERY_SYNC_URL =
  process.env.WEESHOP_WEEDELIVRED_DELIVERY_SYNC_URL ||
  process.env.WEESHOP_DELIVERY_SYNC_URL ||
  'https://weeshop.onrender.com/api/paygate/weedelivred-delivery-sync';

function oneWeekAgoDate() {
  return new Date(Date.now() - DELIVERY_VISIBLE_DAYS * 24 * 60 * 60 * 1000);
}

function notExpiredClause() {
  return {
    $or: [
      { expiresAt: { $exists: false } },
      { expiresAt: null },
      { expiresAt: { $gt: new Date() } },
    ],
  };
}

function normalizePhoneDigits(value) {
  return String(value || '').replace(/\D/g, '');
}

function sameTogoPhone(a, b) {
  const left = normalizePhoneDigits(a);
  const right = normalizePhoneDigits(b);
  if (!left || !right) return false;
  return left === right || left.slice(-8) === right.slice(-8);
}

function buildSyncSignatureHeaders(payload) {
  if (!SYNC_SECRET) {
    return { 'Content-Type': 'application/json' };
  }
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = crypto.randomBytes(12).toString('hex');
  const raw = JSON.stringify(payload || {});
  const signature = crypto
    .createHmac('sha256', SYNC_SECRET)
    .update(`${timestamp}.${nonce}.${raw}`)
    .digest('hex');
  return {
    'Content-Type': 'application/json',
    'X-Webhook-Timestamp': timestamp,
    'X-Webhook-Nonce': nonce,
    'X-Webhook-Signature': signature,
  };
}

function serializeDelivery(message) {
  const meta = message.metadata || {};
  return {
    id: String(message._id),
    subject: message.subject || '',
    orderId: meta.orderId || '',
    orderNumber: meta.orderNumber || '',
    status: meta.pickupPointStatus || meta.status || '',
    deliveryStatus: meta.deliveryStatus || '',
    clientName: meta.clientUsername || 'Client',
    clientPhone: meta.clientPhone || '',
    boutiqueName: meta.boutiqueNom || meta.vendeurUsername || 'Boutique',
    fromLabel: meta.from_label || '',
    fromAddress: meta.from_address || meta.boutiqueAddress || '',
    toLabel: meta.to_label || 'Point de retrait',
    toAddress: meta.to_address || '',
    totalAmount: meta.totalAmount || 0,
    deliveryFee: meta.delivery_fee || 0,
    pickupPointShare: meta.pickup_point_share || 0,
    items: Array.isArray(meta.items) ? meta.items : [],
    createdAt: message.createdAt,
    dropoffAt: meta.pickupPointDropoffAt || null,
    confirmedAt: meta.pickupPointConfirmedAt || null,
    handedOverAt: meta.pickupPointHandedOverAt || null,
  };
}

async function loadPickupPointUser(req, res) {
  const user = await User.findById(req.user.userId).lean();
  if (!user) {
    res.status(404).json({ ok: false, error: 'user_not_found' });
    return null;
  }
  if (!['pickup_point', 'admin'].includes(String(user.role || ''))) {
    res.status(403).json({
      ok: false,
      error: 'pickup_point_only',
      message: 'Acces reserve aux points de retrait',
    });
    return null;
  }
  return user;
}

function deliveryMatchesUser(message, user) {
  if (String(user.role || '') === 'admin') return true;
  const meta = message.metadata || {};
  const targetPhone = meta.pickup_point_phone || meta.pickupPointPhone || '';
  return sameTogoPhone(targetPhone, user.phone) ||
    sameTogoPhone(targetPhone, user.metadata?.payoutPhone);
}

async function findPickupDeliveryForUser(id, user) {
  const message = await Message.findOne({
    _id: id,
    type: 'order_notification',
    'metadata.leg_type': 'boutique_to_point',
  });
  if (!message || !deliveryMatchesUser(message, user)) {
    return null;
  }
  return message;
}

async function syncDeliveryToWeeshop(message, status) {
  const meta = message.metadata || {};
  if (!meta.orderId) return;
  const payload = {
    order_id: String(meta.orderId),
    delivery_id: String(message._id),
    delivery_status: status,
    payment_reference: meta.paymentReference || '',
    datetime: new Date().toISOString(),
  };
  await axios.post(WEESHOP_DELIVERY_SYNC_URL, payload, {
    timeout: 10000,
    headers: buildSyncSignatureHeaders(payload),
  });
}

router.get('/orders', authenticateToken, async (req, res) => {
  try {
    const user = await loadPickupPointUser(req, res);
    if (!user) return;

    const messages = await Message.find({
      type: 'order_notification',
      createdAt: { $gte: oneWeekAgoDate() },
      'metadata.leg_type': 'boutique_to_point',
      ...notExpiredClause(),
    })
      .sort({ 'metadata.pickupPointDropoffAt': -1, createdAt: -1 })
      .limit(100);

    const items = messages
      .filter((message) => deliveryMatchesUser(message, user))
      .map(serializeDelivery);

    return res.json({
      ok: true,
      summary: {
        count: items.length,
        waitingConfirmation: items.filter((item) => item.status === 'pickup_pending_confirmation').length,
        available: items.filter((item) => item.status === 'available' || item.status === 'pickup_ready').length,
      },
      items,
    });
  } catch (error) {
    console.error('Pickup point orders error:', error);
    return res.status(500).json({ ok: false, error: 'fetch_failed' });
  }
});

router.post('/orders/:id/confirm-arrival', authenticateToken, async (req, res) => {
  try {
    const user = await loadPickupPointUser(req, res);
    if (!user) return;

    const message = await findPickupDeliveryForUser(req.params.id, user);
    if (!message) {
      return res.status(404).json({ ok: false, error: 'delivery_not_found' });
    }

    message.metadata = {
      ...(message.metadata || {}),
      pickupPointStatus: 'available',
      pickupPointUserId: String(user._id),
      pickupPointConfirmedAt: new Date(),
      status: 'pickup_ready',
      deliveryStatus: 'delivered_to_pickup',
      lastStatusUpdate: new Date(),
    };
    await message.save();
    await syncDeliveryToWeeshop(message, 'pickup_ready');

    return res.json({ ok: true, item: serializeDelivery(message) });
  } catch (error) {
    console.error('Pickup point confirm arrival error:', error);
    return res.status(500).json({ ok: false, error: 'confirm_failed' });
  }
});

router.post('/orders/:id/confirm-handover', authenticateToken, async (req, res) => {
  try {
    const user = await loadPickupPointUser(req, res);
    if (!user) return;

    const message = await findPickupDeliveryForUser(req.params.id, user);
    if (!message) {
      return res.status(404).json({ ok: false, error: 'delivery_not_found' });
    }

    message.metadata = {
      ...(message.metadata || {}),
      pickupPointStatus: 'handed_over',
      pickupPointHandedOverAt: new Date(),
      pickupPointHandoverUserId: String(user._id),
      lastStatusUpdate: new Date(),
    };
    await message.save();

    return res.json({ ok: true, item: serializeDelivery(message) });
  } catch (error) {
    console.error('Pickup point confirm handover error:', error);
    return res.status(500).json({ ok: false, error: 'handover_failed' });
  }
});

module.exports = router;
