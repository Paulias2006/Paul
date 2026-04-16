// Courier Routes - Delivery Management for Couriers
const express = require('express');
const mongoose = require('mongoose');
const router = express.Router();
const Message = require('../models/Message');
const User = require('../models/User');
const axios = require('axios');
const { authenticateToken } = require('../middleware/auth');
const liveTracking = require('../services/live_tracking_ws');

const DELIVERY_VISIBLE_DAYS = 7;
const AVAILABLE_ORDER_STATUSES = ['acceptee', 'prete', 'ready'];
const ACTIVE_DELIVERY_STATUSES = ['assigned', 'picked_up', 'in_transit'];

function oneWeekAgoDate() {
  return new Date(Date.now() - DELIVERY_VISIBLE_DAYS * 24 * 60 * 60 * 1000);
}

function notExpiredClause() {
  return {
    $or: [
      { expiresAt: { $exists: false } },
      { expiresAt: null },
      { expiresAt: { $gt: new Date() } }
    ]
  };
}

function unassignedCourierClause() {
  return {
    $or: [
      { 'metadata.courierId': { $exists: false } },
      { 'metadata.courierId': null },
      { 'metadata.courierId': '' }
    ]
  };
}

function availableStatusClause() {
  return {
    $or: [
      { 'metadata.status': { $in: AVAILABLE_ORDER_STATUSES } },
      { 'metadata.status': { $exists: false } },
      { 'metadata.status': null },
      { 'metadata.status': '' }
    ]
  };
}

function sanitizeMetadata(metadata) {
  const clean = { ...metadata };
  delete clean.clientEmail;
  delete clean.vendeurEmail;
  delete clean.qrCode;
  return clean;
}

