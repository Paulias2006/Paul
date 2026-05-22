const axios = require('axios');
const crypto = require('crypto');
 
function normalizeText(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[_\s-]+/g, '');
}
 
function normalizePaymentStatus(value) {
  const normalized = normalizeText(value);
  if (['paid', 'paye', 'payé', 'success', 'succeeded', 'completed', 'complete', 'ok', '0'].includes(normalized)) {
    return 'paid';
  }
  if (['failed', 'failure', 'cancelled', 'canceled', 'rejected', 'expired', '4', '6'].includes(normalized)) {
    return 'failed';
  }
  if (['pending', 'processing', 'waiting', 'inprogress', '2'].includes(normalized)) {
    return 'pending';
  }
  return normalized || 'pending';
}
 
function buildAuthHeaders(authValue) {
  const headers = { 'Content-Type': 'application/json' };
  const auth = String(authValue || '').trim();
  if (auth) {
    headers.Authorization = auth;
  }
  const apiKey = String(process.env.YAS_API_KEY || '').trim();
  if (apiKey) {
    headers['X-Api-Key'] = apiKey;
  }
  const clientId = String(process.env.YAS_CLIENT_ID || '').trim();
  const clientSecret = String(process.env.YAS_CLIENT_SECRET || '').trim();
  if (clientId) headers['X-Client-Id'] = clientId;
  if (clientSecret) headers['X-Client-Secret'] = clientSecret;
  return headers;
}
 
function buildReference(prefix) {
  return `${prefix}-${crypto.randomBytes(6).toString('hex').toUpperCase()}`;
}
 
function envOrEmpty(key) {
  return String(process.env[key] || '').trim();
}
 
async function postJson(url, payload, headers, timeoutMs = 15000) {
  if (!url) {
    return { ok: false, status: 'pending', reason: 'missing_url' };
  }
  try {
    const response = await axios.post(url, payload, { headers, timeout: timeoutMs });
    return { ok: true, httpStatus: response.status, data: response.data };
  } catch (error) {
    const response = error?.response;
    return {
      ok: false,
      httpStatus: response?.status,
      data: response?.data,
      reason: error?.message || 'network_error',
    };
  }
}
 
/**
 * NOTE: The exact YAS API payload may differ. Keep all mapping here so you can
 * tweak env URLs/auth without touching business logic.
 */
async function collectPayment({ phone, amount, reference, description, metadata }) {
  const url = envOrEmpty('YAS_COLLECT_URL');
  const merchantId = envOrEmpty('YAS_MERCHANT_ID');
  const headers = buildAuthHeaders(envOrEmpty('YAS_COLLECT_AUTH') || envOrEmpty('YAS_API_AUTH'));
 
  if (!url || !merchantId) {
    return { ok: false, status: 'pending', reason: 'missing_yas_collect_config' };
  }
 
  const payload = {
    merchantId,
    amount: Number(amount) || 0,
    phone: String(phone || '').trim(),
    reference: reference || buildReference('YAS-COLLECT'),
    description: description || 'Paiement Weeshop',
    currency: 'XOF',
    metadata: metadata || {},
  };
 
  const res = await postJson(url, payload, headers, 20000);
  if (!res.ok) {
    return { ok: false, status: 'pending', reason: res.reason, raw: res.data || null };
  }
 
  const providerStatus = res.data?.status || res.data?.state || res.data?.result || '';
  const status = normalizePaymentStatus(providerStatus);
  const providerReference =
    res.data?.reference ||
    res.data?.transactionId ||
    res.data?.id ||
    res.data?.payment_reference ||
    res.data?.paymentReference ||
    '';
 
  return {
    ok: true,
    status,
    providerStatus: String(providerStatus || ''),
    providerReference: String(providerReference || ''),
    raw: res.data,
    request: payload,
  };
}
 
async function payout({ phone, amount, reference, description, metadata }) {
  const url = envOrEmpty('YAS_PAYOUT_URL');
  const merchantId = envOrEmpty('YAS_MERCHANT_ID');
  const headers = buildAuthHeaders(envOrEmpty('YAS_PAYOUT_AUTH') || envOrEmpty('YAS_API_AUTH'));
 
  if (!url || !merchantId) {
    return { ok: false, status: 'pending', reason: 'missing_yas_payout_config' };
  }
 
  const payload = {
    merchantId,
    amount: Number(amount) || 0,
    phone: String(phone || '').trim(),
    reference: reference || buildReference('YAS-PAYOUT'),
    description: description || 'Reglement Weeshop',
    currency: 'XOF',
    metadata: metadata || {},
  };
 
  const res = await postJson(url, payload, headers, 20000);
  if (!res.ok) {
    return { ok: false, status: 'pending', reason: res.reason, raw: res.data || null };
  }
 
  const providerStatus = res.data?.status || res.data?.state || res.data?.result || '';
  const normalized = normalizePaymentStatus(providerStatus);
  const status = normalized === 'paid' ? 'paid' : (normalized === 'failed' ? 'failed' : 'processing');
  const providerReference =
    res.data?.reference ||
    res.data?.transactionId ||
    res.data?.id ||
    '';
 
  return {
    ok: true,
    status,
    providerStatus: String(providerStatus || ''),
    providerReference: String(providerReference || ''),
    raw: res.data,
    request: payload,
  };
}
 
async function fetchStatus({ reference, providerReference }) {
  const url = envOrEmpty('YAS_STATUS_URL');
  const headers = buildAuthHeaders(envOrEmpty('YAS_STATUS_AUTH') || envOrEmpty('YAS_API_AUTH'));
  if (!url) {
    return { ok: false, status: 'pending', reason: 'missing_yas_status_url' };
  }
 
  const payload = {
    reference: reference || providerReference || '',
    providerReference: providerReference || '',
  };
 
  const res = await postJson(url, payload, headers, 15000);
  if (!res.ok) {
    return { ok: false, status: 'pending', reason: res.reason, raw: res.data || null };
  }
 
  const providerStatus = res.data?.status || res.data?.state || res.data?.result || '';
  const status = normalizePaymentStatus(providerStatus);
  return {
    ok: true,
    status,
    providerStatus: String(providerStatus || ''),
    raw: res.data,
  };
}
 
/**
 * Optional: verify incoming YAS webhooks with a shared secret. If you don't have
 * a signature scheme, keep it permissive by leaving YAS_WEBHOOK_SECRET empty.
 */
function verifyWebhookSignature({ rawBody, signatureHeader }) {
  const secret = envOrEmpty('YAS_WEBHOOK_SECRET');
  if (!secret) return true;
  const signature = String(signatureHeader || '').trim();
  if (!signature) return false;
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
  } catch (_) {
    return false;
  }
}
 
module.exports = {
  normalizePaymentStatus,
  collectPayment,
  payout,
  fetchStatus,
  verifyWebhookSignature,
};

