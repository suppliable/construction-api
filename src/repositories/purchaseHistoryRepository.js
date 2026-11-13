'use strict';

// What each item was last actually BOUGHT for, derived from Zoho bill lines.
//
// The obvious source — the item master's `purchase_rate` — is not usable: it
// drifts from the bills in both directions (a sampled item showed 7500 on the
// master against 6695 on its most recent bill), because nothing keeps it in
// step. The bills are the record of money actually spent, so they are the
// source of truth here.
//
// One document per Zoho item id. Rates are stored in BOTH bases so no reader
// has to know which convention a bill used: `rateExcl` is what the bill line
// said, `rateIncl` is what was really paid per unit and is the only figure
// comparable with a selling price.

const { dbOp } = require('../utils/dbOp');
const { getTrackedDb } = require('../middleware/firestoreTracker');

const db = getTrackedDb();
const COLLECTION = 'itemPurchaseHistory';
const SYNC_DOC = 'purchaseHistorySync';

async function listAll(traceContext = null) {
  return dbOp('listPurchaseHistory', async () => {
    const snap = await db.collection(COLLECTION).get();
    return snap.docs.map(d => ({ itemId: d.id, ...d.data() }));
  }, traceContext);
}

async function getOne(itemId, traceContext = null) {
  return dbOp('getPurchaseHistory', async () => {
    const doc = await db.collection(COLLECTION).doc(String(itemId)).get();
    return doc.exists ? { itemId: doc.id, ...doc.data() } : null;
  }, traceContext);
}

/**
 * Write the latest purchase for each item.
 *
 * Batched: a full backfill touches ~1k documents and Firestore caps a batch at
 * 500 writes. Entries are expected to be pre-reduced to one per item by the
 * caller, which already knows which bill is newest.
 */
async function upsertMany(entries, traceContext = null) {
  if (!entries.length) return 0;
  return dbOp('upsertPurchaseHistory', async () => {
    const CHUNK = 400;
    let written = 0;
    for (let i = 0; i < entries.length; i += CHUNK) {
      const batch = db.batch();
      for (const e of entries.slice(i, i + CHUNK)) {
        batch.set(db.collection(COLLECTION).doc(String(e.itemId)), e, { merge: true });
      }
      // eslint-disable-next-line no-await-in-loop -- batches must commit in sequence
      await batch.commit();
      written += Math.min(CHUNK, entries.length - i);
    }
    return written;
  }, traceContext);
}

// ── sync watermark ──────────────────────────────────────────────────────────
// Zoho's bill list ignores last_modified_time as a filter (verified: passing it
// changes nothing), so the whole list is pulled — 200/page, ~2 calls — and
// filtered here. Only bills modified since the watermark have their detail
// fetched, which is the expensive call.

async function getWatermark(traceContext = null) {
  return dbOp('getPurchaseSyncWatermark', async () => {
    const doc = await db.collection('config').doc(SYNC_DOC).get();
    return doc.exists ? (doc.data().lastModifiedTime || null) : null;
  }, traceContext);
}

async function setWatermark(lastModifiedTime, stats = {}, traceContext = null) {
  return dbOp('setPurchaseSyncWatermark', async () => {
    await db.collection('config').doc(SYNC_DOC).set({
      lastModifiedTime,
      lastRunAt: new Date().toISOString(),
      ...stats,
    }, { merge: true });
  }, traceContext);
}

module.exports = { listAll, getOne, upsertMany, getWatermark, setWatermark, COLLECTION };
