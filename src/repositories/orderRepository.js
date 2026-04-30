'use strict';

const { dbOp } = require('../utils/dbOp');
const { getTrackedDb } = require('../middleware/firestoreTracker');

const db = getTrackedDb();

async function saveOrder(order, traceContext = null) {
  return dbOp('saveOrder', async () => {
    await db.collection('orders').doc(order.orderId).set(order);
    return order;
  }, traceContext);
}

async function getOrdersByUser(userId, limit = 0, traceContext = null) {
  return dbOp('getOrdersByUser', async () => {
    let q = db.collection('orders').where('userId', '==', userId).orderBy('createdAt', 'desc');
    if (limit > 0) q = q.limit(limit);
    const snapshot = await q.get();
    if (snapshot.empty) return [];
    return snapshot.docs.map(doc => doc.data());
  }, traceContext);
}

async function getOrderById(orderId, traceContext = null) {
  return dbOp('getOrderById', async () => {
    const doc = await db.collection('orders').doc(orderId).get();
    if (!doc.exists) return null;
    return doc.data();
  }, traceContext);
}

async function getAllOrders(traceContext = null) {
  return dbOp('getAllOrders', async () => {
    const snapshot = await db.collection('orders').orderBy('createdAt', 'desc').get();
    if (snapshot.empty) return [];
    return snapshot.docs.map(doc => doc.data());
  }, traceContext);
}

async function updateOrder(orderId, data, traceContext = null) {
  return dbOp('updateOrder', async () => {
    await db.collection('orders').doc(orderId).update(data);
    const doc = await db.collection('orders').doc(orderId).get();
    return doc.data();
  }, traceContext);
}

async function getOrdersByDriver(driverId, startISO, endISO, traceContext = null) {
  return dbOp('getOrdersByDriver', async () => {
    let q = db.collection('orders').where('driverId', '==', driverId);
    if (startISO) q = q.where('assignedAt', '>=', startISO);
    if (endISO) q = q.where('assignedAt', '<=', endISO);
    const snapshot = await q.get();
    if (snapshot.empty) return [];
    return snapshot.docs.map(doc => ({ orderId: doc.id, ...doc.data() }));
  }, traceContext);
}

async function getOrdersPage(limit = 10, startAfterOrderId = null, traceContext = null) {
  return dbOp('getOrdersPage', async () => {
    let q = db.collection('orders').orderBy('createdAt', 'desc').limit(limit + 1);
    if (startAfterOrderId) {
      const cursorDoc = await db.collection('orders').doc(startAfterOrderId).get();
      if (cursorDoc.exists) q = q.startAfter(cursorDoc);
    }
    const snapshot = await q.get();
    const docs = snapshot.docs;
    const hasMore = docs.length > limit;
    const orders = (hasMore ? docs.slice(0, limit) : docs).map(doc => doc.data());
    return { orders, hasMore, lastOrderId: orders.length ? orders[orders.length - 1].orderId : null };
  }, traceContext);
}

module.exports = { saveOrder, getOrdersByUser, getOrderById, getAllOrders, updateOrder, getOrdersByDriver, getOrdersPage };
