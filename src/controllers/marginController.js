'use strict';

// Margin report: what each item last cost against what it sells for.
//
// Mounted behind the admin-token gate in routes/admin.js.

const repo = require('../repositories/purchaseHistoryRepository');
const { marginFor, syncFromBills } = require('../services/purchaseHistoryService');
const { getAllProducts } = require('../services/productService');
const { updateZohoItemRate } = require('../services/zohoService');
const { invalidateProducts } = require('../cache/invalidate');

function badRequest(res, message) {
  return res.status(400).json({ success: false, error: 'VALIDATION_ERROR', message });
}

// GET /api/v1/admin/margins?category=&vendor=&status=&q=
//
// The join is done in memory over the whole catalogue (~1k items) rather than
// as a filtered Firestore query, deliberately: it needs no composite index, and
// a missing index is a 500 rather than a slow page.
const listMargins = async (req, res) => {
  try {
    const { category, vendor, status, q } = req.query;
    if (status && !['underwater', 'ok', 'no_purchase', 'no_price'].includes(status)) {
      return badRequest(res, 'status must be underwater, ok, no_purchase or no_price');
    }

    const [products, history] = await Promise.all([
      // includeHidden: a counter-only item is still bought and still has a margin.
      getAllProducts(null, req.traceContext, { includeHidden: true }),
      repo.listAll(req.traceContext),
    ]);

    const byItem = new Map(history.map(h => [String(h.itemId), h]));

    // A grouped product prices per variant, so the comparison belongs on the
    // variant — that is what a bill line refers to.
    const rows = [];
    for (const p of products) {
      // Freight, loading and other charge lines are Zoho items but hold no
      // stock. Comparing a freight charge against a ₹1 placeholder "price"
      // produced a -1,257,212% row that buried the real findings.
      if (p.trackInventory === false) continue;

      const targets = p.hasVariants && Array.isArray(p.variants) && p.variants.length
        ? p.variants.map(v => ({ id: v.id, name: `${p.name} ${v.name || ''}`.trim(), rate: v.price }))
        : [{ id: p.id, name: p.name, rate: p.price }];

      for (const t of targets) {
        const h = byItem.get(String(t.id)) || null;
        const m = marginFor({ rate: t.rate }, h);
        rows.push({
          itemId: t.id,
          name: t.name,
          category: p.category || '',
          unit: p.unit || '',
          vendorName: h?.vendorName || '',
          lastBillNumber: h?.lastBillNumber || null,
          lastPurchaseDate: h?.lastDate || null,
          lastPurchaseExcl: h?.rateExcl ?? null,
          lastPurchaseIncl: m.buyIncl,
          // So a discounted cost is explicable rather than looking mistyped.
          grossPurchaseIncl: h?.grossRateIncl ?? null,
          discountPct: h?.discountPct ?? 0,
          gstRate: h?.gstRate ?? p.gst_percentage ?? null,
          sellingIncl: m.sellIncl,
          marginValue: m.marginValue,
          marginPct: m.marginPct,
          status: m.status,
        });
      }
    }

    const needle = String(q || '').trim().toLowerCase();
    const filtered = rows.filter(r =>
      (!category || r.category.toLowerCase() === String(category).toLowerCase()) &&
      (!vendor || r.vendorName.toLowerCase() === String(vendor).toLowerCase()) &&
      (!status || r.status === status) &&
      (!needle || r.name.toLowerCase().includes(needle))
    );

    // Worst first: underwater items are the reason to open this page. Rows with
    // no margin to report sort last rather than pretending to be zero.
    filtered.sort((a, b) => {
      if (a.marginPct === null && b.marginPct === null) return a.name.localeCompare(b.name);
      if (a.marginPct === null) return 1;
      if (b.marginPct === null) return -1;
      return a.marginPct - b.marginPct;
    });

    const summary = rows.reduce((acc, r) => { acc[r.status] = (acc[r.status] || 0) + 1; return acc; }, {});

    res.json({
      success: true,
      data: {
        rows: filtered,
        summary,
        categories: [...new Set(rows.map(r => r.category).filter(Boolean))].sort(),
        vendors: [...new Set(rows.map(r => r.vendorName).filter(Boolean))].sort(),
      },
    });
  } catch (err) {
    req.log?.error?.({ err: err.response?.data || err.message }, 'listMargins failed');
    res.status(500).json({ success: false, error: 'SERVER_ERROR', message: err.message });
  }
};

// POST /api/v1/admin/margins/sync?full=1
// Pulls new/changed Zoho bills into purchase history. Also driven by cron.
const syncMargins = async (req, res) => {
  try {
    const full = req.query.full === '1' || req.query.full === 'true';
    const result = await syncFromBills({ full }, req.traceContext);
    res.json({ success: true, data: result });
  } catch (err) {
    req.log?.error?.({ err: err.response?.data || err.message }, 'syncMargins failed');
    res.status(500).json({ success: false, error: 'SERVER_ERROR', message: err.message });
  }
};

// PUT /api/v1/admin/margins/:itemId/selling-price   body: { rate }
//
// The point of the report is that an underwater item needs its selling price
// raised; this makes that one click rather than a trip to Zoho. The new rate is
// GST-INCLUSIVE, like every other selling price in the system.
//
// Guarded, because this is the customer-facing price: a mistyped rate here is a
// live pricing error, not a report that looks odd.
const setSellingPrice = async (req, res) => {
  try {
    const { itemId } = req.params;
    const rate = Number(req.body?.rate);

    if (!itemId) return badRequest(res, 'itemId is required');
    if (!Number.isFinite(rate) || rate <= 0) {
      return badRequest(res, 'rate must be a number greater than zero');
    }

    // A selling price below what the item last cost is almost certainly a typo
    // — it is the exact situation this page exists to flag, so do not let the
    // fix re-create it silently.
    const history = await repo.getOne(itemId, req.traceContext);
    if (history && Number(history.rateIncl) > 0 && rate <= Number(history.rateIncl)) {
      return res.status(422).json({
        success: false,
        error: 'BELOW_LAST_PURCHASE',
        message: `₹${rate} is not above the last purchase price of ₹${history.rateIncl} `
          + `(incl. GST, bill ${history.lastBillNumber || '—'}). Enter a higher price.`,
      });
    }

    const item = await updateZohoItemRate(itemId, rate, req.traceContext);
    await invalidateProducts().catch(() => {});

    res.json({
      success: true,
      data: { itemId, rate: Number(item?.rate ?? rate), name: item?.name || null },
    });
  } catch (err) {
    req.log?.error?.({ err: err.response?.data || err.message, itemId: req.params.itemId }, 'setSellingPrice failed');
    res.status(500).json({
      success: false,
      error: 'SERVER_ERROR',
      message: err.response?.data?.message || err.message,
    });
  }
};

module.exports = { listMargins, syncMargins, setSellingPrice };
