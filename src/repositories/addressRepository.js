'use strict';

const admin = require('../utils/firebaseAdmin');
const { dbOp } = require('../utils/dbOp');

const db = admin.firestore();

async function getAddresses(userId) {
  return dbOp('getAddresses', async () => {
    const snapshot = await db.collection('addresses')
      .where('userId', '==', userId)
      .orderBy('createdAt', 'desc')
      .get();
    if (snapshot.empty) return [];
    return snapshot.docs.map(doc => ({ addressId: doc.id, ...doc.data() }));
  });
}

async function clearDefaultAddresses(userId) {
  const existing = await getAddresses(userId);
  for (const addr of existing) {
    if (addr.isDefault) {
      await db.collection('addresses').doc(addr.addressId).update({ isDefault: false });
    }
  }
}

async function addAddress(userId, addressData) {
  return dbOp('addAddress', async () => {
    const addressId = 'ADDR' + Date.now();
    const address = {
      addressId,
      userId,
      ...addressData,
      createdAt: new Date().toISOString()
    };

    if (addressData.isDefault) {
      await clearDefaultAddresses(userId);
    }

    await db.collection('addresses').doc(addressId).set(address);
    return address;
  });
}

async function updateAddress(userId, addressId, addressData) {
  return dbOp('updateAddress', async () => {
    const doc = await db.collection('addresses').doc(addressId).get();
    if (!doc.exists || doc.data().userId !== userId) return null;
    await db.collection('addresses').doc(addressId).update(addressData);
    return { addressId, ...doc.data(), ...addressData };
  });
}

async function deleteAddress(userId, addressId) {
  return dbOp('deleteAddress', async () => {
    const doc = await db.collection('addresses').doc(addressId).get();
    if (!doc.exists || doc.data().userId !== userId) return false;
    await db.collection('addresses').doc(addressId).delete();
    return true;
  });
}

async function setDefaultAddress(userId, addressId) {
  return dbOp('setDefaultAddress', async () => {
    await clearDefaultAddresses(userId);
    const doc = await db.collection('addresses').doc(addressId).get();
    if (!doc.exists || doc.data().userId !== userId) return false;
    await db.collection('addresses').doc(addressId).update({ isDefault: true });
    return true;
  });
}

async function getAddressById(addressId) {
  return dbOp('getAddressById', async () => {
    const doc = await db.collection('addresses').doc(addressId).get();
    if (!doc.exists) return null;
    return doc.data();
  });
}

module.exports = { getAddresses, addAddress, updateAddress, deleteAddress, setDefaultAddress, getAddressById };
