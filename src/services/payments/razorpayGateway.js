'use strict';

const axios = require('axios');
const crypto = require('crypto');
const env = require('../../config/env');
const logger = require('../../utils/logger');
const { withRetry, DEFAULT_TIMEOUT_MS } = require('../../utils/httpClient');
const { ExternalServiceError } = require('../../utils/errors');

const BASE_URL = 'https://api.razorpay.com/v1';

function authHeader() {
  const creds = Buffer.from(`${env.RAZORPAY_KEY_ID}:${env.RAZORPAY_KEY_SECRET}`).toString('base64');
  return { Authorization: `Basic ${creds}` };
}

function paiseToRupees(paise) {
  return Math.round(paise);
}

// Razorpay prefills (and validates) the contact field only when it's a clean
// E.164 / 10-digit Indian number. A malformed value (spaces, leading 0, missing
// country code) is ignored → the hosted page shows an empty, editable field.
// Our users authenticate by phone so customerPhone is normally already
// "+91XXXXXXXXXX", but normalize defensively for any other source.
function normalizeContact(raw) {
  if (!raw) return undefined; // omit rather than send '' (Razorpay rejects empty)
  const digits = String(raw).replace(/[^\d]/g, ''); // strip +, spaces, dashes
  // 10-digit bare number → assume India.
  if (digits.length === 10) return `+91${digits}`;
  // 12-digit starting 91 (e.g. "919884857261") → add +.
  if (digits.length === 12 && digits.startsWith('91')) return `+${digits}`;
  // 11-digit starting 0 (e.g. "09884857261") → drop 0, assume India.
  if (digits.length === 11 && digits.startsWith('0')) return `+91${digits.slice(1)}`;
  // Already had a + and looks international → keep as-is (re-add the +).
  if (String(raw).trim().startsWith('+')) return `+${digits}`;
  // Anything else: pass the digits through; let Razorpay validate.
  return digits || undefined;
}

// Razorpay Orders API statuses → our normalized status.
// Order statuses: created | attempted | paid
// Payment statuses: created | authorized | captured | refunded | failed
function normalizeOrderStatus(orderStatus, payments) {
  if (orderStatus === 'paid') return 'PAID';

  if (payments.some(p => p.status === 'captured')) return 'PAID';

  const hasFailed = payments.some(p => p.status === 'failed');
  const hasInFlight = payments.some(p => p.status !== 'failed');
  if (hasFailed && !hasInFlight) return 'FAILED';

  return 'PENDING';
}

// Razorpay webhook events for the Orders API flow.
function normalizeEvent(event) {
  switch (event) {
    case 'payment.captured':
    case 'payment.authorized':
    case 'order.paid':
      return 'PAYMENT_SUCCESS';
    case 'payment.failed':
      return 'PAYMENT_FAILED';
    default:
      return 'OTHER';
  }
}

// Creates a Razorpay Order (order_xxx) via the Orders API.
// Returns providerOrderId, empty paymentUrl, and a client object the controller
// spreads into the session response for the Flutter SDK to consume directly.
async function createCheckout({ orderId, amountInPaise, currency, customer }) {
  const notes = { internalOrderId: String(orderId) };
  const body = {
    amount: amountInPaise, // Orders API takes paise
    currency: currency || 'INR',
    receipt: orderId.slice(0, 40), // 40-char Razorpay limit
    notes,
  };

  // Build prefill — omit keys with empty values; Razorpay rejects empty strings.
  const prefill = {};
  const contact = normalizeContact(customer.customerPhone);
  if (contact) prefill.contact = contact;
  if (customer.customerName?.trim()) prefill.name = customer.customerName.trim();
  if (customer.customerEmail?.trim()) prefill.email = customer.customerEmail.trim();

  logger.debug(
    { orderId, amount: amountInPaise, currency: body.currency },
    'razorpay.create_order.request'
  );

  try {
    const res = await withRetry('payment.razorpay.create_order', () =>
      axios.post(`${BASE_URL}/orders`, body, {
        headers: { ...authHeader(), 'Content-Type': 'application/json' },
        timeout: DEFAULT_TIMEOUT_MS,
      })
    );
    const data = res.data || {};
    if (!data.id) {
      throw new ExternalServiceError('Razorpay response missing id', 'RAZORPAY_BAD_RESPONSE');
    }
    return {
      providerOrderId: data.id, // order_xxx — used for fetchStatus and webhook lookup
      paymentUrl: '',            // Flutter SDK doesn't use a URL
      client: {
        keyId: env.RAZORPAY_KEY_ID,
        amount: amountInPaise,
        currency: currency || 'INR',
        ...(Object.keys(prefill).length ? { prefill } : {}),
        notes,
      },
      providerRaw: {
        rzpOrderId: data.id,
        receipt: data.receipt,
      },
    };
  } catch (err) {
    if (err instanceof ExternalServiceError) throw err;
    const status = err.response && err.response.status;
    const respBody = err.response && err.response.data;
    logger.warn({ status, body: respBody, err: err.message }, 'razorpay.create_order.failed');
    throw new ExternalServiceError(
      `Razorpay createCheckout failed: ${err.message}`,
      'RAZORPAY_CREATE_FAILED'
    );
  }
}