async function notifyCouriersForDelivery(delivery) {
  try {
    const fcmKey = process.env.FCM_SERVER_KEY || '';
    if (!fcmKey) return;

    const couriers = await User.find({
      role: 'courier',
      'metadata.notificationPreferences.pushNotifications': { $ne: false },
      'metadata.fcmTokens.0': { $exists: true }
    }).select('metadata.fcmTokens').lean();

    const tokens = couriers
      .flatMap(c => c.metadata?.fcmTokens || [])
      .filter(Boolean);

    const uniqueTokens = Array.from(new Set(tokens));
    if (uniqueTokens.length === 0) return;

    const chunks = [];
    for (let i = 0; i < uniqueTokens.length; i += 500) {
      chunks.push(uniqueTokens.slice(i, i + 500));
    }

    const meta = delivery.metadata || {};
    const legIndex = meta.leg_index || meta.legIndex || 1;
    const legTotal = meta.leg_total || meta.legTotal || 1;
    const legLabel = legTotal > 1 ? ` (étape ${legIndex}/${legTotal})` : '';
    const notifTitle = delivery.subject || `Nouvelle livraison${legLabel}`;
    const notifBody = 'Course disponible - Ouvrir pour détails';
    const dataPayload = {
      orderId: meta.orderId ? String(meta.orderId) : '',
      legIndex: String(legIndex),
      legTotal: String(legTotal),
      clientLat: meta.clientLat != null ? String(meta.clientLat) : '',
      clientLng: meta.clientLng != null ? String(meta.clientLng) : '',
      boutiqueLat: meta.boutiqueLat != null ? String(meta.boutiqueLat) : '',
      boutiqueLng: meta.boutiqueLng != null ? String(meta.boutiqueLng) : ''
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
  } catch (error) {
    console.error('Notify couriers error:', error.message);
  }
}

// ==================== GET AVAILABLE DELIVERY ORDERS ====================
router.get('/available-deliveries', authenticateToken, async (req, res) => {
  try {
    const courierId = req.user.userId;
    const courierObjectId = mongoose.Types.ObjectId.isValid(courierId)
      ? new mongoose.Types.ObjectId(courierId)
      : null;

    const availableDeliveries = await Message.find({
      $and: [
        { type: 'order_notification' },
        { createdAt: { $gte: oneWeekAgoDate() } },
        { 'metadata.orderId': { $exists: true, $ne: '' } },
        availableStatusClause(),
        unassignedCourierClause(),
        notExpiredClause(),
        {
          'metadata.rejectedBy': {
            $nin: courierObjectId ? [courierId, courierObjectId] : [courierId]
          }
        }
      ]
    })
    .sort({ createdAt: -1 })
    .limit(50);

    return res.json({
      ok: true,
      deliveries: availableDeliveries.map(delivery => ({
        _id: delivery._id,
        subject: delivery.subject,
        content: delivery.content,
        priority: delivery.priority,
        createdAt: delivery.createdAt,
        metadata: {
          orderId: delivery.metadata.orderId,
          clientUsername: delivery.metadata.clientUsername,
          vendeurUsername: delivery.metadata.vendeurUsername,
          boutiqueNom: delivery.metadata.boutiqueNom,
          clientPhone: delivery.metadata.clientPhone,
          boutiquePhone: delivery.metadata.boutiquePhone,
          clientAddress: delivery.metadata.clientAddress,
          boutiqueAddress: delivery.metadata.boutiqueAddress,
          clientLat: delivery.metadata.clientLat,
          clientLng: delivery.metadata.clientLng,
          boutiqueLat: delivery.metadata.boutiqueLat,
          boutiqueLng: delivery.metadata.boutiqueLng,
          totalAmount: delivery.metadata.totalAmount,
          status: delivery.metadata.status,
          leg_index: delivery.metadata.leg_index,
          leg_total: delivery.metadata.leg_total,
          leg_type: delivery.metadata.leg_type,
          from_label: delivery.metadata.from_label,
          from_address: delivery.metadata.from_address,
          from_lat: delivery.metadata.from_lat,
          from_lng: delivery.metadata.from_lng,
          to_label: delivery.metadata.to_label,
          to_address: delivery.metadata.to_address,
          to_lat: delivery.metadata.to_lat,
          to_lng: delivery.metadata.to_lng,
          delivery_fee: delivery.metadata.delivery_fee,
          paymentStatus: delivery.metadata.paymentStatus,
          photoChoisie: delivery.metadata.photoChoisie,
          items: delivery.metadata.items,
          // Localisation pour le suivi
          clientLat: delivery.metadata.clientLat,
          clientLng: delivery.metadata.clientLng,
          boutiqueLat: delivery.metadata.boutiqueLat,
          boutiqueLng: delivery.metadata.boutiqueLng
        }
      })),
    });

  } catch (error) {
    console.error('Get available deliveries error:', error);
    return res.status(500).json({
      ok: false,
      error: 'fetch_failed',
      message: 'Failed to fetch available deliveries',
    });
  }
});

// ==================== TAKE DELIVERY ORDER ====================
router.post('/take-delivery/:deliveryId', authenticateToken, async (req, res) => {
  try {
    const { deliveryId } = req.params;
    const courierId = req.user.userId;

    // Prevent courier from taking multiple active deliveries
    const activeDelivery = await Message.findOne({
      $and: [
        { type: 'order_notification' },
        { createdAt: { $gte: oneWeekAgoDate() } },
        { 'metadata.courierId': courierId },
        { 'metadata.deliveryStatus': { $in: ACTIVE_DELIVERY_STATUSES } },
        { 'metadata.status': { $ne: 'completed' } },
        notExpiredClause()
      ]
    });
    if (activeDelivery) {
      return res.status(409).json({
        ok: false,
        error: 'active_delivery_exists',
        message: 'Vous avez déjà une livraison en cours.'
      });
    }

    const courierObjectId = mongoose.Types.ObjectId.isValid(courierId)
      ? new mongoose.Types.ObjectId(courierId)
      : null;

    // Atomic assignment: only one courier can claim it.
    const delivery = await Message.findOneAndUpdate(
      {
        $and: [
          { _id: deliveryId },
          { type: 'order_notification' },
          { createdAt: { $gte: oneWeekAgoDate() } },
          availableStatusClause(),
          unassignedCourierClause(),
          notExpiredClause(),
          {
            'metadata.rejectedBy': {
              $nin: courierObjectId ? [courierId, courierObjectId] : [courierId]
            }
          }
        ]
      },
      {
        $set: {
          'metadata.courierId': courierId,
          'metadata.courierAssignedAt': new Date(),
          'metadata.status': 'assigned',
          'metadata.deliveryStatus': 'assigned',
          'metadata.lastStatusUpdate': new Date()
        }
      },
      { new: true }
    );

    if (!delivery) {
      return res.status(409).json({
        ok: false,
        error: 'delivery_unavailable',
        message: 'Cette livraison a deja ete prise ou n est plus disponible',
      });
    }

    return res.json({
      ok: true,
      message: 'Delivery successfully assigned to you',
      delivery: {
        _id: delivery._id,
        subject: delivery.subject,
        content: delivery.content,
        metadata: sanitizeMetadata(delivery.metadata)
      }
    });

  } catch (error) {
    console.error('Take delivery error:', error);
    return res.status(500).json({
      ok: false,
      error: 'assignment_failed',
      message: 'Failed to assign delivery',
    });
  }
});

// ==================== GET MY DELIVERIES ====================
router.get('/my-deliveries', authenticateToken, async (req, res) => {
  try {
    const courierId = req.user.userId;

    // Get deliveries assigned to this courier
    const myDeliveries = await Message.find({
      $and: [
        { type: 'order_notification' },
        { createdAt: { $gte: oneWeekAgoDate() } },
        { 'metadata.courierId': courierId },
        { 'metadata.status': { $ne: 'completed' } },
        notExpiredClause()
      ]
    })
    .sort({ 'metadata.courierAssignedAt': -1 });

    return res.json({
      ok: true,
      deliveries: myDeliveries.map(delivery => ({
        _id: delivery._id,
        subject: delivery.subject,
        content: delivery.content,
        priority: delivery.priority,
        createdAt: delivery.createdAt,
        metadata: sanitizeMetadata(delivery.metadata)
      })),
    });

  } catch (error) {
    console.error('Get my deliveries error:', error);
    return res.status(500).json({
      ok: false,
      error: 'fetch_failed',
      message: 'Failed to fetch assigned deliveries',
    });
  }
});

// ==================== UPDATE DELIVERY STATUS ====================
router.put('/update-delivery-status/:deliveryId', authenticateToken, async (req, res) => {
  try {
    const { deliveryId } = req.params;
    const { status, notes, currentLat, currentLng } = req.body;
    const courierId = req.user.userId;

    // Validate status
    const validStatuses = ['assigned', 'picked_up', 'in_transit', 'delivered', 'cancelled'];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({
        ok: false,
        error: 'invalid_status',
        message: 'Invalid delivery status',
      });
    }

    // Find the delivery
    const delivery = await Message.findById(deliveryId);
    if (!delivery) {
      return res.status(404).json({
        ok: false,
        error: 'delivery_not_found',
        message: 'Delivery not found',
      });
    }

    // Check if delivery is assigned to this courier
    if (delivery.metadata.courierId !== courierId) {
      return res.status(403).json({
        ok: false,
        error: 'not_assigned',
        message: 'Delivery not assigned to you',
      });
    }

    // Update status
    delivery.metadata.deliveryStatus = status;
    delivery.metadata.lastStatusUpdate = new Date();

    if (notes) {
      delivery.metadata.deliveryNotes = notes;
    }

    // Update current location if provided
    if (currentLat && currentLng) {
      delivery.metadata.courierLat = parseFloat(currentLat);
      delivery.metadata.courierLng = parseFloat(currentLng);
    }

    // If delivered, just mark as delivered (payment will be handled by webhook)
    let nextLegActivated = null;
    if (status === 'delivered') {
      delivery.metadata.deliveredAt = new Date();
      delivery.metadata.status = 'completed';
      // Note: Courier fee is calculated and paid in webhook.js when payment is confirmed
      // No wallet update here to avoid double payment
    }

    await delivery.save();

    // If this was leg 1 of a multi-leg delivery, unlock leg 2
    if (status === 'delivered') {
      const legIndex = parseInt(delivery.metadata.leg_index || '0', 10);
      const legTotal = parseInt(delivery.metadata.leg_total || '0', 10);
      if (legIndex === 1 && legTotal > 1 && delivery.metadata.orderId) {
        const nextLeg = await Message.findOneAndUpdate(
          {
            type: 'order_notification',
            'metadata.orderId': delivery.metadata.orderId,
            'metadata.leg_index': legIndex + 1,
            'metadata.status': 'waiting_leg1'
          },
          { $set: { 'metadata.status': 'ready', 'metadata.activatedAt': new Date() } },
          { new: true }
        );
        if (nextLeg) {
          nextLegActivated = nextLeg._id;
          await notifyCouriersForDelivery(nextLeg);
        }
      }
    }

    return res.json({
      ok: true,
      message: 'Delivery status updated successfully',
      nextLegActivated,
      delivery: {
        _id: delivery._id,
        metadata: delivery.metadata
      }
    });

  } catch (error) {
    console.error('Update delivery status error:', error);
    return res.status(500).json({
      ok: false,
      error: 'update_failed',
      message: 'Failed to update delivery status',
    });
  }
});

