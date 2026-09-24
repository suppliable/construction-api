'use strict';

// Bulk Orders & Quotes — /api/v1/bulk
//
// Stages 1 and 2 of the client handoff. Stage 3 (GET /quotes, /quotes/:id,
// edit-request, decline) and stage 4 (approve + payment session) are not built
// yet; the client picks mock vs live per Remote Config, so it can stay on the
// mock for those until they land.

const express = require('express');
const router = express.Router();
const authenticate = require('../middleware/auth');
const { cacheFor } = require('../cache/middleware');
const { CACHE_TTL_CATALOGUE_S } = require('../constants');
const {
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
} = require('../controllers/bulkController');
const { idempotency } = require('../middleware/idempotency');

// ── Public ────────────────────────────────────────────────────────────────────
// No auth: a guest checks a pincode before logging in, and the result is what
// routes them to bulk in the first place.
router.get('/availability', getAvailability);
router.get('/categories', cacheFor(CACHE_TTL_CATALOGUE_S, () => 'bulk:categories'), listCategories);
router.get(
  '/categories/:id/products',
  cacheFor(CACHE_TTL_CATALOGUE_S, req =>
    `bulk:products:${req.params.id}:${(req.query.search || '').trim().toLowerCase()}`),
  listCategoryProducts
);

// ── Authenticated ─────────────────────────────────────────────────────────────
router.post('/photos', authenticate, createPhotoSlot);
router.post('/quote-requests', authenticate, createQuoteRequest);
// Not cached: a customer's own quotes change as they are priced, and the list
// is small enough that a round trip is cheaper than stale data.
router.get('/quotes', authenticate, listQuotes);
router.get('/quotes/:id', authenticate, getQuote);
router.post('/quotes/:id/edit-request', authenticate, requestEdit);
router.post('/quotes/:id/decline', authenticate, declineQuote);
// Idempotent: the client sends X-Idempotency-Key: approve-<quoteId>, so a
// repeat returns the same session instead of minting a second one at the
// gateway. The middleware is opt-in on the header and already used by
// /payments/checkout.
router.post('/quotes/:id/approve', authenticate, idempotency(), approveQuote);

module.exports = router;
