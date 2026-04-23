'use strict';

const admin = require('../utils/firebaseAdmin');
const { dbOp } = require('../utils/dbOp');

const db = admin.firestore();

async function getSettings() {
  return dbOp('getSettings', async () => {
    const doc = await db.collection('config').doc('settings').get();
    if (!doc.exists) return { cod_threshold: 7500 };
    return doc.data();
  });
}

async function updateSettings(data) {
  return dbOp('updateSettings', async () => {
    await db.collection('config').doc('settings').set(data, { merge: true });
    return data;
  });
}

async function getDeliveryConfig() {
  return dbOp('getDeliveryConfig', async () => {
    const doc = await db.collection('config').doc('deliveryConfig').get();
    if (!doc.exists) {
      return { freeDeliveryEnabled: false, freeDeliveryThreshold: null, freeDeliveryPincodes: [] };
    }
    return doc.data();
  });
}

async function updateDeliveryConfig(config) {
  return dbOp('updateDeliveryConfig', async () => {
    await db.collection('config').doc('deliveryConfig').set(config, { merge: true });
    return config;
  });
}

async function getImageMap() {
  return dbOp('getImageMap', async () => {
    const doc = await db.collection('config').doc('imageMap').get();
    if (!doc.exists) return {};
    return doc.data();
  });
}

async function setImage(itemId, imageUrl) {
  return dbOp('setImage', async () => {
    await db.collection('config').doc('imageMap').set(
      { [itemId]: imageUrl },
      { merge: true }
    );
  });
}

async function setFeatured(itemId, featured) {
  return dbOp('setFeatured', async () => {
    await db.collection('config').doc('imageMap').set(
      { [`featured_${itemId}`]: featured },
      { merge: true }
    );
  });
}

module.exports = { getSettings, updateSettings, getDeliveryConfig, updateDeliveryConfig, getImageMap, setImage, setFeatured };
