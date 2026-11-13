'use strict';

// Margin report: what each item last cost against what it sells for.
//
// Mounted behind the admin-token gate in routes/admin.js.

const repo = require('../repositories/purchaseHistoryRepository');
const { marginFor, syncFromBills } = require('../services/purchaseHistoryService');
const { getAllProducts } = require('../services/productService');

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

module.exports = { listMargins, syncMargins };
