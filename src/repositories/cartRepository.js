'use strict';

const { dbOp } = require('../utils/dbOp');
const { getTrackedDb } = require('../middleware/firestoreTracker');

const db = getTrackedDb();

async function getCart(userId, traceContext = null) {
  return dbOp('getCart', async () => {
    const doc = await db.collection('carts').doc(userId).get();
    if (!doc.exists) return { items: [] };
    return doc.data();
  }, traceContext);
}

async function saveCart(userId, cart, traceContext = null) {
  return dbOp('saveCart', async () => {
    await db.collection('carts').doc(userId).set(cart);
    return cart;
  }, traceContext);
}

module.exports = { getCart, saveCart };
