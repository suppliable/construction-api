'use strict';

// Vendor bill entry. Mounted behind the admin-token gate in routes/admin.js.

const billService = require('../services/billService');
const { zohoGet } = require('../services/zohoHttp');
const { getSyncState } = require('../repositories/purchaseHistoryRepository');
const audit = require('../services/auditService');

function sendError(res, err, log, label) {
  if (err && err.statusCode) {
    return res.status(err.statusCode).json({ success: false, error: err.code, message: err.message });
  }

  // A Zoho rejection is a problem with what we sent, not a server fault, and
  // its message is the only thing that says what to change ("bill number
  // already exists", "invalid value for unit"). Returning 5xx hid it: the
  // sanitizeServerErrors middleware replaces every 5xx message with generic
  // copy, so the admin saw "Something went wrong" and the real reason stayed
  // in the logs. 422 keeps Zoho's own words on screen.
  const zoho = err?.response?.data;
  if (zoho && (zoho.code !== undefined || zoho.message)) {
    if (log) log.warn({ zohoCode: zoho.code, zohoMessage: zoho.message, payload: err.zohoPayload }, label);
    return res.status(422).json({
      success: false,
      error: 'ZOHO_REJECTED',
      message: zoho.message || 'Zoho rejected the bill',
      zohoCode: zoho.code ?? null,
    });
  }

  if (log) log.error({ err: err.message }, label);
  return res.status(500).json({ success: false, error: 'SERVER_ERROR', message: err.message });
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
    await audit.record(req, audit.ACTIONS.BILL_CREATED,
      { type: 'bill', id: bill.billId, name: bill.billNumber },
      null, { total: bill.total, vendor: bill.vendorName });
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
