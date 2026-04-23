'use strict';

const admin = require('../utils/firebaseAdmin');
const { dbOp } = require('../utils/dbOp');

const db = admin.firestore();

async function getCustomer(userId) {
  return dbOp('getCustomer', async () => {
    const doc = await db.collection('customers').doc(userId).get();
    if (!doc.exists) return null;
    return doc.data();
  });
}

async function saveCustomer(customer) {
  return dbOp('saveCustomer', async () => {
    await db.collection('customers').doc(customer.userId).set(customer);
    return customer;
  });
}

async function getCustomerByPhone(phone) {
  return dbOp('getCustomerByPhone', async () => {
    const snapshot = await db.collection('customers').where('phone', '==', phone).limit(1).get();
    if (snapshot.empty) return null;
    return snapshot.docs[0].data();
  });
}

module.exports = { getCustomer, saveCustomer, getCustomerByPhone };
