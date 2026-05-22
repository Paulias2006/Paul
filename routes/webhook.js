const express = require('express');
const axios = require('axios');
const crypto = require('crypto');

const db = require('../db');
const yasClient = require('../services/yasClient');
const Transaction = require('../models/Transaction');

const router = express.Router();

const SYNC_SECRET =
  process.env.WEEDELIVRED_SYNC_SECRET ||
  process.env.PAYGATE_WEBHOOK_SECRET ||
  '';

const WEESHOP_PAYMENT_SYNC_URL =
  process.env.WEESHOP_WEEDELIVRED_PAYMENT_SYNC_URL ||
  process.env.WEESHOP_PAYMENT_SYNC_URL ||
  'https://weeshop.onrender.com/api/paygate/weedelivred-sync';

const WEESHOP_PAYOUT_SYNC_URL =
  process.env.WEESHOP_WEEDELIVRED_PAYOUT_SYNC_URL ||
  process.env.WEESHOP_PAYOUT_SYNC_URL ||
  'https://weeshop.onrender.com/api/paygate/weedelivred-payout-sync';

function parseNumber(value) {
  if (value == null || value === '') return null;
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

function readRawBody(req) {
  if (Buffer.isBuffer(req.body)) {
    return req.body.toString('utf8');
  }
  if (typeof req.body === 'string') {
    return req.body;
  }
  return '';
}

function parseJsonBody(req) {
  if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) {
    return req.body;
  }
  const raw = readRawBody(req);
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch (_) {
    return {};
  }
}

async function postWeeshopSync(url, payload) {
  const headers = buildSyncSignatureHeaders(payload);
  return axios.post(url, payload, { timeout: 10000, headers });
}

async function syncPaymentToWeeshop({ tx, amount, sellerShare, transportFee, courierFee }) {
  const payload = {
    order_id: String(tx.orderId || ''),
    payment_reference: tx.paymentReference || '',
    amount: Number(amount || tx.amount || 0),
    seller_share: sellerShare,
    transport_fee: transportFee,
    courier_fee: courierFee,
    payment_method: 'TMONEY',
    status: 'completed',
    datetime: new Date().toISOString(),
  };
  await postWeeshopSync(WEESHOP_PAYMENT_SYNC_URL, payload);
  return payload;
}

async function syncPayoutToWeeshop({ tx, role, status, amount, phone, reference }) {
  const payload = {
    role,
    order_id: String(tx.orderId || ''),
    payment_reference: tx.paymentReference || '',
    payout_reference: reference || '',
    status,
    amount,
    phone,
    network: 'TMONEY',
    datetime: new Date().toISOString(),
  };
  await postWeeshopSync(WEESHOP_PAYOUT_SYNC_URL, payload);
  return payload;
}

async function runPayouts({ tx, sellerShare, courierFee }) {
  const meta = tx.metadata || {};
  const payouts = Array.isArray(meta.payouts) ? [...meta.payouts] : [];

  const runOne = async ({ role, phone, amount }) => {
    const cleanAmount = Math.round(Number(amount) || 0);
    const cleanPhone = String(phone || '').trim();
    if (!cleanPhone || !(cleanAmount > 0)) {
      return { role, ok: false, status: 'skipped', reason: 'missing_phone_or_amount' };
    }

    const reference = `WS-${String(tx.orderId || '').slice(-10)}-${role}-${String(tx.identifier || '').slice(-8)}`;
    const result = await yasClient.payout({
      phone: cleanPhone,
      amount: cleanAmount,
      reference,
      description: role === 'seller'
        ? 'Reglement vendeur Weeshop'
        : role === 'pickup_point'
          ? 'Commission point de retrait Weeshop'
          : 'Reglement livreur Weeshop',
      metadata: { order_id: tx.orderId, identifier: tx.identifier, role },
    });

    const status = result.ok
      ? (result.status === 'paid' ? 'paid' : 'processing')
      : 'rejected';

    const providerReference = result.providerReference || reference;
    payouts.push({
      role,
      amount: cleanAmount,
      phone: cleanPhone,
      status,
      provider: 'yas',
      reference: providerReference,
      providerStatus: result.providerStatus || '',
    });

    try {
      await syncPayoutToWeeshop({
        tx,
        role,
        status,
        amount: cleanAmount,
        phone: cleanPhone,
        reference: providerReference,
      });
    } catch (error) {
      console.error('❌ Payout sync error:', error?.message || String(error));
    }

    return { role, ok: result.ok, status, reference: providerReference };
  };

  const sellerPhone = String(meta.seller_phone || '').trim();
  const courierPhone = String(meta.courier_phone || '').trim();
  const pickupPointPhone = String(meta.pickup_point_phone || '').trim();
  const pickupPointFee = Number(meta.pickup_point_fee || meta.pickupPointFee || 0);

  const sellerResult = await runOne({ role: 'seller', phone: sellerPhone, amount: sellerShare });
  const courierResult = await runOne({ role: 'courier', phone: courierPhone, amount: courierFee });
  const pickupPointResult = await runOne({
    role: 'pickup_point',
    phone: pickupPointPhone,
    amount: pickupPointFee,
  });

  await Transaction.findByIdAndUpdate(tx._id, { $set: { 'metadata.payouts': payouts } });
  return { sellerResult, courierResult, pickupPointResult };
}

