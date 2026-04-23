'use strict';

const admin = require('../utils/firebaseAdmin');
const { dbOp } = require('../utils/dbOp');

const db = admin.firestore();

async function getDrivers(traceContext = null) {
  return dbOp('getDrivers', async () => {
    const snapshot = await db.collection('drivers').where('isActive', '==', true).get();
    if (snapshot.empty) return [];
    return snapshot.docs.map(doc => ({ driverId: doc.id, ...doc.data() }));
  }, traceContext);
}

async function addDriver(name, phone, traceContext = null) {
  return dbOp('addDriver', async () => {
    const driverId = 'DR' + Date.now();
    const driver = { driverId, name, phone, isActive: true, isAvailable: true };
    await db.collection('drivers').doc(driverId).set(driver);
    return driver;
  }, traceContext);
}

async function updateDriver(driverId, data, traceContext = null) {
  return dbOp('updateDriver', async () => {
    await db.collection('drivers').doc(driverId).update(data);
  }, traceContext);
}

async function softDeleteDriver(driverId, traceContext = null) {
  return dbOp('softDeleteDriver', async () => {
    await db.collection('drivers').doc(driverId).update({ isActive: false });
  }, traceContext);
}

async function getDriverById(driverId, traceContext = null) {
  return dbOp('getDriverById', async () => {
    const doc = await db.collection('drivers').doc(driverId).get();
    if (!doc.exists) return null;
    return { driverId: doc.id, ...doc.data() };
  }, traceContext);
}

async function getDriverByPhone(phone, traceContext = null) {
  return dbOp('getDriverByPhone', async () => {
    const snapshot = await db.collection('drivers').where('phone', '==', phone).limit(1).get();
    if (snapshot.empty) return null;
    return { driverId: snapshot.docs[0].id, ...snapshot.docs[0].data() };
  }, traceContext);
}

async function getDriverByToken(token, traceContext = null) {
  return dbOp('getDriverByToken', async () => {
    const snapshot = await db.collection('drivers').where('currentToken', '==', token).limit(1).get();
    if (snapshot.empty) return null;
    return { driverId: snapshot.docs[0].id, ...snapshot.docs[0].data() };
  }, traceContext);
}

async function getAllHandoversForDriver(driverId, traceContext = null) {
  return dbOp('getAllHandoversForDriver', async () => {
    const snap = await db.collection('codHandovers').where('driverId', '==', driverId).get();
    const docs = snap.docs.map(d => d.data());
    return docs.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
  }, traceContext);
}

async function createHandover(handoverData, traceContext = null) {
  return dbOp('createHandover', async () => {
    await db.collection('codHandovers').doc(handoverData.handoverId).set(handoverData);
    return handoverData;
  }, traceContext);
}

async function getHandoversByDriver(driverId, date, traceContext = null) {
  return dbOp('getHandoversByDriver', async () => {
    const snap = await db.collection('codHandovers')
      .where('driverId', '==', driverId)
      .where('date', '==', date)
      .get();
    return snap.docs.map(d => d.data());
  }, traceContext);
}

async function getAllHandovers(status, traceContext = null) {
  return dbOp('getAllHandovers', async () => {
    const snap = await db.collection('codHandovers').orderBy('createdAt', 'desc').get();
    let handovers = snap.docs.map(d => d.data());
    if (status) handovers = handovers.filter(h => h.status === status);
    return handovers;
  }, traceContext);
}

async function getHandoverById(handoverId, traceContext = null) {
  return dbOp('getHandoverById', async () => {
    const doc = await db.collection('codHandovers').doc(handoverId).get();
    return doc.exists ? doc.data() : null;
  }, traceContext);
}

async function updateHandover(handoverId, updates, traceContext = null) {
  return dbOp('updateHandover', async () => {
    await db.collection('codHandovers').doc(handoverId).update(updates);
    return { ...updates, handoverId };
  }, traceContext);
}

module.exports = {
  getDrivers, addDriver, updateDriver, softDeleteDriver,
  getDriverById, getDriverByPhone, getDriverByToken,
  getAllHandoversForDriver,
  createHandover, getHandoversByDriver, getAllHandovers, getHandoverById, updateHandover,
};
