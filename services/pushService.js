const admin = require('firebase-admin');
const User = require('../models/User');

let firebaseApp = null;
let firebaseDisabledReason = '';

function parseServiceAccount(raw) {
  if (!raw) return null;
  const trimmed = String(raw).trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch (_) {
    try {
      const decoded = Buffer.from(trimmed, 'base64').toString('utf8');
      return JSON.parse(decoded);
    } catch (error) {
      firebaseDisabledReason = `Invalid FIREBASE_SERVICE_ACCOUNT_JSON: ${error.message}`;
      return null;
    }
  }
}

function getFirebaseApp() {
  if (firebaseApp) return firebaseApp;
  if (admin.apps.length > 0) {
    firebaseApp = admin.app();
    return firebaseApp;
  }

  const projectId = process.env.FIREBASE_PROJECT_ID || 'weeshop-3fd8a';
  const serviceAccount = parseServiceAccount(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
  try {
    if (serviceAccount) {
      firebaseApp = admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
        projectId: serviceAccount.project_id || projectId,
      });
      return firebaseApp;
    }
    if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
      firebaseApp = admin.initializeApp({
        credential: admin.credential.applicationDefault(),
        projectId,
      });
      return firebaseApp;
    }
    firebaseDisabledReason =
      'FIREBASE_SERVICE_ACCOUNT_JSON or GOOGLE_APPLICATION_CREDENTIALS is required';
    return null;
  } catch (error) {
    firebaseDisabledReason = error.message;
    return null;
  }
}

function logPush(message) {
  if (process.env.NODE_ENV !== 'test') {
    console.warn(`[push] ${message}`);
  }
}

async function sendPushToTokens(tokens, { title, body, data = {} } = {}) {
  const uniqueTokens = Array.from(new Set((tokens || []).filter(Boolean)));
  if (uniqueTokens.length === 0) {
    return { sent: 0, failed: 0 };
  }

  const app = getFirebaseApp();
  if (!app) {
    if (firebaseDisabledReason) logPush(firebaseDisabledReason);
    return { sent: 0, failed: uniqueTokens.length, disabled: true };
  }

  let sent = 0;
  let failed = 0;
  for (let index = 0; index < uniqueTokens.length; index += 500) {
    const batch = uniqueTokens.slice(index, index + 500);
    const response = await admin.messaging(app).sendEachForMulticast({
      tokens: batch,
      notification: {
        title: title || 'WeeDelivred',
        body: body || 'Nouvelle notification WeeDelivred',
      },
      data: Object.fromEntries(
        Object.entries(data).map(([key, value]) => [key, String(value ?? '')]),
      ),
      android: {
        priority: 'high',
        notification: {
          channelId: 'weedelivred_actions',
          sound: 'default',
        },
      },
      apns: {
        payload: {
          aps: { sound: 'default' },
        },
      },
    });
    sent += response.successCount;
    failed += response.failureCount;
  }
  return { sent, failed };
}

async function sendPushToUsersByRole(role, notification, filter = () => true) {
  const users = await User.find({
    role,
    'metadata.notificationPreferences.pushNotifications': { $ne: false },
    'metadata.fcmTokens.0': { $exists: true },
  }).select('phone metadata').lean();
  const tokens = users
    .filter(filter)
    .flatMap((user) => user.metadata?.fcmTokens || [])
    .filter(Boolean);
  return sendPushToTokens(tokens, notification);
}

module.exports = {
  sendPushToTokens,
  sendPushToUsersByRole,
};
