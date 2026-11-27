'use strict';

const { dbOp } = require('../utils/dbOp');
const { getTrackedDb } = require('../middleware/firestoreTracker');
const { DEFAULT_HANDOVER_QUERY_LIMIT } = require('../constants');

const db = getTrackedDb();

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

/**
 * The driver who may sign in with this number.
 *
 * One number can have SEVERAL records: removing a driver only marks it inactive,
 * and adding them again creates a new one. Taking whichever came back first
 * picked the oldest, so a re-added driver was told their account was inactive
 * while the admin portal showed them active. An active record therefore always
 * wins; between several active ones, one with a PIN, then the newest (ids are
 * "DR" + creation time). With no active record the newest is returned, so the
 * caller can still say "inactive" rather than "not registered".
 */
async function getDriverByPhone(phone, traceContext = null) {
  return dbOp('getDriverByPhone', async () => {
    const snapshot = await db.collection('drivers').where('phone', '==', phone).get();
    if (snapshot.empty) return null;
    const rank = d => (d.isActive ? 2 : 0) + (d.isActive && d.pin ? 1 : 0);
    const [best] = snapshot.docs
      .map(doc => ({ driverId: doc.id, ...doc.data() }))
      .sort((a, b) => rank(b) - rank(a) || String(b.driverId).localeCompare(String(a.driverId)));
    return best;
  }, traceContext);
}

async function getDriverByToken(token, traceContext = null) {
  return dbOp('getDriverByToken', async () => {
    const snapshot = await db.collection('drivers').where('currentToken', '==', token).limit(1).get();
    if (snapshot.empty) return null;
    return { driverId: snapshot.docs[0].id, ...snapshot.docs[0].data() };
  }, traceContext);
}

async function getAllHandoversForDriver(driverId, traceContext = null, options = {}) {
  return getAllHandoversForDriverFiltered(driverId, traceContext, options);
}

async function getAllHandoversForDriverFiltered(driverId, traceContext = null, options = {}) {
  const { date, limit = DEFAULT_HANDOVER_QUERY_LIMIT } = options;
  return dbOp('getAllHandoversForDriver', async () => {
    let q = db.collection('codHandovers').where('driverId', '==', driverId);
    if (date) q = q.where('date', '==', date);
    q = q.orderBy('createdAt', 'desc');
    if (limit > 0) q = q.limit(limit);
    const snap = await q.get();
    return snap.docs.map(d => d.data());
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
      .orderBy('createdAt', 'desc')
      .limit(DEFAULT_HANDOVER_QUERY_LIMIT)
      .get();
    return snap.docs.map(d => d.data());
  }, traceContext);
}

async function getAllHandovers(status, traceContext = null, options = {}) {
  return getAllHandoversFiltered(status, traceContext, options);
}

async function getAllHandoversFiltered(status, traceContext = null, options = {}) {
  const { date, driverId, limit = DEFAULT_HANDOVER_QUERY_LIMIT } = options;
  return dbOp('getAllHandovers', async () => {
    let q = db.collection('codHandovers');
    if (status) q = q.where('status', '==', status);
    if (date) q = q.where('date', '==', date);
    if (driverId) q = q.where('driverId', '==', driverId);
    q = q.orderBy('createdAt', 'desc');
    if (limit > 0) q = q.limit(limit);
    const snap = await q.get();
    return snap.docs.map(d => d.data());
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
  getAllHandoversForDriver, getAllHandoversForDriverFiltered,
  createHandover, getHandoversByDriver, getAllHandovers, getAllHandoversFiltered,
  getHandoverById, updateHandover,
};
