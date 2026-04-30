'use strict';

const { getDatabase } = require('firebase-admin/database');

async function writeLiveOrder(orderId, data) {
  const db = getDatabase();
  const payload = {
    status: data.status,
    eta: data.eta || null,
    etaMinutes: data.etaMinutes || null,
    latitude: data.latitude || null,
    longitude: data.longitude || null,
    updatedAt: data.updatedAt || new Date().toISOString(),
  };
  if (data.destLat != null) payload.destLat = data.destLat;
  if (data.destLng != null) payload.destLng = data.destLng;
  await db.ref(`liveOrders/${orderId}`).set(payload);
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
