const crypto = require('crypto');
const express = require('express');
const router = express.Router();
const axios = require('axios');
const db = require('../db');
const yasClient = require('../services/yasClient');
const { normalizeWeeshopSyncUrl } = require('../utils/weeshopSyncUrl');

const SYNC_SECRET =
  process.env.WEEDELIVRED_SYNC_SECRET ||
  '';
const WEESHOP_ORDER_VERIFY_URL = normalizeWeeshopSyncUrl(
  process.env.WEESHOP_WEEDELIVRED_ORDER_VERIFY_URL ||
  process.env.WEESHOP_WEEDELIVRED_VERIFY_ORDER_URL ||
  '',
  'https://weeshop.onrender.com/api/yas/weedelivred-order-verify',
);

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

// Initiate a payment: create a transaction and call YAS/TMoney direct collect API
router.post('/initiate', async (req, res) => {
  try {
    const {
      order_id,
      boutique_id,
      client_id,
      client_phone,
      amount,
      product_amount,
      transport_amount,
      courier_fee,
      courier_id,
      seller_amount,
      seller_share,
      description,
      items,
      seller_phone,
      courier_phone,
    } = req.body;

    if (!order_id || !client_phone) {
      return res.status(400).json({ error: 'Missing required fields: order_id, client_phone' });
    }

    const orderIdKey = String(order_id).trim();
    let verifiedOrder = null;
    try {
      verifiedOrder = await verifyOrderWithWeeshop({ orderId: orderIdKey });
    } catch (verifyError) {
      return res.status(400).json({ ok: false, error: 'order_verification_failed', message: String(verifyError.message) });
    }

    if (String(verifiedOrder.payment_status || '').toLowerCase() === 'paid') {
      return res.status(400).json({ ok: false, error: 'order_already_paid', message: 'Order already paid in Weeshop' });
    }
    if (['cancelled'].includes(String(verifiedOrder.order_status || '').toLowerCase())) {
      return res.status(400).json({ ok: false, error: 'order_not_payable', message: 'Order is not payable in Weeshop' });
    }

    const sellerShareRaw = seller_share ?? seller_amount ?? null;
    const sellerShare = sellerShareRaw != null && sellerShareRaw !== '' ? Number.parseFloat(sellerShareRaw) : null;
    let transportAmt = transport_amount != null ? parseFloat(transport_amount) : null;
    let totalAmt = amount != null ? parseFloat(amount) : null;
    let prodAmt = product_amount != null ? parseFloat(product_amount) : null;
    const courierFee = courier_fee != null ? parseFloat(courier_fee) : null;

    if (sellerShare != null && !Number.isFinite(sellerShare)) {
      return res.status(400).json({ error: 'invalid_seller_share' });
    }
    if (transportAmt != null && !Number.isFinite(transportAmt)) {
      return res.status(400).json({ error: 'invalid_transport_amount' });
    }
    if (totalAmt != null && !Number.isFinite(totalAmt)) {
      return res.status(400).json({ error: 'invalid_total_amount' });
    }
    if (prodAmt != null && !Number.isFinite(prodAmt)) {
      return res.status(400).json({ error: 'invalid_product_amount' });
    }
    if (courierFee != null && !Number.isFinite(courierFee)) {
      return res.status(400).json({ error: 'invalid_courier_fee' });
    }

    const expectedTotal = parseNumber(verifiedOrder.total_amount);
    const expectedSellerShare = parseNumber(verifiedOrder.seller_share);
    const expectedShippingAmount = parseNumber(verifiedOrder.shipping_amount ?? verifiedOrder.shippingAmount) ?? 0;

    if (expectedTotal != null && totalAmt != null && Math.abs(totalAmt - expectedTotal) > 1) {
      return res.status(400).json({ ok: false, error: 'total_amount_mismatch', expected: expectedTotal, received: totalAmt });
    }

    if (transportAmt == null) {
      transportAmt = expectedShippingAmount;
    }

    if (expectedShippingAmount != null && transportAmt != null && Math.abs(transportAmt - expectedShippingAmount) > 1) {
      return res.status(400).json({ ok: false, error: 'transport_amount_mismatch', expected: expectedShippingAmount, received: transportAmt });
    }

    if (sellerShare == null && expectedSellerShare != null) {
      sellerShare = expectedSellerShare;
    } else if (sellerShare != null && expectedSellerShare != null && Math.abs(sellerShare - expectedSellerShare) > 1) {
      return res.status(400).json({ ok: false, error: 'seller_share_mismatch', expected: expectedSellerShare, received: sellerShare });
    }

    if (prodAmt == null && transportAmt != null && totalAmt != null) {
      prodAmt = Math.max(0, totalAmt - transportAmt);
    }
    if (transportAmt == null && prodAmt != null && totalAmt != null) {
      transportAmt = Math.max(0, totalAmt - prodAmt);
    }
    if (totalAmt == null && prodAmt != null && transportAmt != null) {
      totalAmt = prodAmt + transportAmt;
    }

    if (totalAmt == null) {
      return res.status(400).json({ error: 'Missing amount information' });
    }
    if (transportAmt == null) {
      transportAmt = 0;
    }
    if (prodAmt == null) {
      prodAmt = Math.max(0, totalAmt - transportAmt);
    }

    if (transportAmt < 0 || totalAmt < 0 || prodAmt < 0) {
      return res.status(400).json({ error: 'invalid_amounts' });
    }
    if (sellerShare != null && sellerShare > totalAmt) {
      return res.status(400).json({ error: 'invalid_seller_share', message: 'seller_share cannot exceed total amount' });
    }

    const identifier = 'ATG-' + Date.now() + '-' + Math.floor(Math.random() * 9000 + 1000);

    // Create transaction in DB (store product & transport in metadata)
    const transactionData = {
      order_id: String(order_id),
      boutique_id: boutique_id ? String(boutique_id) : null,
      client_id: client_id ? String(client_id) : null,
      client_phone: client_phone,
      amount: parseFloat(totalAmt),
      product_amount: parseFloat(prodAmt),
      transport_fee: parseFloat(transportAmt),
      identifier: identifier,
      status: 'pending',
      network: 'TMONEY',
      description: description || `Paiement commande ${order_id}`,
      metadata: {
        courierId: courier_id || null,
        items: Array.isArray(items) ? items : [],
        courier_fee: courier_fee != null ? parseFloat(courier_fee) : null,
        seller_share: sellerShare != null ? Number.parseFloat(sellerShare) : null,
        seller_phone: seller_phone || null,
        courier_phone: courier_phone || null,
      }
    };

    const transaction = await db.createTransaction(transactionData);
    const txId = transaction._id || transaction.id;

    await db.createPaymentLog({
      transaction_id: txId,
      type: 'request',
      endpoint: 'yas_collect',
      payload: {
        order_id,
        client_phone,
        amount: totalAmt,
        product_amount: prodAmt,
        transport_amount: transportAmt,
        seller_share: sellerShare,
        courier_fee,
        identifier,
      },
    });

    const collectResult = await yasClient.collectPayment({
      phone: client_phone,
      amount: totalAmt,
      reference: `WS-${String(order_id).slice(-10)}-${identifier}`,
      description: description || `Paiement commande ${order_id}`,
      metadata: {
        order_id: String(order_id),
        identifier,
        seller_share: sellerShare,
        transport_fee: transportAmt,
        courier_fee: courier_fee != null ? parseFloat(courier_fee) : null,
      },
    });

    await db.createPaymentLog({
      transaction_id: txId,
      type: 'response',
      endpoint: 'yas_collect',
      payload: collectResult.raw || collectResult,
      status_code: collectResult.ok ? 200 : 500,
    });

    const updatedTx = await db.updateTransaction(txId, {
      status: collectResult.ok ? 'processing' : 'failed',
      payment_reference: collectResult.providerReference || null,
      payment_method: 'TMONEY',
      phone_number: client_phone,
    });

    return res.json({
      ok: collectResult.ok,
      txId: String(txId),
      identifier,
      payment_reference: collectResult.providerReference || null,
      provider_status: collectResult.providerStatus || '',
      status: collectResult.status || 'pending',
      transaction: updatedTx,
    });
  } catch (err) {
    console.error('Payment initiation error:', err);

    // Log the error
    if (err.response) {
      await db.createPaymentLog({
        transaction_id: null,
        type: 'error',
      endpoint: 'yas_collect',
        payload: err.response.data,
        status_code: err.response.status,
        error_message: err.message
      });
    }

    return res.status(500).json({ ok: false, error: 'failed', details: err.message });
  }
});

