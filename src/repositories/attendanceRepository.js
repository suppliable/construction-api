'use strict';

// One document per person per IST day, keyed `{userId}_{YYYY-MM-DD}`.
//
// The key is the point. "Is this the first login of the day?" becomes a single
// document get rather than a query, and two tabs opened at once cannot both
// create the record — the create is a transaction on that one id.
//
// Transactions and batches use RAW Firestore refs. getTrackedDb() hands back
// wrapper objects that a real transaction rejects ("not a valid
// DocumentReference"), which is what broke the first purchase-history backfill.

const admin = require('../utils/firebaseAdmin');
const { dbOp } = require('../utils/dbOp');
const { getTrackedDb } = require('../middleware/firestoreTracker');

const db = getTrackedDb();
const COLLECTION = 'attendance';

const docIdFor = (userId, dateKey) => `${String(userId).toLowerCase()}_${dateKey}`;

async function get(id, traceContext = null) {
  return dbOp('getAttendance', async () => {
    const doc = await db.collection(COLLECTION).doc(id).get();
    return doc.exists ? doc.data() : null;
  }, traceContext);
}

/**
 * Create the day's record unless it already exists.
 * Returns { created, record } — `record` is whichever one is now authoritative.
 */
async function createIfAbsent(record, traceContext = null) {
  return dbOp('createAttendance', async () => {
    const raw = admin.firestore();
    const ref = raw.collection(COLLECTION).doc(record.id);
    return raw.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (snap.exists) return { created: false, record: snap.data() };
      tx.set(ref, record);
      return { created: true, record };
    });
  }, traceContext);
}

async function update(id, patch, traceContext = null) {
  return dbOp('updateAttendance', async () => {
    await db.collection(COLLECTION).doc(id).set(patch, { merge: true });
  }, traceContext);
}

/** Records with no clock-out yet, optionally for one person. Equality filters
 *  only, so no composite index. */
async function listOpen({ userId = null } = {}, traceContext = null) {
  return dbOp('listOpenAttendance', async () => {
    let q = db.collection(COLLECTION).where('outAt', '==', null);
    if (userId) q = q.where('userId', '==', String(userId).toLowerCase());
    const snap = await q.get();
    return snap.docs.map(d => d.data());
  }, traceContext);
}

/** Inclusive date range. A single range filter on one field needs no composite
 *  index; person is filtered by the caller. */
async function listRange({ from, to }, traceContext = null) {
  return dbOp('listAttendanceRange', async () => {
    let q = db.collection(COLLECTION);
    if (from) q = q.where('date', '>=', from);
    if (to) q = q.where('date', '<=', to);
    const snap = await q.orderBy('date', 'desc').get();
    return snap.docs.map(d => d.data());
  }, traceContext);
}

module.exports = { get, createIfAbsent, update, listOpen, listRange, docIdFor, COLLECTION };