async function fetchStatus({ providerOrderId }) {
  try {
    // 1. Fetch the order to check top-level status.
    const orderRes = await withRetry('payment.razorpay.fetch_order', () =>
      axios.get(`${BASE_URL}/orders/${encodeURIComponent(providerOrderId)}`, {
        headers: authHeader(),
        timeout: DEFAULT_TIMEOUT_MS,
      })
    );
    const order = orderRes.data || {};

    if (order.status === 'paid') {
      return {
        status: 'PAID',
        rawProviderStatus: order.status,
        amountInPaise: order.amount != null ? Number(order.amount) : undefined,
        amountPaidInPaise: order.amount_paid != null ? Number(order.amount_paid) : undefined,
        attempted: true,
      };
    }

    // 2. Fetch payments on this order to distinguish PENDING / FAILED.
    const paymentsRes = await withRetry('payment.razorpay.fetch_order_payments', () =>
      axios.get(`${BASE_URL}/orders/${encodeURIComponent(providerOrderId)}/payments`, {
        headers: authHeader(),
        timeout: DEFAULT_TIMEOUT_MS,
      })
    );
    const payments = paymentsRes.data?.items || [];
    const normalized = normalizeOrderStatus(order.status, payments);

    return {
      status: normalized,
      rawProviderStatus: order.status,
      amountInPaise: order.amount != null ? Number(order.amount) : undefined,
      amountPaidInPaise: order.amount_paid != null ? Number(order.amount_paid) : 0,
      // attempted=false means the customer never interacted (safe to refuse proceed-as-pending).
      attempted: payments.length > 0,
    };
  } catch (err) {
    const status = err.response && err.response.status;
    const respBody = err.response && err.response.data;
    logger.warn({ status, body: respBody, err: err.message, providerOrderId }, 'razorpay.fetch_order.failed');
    throw new ExternalServiceError(
      `Razorpay fetchStatus failed: ${err.message}`,
      'RAZORPAY_FETCH_FAILED'
    );
  }
}

// Razorpay webhook signature: HMAC-SHA256 of rawBody using RAZORPAY_WEBHOOK_SECRET,
// compared to x-razorpay-signature header (hex digest).
function verifyWebhook({ rawBody, headers: hdrs }) {
  const signature = hdrs['x-razorpay-signature'] || hdrs['X-Razorpay-Signature'];
  if (!signature) {
    return { isValid: false, event: 'OTHER' };
  }
  const bodyStr = Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : String(rawBody);
  const expected = crypto
    .createHmac('sha256', env.RAZORPAY_WEBHOOK_SECRET)
    .update(bodyStr)
    .digest('hex');

  let isValid = false;
  try {
    isValid = crypto.timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(expected, 'hex'));
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

  const eventType = parsed.event || '';
  const event = normalizeEvent(eventType);

  // payment.captured / payment.failed → payload.payment.entity.order_id
  // order.paid                        → payload.order.entity.id
  const paymentEntity = parsed.payload?.payment?.entity || {};
  const orderEntity = parsed.payload?.order?.entity || {};

  // providerOrderId is always the Razorpay order_xxx.
  const providerOrderId = paymentEntity.order_id || orderEntity.id || undefined;
  // internalOrderId is echoed from notes so the webhook handler can look up our order.
  const internalOrderId = paymentEntity.notes?.internalOrderId
    || orderEntity.notes?.internalOrderId
    || undefined;

  const amountInPaise = paymentEntity.amount != null
    ? Number(paymentEntity.amount)
    : (orderEntity.amount_paid != null ? Number(orderEntity.amount_paid) : undefined);

  return {
    isValid: true,
    event,
    providerOrderId,
    internalOrderId,
    amountInPaise,
    rawEvent: { event: eventType, status: paymentEntity.status || orderEntity.status },
  };
}

module.exports = {
  name: 'razorpay',
  createCheckout,
  fetchStatus,
  verifyWebhook,
};
