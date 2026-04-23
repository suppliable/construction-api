'use strict';

const admin = require('../utils/firebaseAdmin');
const { dbOp } = require('../utils/dbOp');

const db = admin.firestore();

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

module.exports = { saveOrder, getOrdersByUser, getOrderById, getAllOrders, updateOrder, getOrdersByDriver };
