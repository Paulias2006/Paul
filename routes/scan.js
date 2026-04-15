const crypto = require('crypto');
const express = require('express');
const axios = require('axios');

const db = require('../db');

const router = express.Router();

const normalizeOrderId = (value) => String(value || '').trim();

const SYNC_SECRET =
  process.env.WEEDELIVRED_SYNC_SECRET ||
  process.env.PAYGATE_WEBHOOK_SECRET ||
  '';
const WEESHOP_ORDER_VERIFY_URL =
  process.env.WEESHOP_WEEDELIVRED_ORDER_VERIFY_URL ||
  process.env.WEESHOP_WEEDELIVRED_VERIFY_ORDER_URL ||
  'https://weeshop.onrender.com/api/paygate/weedelivred-verify-order';

function parseNumber(value) {
  const num = Number.parseFloat(value);
  return Number.isFinite(num) ? num : null;
}

function buildSyncSignatureHeaders(payload) {
  if (!SYNC_SECRET) {
    return { 'Content-Type': 'application/json' };
  }
  const ts = String(Math.floor(Date.now() / 1000));
  const nonce = crypto.randomBytes(12).toString('hex');
  const raw = JSON.stringify(payload || {});
  const canonical = `${ts}.${nonce}.${raw}`;
  const sig = crypto.createHmac('sha256', SYNC_SECRET).update(canonical).digest('hex');
  return {
    'Content-Type': 'application/json',
    'X-Webhook-Timestamp': ts,
    'X-Webhook-Nonce': nonce,
    'X-Webhook-Signature': sig,
  };
}

async function verifyOrderWithWeeshop({ orderId, paymentReference }) {
  const payload = {};
  if (orderId) payload.order_id = orderId;
  if (paymentReference) payload.payment_reference = paymentReference;
  const response = await axios.post(WEESHOP_ORDER_VERIFY_URL, payload, {
    timeout: 10000,
    headers: buildSyncSignatureHeaders(payload),
  });
  if (!response?.data?.ok) {
    throw new Error(response?.data?.error || 'verify_failed');
  }
  return response.data;
}

const getScanSecret = () =>
  process.env.QR_SCAN_SECRET ||
  process.env.PAYGATE_CALLBACK_SECRET ||
  process.env.PAYGATE_WEBHOOK_SECRET ||
  'default_key';

const decodePackedPayload = (packed) => {
  const decoded = Buffer.from(String(packed || ''), 'base64').toString('utf8');
  return JSON.parse(decoded);
};

const verifyQrSignature = (payload) => {
  const signature = payload.signature || payload.qr_signature;
  if (!signature) return { ok: false, error: 'missing_signature' };

  const payloadForSig = { ...payload };
  delete payloadForSig.signature;
  delete payloadForSig.qr_signature;

  const sorted = Object.keys(payloadForSig)
    .sort()
    .reduce((acc, key) => {
      acc[key] = payloadForSig[key];
      return acc;
    }, {});

  const expected = crypto
    .createHmac('sha256', getScanSecret())
    .update(JSON.stringify(sorted))
    .digest('hex');

  if (expected !== signature) return { ok: false, error: 'invalid_signature' };
  return { ok: true };
};

const validateRequiredFields = (payload) => {
  const orderId = normalizeOrderId(payload.order_id);
  const clientPhone = String(payload.client_phone || '').trim();
  const amount = Number(payload.amount || 0);

  if (!orderId || !clientPhone || !(amount > 0)) {
    return { ok: false, error: 'invalid_payload_structure' };
  }

  return { ok: true, orderId, clientPhone, amount };
};

const buildPaygatePageUrl = ({ tx, payload }) => {
  const token = process.env.PAYGATE_AUTH_TOKEN || '';
  if (!token) return '';
  const params = new URLSearchParams({
    token,
    amount: String(Math.round(Number(tx.amount || payload.amount || 0))),
    identifier: tx.identifier,
    description: tx.description || payload.description || `Commande ${payload.order_id || ''}`,
  });

  const phone = String(tx.phoneNumber || payload.client_phone || '').trim();
  if (phone) params.set('phone', phone);

  const network = String(
    tx.paymentMethod ||
      payload.network ||
      payload.client_network ||
      ''
  )
    .trim()
    .toUpperCase();
  // Method 2 (PayGate page) accepts optional network (e.g. MOOV / TOGOCEL).
  if (/^[A-Z0-9_-]{2,20}$/.test(network)) {
    params.set('network', network);
  }

  const returnUrl = String(process.env.PAYGATE_RETURN_URL || '').trim();
  if (returnUrl) params.set('url', returnUrl);

  return `https://paygateglobal.com/v1/page?${params.toString()}`;
};

