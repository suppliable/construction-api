'use strict';

const admin = require('../utils/firebaseAdmin');
const { dbOp } = require('../utils/dbOp');

const db = admin.firestore();

async function getCart(userId) {
  return dbOp('getCart', async () => {
    const doc = await db.collection('carts').doc(userId).get();
    if (!doc.exists) return { items: [] };
    return doc.data();
  });
}

async function saveCart(userId, cart) {
  return dbOp('saveCart', async () => {
    await db.collection('carts').doc(userId).set(cart);
    return cart;
  });
}

module.exports = { getCart, saveCart };
