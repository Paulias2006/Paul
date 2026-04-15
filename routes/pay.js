const crypto = require('crypto');
const express = require('express');
const router = express.Router();
const axios = require('axios');
const { v4: uuidv4 } = require('uuid');
const db = require('../db');

const SYNC_SECRET =
  process.env.WEEDELIVRED_SYNC_SECRET ||
  process.env.PAYGATE_WEBHOOK_SECRET ||
  '';
const WEESHOP_ORDER_VERIFY_URL =
  process.env.WEESHOP_WEEDELIVRED_ORDER_VERIFY_URL ||
  process.env.WEESHOP_WEEDELIVRED_VERIFY_ORDER_URL ||
  'http://localhost:5000/api/paygate/weedelivred-verify-order';

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

const mapPayGateStatus = (status) => {
  if (status === 0 || status === '0') return 'completed';
  if (status === 2 || status === '2') return 'processing';
  if (status === 4 || status === '4') return 'failed';
  if (status === 6 || status === '6') return 'cancelled';
  return 'processing';
};

const triggerSettlementWebhook = async ({ tx, paygateData }) => {
  if (!tx || !tx.identifier) return;
  const base = process.env.SELF_BASE_URL || `http://127.0.0.1:${process.env.PORT || 4001}`;
  const url = `${base.replace(/\/$/, '')}/api/webhook`;
  const payload = {
    auth_token: process.env.PAYGATE_AUTH_TOKEN,
    identifier: tx.identifier,
    tx_reference: paygateData?.tx_reference || tx.paygateTxReference || '',
    payment_reference: paygateData?.payment_reference || tx.paymentReference || '',
    amount: Number(paygateData?.amount || tx.amount || 0),
    datetime: paygateData?.datetime || new Date().toISOString(),
    payment_method: paygateData?.payment_method || tx.paymentMethod || '',
    phone_number: paygateData?.phone_number || tx.phoneNumber || '',
    status: 0,
  };
  await axios.post(url, payload, {
    timeout: 15000,
    headers: { 'Content-Type': 'application/json' },
  });
};

// Initiate a payment: create a transaction and call PayGateGlobal
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
      network,
      description,
      items,
    } = req.body;

    if (!order_id || !client_phone || !network) {
      return res.status(400).json({ error: 'Missing required fields: order_id, client_phone, network' });
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
      network: network || null,
      description: description || `Paiement commande ${order_id}`,
      metadata: {
        courierId: courier_id || null,
        items: Array.isArray(items) ? items : [],
        courier_fee: courier_fee != null ? parseFloat(courier_fee) : null,
        seller_share: sellerShare != null ? Number.parseFloat(sellerShare) : null,
      }
    };

    const transaction = await db.createTransaction(transactionData);
    const txId = transaction._id || transaction.id;

    // Log the request
    await db.createPaymentLog({
      transaction_id: txId,
      type: 'request',
      endpoint: 'paygate_initiate',
      payload: { order_id, client_phone, amount: totalAmt, product_amount: prodAmt, transport_amount: transportAmt, seller_share: sellerShare, courier_fee: courier_fee, identifier }
    });

    // Call PayGateGlobal API (Method 1 - direct POST)
    const paygateUrl = 'https://paygateglobal.com/api/v1/pay';
    const payload = {
      auth_token: process.env.PAYGATE_AUTH_TOKEN,
      phone_number: client_phone,
      amount: totalAmt,
      description: description || `Paiement commande ${order_id}`,
      identifier: identifier,
      network: network || 'FLOOZ' // Required: FLOOZ or TMONEY
    };

    const pgRes = await axios.post(paygateUrl, payload, { timeout: 15000 });

    // Log the response
    await db.createPaymentLog({
      transaction_id: txId,
      type: 'response',
      endpoint: 'paygate_initiate',
      payload: pgRes.data,
      status_code: pgRes.status
    });

    // Update transaction with paygate response
    const txRef = pgRes.data.tx_reference || null;
    const status = pgRes.data.status || 2;

    // Log PayGate response for debugging
    await db.createPaymentLog({
      transaction_id: txId,
      type: 'paygate_response',
      endpoint: 'paygate_initiate',
      payload: {
        paygate_status: status,
        tx_reference: txRef,
        status_codes: '0=enregistré, 2=auth_invalid, 4=params_invalid, 6=doublon'
      }
    });

    // Per PayGate guide: status 0 means registered successfully, others are errors
    if (status !== 0 && status !== '0') {
      return res.json({
        ok: false,
        error: 'paygate_error',
        paygate_status: status,
        message: {
          0: 'Transaction enregistrée',
          2: 'Token invalide',
          4: 'Paramètres invalides',
          6: 'Doublon détecté'
        }[status] || 'Erreur inconnue'
      });
    }

    // Transaction registered successfully - keep pending until webhook confirms
    await db.updateTransaction(txId, {
      paygate_tx_reference: txRef,
      status: 'processing' // waiting for payment
    });

    return res.json({
      ok: true,
      txId,
      identifier,
      tx_reference: txRef,
      paygate_status: status,
      pgResponse: pgRes.data
    });
  } catch (err) {
    console.error('Payment initiation error:', err);

    // Log the error
    if (err.response) {
      await db.createPaymentLog({
        transaction_id: null,
        type: 'error',
        endpoint: 'paygate_initiate',
        payload: err.response.data,
        status_code: err.response.status,
        error_message: err.message
      });
    }

    return res.status(500).json({ error: 'failed', details: err.message });
  }
});

