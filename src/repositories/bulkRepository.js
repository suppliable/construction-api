'use strict';

// Bulk Orders & Quotes — Firestore data access.
//
// Bulk products are NOT stored here. A bulk product is an ordinary Zoho item
// with the `cf_bulk` checkbox ticked (see utils/appVisibility.isBulkItem), so
// rate, GST, HSN and units stay the ones finance already maintains, and an
// order placed against one can raise a Zoho SO because the item_id is real.
//
// What Firestore holds:
//   bulkCategories — an overlay on Zoho categories, carrying the things Zoho
//                    has no concept of: minimum order value, icon, sort order.
//                    Doc id is a slug of the Zoho category name.
//   bulkQuotes     — the quote lifecycle (requested → quoted → ordered/…)
//   bulkPhotos     — one doc per pre-signed upload slot, so a photoId resolves
//                    back to a storage path and its owner can be verified

const { dbOp } = require('../utils/dbOp');
const { getTrackedDb } = require('../middleware/firestoreTracker');

const db = getTrackedDb();

const CATEGORIES = 'bulkCategories';
const QUOTES = 'bulkQuotes';
const PHOTOS = 'bulkPhotos';

// ---- category overlay ----

async function listCategoryOverlays(traceContext = null) {
  return dbOp('bulk.listCategoryOverlays', async () => {
    const snap = await db.collection(CATEGORIES).get();
    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
  }, traceContext);
}

async function getCategoryOverlay(categoryId, traceContext = null) {
  return dbOp('bulk.getCategoryOverlay', async () => {
    const doc = await db.collection(CATEGORIES).doc(categoryId).get();
    if (!doc.exists) return null;
    return { id: doc.id, ...doc.data() };
  }, traceContext);
}

async function setCategoryOverlay(categoryId, data, traceContext = null) {
  return dbOp('bulk.setCategoryOverlay', async () => {
    await db.collection(CATEGORIES).doc(categoryId).set(data, { merge: true });
    const doc = await db.collection(CATEGORIES).doc(categoryId).get();
    return { id: doc.id, ...doc.data() };
  }, traceContext);
}

// ---- quotes ----

/**
 * One page of a customer's quotes, newest first.
 *
 * Cursor is the last quote id of the previous page, matching how orders are
 * paged. Needs a composite index on bulkQuotes (userId ASC, createdAt DESC) —
 * Firestore returns a creation link in the error the first time it is missing.
 */
async function listQuotesByUser(userId, limit, startAfterQuoteId = null, traceContext = null) {
  return dbOp('bulk.listQuotesByUser', async () => {
    let q = db.collection(QUOTES)
      .where('userId', '==', userId)
      .orderBy('createdAt', 'desc');

    if (startAfterQuoteId) {
      const cursorDoc = await db.collection(QUOTES).doc(startAfterQuoteId).get();
      if (cursorDoc.exists) q = q.startAfter(cursorDoc);
    }

    // One extra row is the cheapest way to know whether another page exists.
    const snap = await q.limit(limit + 1).get();
    const docs = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    const hasMore = docs.length > limit;
    const quotes = hasMore ? docs.slice(0, limit) : docs;

    return {
      quotes,
      hasMore,
      nextCursor: hasMore && quotes.length ? quotes[quotes.length - 1].id : null,
    };
  }, traceContext);
}

/** Admin queue. Optional status filter; newest first. */
async function listQuotesForAdmin({ status = null, limit = 50 } = {}, traceContext = null) {
  return dbOp('bulk.listQuotesForAdmin', async () => {
    let q = db.collection(QUOTES);
    if (status) q = q.where('status', '==', status);
    const snap = await q.get();
    const rows = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    // Sorted in memory so a status filter needs no composite index.
    rows.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
    return rows.slice(0, limit);
  }, traceContext);
}

/** Quotes whose validity has lapsed — drives the expiry job. */
async function listExpirableQuotes(nowISO, traceContext = null) {
  return dbOp('bulk.listExpirableQuotes', async () => {
    const snap = await db.collection(QUOTES).where('status', '==', 'quoted').get();
    return snap.docs
      .map(d => ({ id: d.id, ...d.data() }))
      .filter(q => q.validUntil && String(q.validUntil) <= nowISO);
  }, traceContext);
}

async function getQuote(quoteId, traceContext = null) {
  return dbOp('bulk.getQuote', async () => {
    const doc = await db.collection(QUOTES).doc(quoteId).get();
    if (!doc.exists) return null;
    return { id: doc.id, ...doc.data() };
  }, traceContext);
}

async function saveQuote(quote, traceContext = null) {
  return dbOp('bulk.saveQuote', async () => {
    await db.collection(QUOTES).doc(quote.id).set(quote);
    return quote;
  }, traceContext);
}

async function updateQuote(quoteId, data, traceContext = null) {
  return dbOp('bulk.updateQuote', async () => {
    await db.collection(QUOTES).doc(quoteId).set(data, { merge: true });
    const doc = await db.collection(QUOTES).doc(quoteId).get();
    return { id: doc.id, ...doc.data() };
  }, traceContext);
}

// ---- photos ----

async function savePhotoSlot(slot, traceContext = null) {
  return dbOp('bulk.savePhotoSlot', async () => {
    await db.collection(PHOTOS).doc(slot.photoId).set(slot);
    return slot;
  }, traceContext);
}

async function getPhotoSlots(photoIds, traceContext = null) {
  const unique = [...new Set((photoIds || []).filter(Boolean))];
  if (!unique.length) return [];
  return dbOp('bulk.getPhotoSlots', async () => {
    const snaps = await Promise.all(
      unique.map(id => db.collection(PHOTOS).doc(id).get())
    );
    return snaps.filter(s => s.exists).map(s => ({ photoId: s.id, ...s.data() }));
  }, traceContext);
}

module.exports = {
  listCategoryOverlays,
  getCategoryOverlay,
  setCategoryOverlay,
  listQuotesByUser,
  listQuotesForAdmin,
  listExpirableQuotes,
  getQuote,
  saveQuote,
  updateQuote,
  savePhotoSlot,
  getPhotoSlots,
};
