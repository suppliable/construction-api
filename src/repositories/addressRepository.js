'use strict';

const { dbOp } = require('../utils/dbOp');
const { getTrackedDb } = require('../middleware/firestoreTracker');

const db = getTrackedDb();

async function getAddresses(userId, traceContext = null) {
  return dbOp('getAddresses', async (span) => {
    const snapshot = await db.collection('addresses')
      .where('userId', '==', userId)
      .orderBy('createdAt', 'desc')
      .get();
    if (snapshot.empty) {
      span.setAttribute('db.response.rows_returned', 0);
      return [];
    }
    span.setAttribute('db.response.rows_returned', snapshot.docs.length);
    return snapshot.docs.map(doc => ({ addressId: doc.id, ...doc.data() }));
  }, traceContext, { 'enduser.id': userId });
}

async function clearDefaultAddresses(userId, traceContext = null) {
  const existing = await getAddresses(userId, traceContext);
  const toReset = existing.filter(addr => addr.isDefault);
  await Promise.all(
    toReset.map(addr => dbOp('clearDefaultAddress', () =>
      db.collection('addresses').doc(addr.addressId).update({ isDefault: false }),
      traceContext,
      { 'enduser.id': userId, 'app.address.id': addr.addressId }
    ))
  );
}

async function addAddress(userId, addressData, traceContext = null) {
  return dbOp('addAddress', async (span) => {
    const addressId = 'ADDR' + Date.now();
    const address = {
      addressId,
      userId,
      ...addressData,
      createdAt: new Date().toISOString()
    };

    span.setAttribute('app.address.id', addressId);
    span.setAttribute('app.address.is_default', Boolean(addressData.isDefault));

    if (addressData.isDefault) {
      await clearDefaultAddresses(userId, traceContext);
    }

    await db.collection('addresses').doc(addressId).set(address);
    return address;
  }, traceContext, { 'enduser.id': userId });
}

async function updateAddress(userId, addressId, addressData, traceContext = null) {
  return dbOp('updateAddress', async (span) => {
    const doc = await db.collection('addresses').doc(addressId).get();
    const found = doc.exists && doc.data().userId === userId;
    span.setAttribute('app.address.found', found);
    if (!found) return null;
    await db.collection('addresses').doc(addressId).update(addressData);
    return { addressId, ...doc.data(), ...addressData };
  }, traceContext, { 'enduser.id': userId, 'app.address.id': addressId });
}

async function deleteAddress(userId, addressId, traceContext = null) {
  return dbOp('deleteAddress', async (span) => {
    const doc = await db.collection('addresses').doc(addressId).get();
    const found = doc.exists && doc.data().userId === userId;
    span.setAttribute('app.address.found', found);
    if (!found) {
      span.setAttribute('app.address.deleted', false);
      return false;
    }
    await db.collection('addresses').doc(addressId).delete();
    span.setAttribute('app.address.deleted', true);
    return true;
  }, traceContext, { 'enduser.id': userId, 'app.address.id': addressId });
}

async function setDefaultAddress(userId, addressId, traceContext = null) {
  return dbOp('setDefaultAddress', async (span) => {
    await clearDefaultAddresses(userId, traceContext);
    const doc = await db.collection('addresses').doc(addressId).get();
    const found = doc.exists && doc.data().userId === userId;
    span.setAttribute('app.address.found', found);
    if (!found) return false;
    await db.collection('addresses').doc(addressId).update({ isDefault: true });
    return true;
  }, traceContext, { 'enduser.id': userId, 'app.address.id': addressId });
}

async function getAddressById(addressId, traceContext = null) {
  return dbOp('getAddressById', async (span) => {
    const doc = await db.collection('addresses').doc(addressId).get();
    span.setAttribute('app.address.found', doc.exists);
    if (!doc.exists) return null;
    return doc.data();
  }, traceContext, { 'app.address.id': addressId });
}

module.exports = { getAddresses, addAddress, updateAddress, deleteAddress, setDefaultAddress, getAddressById };
