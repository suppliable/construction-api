'use strict';

// Bulk Orders — admin side.
//
// Two jobs here:
//   1. The catalogue overlay. Bulk products themselves are Zoho items with the
//      cf_bulk checkbox, so there is nothing to create or edit — only the
//      per-category minimum order value, which Zoho has no concept of.
//   2. The quote console: read what a customer asked for, price it, publish.
//      Nothing reaches a customer without this step.

const bulkService = require('../services/bulkService');
const bulkRepo = require('../repositories/bulkRepository');
const { invalidateBulkCatalogue } = require('../cache/invalidate');
const { getCustomer } = require('../services/firestoreService');
const fcm = require('../services/fcmService');

function badRequest(res, message) {
  return res.status(400).json({ success: false, error: 'VALIDATION_ERROR', message });
}

function sendError(res, err, log) {
  if (err && err.statusCode) {
    return res.status(err.statusCode).json({ success: false, error: err.code, message: err.message });
  }
  if (log) log.error({ err: err.message }, 'bulk.admin.failed');
  return res.status(500).json({ success: false, error: 'SERVER_ERROR', message: err.message });
}

function parseMoney(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) / 100 : null;
}

// ---- catalogue ----

// Categories are derived from the Zoho categories of bulk-flagged items, then
// joined with the Firestore overlay. Unlike the customer endpoint this includes
// categories whose overlay is switched off, so they can be switched back on.
const listCategories = async (req, res) => {
  try {
    const [products, overlays] = await Promise.all([
      bulkService.getBulkProducts(req.traceContext),
      bulkRepo.listCategoryOverlays(req.traceContext),
    ]);
    const overlayById = new Map(overlays.map(o => [o.id, o]));

    const byId = new Map();
    for (const p of products) {
      const id = bulkService.categorySlug(p.category);
      if (!byId.has(id)) byId.set(id, { id, zohoName: p.category || 'Uncategorised', productCount: 0 });
      byId.get(id).productCount++;
    }

    const categories = [...byId.values()].map(c => {
      const o = overlayById.get(c.id) || {};
      return {
        id: c.id,
        name: o.name || c.zohoName,
        zohoName: c.zohoName,
        iconKey: o.iconKey || null,
        minOrderValue: Number(o.minOrderValue ?? 0),
        sortOrder: o.sortOrder ?? 999,
        active: o.active !== false,
        productCount: c.productCount,
        configured: !!overlayById.get(c.id),
      };
    }).sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));

    res.json({ success: true, data: { categories } });
  } catch (err) { sendError(res, err, req.log); }
};

const saveCategory = async (req, res) => {
  try {
    const { id, name, iconKey, minOrderValue, sortOrder, active } = req.body || {};
    if (!id) return badRequest(res, 'Category id is required');

    const min = parseMoney(minOrderValue);
    if (min === null) return badRequest(res, 'Minimum order value must be 0 or more');

    const saved = await bulkRepo.setCategoryOverlay(id, {
      name: String(name || '').trim() || null,
      iconKey: String(iconKey || '').trim() || null,
      minOrderValue: min,
      sortOrder: Number.isFinite(Number(sortOrder)) ? Number(sortOrder) : 999,
      active: active !== false,
      updatedAt: new Date().toISOString(),
    }, req.traceContext);

    await invalidateBulkCatalogue().catch(() => {});
    res.json({ success: true, data: saved });
  } catch (err) { sendError(res, err, req.log); }
};

// Read-only: to add or remove a bulk product, tick cf_bulk on the Zoho item.
const listProducts = async (req, res) => {
  try {
    const products = await bulkService.getBulkProducts(req.traceContext);
    const categoryId = req.query.categoryId || null;
    const rows = products
      .filter(p => !categoryId || bulkService.categorySlug(p.category) === categoryId)
      .map(p => ({
        id: p.id,
        name: p.name,
        brand: p.brand || '',
        category: p.category || '',
        categoryId: bulkService.categorySlug(p.category),
        unit: p.unit || '',
        price: Number(p.price ?? 0),
        gstPercentage: Number(p.gst_percentage ?? 0),
        hsn: p.hsn || '',
        imageUrl: p.imageUrl || null,
      }))
      .sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name));

    res.json({ success: true, data: { products: rows } });
  } catch (err) { sendError(res, err, req.log); }
};

// ---- quote console ----

const listQuotes = async (req, res) => {
  try {
    const quotes = await bulkRepo.listQuotesForAdmin({
      status: req.query.status || null,
      limit: Math.min(200, Number(req.query.limit) || 50),
    }, req.traceContext);

    const rows = await Promise.all(quotes.map(async q => {
      const customer = q.userId ? await getCustomer(q.userId, req.traceContext).catch(() => null) : null;
      return {
        id: q.id,
        status: q.status,
        source: q.source,
        createdAt: q.createdAt,
        itemCount: (q.items || []).length,
        photoCount: (q.photos || []).length,
        grandTotal: q.grandTotal ?? 0,
        validUntil: q.validUntil || null,
        orderId: q.orderId || null,
        deliveryPincode: q.deliveryPincode || null,
        customerName: customer?.name || null,
        customerPhone: customer?.phone || null,
      };
    }));

    res.json({ success: true, data: { quotes: rows } });
  } catch (err) { sendError(res, err, req.log); }
};

const getQuote = async (req, res) => {
  try {
    const quote = await bulkRepo.getQuote(req.params.quoteId, req.traceContext);
    if (!quote) return res.status(404).json({ success: false, error: 'NOT_FOUND', message: 'Quote not found' });

    // Photo links are short-lived signed reads, so they are minted per view.
    const hydrated = await bulkService.hydratePhotos(quote);
    const customer = quote.userId ? await getCustomer(quote.userId, req.traceContext).catch(() => null) : null;

    res.json({
      success: true,
      data: {
        quote: {
          ...hydrated,
          // Internal-only; never sent to the customer app but useful here.
          photos: (hydrated.photos || []).map(p => ({ id: p.id, url: p.url })),
          customer: customer ? { name: customer.name, phone: customer.phone } : null,
        },
      },
    });
  } catch (err) { sendError(res, err, req.log); }
};

/**
 * Publish a priced quote. GST is computed per line from each item's Zoho tax
 * band, so a mixed quote is correct without anyone doing arithmetic.
 */
const publishQuote = async (req, res) => {
  try {
    const { items, deliveryCharge, validityDays, deliveryDate, teamNote } = req.body || {};
    const quote = await bulkService.publishQuote(req.params.quoteId, {
      items, deliveryCharge, validityDays, deliveryDate, teamNote,
    }, req.traceContext);

    // Tell the customer their quote is ready. Non-fatal: the quote is published
    // either way, and they will see it next time they open the app.
    if (quote.userId) {
      fcm.sendNotification(quote.userId, {
        title: 'Your quote is ready',
        body: `Quote ${quote.id} — ₹${Number(quote.grandTotal || 0).toLocaleString('en-IN')}`,
        data: { link: `/bulk/quotes/${quote.id}` },
      }).catch(e => req.log?.warn({ err: e.message }, '[FCM] quote-ready push failed (non-fatal)'));
    }

    res.json({ success: true, data: { quote } });
  } catch (err) { sendError(res, err, req.log); }
};

module.exports = {
  listCategories,
  saveCategory,
  listProducts,
  listQuotes,
  getQuote,
  publishQuote,
};
