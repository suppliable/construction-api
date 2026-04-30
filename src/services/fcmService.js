'use strict';

const admin = require('../utils/firebaseAdmin');

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

async function sendNotification(userId, { title, body, data = {} }) {
  const tokens = await getUserTokens(userId);
  if (!tokens.length) {
    console.log('[FCM] No tokens for user:', userId);
    return;
  }

  const results = await Promise.allSettled(
    tokens.map(token =>
      admin.messaging().send({
        token,
        notification: { title, body },
        data: Object.fromEntries(
          Object.entries(data).map(([k, v]) => [k, String(v)])
        ),
        android: { notification: { sound: 'default', priority: 'high' } },
        apns: { payload: { aps: { sound: 'default', badge: 1 } } }
      })
    )
  );

  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    if (result.status === 'rejected') {
      const code = result.reason?.errorInfo?.code || '';
      if (
        code === 'messaging/registration-token-not-registered' ||
        code === 'messaging/invalid-registration-token'
      ) {
        await removeStaleToken(userId, tokens[i]);
      } else {
        console.warn('[FCM] Send failed:', code, result.reason?.message);
      }
    }
  }
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
  notifyOrderAccepted,
  notifyOutForDelivery,
  notifyDelivered,
  notifyOrderCancelled,
  getUserTokens,
};
