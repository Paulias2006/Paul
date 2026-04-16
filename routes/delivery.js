const express = require('express');
const { v4: uuidv4 } = require('uuid');
const db = require('../db');
const axios = require('axios');
const Message = require('../models/Message');
const User = require('../models/User');
const { authenticateToken } = require('../middleware/auth');

const router = express.Router();

const toStringSafe = (value, fallback = '') => {
  if (value === undefined || value === null) return fallback;
  return String(value).trim();
};

const toNumberSafe = (value, fallback = 0) => {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
};

const plus7Days = () => new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

const shouldNotifyCouriers = (status) => !['waiting_leg1', 'waiting_group', 'cancelled', 'completed'].includes(
  toStringSafe(status),
);

async function notifyCouriersForMessage(subject, metadata) {
  try {
    const fcmKey = process.env.FCM_SERVER_KEY || '';
    if (!fcmKey) return;

    const couriers = await User.find({
      role: 'courier',
      'metadata.notificationPreferences.pushNotifications': { $ne: false },
      'metadata.fcmTokens.0': { $exists: true }
    }).select('metadata.fcmTokens').lean();

    const tokens = couriers
      .flatMap((courier) => courier.metadata?.fcmTokens || [])
      .filter(Boolean);

    const uniqueTokens = Array.from(new Set(tokens));
    if (uniqueTokens.length === 0) return;

    for (let index = 0; index < uniqueTokens.length; index += 500) {
      const batch = uniqueTokens.slice(index, index + 500);
      await axios.post('https://fcm.googleapis.com/fcm/send', {
        registration_ids: batch,
        notification: {
          title: subject || 'Nouvelle livraison',
          body: 'Une commande prete attend un livreur',
        },
        data: {
          orderId: metadata?.orderId ? String(metadata.orderId) : '',
          legIndex: metadata?.leg_index != null ? String(metadata.leg_index) : '',
          legTotal: metadata?.leg_total != null ? String(metadata.leg_total) : '',
          clientLat: metadata?.clientLat != null ? String(metadata.clientLat) : '',
          clientLng: metadata?.clientLng != null ? String(metadata.clientLng) : '',
          boutiqueLat: metadata?.boutiqueLat != null ? String(metadata.boutiqueLat) : '',
          boutiqueLng: metadata?.boutiqueLng != null ? String(metadata.boutiqueLng) : '',
        },
        priority: 'high',
      }, {
        headers: {
          'Content-Type': 'application/json',
          Authorization: `key=${fcmKey}`,
        },
        timeout: 10000,
      });
    }
  } catch (error) {
    console.error('Notify couriers from delivery route error:', error?.message || error);
  }
}

const buildOrderContent = ({
  orderNumber,
  clientName,
  modePaiement,
  totalAmount,
  legSummary,
}) => {
  const lines = ['Nouvelle livraison disponible'];
  if (orderNumber) lines.push(`Commande: ${orderNumber}`);
  if (clientName) lines.push(`Client: ${clientName}`);
  if (modePaiement) lines.push(`Mode: ${modePaiement}`);
  if (legSummary) lines.push(`Trajet: ${legSummary}`);
  lines.push(`Total: ${Math.round(totalAmount || 0)} FCFA`);
  return lines.join('\n');
};