// GET /api/scan?p=<base64> - decode + validate signature + duplicate check
router.get('/', async (req, res) => {
  const packed = req.query.p;
  if (!packed) return res.status(400).json({ ok: false, error: 'missing_p' });

  try {
    const payload = decodePackedPayload(packed);
    const signatureCheck = verifyQrSignature(payload);
    if (!signatureCheck.ok) return res.status(401).json({ ok: false, error: signatureCheck.error });

    const required = validateRequiredFields(payload);
    if (!required.ok) return res.status(400).json({ ok: false, error: required.error });

    const existing = await db.checkDuplicateTransaction(required.orderId);
    if (!existing) {
      return res.json({ ok: true, payload, duplicate: false });
    }

    const alreadyProcessed = ['completed'].includes(String(existing.status || '').toLowerCase());
    return res.json({
      ok: true,
      payload,
      duplicate: true,
      already_processed: alreadyProcessed,
      transaction: existing,
      paygate_url: alreadyProcessed ? null : buildPaygatePageUrl({ tx: existing, payload }),
      message: alreadyProcessed ? 'Paiement deja termine' : 'Paiement deja initie',
    });
  } catch (err) {
    console.error('QR scan error:', err);
    return res.status(400).json({ ok: false, error: 'invalid_payload', details: err.message });
  }
});