// ==================== REFUSE DELIVERY ORDER ====================
router.post('/refuse-delivery/:deliveryId', authenticateToken, async (req, res) => {
  try {
    const { deliveryId } = req.params;
    const courierId = String(req.user.userId);
    const courierObjectId = mongoose.Types.ObjectId.isValid(courierId)
      ? new mongoose.Types.ObjectId(courierId)
      : null;

    const delivery = await Message.findById(deliveryId);
    if (!delivery) {
      return res.status(404).json({
        ok: false,
        error: 'delivery_not_found',
        message: 'Delivery not found',
      });
    }

    if (delivery.metadata.courierId) {
      return res.status(409).json({
        ok: false,
        error: 'delivery_taken',
        message: 'Delivery already assigned',
      });
    }

    const rejectedValues = courierObjectId ? [courierId, courierObjectId] : [courierId];
    await Message.findByIdAndUpdate(
      deliveryId,
      { $addToSet: { 'metadata.rejectedBy': { $each: rejectedValues } } },
      { new: true }
    );

    return res.json({ ok: true, message: 'Delivery refused' });
  } catch (error) {
    console.error('Refuse delivery error:', error);
    return res.status(500).json({
      ok: false,
      error: 'refuse_failed',
      message: 'Failed to refuse delivery',
    });
  }
});

