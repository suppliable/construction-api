'use strict';

const { dbOp } = require('../utils/dbOp');
const { getTrackedDb } = require('../middleware/firestoreTracker');

const db = getTrackedDb();
const COLLECTION = 'checkoutSessions';

async function saveCheckoutSession(session, traceContext = null) {
  return dbOp('checkout.saveSession', async () => {
    await db.collection(COLLECTION).doc(session.orderId).set(session);
    return session;
  }, traceContext);
}

async function getCheckoutSession(orderId, traceContext = null) {
  return dbOp('checkout.getSession', async () => {
    const doc = await db.collection(COLLECTION).doc(orderId).get();
    return doc.exists ? doc.data() : null;
  }, traceContext);
}

async function deleteCheckoutSession(orderId, traceContext = null) {
  return dbOp('checkout.deleteSession', async () => {
    await db.collection(COLLECTION).doc(orderId).delete();
  }, traceContext);
}

module.exports = { saveCheckoutSession, getCheckoutSession, deleteCheckoutSession };