// Check transaction status by identifier or tx_reference
router.post('/status', async (req, res) => {
  try {
    const { identifier, tx_reference } = req.body;
    if (!identifier && !tx_reference) return res.status(400).json({ error: 'Provide identifier or tx_reference' });

    const transaction = await db.findTransaction(
      identifier ? { identifier } : { paygate_tx_reference: tx_reference }
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
        const alitogoshopUrl = process.env.ALITOGOSHOP_URL || 'http://localhost/alitogoshop';
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

      // Build PayGate URL for withdrawal
      const paygateBaseUrl = 'https://paygateglobal.com/v1/page';
      const paygateParams = new URLSearchParams({
        token: process.env.PAYGATE_AUTH_TOKEN || '85910664-0d67-481c-b27a-03058183020e',
        amount: parsedAmount.toString(),
        description: description || `Retrait ${courier_id ? 'livreur' : 'vendeur'} ${user_id}`,
        identifier: identifier,
        phone: phone,
        network: network || 'FLOOZ',
        callback_url: process.env.WITHDRAW_CALLBACK_URL || 'http://localhost:4001/api/webhook/withdraw'
      });
      const paygateUrl = `${paygateBaseUrl}?${paygateParams.toString()}`;

      console.log('[WITHDRAW] ✅ Retrait initié - ID:', identifier, 'Montant:', parsedAmount, 'Network:', network);

      return res.json({
        ok: true,
        txId,
        identifier,
        paygate_url: paygateUrl,
        message: 'Withdrawal initiated successfully'
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

// Check transaction status via PayGateGlobal API (Method v1 - by tx_reference)
router.post('/check-status', async (req, res) => {
  try {
    const { tx_reference, identifier } = req.body;
    if (!tx_reference && !identifier) {
      return res.status(400).json({ error: 'Provide tx_reference or identifier' });
    }

    // Find local transaction
    const tx = tx_reference
      ? await db.findTransaction({ paygate_tx_reference: tx_reference })
      : await db.findTransaction({ identifier });

    if (!tx) {
      return res.status(404).json({ error: 'transaction_not_found' });
    }

    const beforeStatus = String(tx.status || '').toLowerCase();
    let paygateResponse = null;
    let internalStatus = beforeStatus || 'processing';

    try {
      if (tx.paygateTxReference) {
        // Method v1 (tx_reference)
        const v1Url = 'https://paygateglobal.com/api/v1/status';
        const payload = {
          auth_token: process.env.PAYGATE_AUTH_TOKEN,
          tx_reference: tx.paygateTxReference,
        };
        const pgRes = await axios.post(v1Url, payload, { timeout: 15000 });
        paygateResponse = pgRes.data || {};
      } else if (tx.identifier) {
        // Method v2 (identifier) - required for QR page flow
        const v2Url = 'https://paygateglobal.com/api/v2/status';
        const payload = {
          auth_token: process.env.PAYGATE_AUTH_TOKEN,
          identifier: tx.identifier,
        };
        const pgRes = await axios.post(v2Url, payload, { timeout: 15000 });
        paygateResponse = pgRes.data || {};
      }
    } catch (pgErr) {
      console.error('PayGate status check failed:', pgErr.message);
      return res.status(500).json({ error: 'paygate_error', details: pgErr.message });
    }

    if (paygateResponse) {
      const pgStatus = paygateResponse.status ?? 2;
      internalStatus = mapPayGateStatus(pgStatus);
      const updated = await db.updateTransaction(tx._id, {
        status: internalStatus,
        paygate_tx_reference: paygateResponse.tx_reference || tx.paygateTxReference || null,
        payment_reference: paygateResponse.payment_reference || tx.paymentReference || null,
        payment_method: paygateResponse.payment_method || tx.paymentMethod || null,
      });
      tx.status = updated?.status || internalStatus;
      tx.paygateTxReference = updated?.paygateTxReference || tx.paygateTxReference;
      tx.paymentReference = updated?.paymentReference || tx.paymentReference;
      tx.paymentMethod = updated?.paymentMethod || tx.paymentMethod;
    }

    // If paid and this call discovered payment first, trigger settlement now.
    if (internalStatus === 'completed' && beforeStatus !== 'completed') {
      try {
        await triggerSettlementWebhook({ tx, paygateData: paygateResponse });
      } catch (settleErr) {
        console.error('Settlement trigger error:', settleErr.message);
      }
    }

    const latestTx = await db.findTransaction({ id: tx._id });
    return res.json({
      ok: true,
      transaction: latestTx || tx,
      paygate_response: paygateResponse || null,
    });
  } catch (err) {
    console.error('Status check error:', err);
    return res.status(500).json({ error: 'failed', details: err.message });
  }
});

// Check platform balance via PayGateGlobal API
router.post('/check-balance', async (req, res) => {
  try {
    const paygateUrl = 'https://paygateglobal.com/api/v1/check-balance';
    const payload = {
      auth_token: process.env.PAYGATE_AUTH_TOKEN
    };

    const pgRes = await axios.post(paygateUrl, payload, { timeout: 15000 });

    return res.json({
      ok: true,
      flooz_balance: pgRes.data.flooz || 0,
      tmoney_balance: pgRes.data.tmoney || 0,
      total_balance: (parseFloat(pgRes.data.flooz || 0) + parseFloat(pgRes.data.tmoney || 0))
    });
  } catch (err) {
    console.error('Balance check error:', err);
    return res.status(500).json({ error: 'failed', details: err.message });
  }
});


module.exports = router;
