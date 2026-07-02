'use strict';

const { getDatabase } = require('firebase-admin/database');
const {
  NON_TERMINAL_ORDER_STATUSES,
  TERMINAL_ORDER_STATUSES,
  LIVE_ORDER_PROJECTION_FIELDS,
} = require('../constants');

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

// Slim projection of an order onto the liveOrders node. Uses update() so it
// merges with any delivery-tracking fields (eta/lat/lng) written separately by
// the driver flow rather than clobbering them.
async function upsertLiveOrder(orderId, order) {
  const db = getDatabase();
  const projection = {};
  for (const field of LIVE_ORDER_PROJECTION_FIELDS) {
    projection[field] = order[field] != null ? order[field] : null;
  }
  projection.updatedAt = new Date().toISOString();
  await db.ref(`liveOrders/${orderId}`).update(projection);
}

// Reconciles liveOrders membership from a full order object:
//   non-terminal (≥ warehouse_review) → upsert the slim projection
//   terminal                          → remove from the node
// Pre-warehouse_review statuses (pending_payment/pending_proceeding) are
// terminal here and are never written to liveOrders.
async function syncLiveOrder(orderId, order) {
  if (!order || !order.status) return;
  if (NON_TERMINAL_ORDER_STATUSES.includes(order.status)) {
    await upsertLiveOrder(orderId, order);
  } else if (TERMINAL_ORDER_STATUSES.includes(order.status)) {
    await deleteLiveOrder(orderId);
  }
}

module.exports = {
  writeLiveOrder,
  updateLiveOrderStatus,
  deleteLiveOrder,
  upsertLiveOrder,
  syncLiveOrder,
};
