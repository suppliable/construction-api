'use strict';

const axios = require('axios');
const crypto = require('crypto');
const env = require('../../config/env');
const logger = require('../../utils/logger');
const { withRetry, DEFAULT_TIMEOUT_MS } = require('../../utils/httpClient');
const { ExternalServiceError } = require('../../utils/errors');

const API_VERSION = '2023-08-01';

// API host (server-to-server). Switches on CASHFREE_ENV.
function baseUrl() {
  return env.CASHFREE_ENV === 'production'
    ? 'https://api.cashfree.com/pg'
    : 'https://sandbox.cashfree.com/pg';
}

// Hosted checkout host (where the WebView sends the customer). This is a
// DIFFERENT host from the API base — Orders API returns a payment_session_id,
// and the hosted page is reached at this URL with that id in the fragment.
function checkoutBaseUrl() {
  return env.CASHFREE_ENV === 'production'
    ? 'https://payments.cashfree.com'
    : 'https://payments-test.cashfree.com';
}

function headers() {
  return {
    'x-client-id': env.CASHFREE_APP_ID,
    'x-client-secret': env.CASHFREE_SECRET_KEY,
    'x-api-version': API_VERSION,
    'Content-Type': 'application/json',
  };
}

function paiseToRupees(paise) {
  return Math.round(paise) / 100;
}

// Order-level status on Cashfree PG Orders API:
// ACTIVE | PAID | EXPIRED | TERMINATED | TERMINATION_REQUESTED.
//
// NOTE: as with links, a *single failed payment attempt* does NOT move the order
// off ACTIVE — it stays ACTIVE so the customer can retry until it expires. So
// ACTIVE alone can't distinguish "no attempt yet / in-flight" from "last attempt
// failed". fetchStatus disambiguates by inspecting per-attempt payment status
// (classifyAttempts) before falling back to this order-level mapping.
function normalizeOrderStatus(orderStatus) {
  switch (orderStatus) {
    case 'PAID':
      return 'PAID';
    case 'ACTIVE':
      return 'PENDING';
    case 'EXPIRED':
    case 'TERMINATED':
    case 'TERMINATION_REQUESTED':
      return 'FAILED';
    default:
      return 'PENDING';
  }
}

// Per-attempt payment_status values on Cashfree:
// SUCCESS | FAILED | USER_DROPPED | PENDING | NOT_ATTEMPTED | CANCELLED | FLAGGED.
// Returns 'PAID' | 'FAILED' | 'PENDING' | null (null = no decisive signal; the
// caller should fall back to the order-level status).
function classifyAttempts(payments) {
  if (!Array.isArray(payments) || payments.length === 0) return null;

  // A success anywhere wins (covers the rare case where the order status hasn't
  // caught up to PAID yet).
  if (payments.some(p => p.payment_status === 'SUCCESS')) return 'PAID';

  // Anything still in flight → don't declare failure; wait for it to settle.
  if (payments.some(p =>
    p.payment_status === 'PENDING' ||
    p.payment_status === 'FLAGGED' ||
    p.payment_status === 'NOT_ATTEMPTED')) {
    return 'PENDING';
  }

  // No success, nothing in flight, but at least one explicit failure/drop →
  // this attempt failed. The order is still ACTIVE for retry, but we surface the
  // failure so the client shows a retry prompt instead of "confirming…".
  if (payments.some(p =>
    p.payment_status === 'FAILED' ||
    p.payment_status === 'USER_DROPPED' ||
    p.payment_status === 'CANCELLED')) {
    return 'FAILED';
  }

  return null;
}

// Fetch every payment attempt for an order. Orders API exposes this as a single
// hop: GET /orders/{order_id}/payments → [{ payment_status, ... }].
// Returns [] when no attempt exists yet, or null when the lookup itself failed
// (so the caller can fall back to the order-level status).
async function fetchAttempts(providerOrderId, log) {
  try {
    const res = await withRetry('payment.cashfree.fetch_order_payments', () =>
      axios.get(`${baseUrl()}/orders/${encodeURIComponent(providerOrderId)}/payments`, {
        headers: headers(),
        timeout: DEFAULT_TIMEOUT_MS,
      })
    );
    return Array.isArray(res.data) ? res.data : [];
  } catch (err) {
    // Non-fatal: if the lookup fails (e.g. 404 before any attempt exists), fall
    // back to the order-level status. Never let this break verification.
    const status = err.response && err.response.status;
    (log || logger).warn({ status, err: err.message, providerOrderId },
      'cashfree.fetch_order_payments.failed');
    return null;
  }
}

function normalizeEvent(type) {
  switch (type) {
    case 'PAYMENT_SUCCESS_WEBHOOK':
      return 'PAYMENT_SUCCESS';
    case 'PAYMENT_FAILED_WEBHOOK':
    case 'PAYMENT_USER_DROPPED_WEBHOOK':
      return 'PAYMENT_FAILED';
    default:
      return 'OTHER';
  }
}