const buildMessageMetadata = ({
  orderId,
  orderNumber,
  boutiqueId,
  clientId,
  clientName,
  clientPhone,
  clientEmail,
  clientAddress,
  clientRegion,
  clientCity,
  clientDistrict,
  clientLat,
  clientLng,
  vendorId,
  vendorName,
  vendorAddress,
  boutiqueLat,
  boutiqueLng,
  totalAmount,
  productAmount,
  deliveryFee,
  paymentStatus,
  paygateReference,
  items,
  legType,
  legIndex,
  legTotal,
  fromLabel,
  fromAddress,
  fromLat,
  fromLng,
  toLabel,
  toAddress,
  toLat,
  toLng,
  initialStatus,
}) => ({
  orderId: toStringSafe(orderId),
  orderNumber: toStringSafe(orderNumber),
  boutiqueId: toStringSafe(boutiqueId),
  clientId: toStringSafe(clientId),
  clientUsername: toStringSafe(clientName),
  clientPhone: toStringSafe(clientPhone),
  clientEmail: toStringSafe(clientEmail),
  clientAddress: [clientAddress, clientDistrict, clientCity, clientRegion]
    .map((v) => toStringSafe(v))
    .filter(Boolean)
    .join(', '),
  clientLat: toNumberSafe(clientLat, 0),
  clientLng: toNumberSafe(clientLng, 0),
  vendeurId: toStringSafe(vendorId),
  vendeurUsername: toStringSafe(vendorName),
  boutiqueNom: toStringSafe(vendorName) || toStringSafe(boutiqueId),
  boutiqueAddress: toStringSafe(vendorAddress) || toStringSafe(fromAddress),
  boutiqueLat: toNumberSafe(boutiqueLat, toNumberSafe(fromLat, 0)),
  boutiqueLng: toNumberSafe(boutiqueLng, toNumberSafe(fromLng, 0)),
  totalAmount: toNumberSafe(totalAmount, 0),
  productAmount: toNumberSafe(productAmount, 0),
  delivery_fee: toNumberSafe(deliveryFee, 0),
  paymentStatus: toStringSafe(paymentStatus, 'pending'),
  paymentReference: toStringSafe(paygateReference),
  status: toStringSafe(initialStatus, 'ready'),
  deliveryStatus: null,
  courierId: null,
  leg_type: toStringSafe(legType),
  leg_index: legIndex,
  leg_total: legTotal,
  from_label: toStringSafe(fromLabel),
  from_address: toStringSafe(fromAddress),
  from_lat: toNumberSafe(fromLat, 0),
  from_lng: toNumberSafe(fromLng, 0),
  to_label: toStringSafe(toLabel),
  to_address: toStringSafe(toAddress),
  to_lat: toNumberSafe(toLat, 0),
  to_lng: toNumberSafe(toLng, 0),
  items: Array.isArray(items)
    ? items.map((it) => ({
        productId: toStringSafe(it.productId || it.product_id || it.id),
        name: toStringSafe(it.name || it.title || 'Produit'),
        quantity: toNumberSafe(it.quantity, 1),
        price: toNumberSafe(it.price || it.unitPrice, 0),
        photo: toStringSafe(it.photo || it.image),
      }))
    : [],
});

const resolveDeliveryStatus = (existingDelivery, initialStatus) => {
  if (initialStatus === 'cancelled') {
    return 'cancelled';
  }
  const currentStatus = toStringSafe(existingDelivery?.status);
  if (['accepted', 'assigned', 'picked_up', 'in_transit', 'completed', 'delivered'].includes(currentStatus)) {
    return currentStatus;
  }
  return toStringSafe(initialStatus, 'ready');
};

const mergeMessageMetadata = (baseMeta, existingMeta, initialStatus) => {
  const previous = existingMeta && typeof existingMeta === 'object' ? existingMeta : {};
  const paymentStatus = toStringSafe(baseMeta.paymentStatus) || toStringSafe(previous.paymentStatus, 'pending');
  const paymentReference = toStringSafe(baseMeta.paymentReference) || toStringSafe(previous.paymentReference);
  const nextStatus = initialStatus === 'cancelled'
    ? 'cancelled'
    : ['assigned', 'picked_up', 'in_transit', 'completed'].includes(toStringSafe(previous.status))
      ? previous.status
      : toStringSafe(initialStatus, previous.status || 'ready');
  return {
    ...previous,
    ...baseMeta,
    status: nextStatus,
    deliveryStatus: previous.deliveryStatus ?? null,
    courierId: previous.courierId ?? null,
    courierAssignedAt: previous.courierAssignedAt ?? null,
    courierLat: previous.courierLat ?? null,
    courierLng: previous.courierLng ?? null,
    paidAt: previous.paidAt ?? null,
    rejectedBy: Array.isArray(previous.rejectedBy) ? previous.rejectedBy : [],
    paymentStatus,
    paymentReference,
  };
};

