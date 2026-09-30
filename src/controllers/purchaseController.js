'use strict';

// Purchase management: low-stock sourcing from Zoho, purchase orders, the daily
// vendor checklist, and per-vendor delivery-day scheduling.
//
// Follows the existing controller conventions: axios + withRetry + createSpan for
// Zoho, getTrackedDb() for Firestore, the shared Upstash client for cache, and
// { success, data } / { success:false, error, message } responses. Admin auth is
// inherited from the router.use gate in routes/admin.js — nothing here re-checks
// the token.

const axios = require('axios');
const { getAccessToken } = require('../services/zohoService');
const { withRetry, DEFAULT_TIMEOUT_MS } = require('../utils/httpClient');
const { createSpan } = require('../utils/spanTracer');
const { getTrackedDb } = require('../middleware/firestoreTracker');
const admin = require('../utils/firebaseAdmin');
const redis = require('../cache/redis');

const LOW_STOCK_CACHE_KEY = 'purchase:lowstock';
const LOW_STOCK_CACHE_TTL_S = 30 * 60;
const PO_LIST_LIMIT = 50;
const UNASSIGNED_VENDOR_ID = 'unassigned';

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// Status lifecycle. Forward-only: a PO can never go back to an earlier state, and
// 'received' is terminal. Cancelling is allowed from draft or sent only.
const PO_STATUSES = ['draft', 'sent', 'received', 'cancelled'];
const ALLOWED_TRANSITIONS = {
  draft: ['sent', 'cancelled'],
  sent: ['received', 'cancelled'],
  received: [],
  cancelled: [],
};

// ── HELPERS ───────────────────────────────────────────────

function db() { return getTrackedDb(); }

// IST calendar day (YYYY-MM-DD). The warehouse's local day, matching istDate.js.
function istDateKey(d = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(d);
}

// Day of week (0=Sun..6=Sat) for a YYYY-MM-DD key, read in IST.
function dayOfWeekFor(dateKey) {
  const d = new Date(`${dateKey}T12:00:00+05:30`);
  return Number.isNaN(d.getTime()) ? null : d.getDay();
}

