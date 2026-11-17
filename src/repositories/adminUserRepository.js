'use strict';

// Admin users and their sessions.
//
// Two collections rather than one, for a reason worth stating. A session is
// keyed by the SHA-256 of the bearer token, so authenticating a request is a
// single document get by id — no query, no index, one read. The raw token is
// never stored: a leaked database dump cannot be replayed as a login.
//
// The session carries the name and role it was minted with, so a request needs
// that one read and not a second for the user. The cost is that a change to a
// user does not reach a live session — which is why deactivating a user deletes
// their sessions outright rather than relying on expiry.

const crypto = require('crypto');
const admin = require('../utils/firebaseAdmin');
const { dbOp } = require('../utils/dbOp');
const { getTrackedDb } = require('../middleware/firestoreTracker');

const db = getTrackedDb();
const USERS = 'adminUsers';
const SESSIONS = 'adminSessions';

const hashToken = token => crypto.createHash('sha256').update(String(token)).digest('hex');

// ── users ───────────────────────────────────────────────────────────────────

async function getUser(userId, traceContext = null) {
  return dbOp('getAdminUser', async () => {
    const doc = await db.collection(USERS).doc(userId).get();
    return doc.exists ? { userId: doc.id, ...doc.data() } : null;
  }, traceContext);
}

/** Email is the login handle, so it is the document id — lower-cased. */
async function getUserByEmail(email, traceContext = null) {
  return getUser(String(email || '').trim().toLowerCase(), traceContext);
}

async function listUsers(traceContext = null) {
  return dbOp('listAdminUsers', async () => {
    const snap = await db.collection(USERS).get();
    return snap.docs.map(d => ({ userId: d.id, ...d.data() }));
  }, traceContext);
}

async function saveUser(user, traceContext = null) {
  return dbOp('saveAdminUser', async () => {
    await db.collection(USERS).doc(user.userId).set(user, { merge: true });
    return user;
  }, traceContext);
}

async function countUsers(traceContext = null) {
  return dbOp('countAdminUsers', async () => {
    const snap = await db.collection(USERS).limit(1).get();
    return snap.size;
  }, traceContext);
}

// ── sessions ────────────────────────────────────────────────────────────────

async function createSession(token, session, traceContext = null) {
  return dbOp('createAdminSession', async () => {
    await db.collection(SESSIONS).doc(hashToken(token)).set(session);
    return session;
  }, traceContext);
}

async function getSession(token, traceContext = null) {
  return dbOp('getAdminSession', async () => {
    const doc = await db.collection(SESSIONS).doc(hashToken(token)).get();
    return doc.exists ? doc.data() : null;
  }, traceContext);
}

async function deleteSession(token, traceContext = null) {
  return dbOp('deleteAdminSession', async () => {
    await db.collection(SESSIONS).doc(hashToken(token)).delete();
  }, traceContext);
}

/**
 * Drop every session belonging to a user — what makes deactivation immediate
 * rather than "once the token expires".
 */
async function deleteSessionsForUser(userId, traceContext = null) {
  return dbOp('deleteAdminSessionsForUser', async () => {
    const raw = admin.firestore();
    const snap = await raw.collection(SESSIONS).where('userId', '==', userId).get();
    if (snap.empty) return 0;
    // Raw refs: a real batch rejects the tracker's TrackedDoc wrappers.
    const batch = raw.batch();
    snap.docs.forEach(d => batch.delete(d.ref));
    await batch.commit();
    return snap.size;
  }, traceContext);
}

module.exports = {
  getUser, getUserByEmail, listUsers, saveUser, countUsers,
  createSession, getSession, deleteSession, deleteSessionsForUser,
  hashToken, USERS, SESSIONS,
};
