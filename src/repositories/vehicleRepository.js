'use strict';

const admin = require('../utils/firebaseAdmin');
const { dbOp } = require('../utils/dbOp');

const db = admin.firestore();

async function getVehicles(traceContext = null) {
  return dbOp('getVehicles', async () => {
    const snapshot = await db.collection('vehicles').get();
    if (snapshot.empty) return [];
    return snapshot.docs.map(doc => ({ vehicleId: doc.id, ...doc.data() }));
  }, traceContext);
}

async function addVehicle(name, traceContext = null) {
  return dbOp('addVehicle', async () => {
    const vehicleId = 'VH' + Date.now();
    const vehicle = { vehicleId, name, isAvailable: true };
    await db.collection('vehicles').doc(vehicleId).set(vehicle);
    return vehicle;
  }, traceContext);
}

async function updateVehicle(vehicleId, data, traceContext = null) {
  return dbOp('updateVehicle', async () => {
    await db.collection('vehicles').doc(vehicleId).update(data);
  }, traceContext);
}

async function deleteVehicle(vehicleId, traceContext = null) {
  return dbOp('deleteVehicle', async () => {
    await db.collection('vehicles').doc(vehicleId).delete();
  }, traceContext);
}

async function getVehicleById(vehicleId, traceContext = null) {
  return dbOp('getVehicleById', async () => {
    const doc = await db.collection('vehicles').doc(vehicleId).get();
    if (!doc.exists) return null;
    return { vehicleId: doc.id, ...doc.data() };
  }, traceContext);
}

module.exports = { getVehicles, addVehicle, updateVehicle, deleteVehicle, getVehicleById };
