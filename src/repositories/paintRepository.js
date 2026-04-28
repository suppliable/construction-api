'use strict';

const { getTrackedDb } = require('../middleware/firestoreTracker');

const db = getTrackedDb();
const VALID_TIERS = ['light', 'mid', 'dark'];
const VALID_SIZES = ['1L', '4L', '10L', '20L'];

async function getPaintPricing(productId) {
  const doc = await db.collection('paintPricing').doc(productId).get();
  if (!doc.exists) return null;
  return { id: doc.id, ...doc.data() };
}

async function setPaintPricing(productId, data) {
  await db.collection('paintPricing').doc(productId).set(data, { merge: true });
}

async function listAllPaintPricing() {
  const snap = await db.collection('paintPricing').get();
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

async function getShadesByBrand(brandSlug, searchQuery, includeInactive = false) {
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
}

async function getBrandDoc(brandSlug) {
  const doc = await db.collection('shades').doc(brandSlug).get();
  if (!doc.exists) return null;
  return { id: doc.id, ...doc.data() };
}

async function addShade(brandSlug, shadeData) {
  const ref = db.collection('shades').doc(brandSlug).collection('colours').doc();
  await ref.set({ ...shadeData, active: true, createdAt: new Date().toISOString() });
  return { id: ref.id, ...shadeData, active: true };
}

async function updateShade(brandSlug, shadeId, updates) {
  await db.collection('shades').doc(brandSlug).collection('colours').doc(shadeId).update(updates);
}

async function getShadeByCode(brandSlug, code) {
  const snap = await db.collection('shades').doc(brandSlug).collection('colours')
    .where('code', '==', code).limit(1).get();
  return snap.empty ? null : { id: snap.docs[0].id, ...snap.docs[0].data() };
}

module.exports = {
  getPaintPricing, setPaintPricing, listAllPaintPricing,
  getShadesByBrand, getBrandDoc, addShade, updateShade, getShadeByCode,
  VALID_TIERS, VALID_SIZES,
};
