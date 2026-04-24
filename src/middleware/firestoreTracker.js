'use strict';

const { AsyncLocalStorage } = require('async_hooks');
const onHeaders = require('on-headers');

// ── Per-request storage ───────────────────────────────────────────────────────
const storage = new AsyncLocalStorage();

function getStore() {
  return storage.getStore();
}

// ── Global aggregate (survives across requests) ───────────────────────────────
const globalStats = {
  byEndpoint: new Map(), // key: "METHOD /path"
  totalReads: 0,
  totalWrites: 0,
  totalDeletes: 0,
};

function recordGlobal(endpoint, reads, writes, deletes) {
  globalStats.totalReads += reads;
  globalStats.totalWrites += writes;
  globalStats.totalDeletes += deletes;

  const existing = globalStats.byEndpoint.get(endpoint) || { reads: 0, writes: 0, deletes: 0, calls: 0 };
  existing.reads += reads;
  existing.writes += writes;
  existing.deletes += deletes;
  existing.calls += 1;
  globalStats.byEndpoint.set(endpoint, existing);
}

function resetGlobal() {
  globalStats.byEndpoint.clear();
  globalStats.totalReads = 0;
  globalStats.totalWrites = 0;
  globalStats.totalDeletes = 0;
}

function getGlobalReport() {
  const byEndpoint = Array.from(globalStats.byEndpoint.entries())
    .sort((a, b) => b[1].reads - a[1].reads)
    .map(([endpoint, stats]) => ({
      endpoint,
      reads: stats.reads,
      writes: stats.writes,
      deletes: stats.deletes,
      calls: stats.calls,
      readsPerCall: stats.calls > 0 ? +(stats.reads / stats.calls).toFixed(1) : 0,
    }));

  return {
    summary: {
      totalReads: globalStats.totalReads,
      totalWrites: globalStats.totalWrites,
      totalDeletes: globalStats.totalDeletes,
    },
    byEndpoint,
  };
}

// ── Per-request recording ─────────────────────────────────────────────────────
function recordRead(collection, count = 1) {
  const store = getStore();
  if (!store) return;
  store.reads += count;
  if (count > 0) store.ops.push({ type: 'read', collection, count });
}

function recordWrite(collection) {
  const store = getStore();
  if (!store) return;
  store.writes += 1;
  store.ops.push({ type: 'write', collection });
}

function recordDelete(collection) {
  const store = getStore();
  if (!store) return;
  store.deletes += 1;
  store.ops.push({ type: 'delete', collection });
}

// ── Express middleware ─────────────────────────────────────────────────────────
function requestMiddleware(req, res, next) {
  if (req.method === 'HEAD') return next();

  const store = { reads: 0, writes: 0, deletes: 0, ops: [] };
  storage.run(store, () => {
    // on-headers fires just before headers are written — safe to set headers here
    onHeaders(res, function () {
      this.setHeader('X-Firestore-Reads', store.reads);
      this.setHeader('X-Firestore-Writes', store.writes);
    });

    res.on('finish', () => {
      const endpoint = `${req.method} ${req.route?.path || req.path}`;
      const { reads, writes, deletes } = store;

      if (reads > 0 || writes > 0 || deletes > 0) {
        console.log(`[FIRESTORE] ${req.method} ${req.path} → reads: ${reads}, writes: ${writes}, deletes: ${deletes}`);
      }

      recordGlobal(endpoint, reads, writes, deletes);
    });

    next();
  });
}

// ── Tracked Firestore wrapper ─────────────────────────────────────────────────
class TrackedQuery {
  constructor(query, collectionName) {
    this._q = query;
    this._col = collectionName;
  }

  where(...args) { return new TrackedQuery(this._q.where(...args), this._col); }
  orderBy(...args) { return new TrackedQuery(this._q.orderBy(...args), this._col); }
  limit(...args) { return new TrackedQuery(this._q.limit(...args), this._col); }
  startAfter(...args) { return new TrackedQuery(this._q.startAfter(...args), this._col); }
  offset(...args) { return new TrackedQuery(this._q.offset(...args), this._col); }

  async get() {
    const snapshot = await this._q.get();
    // Empty queries cost 0 reads; non-empty cost 1 per doc
    recordRead(this._col, snapshot.size);
    return snapshot;
  }
}

class TrackedDoc {
  constructor(ref, collectionName) {
    this._ref = ref;
    this._col = collectionName;
  }

  collection(name) {
    return new TrackedCollection(this._ref.collection(name), name);
  }

  async get() {
    recordRead(this._col, 1);
    return this._ref.get();
  }

  async set(...args) {
    recordWrite(this._col);
    return this._ref.set(...args);
  }

  async update(...args) {
    recordWrite(this._col);
    return this._ref.update(...args);
  }

  async delete() {
    recordDelete(this._col);
    return this._ref.delete();
  }
}

class TrackedCollection {
  constructor(ref, collectionName) {
    this._ref = ref;
    this._col = collectionName;
  }

  doc(id) {
    return new TrackedDoc(this._ref.doc(id), this._col);
  }

  where(...args) { return new TrackedQuery(this._ref.where(...args), this._col); }
  orderBy(...args) { return new TrackedQuery(this._ref.orderBy(...args), this._col); }
  limit(...args) { return new TrackedQuery(this._ref.limit(...args), this._col); }

  async get() {
    const snapshot = await this._ref.get();
    recordRead(this._col, snapshot.size);
    return snapshot;
  }
}

class TrackedDb {
  constructor(db) {
    this._db = db;
  }

  collection(name) {
    return new TrackedCollection(this._db.collection(name), name);
  }

  // Pass through anything else (batch, runTransaction, etc.)
  batch() { return this._db.batch(); }
  runTransaction(...args) { return this._db.runTransaction(...args); }
}

let _trackedDb = null;

function getTrackedDb() {
  if (!_trackedDb) {
    const admin = require('../utils/firebaseAdmin');
    _trackedDb = new TrackedDb(admin.firestore());
  }
  return _trackedDb;
}

module.exports = {
  requestMiddleware,
  getTrackedDb,
  getGlobalReport,
  resetGlobal,
};
