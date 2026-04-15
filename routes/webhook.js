const express = require('express');
const router = express.Router();
const db = require('../db');
const crypto = require('crypto');
const axios = require('axios');
const Message = require('../models/Message');
const User = require('../models/User');
const WalletService = require('../services/walletService');

const WEESHOP_ORDER_VERIFY_URL =
  process.env.WEESHOP_WEEDELIVRED_ORDER_VERIFY_URL ||
  process.env.WEESHOP_WEEDELIVRED_VERIFY_ORDER_URL ||
  'http://localhost:5000/api/paygate/weedelivred-verify-order';

// Commission mapping per category (AliTogoShop)
const DEFAULT_COMMISSION_RATE = 0.05;
// Toutes les categories utilisent maintenant le meme taux fixe: 5%.
const CATEGORY_COMMISSIONS = {};

function normalizeCategory(input) {
  if (!input) return '';
  const str = String(input).toLowerCase();
  const noAccents = str.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  return noAccents
    .replace(/&/g, ' ')
    .replace(/\//g, ' ')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/__+/g, '_');
}

function resolveCommissionRate(category, categoryKey) {
  const key = normalizeCategory(categoryKey || category);
  if (key && CATEGORY_COMMISSIONS[key] !== undefined) {
    return CATEGORY_COMMISSIONS[key];
  }
  return DEFAULT_COMMISSION_RATE;
}

const PAYOUT_ENABLED = process.env.PAYGATE_PAYOUT_ENABLED
  ? String(process.env.PAYGATE_PAYOUT_ENABLED).toLowerCase() === 'true'
  : false;
const PAYOUT_URL = process.env.PAYGATE_PAYOUT_URL || 'https://paygateglobal.com/api/v1/cashout';
const DEFAULT_PAYOUT_NETWORK = (process.env.PAYGATE_PAYOUT_NETWORK || 'FLOOZ').toUpperCase();
const COURIER_FEE_SHARE = Math.max(0, Math.min(1, parseFloat(process.env.COURIER_FEE_SHARE || '1')));
const SYNC_SECRET =
  process.env.WEEDELIVRED_SYNC_SECRET || process.env.PAYGATE_WEBHOOK_SECRET || '';
const WEESHOP_PAYOUT_SYNC_URL =
  process.env.WEESHOP_WEEDELIVRED_PAYOUT_SYNC_URL ||
  process.env.ALITOGOSHOP_PAYOUT_SYNC_URL ||
  process.env.WEESHOP_PAYOUT_SYNC_URL ||
  'http://localhost:5000/api/paygate/weedelivred-payout-sync';
const WEESHOP_PAYMENT_SYNC_URL =
  process.env.WEESHOP_WEEDELIVRED_PAYMENT_SYNC_URL ||
  process.env.ALITOGOSHOP_SYNC_URL ||
  process.env.WEESHOP_PAYMENT_SYNC_URL ||
  'http://localhost:5000/api/paygate/weedelivred-sync';
const PAYGATE_STATUS_V1_URL = process.env.PAYGATE_STATUS_V1_URL || 'https://paygateglobal.com/api/v1/status';
const PAYGATE_STATUS_V2_URL = process.env.PAYGATE_STATUS_V2_URL || 'https://paygateglobal.com/api/v2/status';

function normalizeNetwork(input) {
  const net = (input || '').toString().trim().toUpperCase();
  if (net === 'FLOOZ' || net === 'TMONEY') return net;
  return DEFAULT_PAYOUT_NETWORK;
}

function sanitizePhone(input) {
  if (!input) return '';
  let phone = String(input).replace(/\s+/g, '').replace(/[^0-9+]/g, '');
  if (phone.startsWith('00')) phone = '+' + phone.slice(2);
  if (!phone.startsWith('+')) phone = '+' + phone;
  return phone;
}

function normalizePaymentMethod(input) {
  const raw = String(input || '').trim().toUpperCase();
  const compact = raw.replace(/[\s_-]+/g, '');
  if (compact === 'FLOOZ') return 'FLOOZ';
  if (compact === 'TMONEY') return 'TMONEY';
  return raw || null;
}

function parseNumber(value) {
  if (value == null || value === '') return null;
  const num = Number.parseFloat(value);
  return Number.isFinite(num) ? num : null;
}

function resolveSellerShare(tx) {
  const candidate = parseNumber(
    tx?.metadata?.seller_share ??
    tx?.metadata?.seller_amount ??
    tx?.metadata?.sellerShare ??
    tx?.metadata?.sellerAmount
  );
  return candidate != null && candidate >= 0 ? Math.round(candidate) : null;
}

function resolveTransportFee(tx, body) {
  const candidate = parseNumber(
    body?.transport_fee ??
    body?.transportAmount ??
    body?.transportFee ??
    tx?.metadata?.transport_fee ??
    tx?.metadata?.transportFee ??
    tx?.metadata?.delivery_fee ??
    tx?.metadata?.deliveryFee
  );
  return candidate != null && candidate >= 0 ? Math.round(candidate) : 0;
}

function resolveCourierFee(tx, body) {
  const candidate = parseNumber(
    body?.courier_fee ??
    body?.delivery_fee ??
    body?.courierFee ??
    body?.deliveryFee ??
    tx?.metadata?.courier_fee ??
    tx?.metadata?.delivery_fee ??
    tx?.metadata?.courierFee ??
    tx?.metadata?.deliveryFee
  );
  return candidate != null && candidate >= 0 ? Math.round(candidate) : null;
}

function resolveCourierId(tx, body) {
  const candidate =
    (body && (body.courier_id ?? body.courierId)) ??
    (tx && tx.metadata && (tx.metadata.courier_id ?? tx.metadata.courierId));
  return String(candidate || '').trim() || null;
}

function normalizeEntityId(value) {
  const raw = String(value || '').trim();
  return raw || null;
}

function buildSellerPayouts(tx, sellerShare, verifiedOrder) {
  const meta = Object.assign({}, tx?.metadata || {});
  const aggregated = new Map();
  const rawSplits = Array.isArray(meta.seller_splits) ? meta.seller_splits : [];

  const registerSeller = ({ userId, amount, phone, network }) => {
    const normalizedUserId = normalizeEntityId(userId);
    const normalizedAmount = parseNumber(amount);
    if (!normalizedUserId || normalizedAmount == null || normalizedAmount <= 0) {
      return;
    }

    const current = aggregated.get(normalizedUserId) || {
      userId: normalizedUserId,
      amount: 0,
      phone: '',
      network: '',
    };
    current.amount += normalizedAmount;
    current.phone = current.phone || String(phone || '').trim();
    current.network = current.network || String(network || '').trim().toUpperCase();
    aggregated.set(normalizedUserId, current);
  };

  for (const split of rawSplits) {
    registerSeller({
      userId: split?.seller_id ?? split?.sellerId ?? split?.user_id ?? split?.userId,
      amount: split?.seller_share ?? split?.sellerShare ?? split?.amount,
      phone: split?.seller_phone ?? split?.phone,
      network: split?.seller_network ?? split?.network,
    });
  }

  if (aggregated.size === 0) {
    registerSeller({
      userId:
        meta.seller_user_id ??
        meta.sellerId ??
        verifiedOrder?.seller_user_id ??
        verifiedOrder?.sellerUserId,
      amount: sellerShare,
      phone: meta.seller_phone ?? verifiedOrder?.seller_phone,
      network: meta.seller_network ?? verifiedOrder?.seller_network,
    });
  }

  return Array.from(aggregated.values()).map((entry) => ({
    role: 'seller',
    user_id: entry.userId,
    amount: Math.round(entry.amount),
    phone: entry.phone || '',
    network: entry.network || '',
    status: 'credited',
    provider: 'weeshop_wallet',
  }));
}

function isSuccessfulPayoutStatus(status) {
  return ['paid', 'credited'].includes(String(status || '').trim().toLowerCase());
}

function mapPaygateStatusToInternal(status) {
  if (status === 0 || status === '0') return 'completed';
  if (status === 2 || status === '2') return 'processing';
  if (status === 4 || status === '4') return 'failed';
  if (status === 6 || status === '6') return 'cancelled';
  return 'processing';
}

async function resolvePaygateStatus({ identifier, txReference }) {
  const authToken = process.env.PAYGATE_AUTH_TOKEN || '';
  if (!authToken) return null;
  try {
    if (txReference) {
      const v1Res = await axios.post(PAYGATE_STATUS_V1_URL, {
        auth_token: authToken,
        tx_reference: txReference
      }, { timeout: 10000 });
      return v1Res.data || null;
    }
    if (identifier) {
      const v2Res = await axios.post(PAYGATE_STATUS_V2_URL, {
        auth_token: authToken,
        identifier
      }, { timeout: 10000 });
      return v2Res.data || null;
    }
    return null;
  } catch (error) {
    console.warn('PayGate status resolution failed:', error?.message || String(error));
    return null;
  }
}

function buildSyncSignatureHeaders(payload) {
  if (!SYNC_SECRET) {
    return {
      'Content-Type': 'application/json'
    };
  }
  const ts = String(Math.floor(Date.now() / 1000));
  const nonce = crypto.randomBytes(12).toString('hex');
  const raw = JSON.stringify(payload);
  const canonical = `${ts}.${nonce}.${raw}`;
  const sig = crypto.createHmac('sha256', SYNC_SECRET).update(canonical).digest('hex');
  return {
    'Content-Type': 'application/json',
    'X-Webhook-Timestamp': ts,
    'X-Webhook-Nonce': nonce,
    'X-Webhook-Signature': sig
  };
}

async function verifyOrderWithWeeshop({ orderId, paymentReference }) {
  const payload = {};
  if (orderId) payload.order_id = orderId;
  if (paymentReference) payload.payment_reference = paymentReference;
  try {
    const response = await axios.post(WEESHOP_ORDER_VERIFY_URL, payload, {
      timeout: 10000,
      headers: buildSyncSignatureHeaders(payload),
    });
    if (!response?.data?.ok) {
      throw new Error(response?.data?.error || 'verify_failed');
    }
    return response.data;
  } catch (error) {
    console.warn('Order verification failed:', error?.message || String(error));
    throw error;
  }
}

async function paygateCashout({ phone, amount, network, reference }) {
  const authToken = process.env.PAYGATE_AUTH_TOKEN || '';
  if (!authToken) {
    return { ok: false, error: 'missing_paygate_token' };
  }
  const parsedAmount = Math.round(parseFloat(amount || 0));
  if (parsedAmount <= 0) {
    return { ok: false, error: 'invalid_amount' };
  }
  const payload = {
    auth_token: authToken,
    amount: parsedAmount,
    phone_number: phone,
    network: normalizeNetwork(network),
    reference
  };
  const response = await axios.post(PAYOUT_URL, payload, { timeout: 20000 });
  const data = response.data || {};
  const statusRaw = (data.status || data.code || data.result || '').toString().toUpperCase();
  const ok = data.ok === true || statusRaw === 'SUCCESS' || statusRaw === 'OK' || statusRaw === '0';
  return { ok, data };
}

async function cashoutWithRetry(params, maxAttempts = 3) {
  let last = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const result = await paygateCashout(params);
    if (result.ok) {
      return { ok: true, data: result.data, attempts: attempt };
    }
    last = result;
    if (attempt < maxAttempts) {
      const delayMs = 800 * attempt;
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }
  return { ok: false, data: last ? last.data : null, attempts: maxAttempts, error: last ? (last.error || 'cashout_failed') : 'cashout_failed' };
}

// Webhook handler for PayGateGlobal with signature verification
router.post('/', async (req, res) => {
  try {
    // req.body is raw Buffer because server mounts this route with express.raw
    const rawBody = req.body && Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '';

    // Verify signature header if present, else fallback to auth_token in payload.
    // PayGate callback (guide) may come without signature/auth_token; optional compatibility below.
    const sigHeader = (req.headers['x-paygate-signature'] || req.headers['x-signature'] || req.headers['signature'] || '').toString();
    const webhookSecret = process.env.PAYGATE_WEBHOOK_SECRET || '';
    const allowUnsignedGuideCallback = String(process.env.PAYGATE_ALLOW_UNSIGNED_CALLBACK || '').toLowerCase() === 'true';
    let verified = false;

    if (sigHeader && webhookSecret) {
      const expected = crypto.createHmac('sha256', webhookSecret).update(rawBody).digest('hex');
      try {
        if (crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(sigHeader))) {
          verified = true;
        }
      } catch (e) {
        // Signature verification failed
        verified = false;
      }
    }

    let parsed;
    try {
      parsed = rawBody ? JSON.parse(rawBody) : req.body;
    } catch (e) {
      parsed = {};
    }

    if (!verified) {
      // fallback: check auth_token in payload
      if (parsed && parsed.auth_token && parsed.auth_token === process.env.PAYGATE_AUTH_TOKEN) {
        verified = true;
      }
    }

    if (!verified) {
      // Guide callback payload: tx_reference, identifier, payment_reference, amount...
      const looksLikeGuideCallback = Boolean(
        (parsed && (parsed.identifier || parsed.tx_reference)) &&
        (parsed && parsed.payment_reference) &&
        (parsed && parsed.amount !== undefined)
      );
      if (looksLikeGuideCallback && (allowUnsignedGuideCallback || !webhookSecret)) {
        verified = true;
      }
    }

    if (!verified) {
      // log and reject
      console.log('Webhook signature verification failed:', { rawBody: rawBody || JSON.stringify(req.body) });
      return res.status(401).json({ ok: false, error: 'invalid_signature' });
    }

    const body = parsed;
    const { tx_reference, identifier, payment_reference, amount, datetime, payment_method, phone_number, status } = body;
    if (!identifier && !tx_reference) {
      console.log('Webhook missing identifier:', { rawBody: rawBody || JSON.stringify(body) });
      return res.status(400).send('missing identifier');
    }

    // Find transaction using MongoDB
    const tx = await db.findTransaction(
      identifier ? { identifier } : { paygate_tx_reference: tx_reference }
    );
    if (!tx) {
      // Unknown transaction - log and continue
      console.log('Unknown transaction in webhook:', { identifier, tx_reference, body });
      return res.json({ ok: false, message: 'unknown_tx' });
    }

    const callbackAmount = Number(amount || 0);
    if (amount !== undefined && amount !== null && !Number.isFinite(callbackAmount)) {
      return res.status(400).json({ ok: false, error: 'invalid_amount' });
    }
    if (callbackAmount > 0 && Number.isFinite(Number(tx.amount || 0))) {
      const txAmount = Number(tx.amount || 0);
      if (Math.abs(txAmount - callbackAmount) > 1) {
        console.warn('Webhook amount mismatch:', {
          identifier,
          txAmount,
          callbackAmount
        });
      }
    }

    // Map PayGate status codes to internal states per guide:
    // 0=success, 2=processing, 4=expired, 6=cancelled.
    let resolvedPaygate = null;
    let effectiveStatus = status;
    if (effectiveStatus === undefined || effectiveStatus === null || effectiveStatus === '') {
      // Callback payload from PayGate guide can be sent without `status`.
      resolvedPaygate = await resolvePaygateStatus({
        identifier,
        txReference: tx_reference || tx.paygateTxReference || null
      });
      if (resolvedPaygate && resolvedPaygate.status !== undefined && resolvedPaygate.status !== null && resolvedPaygate.status !== '') {
        effectiveStatus = resolvedPaygate.status;
      } else if (payment_reference || tx_reference) {
        // Confirmation callback with payment reference => paid by definition.
        effectiveStatus = 0;
      } else {
        effectiveStatus = 2;
      }
    }

    const newStatus = mapPaygateStatusToInternal(effectiveStatus);
    const normalizedMethod = normalizePaymentMethod(
      payment_method ||
      (resolvedPaygate && resolvedPaygate.payment_method) ||
      tx.paymentMethod
    );
    const resolvedTxReference =
      tx_reference ||
      (resolvedPaygate && resolvedPaygate.tx_reference) ||
      tx.paygateTxReference ||
      null;
    const resolvedPaymentReference =
      payment_reference ||
      (resolvedPaygate && resolvedPaygate.payment_reference) ||
      null;

    // Update transaction with PayGate response fields
    await db.updateTransaction(tx._id, {
      status: newStatus,
      paygate_tx_reference: resolvedTxReference,
      payment_reference: resolvedPaymentReference,
      payment_method: normalizedMethod || null
    });

    // Log webhook
    console.log('Webhook received:', {
      identifier,
      tx_reference: resolvedTxReference,
      payment_method: normalizedMethod,
      status: effectiveStatus,
      newStatus
    });

    if (newStatus === 'completed') {
      const amountTotal = Math.round(parseFloat(amount || tx.amount || 0));
      let sellerShare = resolveSellerShare(tx);
      let verifiedOrder = null;
      const transportFee = resolveTransportFee(tx, body);
      const courierFee = resolveCourierFee(tx, body);
      const courierId = resolveCourierId(tx, body);

      if (sellerShare == null && tx.orderId) {
        try {
          verifiedOrder = await verifyOrderWithWeeshop({
            orderId: String(tx.orderId),
            paymentReference: resolvedPaymentReference,
          });
          const verifiedSellerShare = parseNumber(verifiedOrder?.seller_share);
          if (verifiedSellerShare != null) {
            sellerShare = Math.round(verifiedSellerShare);
          }
        } catch (verifyErr) {
          console.warn('verifyOrderWithWeeshop failed for seller_share:', verifyErr?.message || String(verifyErr));
        }
      }
      const courierPayoutAmount = courierFee != null ? Math.round(courierFee * COURIER_FEE_SHARE) : 0;
      const platformTransportShare = Math.max(0, transportFee - courierPayoutAmount);
      const platformAmountTotal = sellerShare != null ? Math.max(0, amountTotal - sellerShare - courierPayoutAmount) : null;
      const courierPayouts = [];
      const baseMeta = Object.assign({}, tx.metadata || {});
      const existingPayouts = Array.isArray(baseMeta.payouts) ? baseMeta.payouts : [];
      const existingMap = new Map();
      for (const ep of existingPayouts) {
        const key = `${ep.role || ''}:${ep.user_id || ''}:${ep.leg_index || 0}`;
        existingMap.set(key, ep);
      }

      console.log(`💰 Payment details for transaction ${tx._id}:`);
      console.log(`   Total: ${amountTotal} XOF`);
      console.log(`   Seller share: ${sellerShare != null ? sellerShare + ' XOF' : 'unknown'}`);
      console.log(`   Transport fee: ${transportFee} XOF`);
      console.log(`   Courier fee raw: ${courierFee != null ? courierFee + ' XOF' : 'none'}`);
      console.log(`   Courier payout: ${courierPayoutAmount} XOF`);
      console.log(`   Platform transport share: ${platformTransportShare} XOF`);
      if (platformAmountTotal != null) {
        console.log(`   Platform total: ${platformAmountTotal} XOF`);
      }

      // Build courier payouts from direct invoice metadata or webhook payload.
      if (courierId && courierPayoutAmount > 0) {
        let courierPhone = '';
        let courierNetwork = '';
        const meta = tx.metadata || {};

        if (meta.courierPhone) courierPhone = String(meta.courierPhone);
        if (meta.courier_phone) courierPhone = courierPhone || String(meta.courier_phone);
        if (meta.courierNetwork) courierNetwork = String(meta.courierNetwork);
        if (meta.courier_network) courierNetwork = courierNetwork || String(meta.courier_network);

        courierPayouts.push({
          role: 'courier',
          user_id: courierId,
          amount: courierPayoutAmount,
          phone: courierPhone,
          network: courierNetwork,
          leg_index: body?.leg_index || meta?.leg_index || null,
        });
      } else if (courierFee != null && !courierId) {
        console.warn(`Courier fee provided but courier_id missing for transaction ${tx._id}`);
      }

      for (const cp of courierPayouts) {
        if (cp.user_id && cp.amount > 0) {
          try {
            await WalletService.credit(
              cp.user_id,
              cp.amount,
              `Paiement livreur pour transaction ${tx._id}`,
              'courier',
            );
            cp.status = 'paid';
            cp.provider = 'internal_wallet';
            cp.reference = `wallet_credit_${tx._id}`;
          } catch (creditErr) {
            cp.status = 'failed';
            cp.error = creditErr?.message || String(creditErr);
          }
        } else {
          cp.status = 'missing_wallet';
        }
      }

      console.log(`   Transport split: courier=${courierPayoutAmount} XOF, platform=${platformTransportShare} XOF`);

      const sellerPayouts = buildSellerPayouts(tx, sellerShare, verifiedOrder).map((item) => ({
        ...item,
        reference: resolvedPaymentReference || tx.identifier || null,
      }));
      const payouts = [];
      for (const sp of sellerPayouts) {
        payouts.push({
          role: 'seller',
          user_id: sp.user_id,
          amount: sp.amount,
          phone: sp.phone,
          network: sp.network,
          status: sp.status,
          provider: sp.provider,
          reference: sp.reference,
        });
      }
      for (const cp of courierPayouts) {
        payouts.push({
          role: 'courier',
          user_id: cp.user_id,
          amount: cp.amount,
          phone: cp.phone,
          network: cp.network,
          leg_index: cp.leg_index,
          status: cp.status || (cp.phone ? 'pending_external' : 'missing_phone'),
          provider: cp.provider || null,
          reference: cp.reference || null,
          error: cp.error || null,
        });
      }
      if (platformAmountTotal != null && platformAmountTotal > 0) {
        payouts.push({
          role: 'platform',
          user_id: process.env.PLATFORM_USER_ID || null,
          amount: platformAmountTotal,
          status: 'pending_external'
        });
      }

      // Execute direct payouts via PayGate only for platform fees if enabled
      if (PAYOUT_ENABLED) {
        for (const p of payouts) {
          if (p.role !== 'platform') continue;
          if (p.status !== 'pending_external') continue;
          const key = `${p.role || ''}:${p.user_id || ''}:${p.leg_index || 0}`;
          const already = existingMap.get(key);
          if (already && already.status === 'paid') {
            p.status = 'paid';
            p.reference = already.reference || null;
            p.response = already.response || null;
            continue;
          }
          const phone = sanitizePhone(p.phone || '');
          if (!phone || p.amount <= 0) {
            p.status = 'missing_phone';
            continue;
          }
          try {
            const reference = `PO-${tx._id}-${p.role}-${p.leg_index || '0'}`;
            const result = await cashoutWithRetry({
              phone,
              amount: p.amount,
              network: p.network,
              reference
            }, 3);
            p.reference = reference;
            p.provider = 'paygate';
            p.response = result.data || null;
            p.attempts = result.attempts || 1;
            p.status = result.ok ? 'paid' : 'failed';
          } catch (pErr) {
            p.status = 'failed';
            p.error = pErr?.message || String(pErr);
          }
        }
      }

      try {
        const Transaction = require('../models/Transaction');
        const meta = Object.assign({}, tx.metadata || {});
        meta.payout_policy = 'direct_phone_cashout';
        meta.payout_provider = 'paygate';
        const paidStatuses = payouts.filter(p => p.role !== 'platform').map(p => p.status);
        meta.payout_status = paidStatuses.every((s) => isSuccessfulPayoutStatus(s))
          ? 'paid'
          : (paidStatuses.some(s => s === 'failed') ? 'partial_failed' : 'pending_external');
        meta.shares = {
          seller: sellerShare,
          courier: courierPayoutAmount,
          platform: platformAmountTotal,
          commission_product: null,
          transport_fee: transportFee
        };
        meta.payouts = payouts;
        await Transaction.findByIdAndUpdate(tx._id, { $set: { metadata: meta } });
        console.log('✅ Payout plan stored (direct phone payout).');
      } catch (metaErr) {
        console.error('❌ Failed to store payout plan:', metaErr?.message || String(metaErr));
      }

      // Log successful completion
      await db.createPaymentLog({
        transaction_id: tx._id,
        type: 'payment_completed',
        endpoint: 'webhook',
        payload: {
          identifier,
          tx_reference: resolvedTxReference,
          payment_reference: resolvedPaymentReference,
          amount: amountTotal,
          product_amount: tx.metadata?.product_amount ?? null,
          transport_fee: transportFee,
          seller_share: sellerShare,
        },
      });

      if (tx.orderId) {
        const orderIdKey = String(tx.orderId);
        try {
          const Message = require('../models/Message');
          await Message.updateMany(
            { type: 'order_notification', 'metadata.orderId': orderIdKey },
            {
              $set: {
                'metadata.paymentStatus': 'paid',
                'metadata.paymentReference': resolvedPaymentReference || null,
                'metadata.paidAt': new Date(),
                'metadata.status': 'completed'
              }
            }
          );
        } catch (msgErr) {
          console.error('❌ Message update failed:', msgErr?.message || String(msgErr));
        }

        console.log(`📤 Synchronisation commande ${orderIdKey} vers Weeshop...`);
        
        try {
          let officialSellerShare = resolveSellerShare(tx);
          let officialTransportFee = transportFee;
          if (tx.orderId) {
            try {
              const verifiedOrder = await verifyOrderWithWeeshop({ orderId: String(tx.orderId) });
              officialSellerShare = parseNumber(verifiedOrder?.seller_share) ?? officialSellerShare;
              officialTransportFee = parseNumber(verifiedOrder?.shipping_amount ?? verifiedOrder?.shippingAmount) ?? officialTransportFee;
            } catch (verifyErr) {
              console.error('❌ Weeshop verification before sync failed:', verifyErr?.message || String(verifyErr));
            }
          }

          const syncPayload = {
            order_id: orderIdKey,
            identifier: tx.identifier || null,
            tx_reference: resolvedTxReference || null,
            payment_reference: resolvedPaymentReference || null,
            amount: amountTotal,
            seller_share: officialSellerShare,
            transport_fee: officialTransportFee,
            courier_fee: courierFee,
            payment_method: normalizedMethod || 'UNKNOWN',
            status: 'completed',
            datetime: new Date().toISOString()
          };

          const syncResponse = await axios.post(WEESHOP_PAYMENT_SYNC_URL, syncPayload, {
            timeout: 10000,
            headers: buildSyncSignatureHeaders(syncPayload)
          });

          console.log(`✅ Weeshop synchronisé avec succès`, syncResponse.data);
        } catch (syncError) {
          console.error('❌ Erreur synchronisation Weeshop:', syncError?.message || String(syncError));
          // Log l'erreur mais ne pas bloquer le webhook
          await db.createPaymentLog({
            transaction_id: tx._id,
            type: 'sync_error',
            endpoint: 'weeshop_sync',
            error_message: syncError?.message || String(syncError),
            payload: { order_id: orderIdKey }
          });
        }
      }
    }

    // log webhook payload
    console.log('Webhook processed successfully:', {
      identifier,
      tx_reference: resolvedTxReference || tx_reference || null,
      status: newStatus
    });

    return res.json({ ok: true });
  } catch (err) {
    console.error('webhook error', err);
    return res.status(500).json({ ok: false, error: err?.message || String(err) });
  }
});

module.exports = router;
