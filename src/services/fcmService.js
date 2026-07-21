'use strict';

const crypto = require('crypto');
const admin = require('../utils/firebaseAdmin');

// Guest tokens are keyed by a hash of the token itself (no userId available
// pre-login). Hashing gives a fixed-length, Firestore-safe document id.
function guestTokenDocId(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

// Builds the FCM message payload shared by user and guest sends.
function buildMessage(token, { title, body, data = {} }) {
  return {
    token,
    notification: { title, body },
    data: Object.fromEntries(
      Object.entries(data).map(([k, v]) => [k, String(v)])
    ),
    android: { notification: { sound: 'default', priority: 'high' } },
    apns: { payload: { aps: { sound: 'default', badge: 1 } } }
  };
}

async function getUserTokens(userId) {
  const doc = await admin.firestore().collection('fcmTokens').doc(userId).get();
  if (!doc.exists) return [];
  return doc.data().tokens || [];
}

async function removeStaleToken(userId, token) {
  await admin.firestore().collection('fcmTokens').doc(userId).update({
    tokens: admin.firestore.FieldValue.arrayRemove(token)
  });
  console.log('[FCM] Removed stale token for user:', userId);
}

// Registers a token for a logged-in user (arrayUnion under their uid) and
// removes any guest record for the same device, so a device that registered
// as a guest before login isn't targeted twice on a broadcast.
async function registerUserToken(userId, token) {
  const db = admin.firestore();
  await db.collection('fcmTokens').doc(userId).set(
    {
      tokens: admin.firestore.FieldValue.arrayUnion(token),
      updatedAt: new Date().toISOString()
    },
    { merge: true }
  );
  await db.collection('guestFcmTokens').doc(guestTokenDocId(token)).delete().catch(() => {});
}

// Registers a token for a guest (no userId yet), keyed by token hash.
async function registerGuestToken(token) {
  await admin.firestore()
    .collection('guestFcmTokens')
    .doc(guestTokenDocId(token))
    .set({ token, updatedAt: new Date().toISOString() }, { merge: true });
}

async function removeStaleGuestToken(token) {
  await admin.firestore().collection('guestFcmTokens').doc(guestTokenDocId(token)).delete().catch(() => {});
  console.log('[FCM] Removed stale guest token');
}

// Returns all registered guest tokens (broadcast audience with no userId).
async function getAllGuestTokens() {
  const snap = await admin.firestore().collection('guestFcmTokens').get();
  return snap.docs.map(d => d.data().token).filter(Boolean);
}

async function sendNotification(userId, { title, body, data = {} }) {
  const tokens = await getUserTokens(userId);
  if (!tokens.length) {
    console.log('[FCM] No tokens for user:', userId);
    return { hadTokens: false, delivered: 0, failed: 0 };
  }

  const results = await Promise.allSettled(
    tokens.map(token => admin.messaging().send(buildMessage(token, { title, body, data })))
  );

  let delivered = 0, failed = 0;
  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    if (result.status === 'rejected') {
      failed++;
      const code = result.reason?.errorInfo?.code || '';
      if (
        code === 'messaging/registration-token-not-registered' ||
        code === 'messaging/invalid-registration-token'
      ) {
        await removeStaleToken(userId, tokens[i]);
      } else {
        console.warn('[FCM] Send failed:', code, result.reason?.message);
      }
    } else {
      delivered++;
    }
  }
  return { hadTokens: true, delivered, failed };
}

// Returns userIds that have at least one registered FCM token.
async function getAllTokenUserIds() {
  const snap = await admin.firestore().collection('fcmTokens').get();
  return snap.docs.filter(d => (d.data().tokens || []).length > 0).map(d => d.id);
}

// Sends to a single guest token (no userId). Prunes the guest record if the
// token is dead. Shaped like sendNotification's per-user result for the
// campaign summary.
async function sendToGuestToken(token, { title, body, data = {} }) {
  try {
    await admin.messaging().send(buildMessage(token, { title, body, data }));
    return { hadTokens: true, delivered: 1, failed: 0 };
  } catch (err) {
    const code = err?.errorInfo?.code || '';
    if (
      code === 'messaging/registration-token-not-registered' ||
      code === 'messaging/invalid-registration-token'
    ) {
      await removeStaleGuestToken(token);
    } else {
      console.warn('[FCM] Guest send failed:', code, err?.message);
    }
    return { hadTokens: true, delivered: 0, failed: 1 };
  }
}

/**
 * Fan a single notification out to many recipients (marketing/broadcast).
 * Registered users are addressed by uid (sendNotification, which prunes stale
 * tokens); guests are addressed by raw token. Bounded concurrency. Returns a
 * delivery summary. data defaults to a non-routing `marketing` type so tapping
 * just opens the app (no deep link).
 */
async function sendCampaign({ userIds = [], guestTokens = [], title, body, data = {} }) {
  const summary = {
    targeted: userIds.length + guestTokens.length,
    reached: 0, noToken: 0, delivered: 0, failed: 0
  };
  const payload = { title, body, data: { type: 'marketing', ...data } };
  const CONCURRENCY = 20;

  const tally = (results) => {
    for (const r of results) {
      if (!r.hadTokens) { summary.noToken++; continue; }
      summary.reached++;
      summary.delivered += r.delivered;
      summary.failed += r.failed;
    }
  };

  for (let i = 0; i < userIds.length; i += CONCURRENCY) {
    const batch = userIds.slice(i, i + CONCURRENCY);
    tally(await Promise.all(batch.map(uid =>
      sendNotification(uid, payload).catch(err => {
        console.warn('[FCM] campaign send error for', uid, err.message);
        return { hadTokens: true, delivered: 0, failed: 1 };
      })
    )));
  }

  for (let i = 0; i < guestTokens.length; i += CONCURRENCY) {
    const batch = guestTokens.slice(i, i + CONCURRENCY);
    tally(await Promise.all(batch.map(token => sendToGuestToken(token, payload))));
  }

  return summary;
}

async function notifyOrderAccepted(userId, orderId) {
  await sendNotification(userId, {
    title: 'Order Confirmed ✅',
    body: `Your order #${orderId} has been accepted and is being prepared.`,
    data: { type: 'order_update', orderId, status: 'accepted' }
  });
}

async function notifyOutForDelivery(userId, orderId) {
  await sendNotification(userId, {
    title: 'Out for Delivery 🚚',
    body: `Your order #${orderId} is on its way. Track it live in the app.`,
    data: { type: 'order_update', orderId, status: 'out_for_delivery' }
  });
}

async function notifyDelivered(userId, orderId) {
  await sendNotification(userId, {
    title: 'Delivered 📦',
    body: `Your order #${orderId} has been delivered. Thank you for choosing Suppliable!`,
    data: { type: 'order_update', orderId, status: 'delivered' }
  });
}

async function notifyOrderCancelled(userId, orderId) {
  await sendNotification(userId, {
    title: 'Order Cancelled',
    body: `Your order #${orderId} has been cancelled. Contact us for any queries.`,
    data: { type: 'order_update', orderId, status: 'cancelled' }
  });
}

module.exports = {
  sendNotification,
  sendCampaign,
  getAllTokenUserIds,
  getAllGuestTokens,
  registerUserToken,
  registerGuestToken,
  notifyOrderAccepted,
  notifyOutForDelivery,
  notifyDelivered,
  notifyOrderCancelled,
  getUserTokens,
};