// ==================== UPDATE COURIER LOCATION ====================
router.post('/update-location', authenticateToken, async (req, res) => {
  try {
    const { deliveryId, currentLat, currentLng } = req.body;
    if (!deliveryId || currentLat == null || currentLng == null) {
      return res.status(400).json({
        ok: false,
        error: 'missing_fields',
        message: 'deliveryId, currentLat, currentLng are required',
      });
    }

    const delivery = await Message.findById(deliveryId);
    if (!delivery) {
      return res.status(404).json({
        ok: false,
        error: 'delivery_not_found',
        message: 'Delivery not found',
      });
    }

    if (delivery.metadata.courierId !== req.user.userId) {
      return res.status(403).json({
        ok: false,
        error: 'not_assigned',
        message: 'Delivery not assigned to you',
      });
    }

    delivery.metadata.courierLat = parseFloat(currentLat);
    delivery.metadata.courierLng = parseFloat(currentLng);
    delivery.metadata.lastStatusUpdate = new Date();
    await delivery.save();

    liveTracking.broadcast(String(delivery._id), {
      type: 'status_update',
      deliveryId: String(delivery._id),
      courierLat: delivery.metadata.courierLat,
      courierLng: delivery.metadata.courierLng,
      clientLat: delivery.metadata.clientLat,
      clientLng: delivery.metadata.clientLng,
      boutiqueLat: delivery.metadata.boutiqueLat,
      boutiqueLng: delivery.metadata.boutiqueLng,
      status: delivery.metadata.deliveryStatus || delivery.metadata.status,
      paymentStatus: delivery.metadata.paymentStatus || null,
      lastStatusUpdate: delivery.metadata.lastStatusUpdate,
    });

    return res.json({
      ok: true,
      message: 'Location updated',
      delivery: {
        _id: delivery._id,
        metadata: sanitizeMetadata(delivery.metadata)
      }
    });
  } catch (error) {
    console.error('Update location error:', error);
    return res.status(500).json({
      ok: false,
      error: 'update_failed',
      message: 'Failed to update location',
    });
  }
});