router.post('/create', async (req, res) => {
  try {
    const {
      order_id,
      order_number,
      commande_id,
      boutique_id,
      client_id,
      client_name,
      client_phone,
      client_email,
      client_lat,
      client_lng,
      vendor_id,
      vendor_name,
      vendor_lat,
      vendor_lng,
      vendor_address,
      product_id,
      product_name,
      product_quantity,
      product_options,
      product_photo,
      items,
      total_amount,
      product_amount,
      delivery_fee,
      distance,
      distance_km,
      delivery_address,
      delivery_region,
      delivery_city,
      delivery_district,
      mode_paiement,
      mode_livraison,
      statut_paiement,
      paygate_reference,
      leg_type,
      leg_index,
      leg_total,
      from_label,
      from_address,
      from_lat,
      from_lng,
      to_label,
      to_address,
      to_lat,
      to_lng,
      leg_status,
      allow_zero_fee,
    } = req.body || {};

    const orderIdKey = toStringSafe(order_id);
    if (!orderIdKey) {
      return res.status(400).json({
        ok: false,
        error: 'missing_order_id',
        message: 'order_id est requis',
      });
    }

    const feeNum = toNumberSafe(delivery_fee, 0);
    const allowZeroFee = Boolean(allow_zero_fee);
    if (!(feeNum > 0) && !allowZeroFee) {
      return res.status(400).json({
        ok: false,
        error: 'invalid_delivery_fee',
        message: 'delivery_fee doit etre > 0',
      });
    }

    const safeFee = feeNum > 0 ? feeNum : 0;
    const legIndexNum = Number.isFinite(Number(leg_index))
      ? Number(leg_index)
      : null;
    const legTotalNum = Number.isFinite(Number(leg_total))
      ? Number(leg_total)
      : null;
    const initialStatus =
      toStringSafe(leg_status) ||
      (legIndexNum && legIndexNum > 1 ? 'waiting_leg1' : 'ready');

    const deliveryFilter = legIndexNum != null
      ? { order_id: orderIdKey, 'leg.index': legIndexNum }
      : { order_id: orderIdKey };
    const existingDelivery = await db.findDelivery(deliveryFilter);
    const deliveryDoc = {
      _id: existingDelivery?._id || uuidv4(),
      order_id: orderIdKey,
      commande_id: toStringSafe(commande_id || order_number),
      leg: {
        type: toStringSafe(leg_type) || null,
        index: legIndexNum,
        total: legTotalNum,
        from: {
          label: toStringSafe(from_label),
          address: toStringSafe(from_address),
          lat: toNumberSafe(from_lat, 0),
          lng: toNumberSafe(from_lng, 0),
        },
        to: {
          label: toStringSafe(to_label),
          address: toStringSafe(to_address),
          lat: toNumberSafe(to_lat, 0),
          lng: toNumberSafe(to_lng, 0),
        },
      },
      client: {
        id: toStringSafe(client_id),
        name: toStringSafe(client_name, 'Client'),
        phone: toStringSafe(client_phone),
        email: toStringSafe(client_email),
        location: {
          lat: toNumberSafe(client_lat, 0),
          lng: toNumberSafe(client_lng, 0),
          address: toStringSafe(delivery_address),
          region: toStringSafe(delivery_region),
          city: toStringSafe(delivery_city),
          district: toStringSafe(delivery_district),
        },
      },
      vendor: {
        id: toStringSafe(vendor_id || boutique_id),
        name: toStringSafe(vendor_name, 'Boutique'),
        location: {
          lat: toNumberSafe(vendor_lat, toNumberSafe(from_lat, 0)),
          lng: toNumberSafe(vendor_lng, toNumberSafe(from_lng, 0)),
        },
        address: toStringSafe(vendor_address || from_address),
      },
      courier: {
        id: null,
        name: null,
        phone: null,
        acceptedAt: null,
      },
      product: {
        id: toStringSafe(product_id),
        name: toStringSafe(product_name, 'Produit'),
        quantity: toNumberSafe(product_quantity, 1),
        options: toStringSafe(product_options),
        photo: toStringSafe(product_photo),
      },
      items: Array.isArray(items) ? items : [],
      payment: {
        total: toNumberSafe(total_amount, 0),
        product_amount: toNumberSafe(product_amount, 0),
        delivery_fee: safeFee,
        status: toStringSafe(statut_paiement, 'pending'),
        paygate_reference: toStringSafe(paygate_reference),
      },
      delivery_info: {
        distance: toNumberSafe(distance_km, toNumberSafe(distance, 0)),
        mode: toStringSafe(mode_livraison, 'livraison'),
        payment_mode: toStringSafe(mode_paiement, 'delivery'),
      },
      expiresAt: plus7Days(),
      status: resolveDeliveryStatus(existingDelivery, initialStatus),
      source: 'weeshop',
    };

    const messageFilter = {
      type: 'order_notification',
      'metadata.orderId': orderIdKey,
      'metadata.leg_index': legIndexNum,
    };
    const legSummary =
      toStringSafe(from_label) && toStringSafe(to_label)
        ? `${toStringSafe(from_label)} -> ${toStringSafe(to_label)}`
        : '';
    const existingMessage = await Message.findOne(messageFilter).lean();
    const previousMessageStatus = toStringSafe(existingMessage?.metadata?.status);
    const baseMeta = buildMessageMetadata({
      orderId: orderIdKey,
      orderNumber: order_number || commande_id,
      boutiqueId: boutique_id,
      clientId: client_id,
      clientName: client_name,
      clientPhone: client_phone,
      clientEmail: client_email,
      clientAddress: delivery_address,
      clientRegion: delivery_region,
      clientCity: delivery_city,
      clientDistrict: delivery_district,
      clientLat: client_lat,
      clientLng: client_lng,
      vendorId: vendor_id || boutique_id,
      vendorName: vendor_name,
      vendorAddress: vendor_address || from_address,
      boutiqueLat: vendor_lat,
      boutiqueLng: vendor_lng,
      totalAmount: total_amount,
      productAmount: product_amount,
      deliveryFee: safeFee,
      paymentStatus: statut_paiement,
      paygateReference: paygate_reference,
      items,
      legType: leg_type,
      legIndex: legIndexNum,
      legTotal: legTotalNum,
      fromLabel: from_label,
      fromAddress: from_address,
      fromLat: from_lat,
      fromLng: from_lng,
      toLabel: to_label,
      toAddress: to_address,
      toLat: to_lat,
      toLng: to_lng,
      initialStatus,
    });
    const meta = mergeMessageMetadata(baseMeta, existingMessage?.metadata, initialStatus);

    const savedDelivery = existingDelivery
      ? await db.updateDelivery(
        { _id: existingDelivery._id },
        {
          ...deliveryDoc,
          courier: existingDelivery.courier || deliveryDoc.courier,
          updated_at: new Date(),
        },
      )
      : await db.createDelivery(deliveryDoc);

    const upsertedMessage = await Message.findOneAndUpdate(
      messageFilter,
      {
        $set: {
          subject: `Commande ${toStringSafe(order_number || orderIdKey)} - livraison`,
          content: buildOrderContent({
            orderNumber: toStringSafe(order_number || orderIdKey),
            clientName: toStringSafe(client_name),
            modePaiement: toStringSafe(mode_paiement),
            totalAmount: toNumberSafe(total_amount, 0),
            legSummary,
          }),
          priority: 'high',
          metadata: meta,
          expiresAt: plus7Days(),
          updatedAt: new Date(),
        },
        $setOnInsert: {
          type: 'order_notification',
          createdBy: 'weeshop_sync',
        },
      },
      { upsert: true, new: true }
    );

    if (
      upsertedMessage
      && shouldNotifyCouriers(meta.status)
      && previousMessageStatus !== meta.status
    ) {
      await notifyCouriersForMessage(upsertedMessage.subject, upsertedMessage.metadata);
    }

    return res.status(201).json({
      ok: true,
      message: 'Delivery created successfully',
      delivery_id: savedDelivery?._id || deliveryDoc._id,
      message_id: upsertedMessage?._id || null,
      delivery_fee: safeFee,
      status: initialStatus,
    });
  } catch (error) {
    console.error('Error creating delivery:', error);
    return res.status(500).json({
      ok: false,
      error: 'internal_error',
      message: 'Impossible de creer la livraison',
    });
  }
});

