'use strict';

const { getDatabase } = require('firebase-admin/database');

async function writeLiveOrder(orderId, data) {
  const db = getDatabase();
  await db.ref(`liveOrders/${orderId}`).set({
    status: data.status,
    eta: data.eta || null,
    etaMinutes: data.etaMinutes || null,
    latitude: data.latitude || null,
    longitude: data.longitude || null,
    updatedAt: new Date().toISOString(),
  });
}

async function updateLiveOrderStatus(orderId, status) {
  const db = getDatabase();
  await db.ref(`liveOrders/${orderId}`).update({
    status,
    updatedAt: new Date().toISOString(),
  });
}

async function deleteLiveOrder(orderId) {
  const db = getDatabase();
  await db.ref(`liveOrders/${orderId}`).remove();
}

module.exports = { writeLiveOrder, updateLiveOrderStatus, deleteLiveOrder };
