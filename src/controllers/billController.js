'use strict';

// Vendor bill entry. Mounted behind the admin-token gate in routes/admin.js.

const billService = require('../services/billService');
const { zohoGet } = require('../services/zohoHttp');
const { getSyncState } = require('../repositories/purchaseHistoryRepository');

function sendError(res, err, log, label) {
  if (err && err.statusCode) {
    return res.status(err.statusCode).json({ success: false, error: err.code, message: err.message });
  }
  if (log) log.error({ err: err.response?.data || err.message }, label);
  // Zoho's own message is the useful one here ("bill number already exists"),
  // and this route is admin-only, so it is passed through rather than hidden.
  return res.status(500).json({
    success: false,
    error: 'SERVER_ERROR',
    message: err.response?.data?.message || err.message,
  });
}

// GET /api/v1/admin/bills/vendors
const listVendors = async (req, res) => {
  try {
    const all = [];
    let page = 1;
    for (;;) {
      // Sequential: paging is inherently so, and vendor counts are small.
      const r = await zohoGet('https://www.zohoapis.in/books/v3/contacts', {
        params: { contact_type: 'vendor', per_page: 200, page },
        label: 'zoho.api.listVendors',
      });
      all.push(...(r.data.contacts || []));
      if (!r.data.page_context?.has_more_page) break;
      page += 1;
    }
    const vendors = all
      .filter(c => c.status !== 'inactive')
      .map(c => ({ vendorId: c.contact_id, name: c.contact_name || c.company_name || '' }))
      .sort((a, b) => a.name.localeCompare(b.name));
    res.json({ success: true, data: { vendors } });
  } catch (err) {
    sendError(res, err, req.log, 'listVendors failed');
  }
};

// POST /api/v1/admin/bills/preview
// Totals and per-line margins without writing anything, so the form can show
// what Zoho will record before anyone commits to it.
const previewBill = async (req, res) => {
  try {
    const bill = billService.assembleBill(req.body || {});
    const itemsById = new Map(
      (Array.isArray(req.body?.items) ? req.body.items : [])
        .map(i => [String(i.itemId), i])
    );
    res.json({
      success: true,
      data: {
        totals: billService.billTotals(bill),
        lines: billService.lineMargins(bill, itemsById),
      },
    });
  } catch (err) {
    sendError(res, err, req.log, 'previewBill failed');
  }
};

// POST /api/v1/admin/bills
const createBill = async (req, res) => {
  try {
    const bill = await billService.createBill(req.body || {}, req.traceContext);
    res.status(201).json({ success: true, data: bill });
  } catch (err) {
    sendError(res, err, req.log, 'createBill failed');
  }
};

// GET /api/v1/admin/bills/sync-state — when purchase history was last refreshed.
const syncState = async (req, res) => {
  try {
    res.json({ success: true, data: await getSyncState(req.traceContext) });
  } catch (err) {
    sendError(res, err, req.log, 'syncState failed');
  }
};

module.exports = { listVendors, previewBill, createBill, syncState };
