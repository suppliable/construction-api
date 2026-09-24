'use strict';

// Bulk Orders & Quotes — HTTP layer for stages 1 and 2.
//
// Availability and the catalogue are deliberately unauthenticated: a guest hits
// /availability before ever logging in, and if it 401s nobody can reach bulk at
// all, because the pincode check is what routes them there.

const bulkService = require('../services/bulkService');
const { getAddressById, getCustomer } = require('../services/firestoreService');

function sendError(res, err, log) {
  if (err && err.statusCode) {
    return res.status(err.statusCode).json({ success: false, error: err.code, message: err.message });
  }
  if (log) log.error({ err: err.message }, 'bulk.controller.failed');
  return res.status(500).json({ success: false, error: 'SERVER_ERROR', message: err.message });
}

// GET /api/v1/bulk/availability?pincode= — public
async function getAvailability(req, res) {
  try {
    const data = await bulkService.getAvailability(req.query.pincode, req.traceContext);
    res.json({ success: true, data });
  } catch (err) { sendError(res, err, req.log); }
}

// GET /api/v1/bulk/categories — public
async function listCategories(req, res) {
  try {
    const categories = await bulkService.listCategories(req.traceContext);
    res.json({ success: true, data: { categories } });
  } catch (err) { sendError(res, err, req.log); }
}

// GET /api/v1/bulk/categories/:id/products?search= — public
async function listCategoryProducts(req, res) {
  try {
    const products = await bulkService.listCategoryProducts(
      req.params.id, req.query.search, req.traceContext
    );
    res.json({ success: true, data: { products } });
  } catch (err) { sendError(res, err, req.log); }
}

// POST /api/v1/bulk/photos — authenticated
async function createPhotoSlot(req, res) {
  try {
    const { fileName, contentType, sizeBytes } = req.body || {};
    const data = await bulkService.createPhotoSlot(
      { userId: req.user.uid, fileName, contentType, sizeBytes }, req.traceContext
    );
    res.status(201).json({ success: true, data });
  } catch (err) { sendError(res, err, req.log); }
}

// POST /api/v1/bulk/quote-requests — authenticated
async function createQuoteRequest(req, res) {
  try {
    const { source, items, note, addressId, photoIds } = req.body || {};

    // Resolve the site address here so the quote carries a readable address and
    // pincode for whoever prices it. Bulk addresses sit outside instant-delivery
    // pincodes by definition, so this must not apply a serviceability gate.
    let address = null;
    if (addressId) {
      address = await getAddressById(addressId, req.traceContext).catch(() => null);
    }

    const quote = await bulkService.createQuoteRequest({
      userId: req.user.uid,
      source,
      items,
      note,
      addressId,
      photoIds,
      address,
    }, req.traceContext);

    res.status(201).json({ success: true, data: { quote, requestId: quote.id } });
  } catch (err) { sendError(res, err, req.log); }
}

// GET /api/v1/bulk/quotes?cursor=&limit= — authenticated
// Newest first. `nextCursor` is the id to pass back for the following page; a
// client that ignores it simply shows the most recent page.
async function listQuotes(req, res) {
  try {
    const data = await bulkService.listQuotes(
      req.user.uid,
      { limit: req.query.limit, cursor: req.query.cursor },
      req.traceContext
    );
    res.json({ success: true, data });
  } catch (err) { sendError(res, err, req.log); }
}

// GET /api/v1/bulk/quotes/:id — authenticated
async function getQuote(req, res) {
  try {
    const quote = await bulkService.getQuote(req.user.uid, req.params.id, req.traceContext);
    res.json({ success: true, data: { quote } });
  } catch (err) { sendError(res, err, req.log); }
}

// POST /api/v1/bulk/quotes/:id/edit-request — authenticated
async function requestEdit(req, res) {
  try {
    const quote = await bulkService.requestEdit(
      req.user.uid, req.params.id, req.body?.message, req.traceContext
    );
    res.json({ success: true, data: { quote } });
  } catch (err) { sendError(res, err, req.log); }
}

// POST /api/v1/bulk/quotes/:id/decline — authenticated
async function declineQuote(req, res) {
  try {
    const quote = await bulkService.declineQuote(
      req.user.uid, req.params.id, req.body?.reason, req.traceContext
    );
    res.json({ success: true, data: { quote } });
  } catch (err) { sendError(res, err, req.log); }
}

// POST /api/v1/bulk/quotes/:id/approve — authenticated, idempotent
//
// Returns a payment session in the same shape as /payments/checkout. No order
// exists until payment confirms; the client then calls /payments/verify with
// the returned orderId exactly as it does for an instant order.
async function approveQuote(req, res) {
  try {
    const customer = await getCustomer(req.user.uid, req.traceContext).catch(() => null);
    const data = await bulkService.approveQuote(req.user.uid, req.params.id, {
      customerName: req.user.name || customer?.name || '',
      customerPhone: req.user.phone || customer?.phone || '',
      customerEmail: req.user.email || customer?.email || '',
    }, req.traceContext);
    res.json({ success: true, data });
  } catch (err) { sendError(res, err, req.log); }
}

module.exports = {
  getAvailability,
  listCategories,
  listCategoryProducts,
  createPhotoSlot,
  createQuoteRequest,
  listQuotes,
  getQuote,
  requestEdit,
  declineQuote,
  approveQuote,
};
