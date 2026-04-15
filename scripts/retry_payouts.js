const path = require('path');
const axios = require('axios');
const crypto = require('crypto');
const db = require('../db');
const Transaction = require('../models/Transaction');

require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

const PAYOUT_ENABLED = process.env.PAYGATE_PAYOUT_ENABLED
  ? String(process.env.PAYGATE_PAYOUT_ENABLED).toLowerCase() === 'true'
  : true;
const PAYOUT_URL = process.env.PAYGATE_PAYOUT_URL || 'https://paygateglobal.com/api/v1/cashout';
const DEFAULT_PAYOUT_NETWORK = (process.env.PAYGATE_PAYOUT_NETWORK || 'FLOOZ').toUpperCase();
const MAX_ATTEMPTS = Math.max(1, parseInt(process.env.PAYOUT_RETRY_MAX_ATTEMPTS || '5', 10));
const RUN_ATTEMPTS = Math.max(1, parseInt(process.env.PAYOUT_RETRY_ATTEMPTS || '1', 10));
const BATCH_LIMIT = Math.max(1, parseInt(process.env.PAYOUT_RETRY_LIMIT || '200', 10));

function normalizeNetwork(input) {
  const net = (input || '').toString().trim().toUpperCase();
  if (net === 'FLOOZ' || net === 'TMONEY') return net;
  return DEFAULT_PAYOUT_NETWORK;
}

function sanitizePhone(input) {
  if (!input) return '';
  let phone = String(input).replace(/\s+/g, '').replace(/[^0-9+]/g, '');
  if (phone.startsWith('00')) phone = '+' + phone.slice(2);
  return phone;
}

async function paygateCashout({ phone, amount, network, reference }) {
  const authToken = process.env.PAYGATE_AUTH_TOKEN || '';
  if (!authToken) {
    return { ok: false, error: 'missing_paygate_token' };
  }
  const payload = {
    auth_token: authToken,
    amount: Math.round(parseFloat(amount || 0)),
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

async function cashoutWithRetry(params, maxAttempts = 1) {
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
  return { ok: false, data: last ? last.data : null, attempts: maxAttempts, error: last ? last.error : 'cashout_failed' };
}

async function syncSellerPayout(tx, sellerPayout) {
  if (!tx || !sellerPayout || !tx.orderId) return;
  const alitogoshopPayoutUrl = process.env.ALITOGOSHOP_PAYOUT_SYNC_URL || 'http://localhost/alitogoshop/api_payout_sync.php';
  if (!alitogoshopPayoutUrl) return;

  const payload = {
    order_id: tx.orderId,
    boutique_id: tx.shopId || null,
    role: 'seller',
    amount: sellerPayout.amount,
    status: sellerPayout.status,
    phone: sellerPayout.phone || null,
    network: normalizeNetwork(sellerPayout.network),
    payout_reference: sellerPayout.reference || null,
    response: sellerPayout.response || null
  };

  const secret = process.env.PAYGATE_WEBHOOK_SECRET || '';
  const sig = secret
    ? crypto.createHmac('sha256', secret).update(JSON.stringify(payload)).digest('hex')
    : '';

  await axios.post(alitogoshopPayoutUrl, payload, {
    timeout: 10000,
    headers: {
      'Content-Type': 'application/json',
      ...(sig ? { 'X-Webhook-Signature': sig } : {})
    }
  });
}

async function run() {
  if (!PAYOUT_ENABLED) {
    console.log('Payouts disabled (PAYGATE_PAYOUT_ENABLED=false).');
    return;
  }
  if (!process.env.PAYGATE_AUTH_TOKEN) {
    console.log('Missing PAYGATE_AUTH_TOKEN. Retry aborted.');
    return;
  }

  await db.connect();

  const txs = await Transaction.find({
    'metadata.payouts': { $exists: true },
    $or: [
      { 'metadata.payouts.status': 'failed' },
      { 'metadata.payouts.status': 'pending_external' }
    ]
  }).sort({ createdAt: -1 }).limit(BATCH_LIMIT).lean();

  let updated = 0;
  for (const tx of txs) {
    const meta = Object.assign({}, tx.metadata || {});
    const payouts = Array.isArray(meta.payouts) ? meta.payouts : [];
    if (!payouts.length) continue;

    const sellerBefore = payouts.find(p => p && p.role === 'seller');
    const sellerBeforeStatus = sellerBefore ? sellerBefore.status : null;
    let changed = false;

    for (const p of payouts) {
      if (!p || !['seller', 'courier'].includes(p.role)) continue;
      const status = String(p.status || '').toLowerCase();
      if (status !== 'failed' && status !== 'pending_external') continue;

      const attempts = parseInt(p.attempts || 0, 10);
      if (attempts >= MAX_ATTEMPTS) continue;

      const phone = sanitizePhone(p.phone || '');
      if (!phone || !(parseFloat(p.amount || 0) > 0)) {
        if (p.status !== 'missing_phone') {
          p.status = 'missing_phone';
          changed = true;
        }
        continue;
      }

      const reference = p.reference || `PO-${tx._id}-${p.role}-${p.leg_index || '0'}`;
      const result = await cashoutWithRetry({
        phone,
        amount: p.amount,
        network: p.network,
        reference
      }, RUN_ATTEMPTS);

      p.reference = reference;
      p.provider = 'paygate';
      p.response = result.data || null;
      p.attempts = attempts + (result.attempts || 1);
      p.last_attempt_at = new Date().toISOString();
      p.status = result.ok ? 'paid' : 'failed';
      if (!result.ok && result.error) p.error = result.error;
      changed = true;
    }

    if (!changed) continue;

    const paidStatuses = payouts.filter(p => p.role !== 'platform').map(p => p.status);
    meta.payout_policy = meta.payout_policy || 'direct_phone_cashout';
    meta.payout_provider = meta.payout_provider || 'paygate';
    meta.payouts = payouts;
    meta.payout_status = paidStatuses.every(s => s === 'paid')
      ? 'paid'
      : (paidStatuses.some(s => s === 'failed') ? 'partial_failed' : 'pending_external');

    await Transaction.findByIdAndUpdate(tx._id, { $set: { metadata: meta } });
    updated += 1;

    const sellerAfter = payouts.find(p => p && p.role === 'seller');
    if (sellerAfter && sellerAfter.status !== sellerBeforeStatus) {
      try {
        await syncSellerPayout(tx, sellerAfter);
      } catch (e) {
        console.error('Payout sync seller failed:', e.message);
      }
    }
  }

  console.log(`Retry payouts complete: ${updated} transaction(s) updated.`);
}

run()
  .then(() => process.exit(0))
  .catch(err => {
    console.error('Retry payouts error:', err);
    process.exit(1);
  });
