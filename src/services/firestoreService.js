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

// ORDERS
async function saveOrder(order) {
  await db.collection('orders').doc(order.orderId).set(order);
  return order;
}

async function getOrdersByUser(userId) {
  const snapshot = await db.collection('orders')
    .where('userId', '==', userId)
    .orderBy('createdAt', 'desc')
    .get();
  if (snapshot.empty) return [];
  return snapshot.docs.map(doc => doc.data());
}

async function getOrderById(orderId) {
  const doc = await db.collection('orders').doc(orderId).get();
  if (!doc.exists) return null;
  return doc.data();
}

async function getAllOrders() {
  const snapshot = await db.collection('orders').orderBy('createdAt', 'desc').get();
  if (snapshot.empty) return [];
  return snapshot.docs.map(doc => doc.data());
}

async function updateOrder(orderId, data) {
  await db.collection('orders').doc(orderId).update(data);
  const doc = await db.collection('orders').doc(orderId).get();
  return doc.data();
}

async function getAddressById(addressId) {
  const doc = await db.collection('addresses').doc(addressId).get();
  if (!doc.exists) return null;
  return doc.data();
}

// APP SETTINGS
async function getSettings() {
  const doc = await db.collection('config').doc('settings').get();
  if (!doc.exists) return { cod_threshold: 7500 };
  return doc.data();
}

async function updateSettings(data) {
  await db.collection('config').doc('settings').set(data, { merge: true });
  return data;
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

// VEHICLES
async function getVehicles() {
  const snapshot = await db.collection('vehicles').get();
  if (snapshot.empty) return [];
  return snapshot.docs.map(doc => ({ vehicleId: doc.id, ...doc.data() }));
}

async function addVehicle(name) {
  const vehicleId = 'VH' + Date.now();
  const vehicle = { vehicleId, name, isAvailable: true };
  await db.collection('vehicles').doc(vehicleId).set(vehicle);
  return vehicle;
}

async function updateVehicle(vehicleId, data) {
  await db.collection('vehicles').doc(vehicleId).update(data);
}

async function deleteVehicle(vehicleId) {
  await db.collection('vehicles').doc(vehicleId).delete();
}

async function getVehicleById(vehicleId) {
  const doc = await db.collection('vehicles').doc(vehicleId).get();
  if (!doc.exists) return null;
  return { vehicleId: doc.id, ...doc.data() };
}

// DRIVERS
async function getDrivers() {
  const snapshot = await db.collection('drivers').where('isActive', '==', true).get();
  if (snapshot.empty) return [];
  return snapshot.docs.map(doc => ({ driverId: doc.id, ...doc.data() }));
}

async function addDriver(name, phone) {
  const driverId = 'DR' + Date.now();
  const driver = { driverId, name, phone, isActive: true, isAvailable: true };
  await db.collection('drivers').doc(driverId).set(driver);
  return driver;
}

async function updateDriver(driverId, data) {
  await db.collection('drivers').doc(driverId).update(data);
}

async function softDeleteDriver(driverId) {
  await db.collection('drivers').doc(driverId).update({ isActive: false });
}

async function getDriverById(driverId) {
  const doc = await db.collection('drivers').doc(driverId).get();
  if (!doc.exists) return null;
  return { driverId: doc.id, ...doc.data() };
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
  getSettings,
  updateSettings,
  getDeliveryConfig,
  updateDeliveryConfig,
  saveOrder,
  getOrdersByUser,
  getOrderById,
  getAllOrders,
  updateOrder,
  getAddressById,
  getVehicles,
  addVehicle,
  updateVehicle,
  deleteVehicle,
  getVehicleById,
  getDrivers,
  addDriver,
  updateDriver,
  softDeleteDriver,
  getDriverById
};