// ==================== GET DELIVERY UPDATES ====================
router.get('/delivery-updates', authenticateToken, async (req, res) => {
  try {
    const courierId = req.user.userId;
    const deliveries = await Message.find({
      type: 'order_notification',
      'metadata.courierId': courierId
    })
    .sort({ 'metadata.lastStatusUpdate': -1 })
    .limit(50);

    const updates = deliveries.map(d => ({
      deliveryId: d._id,
      status: d.metadata.deliveryStatus || d.metadata.status || 'assigned',
      lastStatusUpdate: d.metadata.lastStatusUpdate || d.updatedAt,
      courierLat: d.metadata.courierLat,
      courierLng: d.metadata.courierLng
    }));

    return res.json({ ok: true, updates });
  } catch (error) {
    console.error('Get delivery updates error:', error);
    return res.status(500).json({
      ok: false,
      error: 'fetch_failed',
      message: 'Failed to fetch delivery updates',
    });
  }
});

// ==================== GET DELIVERY TRACKING INFO ====================
router.get('/tracking/:deliveryId', authenticateToken, async (req, res) => {
  try {
    const { deliveryId } = req.params;
    const courierId = req.user.userId;

    // Find the delivery
    const delivery = await Message.findById(deliveryId);
    if (!delivery) {
      return res.status(404).json({
        ok: false,
        error: 'delivery_not_found',
        message: 'Delivery not found',
      });
    }

    // Check if delivery is assigned to this courier
    if (delivery.metadata.courierId !== courierId) {
      return res.status(403).json({
        ok: false,
        error: 'not_assigned',
        message: 'Delivery not assigned to you',
      });
    }

    return res.json({
      ok: true,
      tracking: {
        deliveryId: delivery._id,
        status: delivery.metadata.deliveryStatus,
        clientLocation: {
          lat: delivery.metadata.clientLat,
          lng: delivery.metadata.clientLng
        },
        vendorLocation: {
          lat: delivery.metadata.boutiqueLat,
          lng: delivery.metadata.boutiqueLng
        },
        courierLocation: {
          lat: delivery.metadata.courierLat,
          lng: delivery.metadata.courierLng
        },
        assignedAt: delivery.metadata.courierAssignedAt,
        lastUpdate: delivery.metadata.lastStatusUpdate,
        notes: delivery.metadata.deliveryNotes
      }
    });

  } catch (error) {
    console.error('Get tracking info error:', error);
    return res.status(500).json({
      ok: false,
      error: 'fetch_failed',
      message: 'Failed to fetch tracking information',
    });
  }
});

// ==================== GET COURIER PROFILE ====================
router.get('/profile', authenticateToken, async (req, res) => {
  try {
    const courier = await User.findById(req.user.userId).select('-passwordHash -resetPasswordToken -resetPasswordExpires');
    if (!courier) {
      return res.status(404).json({ ok: false, error: 'courier_not_found' });
    }

    return res.json({
      ok: true,
      profile: courier,
      wallet: { balance: 0, currency: 'XOF', disabled: true }
    });
  } catch (error) {
    console.error('Get courier profile error:', error);
    return res.status(500).json({ ok: false, error: 'fetch_failed' });
  }
});

// ==================== UPDATE COURIER AVAILABILITY ====================
router.put('/availability', authenticateToken, async (req, res) => {
  try {
    const { isAvailable } = req.body;
    if (typeof isAvailable !== 'boolean') {
      return res.status(400).json({ ok: false, error: 'invalid_payload' });
    }

    const courier = await User.findByIdAndUpdate(
      req.user.userId,
      { $set: { 'metadata.courierAvailable': isAvailable } },
      { new: true }
    ).select('-passwordHash -resetPasswordToken -resetPasswordExpires');

    return res.json({ ok: true, profile: courier });
  } catch (error) {
    console.error('Update availability error:', error);
    return res.status(500).json({ ok: false, error: 'update_failed' });
  }
});

