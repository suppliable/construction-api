'use strict';

const { dbOp } = require('../utils/dbOp');
const { getTrackedDb } = require('../middleware/firestoreTracker');

const db = getTrackedDb();
const VALID_TIERS = ['light', 'mid', 'dark'];
const VALID_SIZES = ['1L', '4L', '10L', '20L'];

async function getPaintPricing(productId, traceContext = null) {
  return dbOp('getPaintPricing', async () => {
    const doc = await db.collection('paintPricing').doc(productId).get();
    if (!doc.exists) return null;
    return { id: doc.id, ...doc.data() };
  }, traceContext);
}

async function setPaintPricing(productId, data, traceContext = null) {
  return dbOp('setPaintPricing', async () => {
    await db.collection('paintPricing').doc(productId).set(data, { merge: true });
  }, traceContext);
}

async function listAllPaintPricing(traceContext = null) {
  return dbOp('listAllPaintPricing', async () => {
    const snap = await db.collection('paintPricing').get();
    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
  }, traceContext);
}

async function getShadesByBrand(brandSlug, searchQuery, includeInactive = false, traceContext = null) {
  return dbOp('getShadesByBrand', async () => {
    let query = db.collection('shades').doc(brandSlug).collection('colours').limit(200);
    if (!includeInactive) query = query.where('active', '==', true);
    const snap = await query.get();

    let shades = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    shades.sort((a, b) => a.code.localeCompare(b.code));

    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      shades = shades.filter(s =>
        s.code.toLowerCase().includes(q) || s.name.toLowerCase().includes(q)
      );
    }
    return shades;
  }, traceContext);
}

async function getBrandDoc(brandSlug, traceContext = null) {
  return dbOp('getBrandDoc', async () => {
    const doc = await db.collection('shades').doc(brandSlug).get();
    if (!doc.exists) return null;
    return { id: doc.id, ...doc.data() };
  }, traceContext);
}

async function addShade(brandSlug, shadeData, traceContext = null) {
  return dbOp('addShade', async () => {
    const ref = db.collection('shades').doc(brandSlug).collection('colours').doc();
    await ref.set({ ...shadeData, active: true, createdAt: new Date().toISOString() });
    return { id: ref.id, ...shadeData, active: true };
  }, traceContext);
}

async function updateShade(brandSlug, shadeId, updates, traceContext = null) {
  return dbOp('updateShade', async () => {
    await db.collection('shades').doc(brandSlug).collection('colours').doc(shadeId).update(updates);
  }, traceContext);
}

async function getShadeByCode(brandSlug, code, traceContext = null) {
  return dbOp('getShadeByCode', async () => {
    const snap = await db.collection('shades').doc(brandSlug).collection('colours')
      .where('code', '==', code).limit(1).get();
    return snap.empty ? null : { id: snap.docs[0].id, ...snap.docs[0].data() };
  }, traceContext);
}

module.exports = {
  getPaintPricing, setPaintPricing, listAllPaintPricing,
  getShadesByBrand, getBrandDoc, addShade, updateShade, getShadeByCode,
  VALID_TIERS, VALID_SIZES,
};
