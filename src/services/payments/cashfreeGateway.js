'use strict';

const axios = require('axios');
const crypto = require('crypto');
const env = require('../../config/env');
const logger = require('../../utils/logger');
const { withRetry, DEFAULT_TIMEOUT_MS } = require('../../utils/httpClient');
const { ExternalServiceError } = require('../../utils/errors');

const API_VERSION = '2023-08-01';

function baseUrl() {
  return env.CASHFREE_ENV === 'production'
    ? 'https://api.cashfree.com/pg'
    : 'https://sandbox.cashfree.com/pg';
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

// Payment Link statuses → our normalized status. Link statuses on Cashfree PG:
// ACTIVE | PAID | PARTIALLY_PAID | EXPIRED | CANCELLED.
//
// NOTE: a *single failed payment attempt* does NOT change the link status — the
// link stays ACTIVE so the customer can retry until it expires. So ACTIVE alone
// can't distinguish "no attempt yet / in-flight" from "last attempt failed".
// fetchStatus disambiguates by also inspecting the per-attempt payment status
// (see classifyAttempts) before falling back to this link-level mapping.
function normalizeLinkStatus(linkStatus) {
  switch (linkStatus) {
    case 'PAID':
      return 'PAID';
    case 'ACTIVE':
    case 'PARTIALLY_PAID':
      return 'PENDING';
    case 'EXPIRED':
    case 'CANCELLED':
      return 'FAILED';
    default:
      return 'PENDING';
  }
}

// Per-attempt payment_status values on Cashfree link payments:
// SUCCESS | FAILED | USER_DROPPED | PENDING | NOT_ATTEMPTED | CANCELLED | FLAGGED.
// Returns 'PAID' | 'FAILED' | 'PENDING' | null (null = no decisive signal; the
// caller should fall back to the link-level status).
function classifyAttempts(payments) {
  if (!Array.isArray(payments) || payments.length === 0) return null;

  // A success anywhere wins (covers the rare case where the link status hasn't
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
  // this attempt failed. The link is still ACTIVE for retry, but we surface the
  // failure so the client shows a retry prompt instead of "confirming…".
  if (payments.some(p =>
    p.payment_status === 'FAILED' ||
    p.payment_status === 'USER_DROPPED' ||
    p.payment_status === 'CANCELLED')) {
    return 'FAILED';
  }

  return null;
}

// Collect every payment attempt across all orders created under a link.
// Cashfree exposes this as two hops: GET /links/{id}/orders → [{ order_id }],
// then GET /orders/{order_id}/payments → [{ payment_status, ... }].
// (There is NO /links/{id}/payments endpoint — it 404s.)
//
// NOTE: a failed/dropped attempt on a link does not always materialize a
// queryable order synchronously; in that case this returns [] and the caller
// falls back to the link status. The authoritative failure signal is the
// PAYMENT_FAILED webhook (see verifyWebhook), not this lookup.
async function fetchAttempts(providerOrderId, log) {
  try {
    const ordersRes = await withRetry('payment.cashfree.fetch_link_orders', () =>
      axios.get(`${baseUrl()}/links/${encodeURIComponent(providerOrderId)}/orders`, {
        headers: headers(),
        timeout: DEFAULT_TIMEOUT_MS,
      })
    );
    const orders = Array.isArray(ordersRes.data) ? ordersRes.data : [];
    if (orders.length === 0) return [];

    const payments = [];
    for (const o of orders) {
      const oid = o.order_id;
      if (!oid) continue;
      try {
        const payRes = await axios.get(
          `${baseUrl()}/orders/${encodeURIComponent(oid)}/payments`,
          { headers: headers(), timeout: DEFAULT_TIMEOUT_MS }
        );
        if (Array.isArray(payRes.data)) payments.push(...payRes.data);
      } catch (payErr) {
        (log || logger).warn(
          { err: payErr.message, orderId: oid, providerOrderId },
          'cashfree.fetch_order_payments.failed');
      }
    }
    return payments;
  } catch (err) {
    // Non-fatal: if the lookup fails (e.g. 404 before any order exists), fall
    // back to the link-level status. Never let this break verification.
    const status = err.response && err.response.status;
    (log || logger).warn({ status, err: err.message, providerOrderId },
      'cashfree.fetch_link_orders.failed');
    return null;
  }
}

function normalizeEvent(type) {
  switch (type) {
    case 'PAYMENT_SUCCESS_WEBHOOK':
    case 'PAYMENT_LINK_EVENT': // legacy
      return 'PAYMENT_SUCCESS';
    case 'PAYMENT_FAILED_WEBHOOK':
    case 'PAYMENT_USER_DROPPED_WEBHOOK':
      return 'PAYMENT_FAILED';
    default:
      return 'OTHER';
  }
}

// Cashfree link_id allows alphanumeric + '-' + '_' (max 50 chars) and must be
// unique per merchant. First attempt uses the orderId verbatim; subsequent
// attempts (only created when a prior link is in a terminal state) append
// `-r<n>` so the audit trail stays human-readable: ORD1234, ORD1234-r2, etc.
function buildLinkId(orderId, attemptCount = 0) {
  const cleaned = orderId.replace(/[^A-Za-z0-9_-]/g, '');
  const suffix = attemptCount > 0 ? `-r${attemptCount + 1}` : '';
  return cleaned.slice(0, 50 - suffix.length) + suffix;
}

async function createCheckout({ orderId, amountInPaise, currency, customer, returnUrl, notifyUrl, attemptCount = 0 }) {
  const linkId = buildLinkId(orderId, attemptCount);
  const body = {
    link_id: linkId,
    link_amount: paiseToRupees(amountInPaise),
    link_currency: currency || 'INR',
    link_purpose: `Order ${orderId}`,
    customer_details: {
      customer_phone: customer.customerPhone,
      ...(customer.customerName ? { customer_name: customer.customerName } : {}),
      ...(customer.customerEmail ? { customer_email: customer.customerEmail } : {}),
    },
    link_meta: {
      return_url: returnUrl,
      notify_url: notifyUrl,
    },
    link_notify: {
      send_sms: false,
      send_email: false,
    },
    // Tight expiry — this link is only used during a single checkout session.
    link_expiry_time: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
  };

  try {
    const res = await withRetry('payment.cashfree.create_link', () =>
      axios.post(`${baseUrl()}/links`, body, { headers: headers(), timeout: DEFAULT_TIMEOUT_MS })
    );
    const data = res.data || {};
    if (!data.link_url || !data.link_id) {
      throw new ExternalServiceError('Cashfree response missing link_url/link_id', 'CASHFREE_BAD_RESPONSE');
    }
    return {
      // Use link_id as the providerOrderId — what we'll look up later in fetchStatus.
      providerOrderId: data.link_id,
      paymentUrl: data.link_url,
      providerRaw: {
        cfLinkId: data.cf_link_id,
        linkExpiryTime: data.link_expiry_time,
        paymentUrl: data.link_url, // cached so we can reuse without re-deriving
      },
    };
  } catch (err) {
    if (err instanceof ExternalServiceError) throw err;
    const status = err.response && err.response.status;
    const body = err.response && err.response.data;
    logger.warn({ status, body, err: err.message }, 'cashfree.create_link.failed');
    throw new ExternalServiceError(
      `Cashfree createCheckout failed: ${err.message}`,
      'CASHFREE_CREATE_FAILED'
    );
  }
}

async function fetchStatus({ providerOrderId }) {
  try {
    const res = await withRetry('payment.cashfree.fetch_link', () =>
      axios.get(`${baseUrl()}/links/${encodeURIComponent(providerOrderId)}`, {
        headers: headers(),
        timeout: DEFAULT_TIMEOUT_MS,
      })
    );
    const data = res.data || {};
    const linkStatus = normalizeLinkStatus(data.link_status);

    // Link is terminal (PAID/EXPIRED/CANCELLED) → trust it directly.
    if (data.link_status === 'PAID' ||
        data.link_status === 'EXPIRED' ||
        data.link_status === 'CANCELLED') {
      return {
        status: linkStatus,
        rawProviderStatus: data.link_status,
        amountInPaise: Math.round(Number(data.link_amount || 0) * 100),
      };
    }

    // Link still ACTIVE → could be "no attempt yet", "in-flight", or "last
    // attempt failed" (the link stays ACTIVE for retry). Inspect the per-attempt
    // status to tell an explicit failure apart from a genuinely pending payment.
    const payments = await fetchAttempts(providerOrderId);
    const attemptStatus = classifyAttempts(payments);
    const effective = attemptStatus || linkStatus;
    const lastAttempt = Array.isArray(payments) && payments.length
      ? payments[payments.length - 1]
      : null;

    return {
      status: effective,
      // Surface the attempt-level status when it drove the decision; otherwise
      // the link status. Helps debugging in the order's payment.attempts[] log.
      rawProviderStatus: attemptStatus && lastAttempt
        ? lastAttempt.payment_status
        : data.link_status,
      amountInPaise: Math.round(Number(data.link_amount || 0) * 100),
    };
  } catch (err) {
    const status = err.response && err.response.status;
    const body = err.response && err.response.data;
    logger.warn({ status, body, err: err.message, providerOrderId }, 'cashfree.fetch_link.failed');
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
  // For payment webhooks on a LINK, order.order_id is Cashfree's synthetic
  // payment-order id (e.g. "CFPay_..._<ts>") — NOT our order id. Our id is the
  // link_id, surfaced under order.order_tags.link_id. Prioritize that.
  // entity_id / top-level link_id / order_id are kept as fallbacks for other
  // event shapes (e.g. PAYMENT_LINK_EVENT) and defensiveness.
  const providerOrderId =
    (order.order_tags && order.order_tags.link_id) ||
    order.link_id ||
    order.entity_id ||
    order.order_id;
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