function toNumber(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

async function zohoGet(path, params, traceContext, spanName) {
  const span = createSpan(traceContext, spanName, { 'peer.service': 'zoho', endpoint: path });
  try {
    const token = await getAccessToken();
    const res = await withRetry(spanName, () =>
      axios.get(`${process.env.ZOHO_API_DOMAIN}${path}`, {
        headers: { Authorization: `Zoho-oauthtoken ${token}` },
        params: { organization_id: process.env.ZOHO_ORG_ID, ...params },
        timeout: DEFAULT_TIMEOUT_MS,
      })
    );
    span.end({ success: true });
    return res.data;
  } catch (err) {
    span.end({ success: false, error: err.response?.data || err.message });
    throw err;
  }
}

// Zoho pages at 200/page; follow page_context.has_more_page like getZohoProducts.
async function zohoGetAll(path, params, traceContext, spanName, collectionKey) {
  const out = [];
  let page = 1;
  for (;;) {
    const data = await zohoGet(path, { ...params, per_page: 200, page }, traceContext, spanName);
    out.push(...(data[collectionKey] || []));
    if (!data.page_context?.has_more_page) break;
    page++;
  }
  return out;
}

async function readVendorSchedules() {
  const snap = await db().collection('vendorSchedule').get();
  const byId = {};
  snap.forEach(doc => { byId[doc.id] = { vendorId: doc.id, ...doc.data() }; });
  return byId;
}

// ── LOW STOCK ─────────────────────────────────────────────

// Normalised key for matching an item's vendor_name to a Zoho contact.
function vendorKey(name) {
  return String(name || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

async function buildLowStock(traceContext) {
  // Zoho Inventory has NO server-side low-stock filter — filter_by only accepts
  // Status.* values and rejects anything else with "Invalid value passed for
  // filter_by". So the whole catalogue is pulled (same paging as
  // getZohoProducts) and the reorder comparison happens here. The 30-minute
  // cache is what keeps this off Zoho on every page load.
  //
  // Items carry vendor_name but not vendor_id in the list response, while
  // vendorSchedule is keyed by Zoho contact_id — so the vendor contact list is
  // fetched alongside and used to resolve one to the other.
  const [items, contacts] = await Promise.all([
    zohoGetAll('/inventory/v1/items', {}, traceContext, 'zoho.api.lowStockItems', 'items'),
    zohoGetAll('/inventory/v1/contacts', { contact_type: 'vendor' }, traceContext, 'zoho.api.listVendors', 'contacts')
      .catch(() => []),
  ]);

  const contactByName = new Map();
  for (const c of contacts) {
    const key = vendorKey(c.contact_name || c.company_name);
    if (key) contactByName.set(key, c);
  }

  const schedules = await readVendorSchedules();

  // A reorder_level of 0 means "not tracked for reordering" — including those
  // would flag every zero-stock item in the catalogue.
  const lowItems = items.filter(i =>
    i.status !== 'inactive' &&
    toNumber(i.reorder_level) > 0 &&
    toNumber(i.stock_on_hand) <= toNumber(i.reorder_level)
  );

  const groups = new Map();
  for (const it of lowItems) {
    const rawName = it.vendor_name || '';
    const contact = contactByName.get(vendorKey(rawName));
    // Prefer the real contact id so schedules attach; fall back to a stable
    // name-derived key so an unmatched vendor still groups sensibly rather than
    // collapsing into "unassigned" with everyone else.
    const vendorId = it.vendor_id || contact?.contact_id
      || (rawName ? `name:${vendorKey(rawName)}` : UNASSIGNED_VENDOR_ID);

    if (!groups.has(vendorId)) {
      const sched = schedules[vendorId] || {};
      groups.set(vendorId, {
        vendorId,
        vendorName: rawName || contact?.contact_name || 'No Vendor Assigned',
        vendorPhone: sched.vendorPhone || contact?.mobile || contact?.phone || null,
        dayOfWeek: sched.dayOfWeek ?? null,
        items: [],
      });
    }

    const stockOnHand = toNumber(it.stock_on_hand);
    const reorderLevel = toNumber(it.reorder_level);
    groups.get(vendorId).items.push({
      itemId: it.item_id,
      name: it.name,
      unit: it.unit || '',
      stockOnHand,
      reorderLevel,
      // Shortfall against the reorder point, and enough to reach double it —
      // clamped so an odd Zoho row can never suggest a negative order.
      deficit: Math.max(0, reorderLevel - stockOnHand),
      suggestedOrderQty: Math.max(0, reorderLevel * 2 - stockOnHand),
      // No rack custom field exists in this Zoho org; kept so the column lights
      // up automatically if one is added later.
      rackNumber: it.cf_rack_number || '',
    });
  }

  const vendors = [...groups.values()];
  return {
    vendors,
    totalLowStockItems: lowItems.length,
    totalVendors: vendors.length,
    generatedAt: new Date().toISOString(),
  };
}

// GET /api/v1/admin/purchases/low-stock?refresh=1
const getLowStock = async (req, res) => {
  try {
    const refresh = req.query.refresh === '1' || req.query.refresh === 'true';
    if (refresh) {
      await redis.del(LOW_STOCK_CACHE_KEY).catch(() => {});
    } else {
      const cached = await redis.get(LOW_STOCK_CACHE_KEY).catch(() => null);
      if (cached) {
        const data = typeof cached === 'string' ? JSON.parse(cached) : cached;
        return res.json({ success: true, data: { ...data, cached: true } });
      }
    }

    const data = await buildLowStock(req.traceContext);
    await redis.set(LOW_STOCK_CACHE_KEY, JSON.stringify(data), { ex: LOW_STOCK_CACHE_TTL_S }).catch(() => {});
    res.json({ success: true, data: { ...data, cached: false } });
  } catch (err) {
    req.log?.error?.({ err: err.response?.data || err.message }, 'low stock fetch failed');
    res.status(500).json({ success: false, error: 'SERVER_ERROR', message: err.message });
  }
};

// Used by the checklist to show per-vendor counts without a second Zoho round
// trip when the cache is warm.
async function lowStockCountsByVendor(traceContext) {
  let data = await redis.get(LOW_STOCK_CACHE_KEY).catch(() => null);
  if (data) data = typeof data === 'string' ? JSON.parse(data) : data;
  if (!data) data = await buildLowStock(traceContext).catch(() => null);
  const counts = {};
  for (const v of (data?.vendors || [])) counts[v.vendorId] = v.items.length;
  return counts;
}

// ── PURCHASE ORDERS ───────────────────────────────────────

// PO-YYYY-NNN. The counter is bumped in a transaction so two managers clicking
// at once cannot mint the same number. The sequence restarts each calendar year.
async function nextPoNumber() {
  // Raw Firestore, not getTrackedDb(): the tracker returns TrackedDoc wrappers,
  // while runTransaction passes straight through to the real client — so a
  // wrapped ref inside tx.get() fails with "Value for argument refOrQuery must
  // be a DocumentReference". The counter is one doc per year, so the lost read
  // accounting is negligible.
  const raw = admin.firestore();
  const ref = raw.collection('purchaseOrderMeta').doc('counter');
  const year = new Date().getFullYear();
  const next = await raw.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const cur = snap.exists ? snap.data() : {};
    const seq = cur.year === year ? toNumber(cur.lastPoNumber, 0) + 1 : 1;
    tx.set(ref, { lastPoNumber: seq, year }, { merge: true });
    return seq;
  });
  return `PO-${year}-${String(next).padStart(3, '0')}`;
}

// POST /api/v1/admin/purchases/orders
const createPurchaseOrder = async (req, res) => {
  try {
    const { vendorId, vendorName, vendorPhone, items, notes } = req.body || {};
    if (!vendorId || !vendorName) {
      return res.status(400).json({ success: false, error: 'MISSING_PARAM', message: 'vendorId and vendorName are required' });
    }
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ success: false, error: 'MISSING_PARAM', message: 'items must be a non-empty array' });
    }

    const cleanItems = items.map(i => ({
      itemId: i.itemId || null,
      itemName: i.itemName || '',
      unit: i.unit || '',
      rackNumber: i.rackNumber || '',
      stockOnHand: toNumber(i.stockOnHand),
      reorderLevel: toNumber(i.reorderLevel),
      orderQty: toNumber(i.orderQty),
      receivedQty: null,
    }));

    const poNumber = await nextPoNumber();
    const createdAt = new Date().toISOString();
    const po = {
      poNumber, vendorId, vendorName,
      vendorPhone: vendorPhone || null,
      status: 'draft',
      createdAt, createdBy: 'admin',
      sentAt: null, receivedAt: null, cancelledAt: null,
      invoiceNumber: null, invoiceDate: null,
      notes: notes || '',
      items: cleanItems,
    };

    // TrackedCollection exposes no .add(), so the id is minted locally from a
    // raw ref (no network call) and the write itself still goes through the
    // tracker.
    const poId = admin.firestore().collection('purchaseOrders').doc().id;
    await db().collection('purchaseOrders').doc(poId).set(po);

    res.json({
      success: true,
      data: { poId, poNumber, vendorName, totalItems: cleanItems.length, createdAt },
    });
  } catch (err) {
    req.log?.error?.({ err: err.message }, 'create purchase order failed');
    res.status(500).json({ success: false, error: 'SERVER_ERROR', message: err.message });
  }
};