router.get('/pending', authenticateToken, async (_req, res) => {
  try {
    const deliveries = await db.findAllDeliveries({ status: { $in: ['ready', 'pending'] } });
    return res.json({
      ok: true,
      deliveries: deliveries || [],
      count: (deliveries || []).length,
    });
  } catch (error) {
    console.error('Error fetching pending deliveries:', error);
    return res.status(500).json({ ok: false, error: 'internal_error' });
  }
});

router.get('/:delivery_id', authenticateToken, async (req, res) => {
  try {
    const delivery = await db.findDelivery({ _id: req.params.delivery_id });
    if (!delivery) {
      return res.status(404).json({ ok: false, error: 'delivery_not_found' });
    }
    return res.json({ ok: true, delivery });
  } catch (error) {
    console.error('Error fetching delivery:', error);
    return res.status(500).json({ ok: false, error: 'internal_error' });
  }
});

router.post('/accept', authenticateToken, async (req, res) => {
  try {
    const deliveryId = toStringSafe(req.body?.delivery_id);
    const courierId = toStringSafe(req.user?.userId || req.user?.id);
    if (!deliveryId) {
      return res.status(400).json({ ok: false, error: 'delivery_id_required' });
    }

    const delivery = await db.findDelivery({ _id: deliveryId });
    if (!delivery) {
      return res.status(404).json({ ok: false, error: 'delivery_not_found' });
    }

    if (!['ready', 'pending'].includes(toStringSafe(delivery.status))) {
      return res.status(409).json({ ok: false, error: 'delivery_not_available' });
    }

    delivery.courier = {
      id: courierId,
      name: toStringSafe(req.user?.fullName || req.user?.email),
      phone: toStringSafe(req.user?.phone),
      acceptedAt: new Date(),
    };
    delivery.status = 'accepted';
    delivery.updated_at = new Date();
    await db.updateDelivery({ _id: deliveryId }, delivery);

    return res.json({
      ok: true,
      message: 'Delivery accepted successfully',
      delivery_id: deliveryId,
    });
  } catch (error) {
    console.error('Error accepting delivery:', error);
    return res.status(500).json({ ok: false, error: 'internal_error' });
  }
});

