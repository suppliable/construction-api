'use strict';

const express = require('express');
const router = express.Router();
const authenticate = require('../middleware/auth');
const { idempotency } = require('../middleware/idempotency');
const {
  createSession,
  verifyPayment,
  handleWebhook,
  paymentReturn,
  checkout,
} = require('../controllers/paymentController');

// Public — Cashfree redirect lands here on payment completion. Flutter's WebView
// intercepts this URL prefix BEFORE it loads and pops back to the app. This route
// is only rendered as a fallback if interception fails for any reason.
router.get('/return', paymentReturn);

// Public — Cashfree posts webhooks here. Signature is verified inside the
// controller via the gateway adapter; no auth middleware.
router.post('/webhook/:gateway', handleWebhook);

// Authenticated — customer-initiated.
router.post('/checkout', authenticate, idempotency(), checkout);
router.post('/session', authenticate, idempotency(), createSession);
router.post('/verify', authenticate, verifyPayment);

module.exports = router;