// GET /api/v1/admin/purchases/orders
const listPurchaseOrders = async (req, res) => {
  try {
    const { status, vendorId, date, cursor } = req.query;

    let q = db().collection('purchaseOrders');
    if (status) q = q.where('status', '==', status);
    if (vendorId) q = q.where('vendorId', '==', vendorId);
    q = q.orderBy('createdAt', 'desc');
    if (cursor) q = q.startAfter(cursor);

    const snap = await q.limit(PO_LIST_LIMIT).get();
    let orders = snap.docs.map(d => {
      const { items, ...rest } = d.data();
      // The list stays light: callers get a count, and the full items array only
      // on the single-PO fetch.
      return { poId: d.id, ...rest, itemCount: (items || []).length };
    });

    // Date filtering is applied here rather than as a range query so it can be
    // combined with status/vendor without needing a composite index per pairing.
    if (date) orders = orders.filter(o => (o.createdAt || '').slice(0, 10) === date);

    const summary = { totalDraft: 0, totalSent: 0, totalReceived: 0, totalCancelled: 0 };
    const allSnap = await db().collection('purchaseOrders').get();
    allSnap.forEach(d => {
      const s = d.data().status;
      if (s === 'draft') summary.totalDraft++;
      else if (s === 'sent') summary.totalSent++;
      else if (s === 'received') summary.totalReceived++;
      else if (s === 'cancelled') summary.totalCancelled++;
    });

    res.json({
      success: true,
      data: {
        orders,
        ...summary,
        nextCursor: orders.length === PO_LIST_LIMIT ? orders[orders.length - 1].createdAt : null,
      },
    });
  } catch (err) {
    req.log?.error?.({ err: err.message }, 'list purchase orders failed');
    res.status(500).json({ success: false, error: 'SERVER_ERROR', message: err.message });
  }
};

