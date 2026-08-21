'use strict';

// FIFO stock costing ledger — generalized from the original cement-only tool.
//
// The warehouse manager records a "restock" every time material is bought:
//   { productId, date, pricePerUnit, qtyReceived, stockInHand }
// where `stockInHand` is the physical count of the OLD stock counted right
// before the new load is unloaded.
//
// We never store mutable layer state. The full FIFO ledger is recomputed by
// replaying every restock for a product in date order (see buildLedger). That
// keeps entries fully editable/auditable — fix a mistyped restock and the
// ledger recomputes correctly.
//
// Storage note: this used to be cement-only, so the Firestore collections are
// still named `cementProducts`/`cementRestocks` and existing documents there
// use the old field names (`bagsReceived`, `landingPricePerBag`). Renaming the
// collections would mean copying every historical document for no functional
// gain, so we don't — old documents are read as-is (see the `??` fallbacks
// below) and keep working unchanged. Only new documents use the generic field
// names. Same idea for `unit`/`category`: old cement docs don't have them, so
// reads default to 'bags' / 'Cement' rather than requiring a migration.

const { dbOp } = require('../utils/dbOp');
const { getTrackedDb } = require('../middleware/firestoreTracker');

const db = getTrackedDb();
const PRODUCTS = 'cementProducts';
const RESTOCKS = 'cementRestocks';

const LEGACY_UNIT = 'bags';
const LEGACY_CATEGORY = 'Cement';

// ---- stock products (the pickable list of materials) ----

async function listProducts(traceContext = null) {
  return dbOp('listStockProducts', async () => {
    const snap = await db.collection(PRODUCTS).where('active', '==', true).get();
    const products = snap.docs.map(d => {
      const data = d.data();
      return {
        id: d.id,
        ...data,
        unit: data.unit || LEGACY_UNIT,
        category: data.category || LEGACY_CATEGORY,
      };
    });
    products.sort((a, b) => (a.category || '').localeCompare(b.category || '')
      || (a.name || '').localeCompare(b.name || ''));
    return products;
  }, traceContext);
}

async function getProduct(productId, traceContext = null) {
  return dbOp('getStockProduct', async () => {
    const doc = await db.collection(PRODUCTS).doc(productId).get();
    if (!doc.exists) return null;
    const data = doc.data();
    return {
      id: doc.id,
      ...data,
      unit: data.unit || LEGACY_UNIT,
      category: data.category || LEGACY_CATEGORY,
    };
  }, traceContext);
}

async function addProduct(name, category, unit, traceContext = null) {
  return dbOp('addStockProduct', async () => {
    const ref = db.collection(PRODUCTS).doc();
    const data = {
      name,
      category: category || '',
      unit: unit || '',
      active: true,
      createdAt: new Date().toISOString(),
    };
    await ref.set(data);
    return { id: ref.id, ...data };
  }, traceContext);
}

// ---- restocks ----

async function listRestocks(productId, traceContext = null) {
  return dbOp('listStockRestocks', async () => {
    const snap = await db.collection(RESTOCKS).where('productId', '==', productId).get();
    const rows = snap.docs.map(d => {
      const data = d.data();
      // Normalize legacy cement field names to the generic shape so callers
      // (controller, admin UI) only ever deal with one set of keys.
      return {
        id: d.id,
        ...data,
        qtyReceived: Number(data.qtyReceived ?? data.bagsReceived) || 0,
        pricePerUnit: Number(data.pricePerUnit ?? data.landingPricePerBag) || 0,
        stockInHand: Number(data.stockInHand) || 0,
      };
    });
    // Oldest first. Tie-break on createdAt so same-day entries stay in entry order.
    rows.sort((a, b) => (a.date || '').localeCompare(b.date || '')
      || (a.createdAt || '').localeCompare(b.createdAt || ''));
    return rows;
  }, traceContext);
}

async function addRestock(entry, traceContext = null) {
  return dbOp('addStockRestock', async () => {
    const ref = db.collection(RESTOCKS).doc();
    const data = {
      productId: entry.productId,
      date: entry.date,                     // 'YYYY-MM-DD'
      pricePerUnit: entry.pricePerUnit,      // number, ₹/unit
      qtyReceived: entry.qtyReceived,        // quantity received in this delivery
      stockInHand: entry.stockInHand,        // OLD quantity counted before this delivery
      note: entry.note || '',
      createdAt: new Date().toISOString(),
    };
    await ref.set(data);
    return { id: ref.id, ...data };
  }, traceContext);
}

async function deleteRestock(restockId, traceContext = null) {
  return dbOp('deleteStockRestock', async () => {
    await db.collection(RESTOCKS).doc(restockId).delete();
  }, traceContext);
}

// ---- FIFO replay ----

// Replays a product's restocks (must be passed oldest-first) into FIFO layers.
// Returns { onHand, stockValue, ratePerUnit, layers, anomalies }.
function buildLedger(restocks) {
  const layers = [];        // FIFO queue: { qty, price } — front is oldest
  const anomalies = [];

  restocks.forEach((r, idx) => {
    const recorded = layers.reduce((s, l) => s + l.qty, 0);
    const leftover = idx === 0 ? recorded : Number(r.stockInHand) || 0;

    // Consume (oldest first) down to the counted leftover — this is FIFO outflow.
    const consumed = recorded - leftover;
    if (consumed > 0) {
      let toRemove = consumed;
      while (toRemove > 0 && layers.length) {
        const front = layers[0];
        if (front.qty <= toRemove) { toRemove -= front.qty; layers.shift(); }
        else { front.qty -= toRemove; toRemove = 0; }
      }
    } else if (consumed < 0 && idx > 0) {
      // Counted MORE than records say should exist — stock "appeared". Flag it;
      // don't fabricate cost basis. The extra is treated as unpriced (₹0) later
      // only if it survives, but here we simply note the discrepancy.
      anomalies.push({
        restockId: r.id,
        date: r.date,
        message: `Counted ${leftover} but records showed ${recorded}. `
          + `${-consumed} extra unit(s) not accounted for.`,
      });
    }

    // Add the new delivery as a fresh FIFO layer at its landing price.
    // qtyReceived is the generic field; bagsReceived is the legacy cement field.
    const qtyReceived = Number(r.qtyReceived ?? r.bagsReceived) || 0;
    const pricePerUnit = Number(r.pricePerUnit ?? r.landingPricePerBag) || 0;
    if (qtyReceived > 0) {
      layers.push({ qty: qtyReceived, price: pricePerUnit });
    }
  });

  const onHand = layers.reduce((s, l) => s + l.qty, 0);
  const stockValue = layers.reduce((s, l) => s + l.qty * l.price, 0);
  const ratePerUnit = onHand > 0 ? stockValue / onHand : 0;

  return {
    onHand,
    stockValue: round2(stockValue),
    ratePerUnit: round2(ratePerUnit),
    layers: layers.map(l => ({ qty: l.qty, price: round2(l.price) })),
    anomalies,
  };
}

function round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }

module.exports = {
  listProducts, getProduct, addProduct,
  listRestocks, addRestock, deleteRestock,
  buildLedger,
};
