'use strict';

const { dbOp } = require('../utils/dbOp');
const { getTrackedDb } = require('../middleware/firestoreTracker');

const db = getTrackedDb();

async function getCustomer(userId, traceContext = null) {
  return dbOp('getCustomer', async () => {
    const doc = await db.collection('customers').doc(userId).get();
    if (!doc.exists) return null;
    return doc.data();
  }, traceContext);
}

async function saveCustomer(customer, traceContext = null) {
  return dbOp('saveCustomer', async () => {
    await db.collection('customers').doc(customer.userId).set(customer);
    return customer;
  }, traceContext);
}

async function getCustomerByPhone(phone, traceContext = null) {
  return dbOp('getCustomerByPhone', async () => {
    const snapshot = await db.collection('customers').where('phone', '==', phone).limit(1).get();
    if (!snapshot.empty) return snapshot.docs[0].data();

    // POS-created customers may have bare 10-digit phones without the +91 prefix.
    // If the caller passed +91XXXXXXXXXX and no match was found, retry with bare digits.
    const digits = String(phone).replace(/\D/g, '');
    const bare = digits.length === 12 && digits.startsWith('91') ? digits.slice(2) : null;
    if (!bare) return null;

    const snap2 = await db.collection('customers').where('phone', '==', bare).limit(1).get();
    return snap2.empty ? null : snap2.docs[0].data();
  }, traceContext);
}

module.exports = { getCustomer, saveCustomer, getCustomerByPhone };