// GET /api/v1/admin/purchases/orders/:poId
const getPurchaseOrder = async (req, res) => {
  try {
    const doc = await db().collection('purchaseOrders').doc(req.params.poId).get();
    if (!doc.exists) {
      return res.status(404).json({ success: false, error: 'NOT_FOUND', message: 'Purchase order not found' });
    }
    res.json({ success: true, data: { poId: doc.id, ...doc.data() } });
  } catch (err) {
    res.status(500).json({ success: false, error: 'SERVER_ERROR', message: err.message });
  }
};

// PUT /api/v1/admin/purchases/orders/:poId
const updatePurchaseOrder = async (req, res) => {
  try {
    const { poId } = req.params;
    const { status, sentAt, invoiceNumber, invoiceDate, notes, items } = req.body || {};
    const ref = db().collection('purchaseOrders').doc(poId);
    const doc = await ref.get();
    if (!doc.exists) {
      return res.status(404).json({ success: false, error: 'NOT_FOUND', message: 'Purchase order not found' });
    }
    const current = doc.data();
    const now = new Date().toISOString();
    const update = {};

    if (status && status !== current.status) {
      if (!PO_STATUSES.includes(status)) {
        return res.status(400).json({ success: false, error: 'INVALID_STATUS', message: `status must be one of ${PO_STATUSES.join(', ')}` });
      }
      const allowed = ALLOWED_TRANSITIONS[current.status] || [];
      if (!allowed.includes(status)) {
        return res.status(400).json({
          success: false, error: 'INVALID_TRANSITION',
          message: `Cannot move a ${current.status} PO to ${status}`,
        });
      }
      // Receiving is the only transition that must carry evidence: without an
      // invoice number there is nothing to reconcile the delivery against.
      if (status === 'received' && !String(invoiceNumber || '').trim()) {
        return res.status(400).json({
          success: false, error: 'MISSING_INVOICE_NUMBER',
          message: 'Invoice number is required to mark a PO as received',
        });
      }
      update.status = status;
      if (status === 'sent') update.sentAt = sentAt || now;
      if (status === 'received') update.receivedAt = now;
      if (status === 'cancelled') update.cancelledAt = now;
    } else if (sentAt) {
      update.sentAt = sentAt;
    }

    if (invoiceNumber !== undefined) update.invoiceNumber = invoiceNumber || null;
    if (invoiceDate !== undefined) update.invoiceDate = invoiceDate || null;
    if (notes !== undefined) update.notes = notes;

    // Received quantities are merged by itemId so a partial payload can't drop
    // the rest of the line items.
    if (Array.isArray(items)) {
      const byId = new Map(items.map(i => [i.itemId, i]));
      update.items = (current.items || []).map(existing => {
        const incoming = byId.get(existing.itemId);
        if (!incoming) return existing;
        return {
          ...existing,
          receivedQty: incoming.receivedQty === undefined || incoming.receivedQty === null
            ? existing.receivedQty
            : toNumber(incoming.receivedQty),
        };
      });
    }

    await ref.update(update);
    const updated = await ref.get();
    res.json({ success: true, data: { poId, ...updated.data() } });
  } catch (err) {
    req.log?.error?.({ err: err.message }, 'update purchase order failed');
    res.status(500).json({ success: false, error: 'SERVER_ERROR', message: err.message });
  }
};

