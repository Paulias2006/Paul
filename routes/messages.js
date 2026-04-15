// Messages Routes - Admin Notifications
const express = require('express');
const router = express.Router();
const Message = require('../models/Message');
const User = require('../models/User');
const axios = require('axios');
const { authenticateToken } = require('../middleware/auth');

// ==================== GET ADMIN MESSAGES ====================
router.get('/admin-messages', authenticateToken, async (req, res) => {
  try {
    // Only allow admin users to access messages
    if (req.user.role !== 'admin') {
      return res.status(403).json({
        ok: false,
        error: 'access_denied',
        message: 'Access denied. Admin privileges required.',
      });
    }

    const messages = await Message.find({})
      .sort({ createdAt: -1 })
      .limit(100); // Limit to last 100 messages

    return res.json({
      ok: true,
      messages: messages.map(msg => ({
        _id: msg._id,
        subject: msg.subject,
        content: msg.content,
        type: msg.type,
        isRead: msg.isRead,
        priority: msg.priority,
        metadata: msg.metadata,
        createdAt: msg.createdAt,
        updatedAt: msg.updatedAt,
      })),
    });

  } catch (error) {
    console.error('Get admin messages error:', error);
    return res.status(500).json({
      ok: false,
      error: 'fetch_failed',
      message: 'Failed to fetch admin messages',
    });
  }
});

// ==================== MARK MESSAGE AS READ ====================
router.put('/admin-messages/:messageId/read', authenticateToken, async (req, res) => {
  try {
    // Only allow admin users to mark messages as read
    if (req.user.role !== 'admin') {
      return res.status(403).json({
        ok: false,
        error: 'access_denied',
        message: 'Access denied. Admin privileges required.',
      });
    }

    const { messageId } = req.params;

    const message = await Message.findById(messageId);
    if (!message) {
      return res.status(404).json({
        ok: false,
        error: 'message_not_found',
        message: 'Message not found',
      });
    }

    message.isRead = true;
    await message.save();

    return res.json({
      ok: true,
      message: 'Message marked as read',
    });

  } catch (error) {
    console.error('Mark message as read error:', error);
    return res.status(500).json({
      ok: false,
      error: 'update_failed',
      message: 'Failed to mark message as read',
    });
  }
});

// ==================== CREATE ADMIN MESSAGE ====================
router.post('/admin-messages', async (req, res) => {
  try {
    const { subject, content, type = 'admin_notification', priority = 'normal', metadata = {} } = req.body;

    if (!subject || !content) {
      return res.status(400).json({
        ok: false,
        error: 'missing_fields',
        message: 'Subject and content are required',
      });
    }

    if (type === 'order_notification') {
      console.log('📩 Courier message received:', {
        subject,
        orderId: metadata.orderId,
        clientLat: metadata.clientLat,
        clientLng: metadata.clientLng,
        boutiqueLat: metadata.boutiqueLat,
        boutiqueLng: metadata.boutiqueLng,
        items: Array.isArray(metadata.items) ? metadata.items.length : 0
      });
    }

    const message = new Message({
      subject,
      content,
      type,
      priority,
      metadata,
      expiresAt: type === 'order_notification'
        ? new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
        : null,
    });

    await message.save();

    // Push notification to couriers (FCM) for order notifications
    // Avoid notifying for leg2 while it is still blocked (waiting_leg1)
    const legStatus = (metadata && metadata.status) ? String(metadata.status) : '';
    const shouldNotify = legStatus !== 'waiting_leg1';
    if (type === 'order_notification' && shouldNotify) {
      const fcmKey = process.env.FCM_SERVER_KEY || '';
      if (fcmKey) {
        const couriers = await User.find({
          role: 'courier',
          'metadata.notificationPreferences.pushNotifications': { $ne: false },
          'metadata.fcmTokens.0': { $exists: true }
        }).select('metadata.fcmTokens').lean();

        const tokens = couriers
          .flatMap(c => c.metadata?.fcmTokens || [])
          .filter(Boolean);

        const uniqueTokens = Array.from(new Set(tokens));
        const chunks = [];
        for (let i = 0; i < uniqueTokens.length; i += 500) {
          chunks.push(uniqueTokens.slice(i, i + 500));
        }

        const notifTitle = subject || 'Nouvelle livraison';
        const notifBody = 'Nouvelle commande disponible - Ouvrir pour détails';
        const dataPayload = {
          orderId: metadata?.orderId ? String(metadata.orderId) : '',
          clientLat: metadata?.clientLat != null ? String(metadata.clientLat) : '',
          clientLng: metadata?.clientLng != null ? String(metadata.clientLng) : '',
          boutiqueLat: metadata?.boutiqueLat != null ? String(metadata.boutiqueLat) : '',
          boutiqueLng: metadata?.boutiqueLng != null ? String(metadata.boutiqueLng) : ''
        };

        for (const batch of chunks) {
          await axios.post('https://fcm.googleapis.com/fcm/send', {
            registration_ids: batch,
            notification: { title: notifTitle, body: notifBody },
            data: dataPayload,
            priority: 'high'
          }, {
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `key=${fcmKey}`
            },
            timeout: 10000
          });
        }
      }
    }

    return res.status(201).json({
      ok: true,
      message: 'Admin message created successfully',
      messageId: message._id,
    });

  } catch (error) {
    console.error('Create admin message error:', error);
    return res.status(500).json({
      ok: false,
      error: 'creation_failed',
      message: 'Failed to create admin message',
    });
  }
});

module.exports = router;