// Check transaction status by identifier or payment_reference
router.post('/status', async (req, res) => {
  try {
    const { identifier, payment_reference } = req.body;
    if (!identifier && !payment_reference) {
      return res.status(400).json({ error: 'Provide identifier or payment_reference' });
    }

    const transaction = await db.findTransaction(
      identifier ? { identifier } : { payment_reference }
    );

    if (!transaction) return res.status(404).json({ error: 'not_found' });
    return res.json({ ok: true, transaction });
  } catch (err) {
    console.error('Status check error:', err);
    return res.status(500).json({ error: 'failed', details: err.message });
  }
});

// Get transaction history
router.get('/history', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 50;
    const transactions = await db.getTransactionHistory(limit);
    return res.json({ ok: true, transactions });
  } catch (err) {
    console.error('History fetch error:', err);
    return res.status(500).json({ error: 'failed', details: err.message });
  }
});

// Withdraw funds for couriers/sellers
router.post('/withdraw', async (req, res) => {
  try {
    return res.status(410).json({ ok: false, error: 'wallet_disabled', message: 'Retraits désactivés (pas de wallet interne).' });
    const { courier_id, amount, phone, network, description } = req.body;
    
    // Pour les couriers: courier_id est requis
    // Pour les vendeurs: user_id est utilisé (legacy)
    const user_id = req.body.user_id || courier_id;
    
    if (!user_id || !amount || !phone) {
      return res.status(400).json({ ok: false, error: 'Missing required fields (user_id/courier_id, amount, phone)' });
    }

    const parsedAmount = parseFloat(amount);
    if (parsedAmount <= 0) {
      return res.status(400).json({ ok: false, error: 'Amount must be positive' });
    }

    // Check wallet balance
    let currentBalance = 0;
    try {
      // Utiliser MongoDB pour tous les utilisateurs (vendeurs et livreurs)
      const wallet = await db.getWallet(parseInt(user_id));
      currentBalance = wallet ? wallet.balance : 0;
    } catch (e) {
      console.error('[WITHDRAW] Erreur lecture wallet:', e);
      return res.status(500).json({ ok: false, error: 'Erreur lecture portefeuille' });
    }

    if (currentBalance < parsedAmount) {
      return res.status(400).json({ 
        ok: false, 
        error: 'Insufficient balance',
        current_balance: currentBalance,
        requested: parsedAmount
      });
    }

    const identifier = 'WD-' + Date.now() + '-' + Math.floor(Math.random() * 9000 + 1000);

    // Create withdrawal transaction record
    try {
      const transactionData = {
        order_id: 0, // 0 for withdrawals
        boutique_id: null,
        client_id: user_id,
        client_phone: phone,
        amount: parsedAmount,
        product_amount: 0,
        transport_amount: 0,
        identifier: identifier,
        status: 'pending',
        network: network || null,
        description: description || `Retrait ${courier_id ? 'livreur' : 'vendeur'} ${user_id}`,
        metadata: {
          type: 'withdraw',
          courier_id: courier_id || null,
          network: network || null
        }
      };

      const transaction = await db.createTransaction(transactionData);
      const txId = transaction.id;

      // Log the withdrawal request
      await db.createPaymentLog({
        transaction_id: txId,
        type: 'withdraw_request',
        endpoint: 'withdraw_initiate',
        payload: { courier_id, user_id, amount: parsedAmount, phone, network }
      });

      // Deduct from wallet immediately
      try {
        await db.debitWallet(parseInt(user_id), parsedAmount);
      } catch (e) {
        console.error('[WITHDRAW] Erreur débit portefeuille:', e);
        return res.status(500).json({ ok: false, error: 'Erreur débit portefeuille' });
      }

      // Synchroniser dÃ©bit avec AliTogoShop (wallet MySQL)
      try {
        const alitogoshopUrl = process.env.ALITOGOSHOP_URL || 'https://alitogoshop.onrender.com';
        const alitogoshopKey = process.env.ALITOGOSHOP_API_KEY || '';
        if (!alitogoshopKey) {
          throw new Error('ALITOGOSHOP_API_KEY not configured');
        }

        const debitPayload = {
          action: 'debit_seller_wallet',
          seller_id: parseInt(user_id),
          amount: parsedAmount,
          transaction_id: identifier,
          description: description || `Retrait vendeur ${user_id}`
        };

        const debitRes = await axios.post(`${alitogoshopUrl}/api_wallet_debit.php`, debitPayload, {
          timeout: 10000,
          headers: {
            'Content-Type': 'application/json',
            'X-API-Key': alitogoshopKey
          }
        });

        if (!debitRes.data || !debitRes.data.ok) {
          throw new Error(debitRes.data?.error || 'AlitogoShop debit failed');
        }
      } catch (syncErr) {
        console.error('[WITHDRAW] Sync AlitogoShop debit failed:', syncErr.message);
        // rollback Mongo debit
        try {
          await db.creditWallet(parseInt(user_id), parsedAmount);
        } catch (rollbackErr) {
          console.error('[WITHDRAW] Rollback Mongo debit failed:', rollbackErr);
        }
        return res.status(500).json({ ok: false, error: 'Sync debit failed', details: syncErr.message });
      }

      return res.status(410).json({
        ok: false,
        error: 'withdraw_disabled',
        message: 'Retraits manuels desactives: les reglements passent automatiquement par YAS/TMoney.',
      });
    } catch (e) {
      console.error('[WITHDRAW] Erreur création transaction:', e);
      return res.status(500).json({ ok: false, error: 'Transaction creation failed', details: e.message });
    }

  } catch (err) {
    console.error('[WITHDRAW] Erreur globale:', err);
    return res.status(500).json({ ok: false, error: 'Withdrawal failed', details: err.message });
  }
});

