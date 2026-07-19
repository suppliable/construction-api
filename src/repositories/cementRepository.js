'use strict';

// FIFO cement stock costing ledger.
//
// The warehouse manager records a "restock" every time cement is bought:
//   { productId, date, landingPricePerBag, bagsReceived, stockInHand }
// where `stockInHand` is the physical bag count of the OLD stock counted
// right before the new load is unloaded.
//
// We never store mutable layer state. The full FIFO ledger is recomputed by
// replaying every restock for a product in date order (see buildLedger). That
// keeps entries fully editable/auditable — fix a mistyped restock and the
// ledger recomputes correctly.

const { dbOp } = require('../utils/dbOp');
const { getTrackedDb } = require('../middleware/firestoreTracker');

const db = getTrackedDb();
const PRODUCTS = 'cementProducts';
const RESTOCKS = 'cementRestocks';

// ---- cement products (the pickable list of cement types) ----

async function listProducts(traceContext = null) {
  return dbOp('listCementProducts', async () => {
    const snap = await db.collection(PRODUCTS).where('active', '==', true).get();
    const products = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    products.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    return products;
  }, traceContext);
}

async function getProduct(productId, traceContext = null) {
  return dbOp('getCementProduct', async () => {
    const doc = await db.collection(PRODUCTS).doc(productId).get();
    if (!doc.exists) return null;
    return { id: doc.id, ...doc.data() };
  }, traceContext);
}

async function addProduct(name, traceContext = null) {
  return dbOp('addCementProduct', async () => {
    const ref = db.collection(PRODUCTS).doc();
    const data = { name, active: true, createdAt: new Date().toISOString() };
    await ref.set(data);
    return { id: ref.id, ...data };
  }, traceContext);
}

// ---- restocks ----

async function listRestocks(productId, traceContext = null) {
  return dbOp('listCementRestocks', async () => {
    const snap = await db.collection(RESTOCKS).where('productId', '==', productId).get();
    const rows = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    // Oldest first. Tie-break on createdAt so same-day entries stay in entry order.
    rows.sort((a, b) => (a.date || '').localeCompare(b.date || '')
      || (a.createdAt || '').localeCompare(b.createdAt || ''));
    return rows;
  }, traceContext);
}

async function addRestock(entry, traceContext = null) {
  return dbOp('addCementRestock', async () => {
    const ref = db.collection(RESTOCKS).doc();
    const data = {
      productId: entry.productId,
      date: entry.date,                                 // 'YYYY-MM-DD'
      landingPricePerBag: entry.landingPricePerBag,     // number, ₹/bag
      bagsReceived: entry.bagsReceived,                 // number of bags in this delivery
      stockInHand: entry.stockInHand,                   // OLD bags counted before this delivery
      note: entry.note || '',
      createdAt: new Date().toISOString(),
    };
    await ref.set(data);
    return { id: ref.id, ...data };
  }, traceContext);
}

async function deleteRestock(restockId, traceContext = null) {
  return dbOp('deleteCementRestock', async () => {
    await db.collection(RESTOCKS).doc(restockId).delete();
  }, traceContext);
}

// ---- FIFO replay ----

// Replays a product's restocks (must be passed oldest-first) into FIFO layers.
// Returns { onHand, stockValue, ratePerBag, layers, anomalies }.
function buildLedger(restocks) {
  const layers = [];        // FIFO queue: { bags, price } — front is oldest
  const anomalies = [];

  restocks.forEach((r, idx) => {
    const recorded = layers.reduce((s, l) => s + l.bags, 0);
    const leftover = idx === 0 ? recorded : Number(r.stockInHand) || 0;

    // Consume (oldest first) down to the counted leftover — this is FIFO outflow.
    const consumed = recorded - leftover;
    if (consumed > 0) {
      let toRemove = consumed;
      while (toRemove > 0 && layers.length) {
        const front = layers[0];
        if (front.bags <= toRemove) { toRemove -= front.bags; layers.shift(); }
        else { front.bags -= toRemove; toRemove = 0; }
      }
    } else if (consumed < 0 && idx > 0) {
      // Counted MORE than records say should exist — bags "appeared". Flag it;
      // don't fabricate cost basis. The extra is treated as unpriced (₹0) later
      // only if it survives, but here we simply note the discrepancy.
      anomalies.push({
        restockId: r.id,
        date: r.date,
        message: `Counted ${leftover} bags but records showed ${recorded}. `
          + `${-consumed} extra bag(s) not accounted for.`,
      });
    }

    // Add the new delivery as a fresh FIFO layer at its landing price.
    const bagsReceived = Number(r.bagsReceived) || 0;
    if (bagsReceived > 0) {
      layers.push({ bags: bagsReceived, price: Number(r.landingPricePerBag) || 0 });
    }
  });

  const onHand = layers.reduce((s, l) => s + l.bags, 0);
  const stockValue = layers.reduce((s, l) => s + l.bags * l.price, 0);
  const ratePerBag = onHand > 0 ? stockValue / onHand : 0;

  return {
    onHand,
    stockValue: round2(stockValue),
    ratePerBag: round2(ratePerBag),
    layers: layers.map(l => ({ bags: l.bags, price: round2(l.price) })),
    anomalies,
  };
}

function round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }

module.exports = {
  listProducts, getProduct, addProduct,
  listRestocks, addRestock, deleteRestock,
  buildLedger,
};
