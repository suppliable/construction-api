'use strict';

const admin = require('../utils/firebaseAdmin');
const { dbOp } = require('../utils/dbOp');

const db = admin.firestore();

async function getAddresses(userId, traceContext = null) {
  return dbOp('getAddresses', async () => {
    const snapshot = await db.collection('addresses')
      .where('userId', '==', userId)
      .orderBy('createdAt', 'desc')
      .get();
    if (snapshot.empty) return [];
    return snapshot.docs.map(doc => ({ addressId: doc.id, ...doc.data() }));
  }, traceContext);
}

async function clearDefaultAddresses(userId, traceContext = null) {
  const existing = await getAddresses(userId, traceContext);
  await Promise.all(
    existing
      .filter(addr => addr.isDefault)
      .map(addr => dbOp('clearDefaultAddress', () =>
        db.collection('addresses').doc(addr.addressId).update({ isDefault: false }),
        traceContext
      ))
  );
}

async function addAddress(userId, addressData, traceContext = null) {
  return dbOp('addAddress', async () => {
    const addressId = 'ADDR' + Date.now();
    const address = {
      addressId,
      userId,
      ...addressData,
      createdAt: new Date().toISOString()
    };

    if (addressData.isDefault) {
      await clearDefaultAddresses(userId, traceContext);
    }

    await db.collection('addresses').doc(addressId).set(address);
    return address;
  }, traceContext);
}

async function updateAddress(userId, addressId, addressData, traceContext = null) {
  return dbOp('updateAddress', async () => {
    const doc = await db.collection('addresses').doc(addressId).get();
    if (!doc.exists || doc.data().userId !== userId) return null;
    await db.collection('addresses').doc(addressId).update(addressData);
    return { addressId, ...doc.data(), ...addressData };
  }, traceContext);
}

async function deleteAddress(userId, addressId, traceContext = null) {
  return dbOp('deleteAddress', async () => {
    const doc = await db.collection('addresses').doc(addressId).get();
    if (!doc.exists || doc.data().userId !== userId) return false;
    await db.collection('addresses').doc(addressId).delete();
    return true;
  }, traceContext);
}

async function setDefaultAddress(userId, addressId, traceContext = null) {
  return dbOp('setDefaultAddress', async () => {
    await clearDefaultAddresses(userId, traceContext);
    const doc = await db.collection('addresses').doc(addressId).get();
    if (!doc.exists || doc.data().userId !== userId) return false;
    await db.collection('addresses').doc(addressId).update({ isDefault: true });
    return true;
  }, traceContext);
}

async function getAddressById(addressId, traceContext = null) {
  return dbOp('getAddressById', async () => {
    const doc = await db.collection('addresses').doc(addressId).get();
    if (!doc.exists) return null;
    return doc.data();
  }, traceContext);
}

module.exports = { getAddresses, addAddress, updateAddress, deleteAddress, setDefaultAddress, getAddressById };