router.post('/refuse', authenticateToken, async (req, res) => {
  try {
    const deliveryId = toStringSafe(req.body?.delivery_id);
    if (!deliveryId) {
      return res.status(400).json({ ok: false, error: 'delivery_id_required' });
    }
    const delivery = await db.findDelivery({ _id: deliveryId });
    if (!delivery) {
      return res.status(404).json({ ok: false, error: 'delivery_not_found' });
    }
    delivery.status = 'ready';
    delivery.courier = { id: null, name: null, phone: null, acceptedAt: null };
    delivery.updated_at = new Date();
    await db.updateDelivery({ _id: deliveryId }, delivery);
    return res.json({ ok: true, message: 'Delivery refused', delivery_id: deliveryId });
  } catch (error) {
    console.error('Error refusing delivery:', error);
    return res.status(500).json({ ok: false, error: 'internal_error' });
  }
});

router.post('/complete', authenticateToken, async (req, res) => {
  try {
    const deliveryId = toStringSafe(req.body?.delivery_id);
    const courierId = toStringSafe(req.user?.userId || req.user?.id);
    if (!deliveryId) {
      return res.status(400).json({ ok: false, error: 'delivery_id_required' });
    }

    const delivery = await db.findDelivery({ _id: deliveryId });
    if (!delivery) {
      return res.status(404).json({ ok: false, error: 'delivery_not_found' });
    }

    if (toStringSafe(delivery?.courier?.id) !== courierId) {
      return res.status(403).json({ ok: false, error: 'not_assigned' });
    }

    delivery.status = 'completed';
    delivery.completed_at = new Date();
    delivery.proof = toStringSafe(req.body?.proof, 'delivered');
    delivery.updated_at = new Date();
    await db.updateDelivery({ _id: deliveryId }, delivery);

    if (
      Number.isFinite(Number(delivery?.leg?.index)) &&
      Number.isFinite(Number(delivery?.leg?.total)) &&
      Number(delivery.leg.index) === 1 &&
      Number(delivery.leg.total) > 1
    ) {
      await db.updateDelivery(
        {
          order_id: toStringSafe(delivery.order_id),
          'leg.index': Number(delivery.leg.index) + 1,
          status: 'waiting_leg1',
        },
        { $set: { status: 'ready', updated_at: new Date() } }
      );
    }

    return res.json({
      ok: true,
      message: 'Delivery marked as completed',
      delivery_id: deliveryId,
    });
  } catch (error) {
    console.error('Error completing delivery:', error);
    return res.status(500).json({ ok: false, error: 'internal_error' });
  }
});

router.get('/courier/:courier_id', authenticateToken, async (req, res) => {
  try {
    const courierId = toStringSafe(req.params.courier_id);
    const deliveries = await db.findAllDeliveries({
      'courier.id': courierId,
      status: { $in: ['accepted', 'completed'] },
    });
    return res.json({
      ok: true,
      deliveries: deliveries || [],
      count: (deliveries || []).length,
    });
  } catch (error) {
    console.error('Error fetching courier deliveries:', error);
    return res.status(500).json({ ok: false, error: 'internal_error' });
  }
});

module.exports = router;