// POST /api/scan/validate - validate + create/find tx + return PayGate page URL
router.post('/validate', async (req, res) => {
  try {
    const packed = req.body?.p;
    if (!packed) return res.status(400).json({ ok: false, error: 'missing_p' });

    const payload = decodePackedPayload(packed);
    const signatureCheck = verifyQrSignature(payload);
    if (!signatureCheck.ok) return res.status(401).json({ ok: false, error: signatureCheck.error });

    const required = validateRequiredFields(payload);
    if (!required.ok) return res.status(400).json({ ok: false, error: required.error });

    const identifier = String(payload.identifier || '').trim();
    const orderId = required.orderId;

    const sellerShareRaw = payload.seller_share ?? payload.seller_amount ?? payload.sellerShare ?? payload.sellerAmount ?? null;
    const sellerShare = sellerShareRaw != null && sellerShareRaw !== '' ? Number.parseFloat(sellerShareRaw) : null;
    const transportAmount = payload.transport_amount != null ? Number(payload.transport_amount) : (payload.transport_fee != null ? Number(payload.transport_fee) : null);
    const courierFee = payload.courier_fee != null ? Number(payload.courier_fee) : (payload.delivery_fee != null ? Number(payload.delivery_fee) : null);
    const productAmount = payload.product_amount != null ? Number(payload.product_amount) : null;
    const totalAmount = Number(required.amount);

    if (sellerShare != null && Number.isFinite(sellerShare) && sellerShare > totalAmount) {
      return res.status(400).json({ ok: false, error: 'invalid_seller_share', message: 'seller_share cannot exceed amount' });
    }
    if (transportAmount < 0 || totalAmount < 0) {
      return res.status(400).json({ ok: false, error: 'invalid_amounts' });
    }

    let verifiedOrder = null;
    try {
      verifiedOrder = await verifyOrderWithWeeshop({ orderId });
    } catch (verifyError) {
      return res.status(400).json({ ok: false, error: 'order_verification_failed', message: String(verifyError.message) });
    }

    if (String(verifiedOrder.payment_status || '').toLowerCase() === 'paid') {
      return res.status(400).json({ ok: false, error: 'order_already_paid', message: 'Order already paid in Weeshop' });
    }
    if (['cancelled'].includes(String(verifiedOrder.order_status || '').toLowerCase())) {
      return res.status(400).json({ ok: false, error: 'order_not_payable', message: 'Order is not payable in Weeshop' });
    }

    const expectedTotal = parseNumber(verifiedOrder.total_amount);
    const expectedSellerShare = parseNumber(verifiedOrder.seller_share);
    const expectedShippingAmount = parseNumber(verifiedOrder.shipping_amount ?? verifiedOrder.shippingAmount) ?? 0;

    if (expectedTotal != null && Math.abs(totalAmount - expectedTotal) > 1) {
      return res.status(400).json({ ok: false, error: 'total_amount_mismatch', expected: expectedTotal, received: totalAmount });
    }

    if (transportAmount == null) {
      transportAmount = expectedShippingAmount;
    }

    if (expectedShippingAmount != null && transportAmount != null && Math.abs(transportAmount - expectedShippingAmount) > 1) {
      return res.status(400).json({ ok: false, error: 'transport_amount_mismatch', expected: expectedShippingAmount, received: transportAmount });
    }

    if (sellerShare == null && expectedSellerShare != null) {
      sellerShare = expectedSellerShare;
    } else if (sellerShare != null && expectedSellerShare != null && Math.abs(sellerShare - expectedSellerShare) > 1) {
      return res.status(400).json({ ok: false, error: 'seller_share_mismatch', expected: expectedSellerShare, received: sellerShare });
    }

    let tx = null;
    if (identifier) tx = await db.findTransaction({ identifier });
    if (!tx) tx = await db.findTransaction({ order_id: orderId });

    if (!tx) {
      const txData = {
        order_id: orderId,
        boutique_id: payload.boutique_id || null,
        client_id: payload.client_id || null,
        client_phone: required.clientPhone,
        amount: totalAmount,
        product_amount: Number.isFinite(productAmount) ? productAmount : totalAmount - Math.max(0, transportAmount || 0),
        transport_fee: Number.isFinite(transportAmount) ? transportAmount : 0,
        identifier:
          identifier || `ATG-${Date.now()}-${Math.floor(Math.random() * 9000 + 1000)}`,
        status: 'pending',
        network: payload.network || payload.client_network || null,
        description: payload.description || `Paiement commande ${orderId}`,
        metadata: {
          source: 'scan_qr',
          items: Array.isArray(payload.items) ? payload.items : [],
          transport_fee: Number.isFinite(transportAmount) ? transportAmount : 0,
          courier_fee: Number.isFinite(courierFee) ? courierFee : null,
          seller_share: Number.isFinite(sellerShare) ? sellerShare : null,
          seller_user_id: payload.seller_user_id || payload.sellerId || null,
          seller_phone: payload.seller_phone || null,
          seller_network: payload.seller_network || null,
          seller_splits: Array.isArray(payload.splits) ? payload.splits : [],
        },
      };
      tx = await db.createTransaction(txData);
    }

    const currentStatus = String(tx.status || '').toLowerCase();
    if (currentStatus === 'completed') {
      return res.json({
        ok: true,
        already_processed: true,
        transaction: tx,
      });
    }

    const mergedMeta = {
      ...(tx.metadata || {}),
      source: 'scan_qr',
      items: Array.isArray(payload.items) ? payload.items : (tx.metadata?.items || []),
      transport_fee: Number.isFinite(transportAmount)
        ? transportAmount
        : tx.metadata?.transport_fee ?? tx.metadata?.transportFee ?? 0,
      courier_fee: Number.isFinite(courierFee)
        ? courierFee
        : tx.metadata?.courier_fee ?? tx.metadata?.delivery_fee ?? tx.metadata?.courierFee ?? null,
      seller_share: Number.isFinite(sellerShare)
        ? sellerShare
        : tx.metadata?.seller_share ?? tx.metadata?.sellerShare ?? null,
      seller_user_id:
        payload.seller_user_id ??
        payload.sellerId ??
        tx.metadata?.seller_user_id ??
        tx.metadata?.sellerId ??
        null,
      seller_phone: payload.seller_phone ?? tx.metadata?.seller_phone ?? null,
      seller_network:
        payload.seller_network ?? tx.metadata?.seller_network ?? null,
      seller_splits: Array.isArray(payload.splits)
        ? payload.splits
        : (Array.isArray(tx.metadata?.seller_splits) ? tx.metadata?.seller_splits : []),
    };

    await db.updateTransaction(tx._id, { status: 'processing' });
    // keep metadata in sync
    const Transaction = require('../models/Transaction');
    tx = await Transaction.findByIdAndUpdate(
      tx._id,
      { $set: { metadata: mergedMeta } },
      { new: true }
    );

    const paygateUrl = buildPaygatePageUrl({ tx, payload });
    if (!paygateUrl) {
      return res.status(500).json({ ok: false, error: 'missing_paygate_token' });
    }
    return res.json({
      ok: true,
      transaction: tx,
      paygate_url: paygateUrl,
      paygate_methods: ['FLOOZ', 'TMONEY'],
    });
  } catch (err) {
    console.error('Scan validate error:', err);
    return res.status(500).json({ ok: false, error: 'failed', details: err.message });
  }
});

module.exports = router;
