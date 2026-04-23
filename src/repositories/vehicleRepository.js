'use strict';

const admin = require('../utils/firebaseAdmin');
const { dbOp } = require('../utils/dbOp');

const db = admin.firestore();

async function getVehicles() {
  return dbOp('getVehicles', async () => {
    const snapshot = await db.collection('vehicles').get();
    if (snapshot.empty) return [];
    return snapshot.docs.map(doc => ({ vehicleId: doc.id, ...doc.data() }));
  });
}

async function addVehicle(name) {
  return dbOp('addVehicle', async () => {
    const vehicleId = 'VH' + Date.now();
    const vehicle = { vehicleId, name, isAvailable: true };
    await db.collection('vehicles').doc(vehicleId).set(vehicle);
    return vehicle;
  });
}

async function updateVehicle(vehicleId, data) {
  return dbOp('updateVehicle', async () => {
    await db.collection('vehicles').doc(vehicleId).update(data);
  });
}

async function deleteVehicle(vehicleId) {
  return dbOp('deleteVehicle', async () => {
    await db.collection('vehicles').doc(vehicleId).delete();
  });
}

async function getVehicleById(vehicleId) {
  return dbOp('getVehicleById', async () => {
    const doc = await db.collection('vehicles').doc(vehicleId).get();
    if (!doc.exists) return null;
    return { vehicleId: doc.id, ...doc.data() };
  });
}

module.exports = { getVehicles, addVehicle, updateVehicle, deleteVehicle, getVehicleById };
