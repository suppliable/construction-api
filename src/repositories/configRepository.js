'use strict';

const admin = require('../utils/firebaseAdmin');
const { dbOp } = require('../utils/dbOp');

const db = admin.firestore();

async function getSettings(traceContext = null) {
  return dbOp('getSettings', async () => {
    const doc = await db.collection('config').doc('settings').get();
    if (!doc.exists) return { cod_threshold: 7500 };
    return doc.data();
  }, traceContext);
}

async function updateSettings(data, traceContext = null) {
  return dbOp('updateSettings', async () => {
    await db.collection('config').doc('settings').set(data, { merge: true });
    return data;
  }, traceContext);
}

async function getDeliveryConfig(traceContext = null) {
  return dbOp('getDeliveryConfig', async () => {
    const doc = await db.collection('config').doc('deliveryConfig').get();
    if (!doc.exists) {
      return { freeDeliveryEnabled: false, freeDeliveryThreshold: null, freeDeliveryPincodes: [] };
    }
    return doc.data();
  }, traceContext);
}

async function updateDeliveryConfig(config, traceContext = null) {
  return dbOp('updateDeliveryConfig', async () => {
    await db.collection('config').doc('deliveryConfig').set(config, { merge: true });
    return config;
  }, traceContext);
}

async function getImageMap(traceContext = null) {
  return dbOp('getImageMap', async () => {
    const doc = await db.collection('config').doc('imageMap').get();
    if (!doc.exists) return {};
    return doc.data();
  }, traceContext);
}

async function setImage(itemId, imageUrl, traceContext = null) {
  return dbOp('setImage', async () => {
    await db.collection('config').doc('imageMap').set(
      { [itemId]: imageUrl },
      { merge: true }
    );
  }, traceContext);
}

async function setFeatured(itemId, featured, traceContext = null) {
  return dbOp('setFeatured', async () => {
    await db.collection('config').doc('imageMap').set(
      { [`featured_${itemId}`]: featured },
      { merge: true }
    );
  }, traceContext);
}

module.exports = { getSettings, updateSettings, getDeliveryConfig, updateDeliveryConfig, getImageMap, setImage, setFeatured };