// Legacy PayGate webhook disabled (explicit).
router.post('/', async (_req, res) => {
  return res.status(410).json({
    ok: false,
    error: 'paygate_disabled',
    message: 'PayGate disabled; use /api/webhook/yas',
  });
});

// YAS webhook: confirms payment, then triggers direct payouts seller+courier.
router.post('/yas', async (req, res) => {
  try {
    const rawBody = readRawBody(req);
    const signatureHeader =
      req.headers['x-yas-signature'] ||
      req.headers['x-webhook-signature'] ||
      req.headers['x-signature'] ||
      req.headers['signature'] ||
      '';

    if (!yasClient.verifyWebhookSignature({ rawBody, signatureHeader })) {
      return res.status(401).json({ ok: false, error: 'invalid_signature' });
    }

    const body = parseJsonBody(req);
    const identifier = String(body.identifier || body.id || '').trim();
    const paymentReference = String(
      body.payment_reference ||
        body.paymentReference ||
        body.reference ||
        body.provider_reference ||
        body.providerReference ||
        '',
    ).trim();

    if (!identifier && !paymentReference) {
      return res.status(400).json({ ok: false, error: 'missing_identifier' });
    }

    let tx = null;
    if (paymentReference) {
      tx = await db.findTransaction({ payment_reference: paymentReference });
    }
    if (!tx && identifier) {
      tx = await db.findTransaction({ identifier });
    }
    if (!tx) {
      return res.status(404).json({ ok: false, error: 'transaction_not_found' });
    }

    const normalizedStatus = yasClient.normalizePaymentStatus(
      body.status ?? body.state ?? body.result ?? body.payment_status ?? body.paymentStatus ?? '',
    );
    const alreadyCompleted = String(tx.status || '').toLowerCase() === 'completed';

    const amountTotal = parseNumber(body.amount) ?? Number(tx.amount || 0);
    const sellerShare = parseNumber(body.seller_share ?? body.sellerShare) ?? parseNumber(tx?.metadata?.seller_share) ?? null;
    const transportFee = parseNumber(body.transport_fee ?? body.transportFee) ?? parseNumber(tx?.metadata?.transport_fee) ?? 0;
    const courierFee = parseNumber(body.courier_fee ?? body.courierFee) ?? parseNumber(tx?.metadata?.courier_fee) ?? null;

    if (normalizedStatus === 'paid') {
      const existingPayouts = Array.isArray(tx?.metadata?.payouts) ? tx.metadata.payouts : [];
      if (alreadyCompleted && existingPayouts.length > 0) {
        return res.json({
          ok: true,
          status: 'paid',
          transactionId: String(tx._id),
          payouts: { skipped: true, reason: 'already_completed' },
        });
      }
      if (!alreadyCompleted) {
        tx = await db.updateTransaction(tx._id, {
          status: 'completed',
          payment_reference: paymentReference || tx.paymentReference || null,
          payment_method: 'TMONEY',
          phone_number: String(body.phone || body.phone_number || tx.phoneNumber || '').trim() || null,
        });
      }

      try {
        await syncPaymentToWeeshop({
          tx,
          amount: amountTotal,
          sellerShare,
          transportFee,
          courierFee,
        });
      } catch (error) {
        console.error('❌ Payment sync error:', error?.message || String(error));
      }

      const payoutResults = await runPayouts({ tx, sellerShare, courierFee });
      return res.json({
        ok: true,
        status: 'paid',
        transactionId: String(tx._id),
        payouts: payoutResults,
      });
    }

    if (normalizedStatus === 'failed') {
      if (!alreadyCompleted) {
        await db.updateTransaction(tx._id, {
          status: 'failed',
          payment_reference: paymentReference || tx.paymentReference || null,
          payment_method: 'TMONEY',
        });
      }
      return res.json({ ok: true, status: 'failed', transactionId: String(tx._id) });
    }

    return res.json({ ok: true, status: normalizedStatus, transactionId: String(tx._id) });
  } catch (err) {
    console.error('yas webhook error', err);
    return res.status(500).json({ ok: false, error: err?.message || String(err) });
  }
});

module.exports = router;

