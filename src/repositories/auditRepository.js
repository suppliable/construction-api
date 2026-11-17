'use strict';

// Append-only record of admin actions that move money or change what customers
// pay.
//
// Separate from the structured logs on purpose: those answer "who did what" for
// as long as the retention window holds — about a fortnight on Grafana Cloud's
// free tier — and the question people actually ask ("who raised this price?")
// tends to arrive months later. Rows here do not expire.
//
// Deliberately cheap: the system writes ~26 documents a day, so a few hundred
// audit rows a month is noise. Queried by `at` alone, which needs no composite
// index; actor and action are filtered in memory, because the volume never
// makes that the expensive part.

const crypto = require('crypto');
const { dbOp } = require('../utils/dbOp');
const { getTrackedDb } = require('../middleware/firestoreTracker');

const db = getTrackedDb();
const COLLECTION = 'adminAuditLog';
const DEFAULT_LIMIT = 200;

async function append(entry, traceContext = null) {
  return dbOp('appendAuditEntry', async () => {
    const id = `${Date.now().toString(36)}${crypto.randomBytes(3).toString('hex')}`.toUpperCase();
    await db.collection(COLLECTION).doc(id).set({ id, ...entry });
    return { id, ...entry };
  }, traceContext);
}

async function list({ limit = DEFAULT_LIMIT } = {}, traceContext = null) {
  return dbOp('listAuditEntries', async () => {
    const snap = await db.collection(COLLECTION).orderBy('at', 'desc').limit(limit).get();
    return snap.docs.map(d => d.data());
  }, traceContext);
}

module.exports = { append, list, COLLECTION, DEFAULT_LIMIT };