// ==================== GET COURIER STATS ====================
router.get('/stats', authenticateToken, async (req, res) => {
  try {
    const courierId = req.user.userId;
    const totalAssigned = await Message.countDocuments({
      type: 'order_notification',
      'metadata.courierId': courierId
    });
    const completed = await Message.countDocuments({
      type: 'order_notification',
      'metadata.courierId': courierId,
      'metadata.deliveryStatus': 'delivered'
    });
    const inProgress = await Message.countDocuments({
      type: 'order_notification',
      'metadata.courierId': courierId,
      'metadata.deliveryStatus': { $in: ['assigned', 'picked_up', 'in_transit'] }
    });

    return res.json({
      ok: true,
      stats: {
        totalAssigned,
        completed,
        inProgress,
        balance: 0,
        currency: 'XOF',
        wallet_disabled: true
      }
    });
  } catch (error) {
    console.error('Get courier stats error:', error);
    return res.status(500).json({ ok: false, error: 'fetch_failed' });
  }
});

// ==================== DELIVERY HISTORY ====================
router.get('/delivery-history', authenticateToken, async (req, res) => {
  try {
    const courierId = req.user.userId;
    const limit = parseInt(req.query.limit) || 20;
    const page = parseInt(req.query.page) || 1;
    const skip = Math.max(0, (page - 1) * limit);

    const deliveries = await Message.find({
      type: 'order_notification',
      'metadata.courierId': courierId
    })
      .sort({ 'metadata.courierAssignedAt': -1 })
      .skip(skip)
      .limit(limit);

    return res.json({
      ok: true,
      deliveries: deliveries.map(d => ({
        ...d.toObject(),
        metadata: sanitizeMetadata(d.metadata)
      }))
    });
  } catch (error) {
    console.error('Delivery history error:', error);
    return res.status(500).json({ ok: false, error: 'fetch_failed' });
  }
});

// ==================== REPORT ISSUE ====================
router.post('/report-issue', authenticateToken, async (req, res) => {
  try {
    const { deliveryId, issueType, description } = req.body;
    if (!deliveryId || !issueType || !description) {
      return res.status(400).json({ ok: false, error: 'missing_fields' });
    }

    const issueMessage = new Message({
      subject: `Issue livraison #${deliveryId}`,
      content: description,
      type: 'system_alert',
      priority: 'high',
      metadata: {
        courierId: req.user.userId,
        deliveryId,
        issueType
      }
    });
    await issueMessage.save();

    return res.json({ ok: true });
  } catch (error) {
    console.error('Report issue error:', error);
    return res.status(500).json({ ok: false, error: 'failed' });
  }
});

// ==================== RATE DELIVERY ====================
router.post('/rate-delivery', authenticateToken, async (req, res) => {
  try {
    const { deliveryId, rating, comment } = req.body;
    if (!deliveryId || rating == null) {
      return res.status(400).json({ ok: false, error: 'missing_fields' });
    }

    const delivery = await Message.findById(deliveryId);
    if (!delivery) {
      return res.status(404).json({ ok: false, error: 'delivery_not_found' });
    }

    if (delivery.metadata.courierId !== req.user.userId) {
      return res.status(403).json({ ok: false, error: 'not_assigned' });
    }

    delivery.metadata.deliveryRating = parseInt(rating);
    if (comment) delivery.metadata.deliveryRatingComment = comment;
    await delivery.save();

    liveTracking.broadcast(String(delivery._id), {
      type: 'tracking_update',
      deliveryId: String(delivery._id),
      courierLat: delivery.metadata.courierLat,
      courierLng: delivery.metadata.courierLng,
      clientLat: delivery.metadata.clientLat,
      clientLng: delivery.metadata.clientLng,
      boutiqueLat: delivery.metadata.boutiqueLat,
      boutiqueLng: delivery.metadata.boutiqueLng,
      status: delivery.metadata.deliveryStatus || delivery.metadata.status,
      paymentStatus: delivery.metadata.paymentStatus || null,
      lastStatusUpdate: delivery.metadata.lastStatusUpdate,
    });

    return res.json({ ok: true });
  } catch (error) {
    console.error('Rate delivery error:', error);
    return res.status(500).json({ ok: false, error: 'failed' });
  }
});

module.exports = router;