// ── VENDOR SCHEDULE ───────────────────────────────────────

// GET /api/v1/admin/purchases/vendors/schedule
const getVendorSchedules = async (req, res) => {
  try {
    const [contacts, schedules] = await Promise.all([
      zohoGetAll('/inventory/v1/contacts', { contact_type: 'vendor' }, req.traceContext, 'zoho.api.listVendors', 'contacts'),
      readVendorSchedules(),
    ]);

    const vendors = contacts.map(c => {
      const s = schedules[c.contact_id] || {};
      return {
        vendorId: c.contact_id,
        vendorName: c.contact_name || c.company_name || '',
        // Zoho exposes the number under several keys depending on how the
        // contact was created; the schedule doc wins if an admin set one.
        vendorPhone: s.vendorPhone || c.mobile || c.phone || null,
        dayOfWeek: s.dayOfWeek ?? null,
        isActive: s.isActive !== false,
        lastCheckedAt: s.lastCheckedAt || null,
      };
    });

    res.json({ success: true, data: { vendors, totalVendors: vendors.length } });
  } catch (err) {
    req.log?.error?.({ err: err.response?.data || err.message }, 'vendor schedule fetch failed');
    res.status(500).json({ success: false, error: 'SERVER_ERROR', message: err.message });
  }
};

// POST /api/v1/admin/purchases/vendors/schedule
const upsertVendorSchedule = async (req, res) => {
  try {
    const { vendorId, vendorName, vendorPhone, dayOfWeek, isActive } = req.body || {};
    if (!vendorId) {
      return res.status(400).json({ success: false, error: 'MISSING_PARAM', message: 'vendorId is required' });
    }
    if (dayOfWeek !== null && dayOfWeek !== undefined && !(Number.isInteger(dayOfWeek) && dayOfWeek >= 0 && dayOfWeek <= 6)) {
      return res.status(400).json({ success: false, error: 'INVALID_PARAM', message: 'dayOfWeek must be 0-6 or null' });
    }

    const update = {};
    if (vendorName !== undefined) update.vendorName = vendorName;
    if (vendorPhone !== undefined) update.vendorPhone = vendorPhone || null;
    if (dayOfWeek !== undefined) update.dayOfWeek = dayOfWeek;
    if (isActive !== undefined) update.isActive = Boolean(isActive);

    await db().collection('vendorSchedule').doc(vendorId).set(update, { merge: true });
    res.json({ success: true, data: { vendorId, ...update } });
  } catch (err) {
    res.status(500).json({ success: false, error: 'SERVER_ERROR', message: err.message });
  }
};

// ── CHECKLIST ─────────────────────────────────────────────

// Firestore document paths must have an even number of segments, so a checklist
// entry lives at purchaseChecklist/{date}/vendors/{vendorId} rather than a
// three-segment path (which Firestore would read as a collection).
function checklistDoc(dateKey, vendorId) {
  return db().collection('purchaseChecklist').doc(dateKey).collection('vendors').doc(vendorId);
}

// GET /api/v1/admin/purchases/checklist?date=YYYY-MM-DD
const getChecklist = async (req, res) => {
  try {
    const dateKey = req.query.date || istDateKey();
    const dow = dayOfWeekFor(dateKey);
    if (dow === null) {
      return res.status(400).json({ success: false, error: 'INVALID_PARAM', message: 'date must be YYYY-MM-DD' });
    }

    const schedules = await readVendorSchedules();
    const due = Object.values(schedules).filter(s => s.dayOfWeek === dow && s.isActive !== false);

    const counts = await lowStockCountsByVendor(req.traceContext).catch(() => ({}));
    const entriesSnap = await db().collection('purchaseChecklist').doc(dateKey).collection('vendors').get();
    const entries = {};
    entriesSnap.forEach(d => { entries[d.id] = d.data(); });

    const vendors = due.map(s => {
      const e = entries[s.vendorId] || {};
      return {
        vendorId: s.vendorId,
        vendorName: s.vendorName || '',
        vendorPhone: s.vendorPhone || null,
        dayOfWeek: s.dayOfWeek,
        checkedAt: e.checkedAt || null,
        checkedBy: e.checkedBy || null,
        poCreated: Boolean(e.poCreated),
        poId: e.poId || null,
        poNumber: e.poNumber || null,
        skipped: Boolean(e.skipped),
        skipReason: e.skipReason || null,
        lowStockCount: counts[s.vendorId] ?? 0,
      };
    });

    res.json({
      success: true,
      data: { date: dateKey, dayName: DAY_NAMES[dow], vendors, totalScheduled: vendors.length },
    });
  } catch (err) {
    req.log?.error?.({ err: err.message }, 'checklist fetch failed');
    res.status(500).json({ success: false, error: 'SERVER_ERROR', message: err.message });
  }
};