// Check transaction status via YAS API (by payment_reference or identifier)
router.post('/check-status', async (req, res) => {
  try {
    const { payment_reference, identifier } = req.body;
    if (!payment_reference && !identifier) {
      return res.status(400).json({ error: 'Provide payment_reference or identifier' });
    }

    // Find local transaction
    const tx = payment_reference
      ? await db.findTransaction({ payment_reference })
      : await db.findTransaction({ identifier });

    if (!tx) {
      return res.status(404).json({ error: 'transaction_not_found' });
    }

    const statusResult = await yasClient.fetchStatus({
      reference: tx.paymentReference || payment_reference || '',
      providerReference: tx.paymentReference || payment_reference || '',
    });

    if (statusResult.ok) {
      const normalized = yasClient.normalizePaymentStatus(statusResult.providerStatus || statusResult.status || '');
      const internalStatus = normalized === 'paid'
        ? 'completed'
        : (normalized === 'failed' ? 'failed' : 'processing');
      await db.updateTransaction(tx._id, {
        status: internalStatus,
        payment_reference: tx.paymentReference || payment_reference || null,
        payment_method: tx.paymentMethod || 'TMONEY',
      });
    }

    const latestTx = await db.findTransaction({ id: tx._id });
    return res.json({
      ok: true,
      transaction: latestTx || tx,
      provider_response: statusResult.raw || null,
    });
  } catch (err) {
    console.error('Status check error:', err);
    return res.status(500).json({ error: 'failed', details: err.message });
  }
});

// Balance endpoints are provider-specific; disabled in YAS direct mode.
router.post('/check-balance', async (_req, res) => {
  return res.status(410).json({ ok: false, error: 'disabled', message: 'check-balance disabled in YAS direct mode' });
});


module.exports = router;