async function createCheckout({ orderId, amountInPaise, currency, customer, returnUrl, notifyUrl }) {
  const body = {
    order_id: orderId,
    order_amount: paiseToRupees(amountInPaise),
    order_currency: currency || 'INR',
    customer_details: {
      customer_id: customer.customerId,
      customer_phone: customer.customerPhone,
      ...(customer.customerName ? { customer_name: customer.customerName } : {}),
      ...(customer.customerEmail ? { customer_email: customer.customerEmail } : {}),
    },
    order_meta: {
      return_url: returnUrl,
      notify_url: notifyUrl,
    },
    order_note: `Order ${orderId}`,
    // Tight expiry — this order is only used during a single checkout session.
    order_expiry_time: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
  };

  try {
    const res = await withRetry('payment.cashfree.create_order', () =>
      axios.post(`${baseUrl()}/orders`, body, { headers: headers(), timeout: DEFAULT_TIMEOUT_MS })
    );
    const data = res.data || {};
    if (!data.payment_session_id || !data.order_id) {
      throw new ExternalServiceError('Cashfree response missing payment_session_id/order_id', 'CASHFREE_BAD_RESPONSE');
    }
    const paymentUrl = `${checkoutBaseUrl()}/order/#${data.payment_session_id}`;
    return {
      // Use order_id as the providerOrderId — what we'll look up later in fetchStatus.
      providerOrderId: data.order_id,
      paymentUrl,
      providerRaw: {
        cfOrderId: data.cf_order_id,
        paymentSessionId: data.payment_session_id,
        orderExpiryTime: data.order_expiry_time,
        paymentUrl, // cached so we can reuse without re-deriving
      },
    };
  } catch (err) {
    if (err instanceof ExternalServiceError) throw err;
    const status = err.response && err.response.status;
    const body = err.response && err.response.data;
    logger.warn({ status, body, err: err.message }, 'cashfree.create_order.failed');
    throw new ExternalServiceError(
      `Cashfree createCheckout failed: ${err.message}`,
      'CASHFREE_CREATE_FAILED'
    );
  }
}

async function fetchStatus({ providerOrderId }) {
  try {
    const res = await withRetry('payment.cashfree.fetch_order', () =>
      axios.get(`${baseUrl()}/orders/${encodeURIComponent(providerOrderId)}`, {
        headers: headers(),
        timeout: DEFAULT_TIMEOUT_MS,
      })
    );
    const data = res.data || {};
    const orderStatus = normalizeOrderStatus(data.order_status);

    // Order is terminal (PAID/EXPIRED/TERMINATED) → trust it directly.
    if (data.order_status === 'PAID' ||
        data.order_status === 'EXPIRED' ||
        data.order_status === 'TERMINATED' ||
        data.order_status === 'TERMINATION_REQUESTED') {
      return {
        status: orderStatus,
        rawProviderStatus: data.order_status,
        amountInPaise: Math.round(Number(data.order_amount || 0) * 100),
      };
    }

    // Order still ACTIVE → could be "no attempt yet", "in-flight", or "last
    // attempt failed" (the order stays ACTIVE for retry). Inspect the per-attempt
    // status to tell an explicit failure apart from a genuinely pending payment.
    const payments = await fetchAttempts(providerOrderId);
    const attemptStatus = classifyAttempts(payments);
    const effective = attemptStatus || orderStatus;
    const lastAttempt = Array.isArray(payments) && payments.length
      ? payments[payments.length - 1]
      : null;

    return {
      status: effective,
      // Surface the attempt-level status when it drove the decision; otherwise
      // the order status. Helps debugging in the order's payment.attempts[] log.
      rawProviderStatus: attemptStatus && lastAttempt
        ? lastAttempt.payment_status
        : data.order_status,
      amountInPaise: Math.round(Number(data.order_amount || 0) * 100),
    };
  } catch (err) {
    const status = err.response && err.response.status;
    const body = err.response && err.response.data;
    logger.warn({ status, body, err: err.message, providerOrderId }, 'cashfree.fetch_order.failed');
    throw new ExternalServiceError(
      `Cashfree fetchStatus failed: ${err.message}`,
      'CASHFREE_FETCH_FAILED'
    );
  }
}

function verifyWebhook({ rawBody, headers: hdrs }) {
  const signature = hdrs['x-webhook-signature'] || hdrs['X-Webhook-Signature'];
  const timestamp = hdrs['x-webhook-timestamp'] || hdrs['X-Webhook-Timestamp'];
  if (!signature || !timestamp) {
    return { isValid: false, event: 'OTHER' };
  }
  const bodyStr = Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : String(rawBody);
  const expected = crypto
    .createHmac('sha256', env.CASHFREE_WEBHOOK_SECRET)
    .update(timestamp + bodyStr)
    .digest('base64');

  let isValid = false;
  try {
    isValid = crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  } catch {
    isValid = false;
  }
  if (!isValid) {
    return { isValid: false, event: 'OTHER' };
  }

  let parsed;
  try {
    parsed = JSON.parse(bodyStr);
  } catch {
    return { isValid: false, event: 'OTHER' };
  }
  const event = normalizeEvent(parsed.type);
  const order = (parsed.data && parsed.data.order) || {};
  const payment = (parsed.data && parsed.data.payment) || {};
  // On the Orders API, order.order_id IS our order id (we set it at creation) —
  // no order_tags/link_id indirection needed.
  const providerOrderId = order.order_id;
  return {
    isValid: true,
    event,
    providerOrderId,
    amountInPaise: order.order_amount != null ? Math.round(Number(order.order_amount) * 100) : undefined,
    rawEvent: { type: parsed.type, paymentStatus: payment.payment_status },
  };
}

module.exports = {
  name: 'cashfree',
  createCheckout,
  fetchStatus,
  verifyWebhook,
};
