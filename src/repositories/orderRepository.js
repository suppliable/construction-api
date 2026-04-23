'use strict';

const admin = require('../utils/firebaseAdmin');
const { dbOp } = require('../utils/dbOp');

const db = admin.firestore();

async function saveOrder(order) {
  return dbOp('saveOrder', async () => {
    await db.collection('orders').doc(order.orderId).set(order);
    return order;
  });
}

async function getOrdersByUser(userId, limit = 0) {
  return dbOp('getOrdersByUser', async () => {
    let q = db.collection('orders').where('userId', '==', userId).orderBy('createdAt', 'desc');
    if (limit > 0) q = q.limit(limit);
    const snapshot = await q.get();
    if (snapshot.empty) return [];
    return snapshot.docs.map(doc => doc.data());
  });
}

async function getOrderById(orderId) {
  return dbOp('getOrderById', async () => {
    const doc = await db.collection('orders').doc(orderId).get();
    if (!doc.exists) return null;
    return doc.data();
  });
}

async function getAllOrders() {
  return dbOp('getAllOrders', async () => {
    const snapshot = await db.collection('orders').orderBy('createdAt', 'desc').get();
    if (snapshot.empty) return [];
    return snapshot.docs.map(doc => doc.data());
  });
}

async function updateOrder(orderId, data) {
  return dbOp('updateOrder', async () => {
    await db.collection('orders').doc(orderId).update(data);
    const doc = await db.collection('orders').doc(orderId).get();
    return doc.data();
  });
}

async function getOrdersByDriver(driverId, startISO, endISO) {
  return dbOp('getOrdersByDriver', async () => {
    let q = db.collection('orders').where('driverId', '==', driverId);
    if (startISO) q = q.where('assignedAt', '>=', startISO);
    if (endISO) q = q.where('assignedAt', '<=', endISO);
    const snapshot = await q.get();
    if (snapshot.empty) return [];
    return snapshot.docs.map(doc => ({ orderId: doc.id, ...doc.data() }));
  });
}

module.exports = { saveOrder, getOrdersByUser, getOrderById, getAllOrders, updateOrder, getOrdersByDriver };