// POST /api/v1/admin/purchases/checklist/:vendorId/check
const checkVendor = async (req, res) => {
  try {
    const { vendorId } = req.params;
    const { date, skipped, skipReason, poId, poNumber } = req.body || {};
    const dateKey = date || istDateKey();
    if (dayOfWeekFor(dateKey) === null) {
      return res.status(400).json({ success: false, error: 'INVALID_PARAM', message: 'date must be YYYY-MM-DD' });
    }

    const now = new Date().toISOString();
    const entry = {
      checkedAt: now,
      checkedBy: 'admin',
      skipped: Boolean(skipped),
      skipReason: skipped ? (skipReason || 'Other') : null,
    };
    if (poId) { entry.poCreated = true; entry.poId = poId; entry.poNumber = poNumber || null; }

    await checklistDoc(dateKey, vendorId).set(entry, { merge: true });
    // Mirrored onto the schedule so the vendor table can show "last checked"
    // without scanning the per-day subcollections.
    await db().collection('vendorSchedule').doc(vendorId).set({ lastCheckedAt: now }, { merge: true });

    res.json({ success: true, data: { vendorId, date: dateKey, ...entry } });
  } catch (err) {
    res.status(500).json({ success: false, error: 'SERVER_ERROR', message: err.message });
  }
};

// GET /api/v1/admin/purchases/checklist/history?days=28
const getChecklistHistory = async (req, res) => {
  try {
    const days = Math.min(Math.max(toNumber(req.query.days, 28), 1), 60);
    const schedules = await readVendorSchedules();

    const dates = [];
    for (let i = days - 1; i >= 0; i--) {
      dates.push(istDateKey(new Date(Date.now() - i * 86400000)));
    }

    const perDate = await Promise.all(dates.map(async (d) => {
      const snap = await db().collection('purchaseChecklist').doc(d).collection('vendors').get();
      const map = {};
      snap.forEach(doc => { map[doc.id] = doc.data(); });
      return [d, map];
    }));
    const byDate = Object.fromEntries(perDate);

    // One row per scheduled vendor; each cell says what happened that day.
    // 'not-scheduled' is distinct from 'missed' so a quiet Tuesday for a Monday
    // vendor doesn't read as a lapse.
    const vendors = Object.values(schedules).map(s => ({
      vendorId: s.vendorId,
      vendorName: s.vendorName || '',
      dayOfWeek: s.dayOfWeek ?? null,
      cells: dates.map(d => {
        const scheduled = s.dayOfWeek !== null && s.dayOfWeek !== undefined && dayOfWeekFor(d) === s.dayOfWeek;
        if (!scheduled) return { date: d, state: 'not-scheduled' };
        const e = byDate[d][s.vendorId];
        if (!e) return { date: d, state: 'missed' };
        return { date: d, state: e.skipped ? 'skipped' : 'checked', skipReason: e.skipReason || null };
      }),
    }));

    res.json({ success: true, data: { dates, vendors } });
  } catch (err) {
    res.status(500).json({ success: false, error: 'SERVER_ERROR', message: err.message });
  }
};

module.exports = {
  getLowStock,
  createPurchaseOrder,
  listPurchaseOrders,
  getPurchaseOrder,
  updatePurchaseOrder,
  getVendorSchedules,
  upsertVendorSchedule,
  getChecklist,
  checkVendor,
  getChecklistHistory,
};
