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
    return {
      status: normalizeLinkStatus(data.link_status),
      rawProviderStatus: data.link_status,
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
  // Payment webhooks for a link carry the link_id in order.entity_id (link_id) — but
  // for safety, fall back to order.order_id (which Cashfree sets equal to link_id
  // when a payment is made against a link).
  const providerOrderId = order.entity_id || order.order_id || order.link_id;
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
