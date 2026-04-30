'use strict';

const { dbOp } = require('../utils/dbOp');
const { getTrackedDb } = require('../middleware/firestoreTracker');
const { DEFAULT_ORDER_QUERY_LIMIT } = require('../constants');

const db = getTrackedDb();

function getDayBounds(date) {
  const start = new Date(`${date}T00:00:00.000Z`);
  if (Number.isNaN(start.getTime())) return null;
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + 1);
  return { startISO: start.toISOString(), endISO: end.toISOString() };
}

async function runOrderQuery(filters, traceContext = null) {
  const {
    userId,
    driverId,
    paymentType,
    status,
    statuses,
    date,
    dateField = 'createdAt',
    startISO,
    endISO,
    orderByField = dateField,
    limit = DEFAULT_ORDER_QUERY_LIMIT,
  } = filters;

  return dbOp('findOrders', async () => {
    let q = db.collection('orders');

    if (userId) q = q.where('userId', '==', userId);
    if (driverId) q = q.where('driverId', '==', driverId);
    if (paymentType) q = q.where('paymentType', '==', paymentType);
    if (status) q = q.where('status', '==', status);
    if (Array.isArray(statuses) && statuses.length > 0) q = q.where('status', 'in', statuses.slice(0, 10));

    let rangeStart = startISO;
    let rangeEnd = endISO;
    if (date) {
      const bounds = getDayBounds(date);
      if (bounds) {
        rangeStart = bounds.startISO;
        rangeEnd = bounds.endISO;
      }
    }

    if (rangeStart) q = q.where(dateField, '>=', rangeStart);
    if (rangeEnd) q = q.where(dateField, '<', rangeEnd);

    if (orderByField) q = q.orderBy(orderByField, 'desc');
    if (limit > 0) q = q.limit(limit);

    const snapshot = await q.get();
    if (snapshot.empty) return [];
    return snapshot.docs;
  }, traceContext);
}

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
    const snapshot = await db.collection('orders').orderBy('createdAt', 'desc').limit(DEFAULT_ORDER_QUERY_LIMIT).get();
    if (snapshot.empty) return [];
    return snapshot.docs.map(doc => doc.data());
  }, traceContext);
}

async function findOrders(filters = {}, traceContext = null) {
  const docs = await runOrderQuery(filters, traceContext);
  return docs.map(doc => doc.data());
}

async function updateOrder(orderId, data, traceContext = null) {
  return dbOp('updateOrder', async () => {
    await db.collection('orders').doc(orderId).update(data);
    const doc = await db.collection('orders').doc(orderId).get();
    return doc.data();
  }, traceContext);
}

async function getOrdersByDriver(driverId, startISO, endISO, traceContext = null, options = {}) {
  return getOrdersByDriverFiltered(driverId, startISO, endISO, traceContext, options);
}

async function getOrdersByDriverFiltered(driverId, startISO, endISO, traceContext = null, options = {}) {
  const docs = await runOrderQuery({
    driverId,
    startISO,
    endISO,
    dateField: 'assignedAt',
    orderByField: 'assignedAt',
    ...options,
  }, traceContext);
  return docs.map(doc => ({ orderId: doc.id, ...doc.data() }));
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

module.exports = {
  saveOrder,
  getOrdersByUser,
  getOrderById,
  getAllOrders,
  findOrders,
  updateOrder,
  getOrdersByDriver,
  getOrdersByDriverFiltered,
  getOrdersPage,
};
