const admin = require('firebase-admin');

let serviceAccount;
if (process.env.FIREBASE_SERVICE_ACCOUNT) {
  serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
} else {
  serviceAccount = require('../../firebase-service-account.json');
}

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
}

const db = admin.firestore();

// CUSTOMERS
async function getCustomer(userId) {
  const doc = await db.collection('customers').doc(userId).get();
  if (!doc.exists) return null;
  return doc.data();
}

async function saveCustomer(customer) {
  await db.collection('customers').doc(customer.userId).set(customer);
  return customer;
}

async function getCustomerByPhone(phone) {
  const snapshot = await db.collection('customers').where('phone', '==', phone).limit(1).get();
  if (snapshot.empty) return null;
  return snapshot.docs[0].data();
}

// CART
async function getCart(userId) {
  const doc = await db.collection('carts').doc(userId).get();
  if (!doc.exists) return { items: [] };
  return doc.data();
}

async function saveCart(userId, cart) {
  await db.collection('carts').doc(userId).set(cart);
  return cart;
}

// IMAGE MAP
async function getImageMap() {
  const doc = await db.collection('config').doc('imageMap').get();
  if (!doc.exists) return {};
  return doc.data();
}

async function setImage(itemId, imageUrl) {
  await db.collection('config').doc('imageMap').set(
    { [itemId]: imageUrl },
    { merge: true }
  );
}

// ADDRESSES
async function getAddresses(userId) {
  const snapshot = await db.collection('addresses')
    .where('userId', '==', userId)
    .orderBy('createdAt', 'desc')
    .get();
  if (snapshot.empty) return [];
  return snapshot.docs.map(doc => ({ addressId: doc.id, ...doc.data() }));
}

async function addAddress(userId, addressData) {
  const addressId = 'ADDR' + Date.now();
  const address = {
    addressId,
    userId,
    ...addressData,
    createdAt: new Date().toISOString()
  };

  // If isDefault true, unset all other defaults first
  if (addressData.isDefault) {
    const existing = await getAddresses(userId);
    for (const addr of existing) {
      if (addr.isDefault) {
        await db.collection('addresses').doc(addr.addressId).update({ isDefault: false });
      }
    }
  }

  await db.collection('addresses').doc(addressId).set(address);
  return address;
}

async function updateAddress(userId, addressId, addressData) {
  const doc = await db.collection('addresses').doc(addressId).get();
  if (!doc.exists || doc.data().userId !== userId) return null;
  await db.collection('addresses').doc(addressId).update(addressData);
  return { addressId, ...doc.data(), ...addressData };
}

async function deleteAddress(userId, addressId) {
  const doc = await db.collection('addresses').doc(addressId).get();
  if (!doc.exists || doc.data().userId !== userId) return false;
  await db.collection('addresses').doc(addressId).delete();
  return true;
}

async function setDefaultAddress(userId, addressId) {
  // Unset all existing defaults
  const existing = await getAddresses(userId);
  for (const addr of existing) {
    if (addr.isDefault) {
      await db.collection('addresses').doc(addr.addressId).update({ isDefault: false });
    }
  }
  // Set new default
  const doc = await db.collection('addresses').doc(addressId).get();
  if (!doc.exists || doc.data().userId !== userId) return false;
  await db.collection('addresses').doc(addressId).update({ isDefault: true });
  return true;
}

// DELIVERY CONFIG
async function getDeliveryConfig() {
  try {
    const doc = await db.collection('config').doc('deliveryConfig').get();
    if (!doc.exists) {
      return {
        freeDeliveryEnabled: false,
        freeDeliveryThreshold: null,
        freeDeliveryPincodes: []
      };
    }
    return doc.data();
  } catch (err) {
    return {
      freeDeliveryEnabled: false,
      freeDeliveryThreshold: null,
      freeDeliveryPincodes: []
    };
  }
}

async function updateDeliveryConfig(config) {
  await db.collection('config').doc('deliveryConfig').set(config, { merge: true });
  return config;
}

module.exports = {
  db,
  getCustomer,
  saveCustomer,
  getCustomerByPhone,
  getCart,
  saveCart,
  getImageMap,
  setImage,
  getAddresses,
  addAddress,
  updateAddress,
  deleteAddress,
  setDefaultAddress,
  getDeliveryConfig,
  updateDeliveryConfig
};
