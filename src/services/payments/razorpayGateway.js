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

// Razorpay payment link statuses → our normalized status.
// Link statuses: created | partially_paid | expired | cancelled | paid
function normalizeLinkStatus(status) {
  switch (status) {
    case 'paid':
      return 'PAID';
    case 'created':
    case 'partially_paid':
      return 'PENDING';
    case 'expired':
    case 'cancelled':
      return 'FAILED';
    default:
      return 'PENDING';
  }
}

// Razorpay sends webhook events like "payment_link.paid", "payment_link.expired",
// "payment.failed", "payment.authorized", etc.
function normalizeEvent(event) {
  switch (event) {
    case 'payment_link.paid':
    case 'payment.captured':
    case 'payment.authorized':
      return 'PAYMENT_SUCCESS';
    case 'payment_link.expired':
    case 'payment_link.cancelled':
    case 'payment.failed':
      return 'PAYMENT_FAILED';
    default:
      return 'OTHER';
  }
}

// Razorpay Payment Links accept a description (max 255 chars) but no custom id ≤ 50 chars.
// We store our orderId in the `reference_id` field (max 40 chars). The provider's
// `id` (plink_xxx) is used as providerOrderId since it's what fetchStatus and webhook use.
async function createCheckout({ orderId, amountInPaise, currency, customer, returnUrl, notifyUrl }) {
  const body = {
    amount: paiseToRupees(amountInPaise), // Razorpay already uses paise
    currency: currency || 'INR',
    description: `Order ${orderId}`,
    reference_id: orderId.slice(0, 40),
    callback_url: returnUrl,
    callback_method: 'get',
    notify: { sms: false, email: false },
    customer: {
      contact: customer.customerPhone,
      ...(customer.customerName ? { name: customer.customerName } : {}),
      ...(customer.customerEmail ? { email: customer.customerEmail } : {}),
    },
    // Notify via webhook — Razorpay reads this from dashboard settings but we
    // pass it explicitly per payment link so each env gets the right URL.
    ...(notifyUrl ? { notify: { sms: false, email: false } } : {}),
    expire_by: Math.floor((Date.now() + 30 * 60 * 1000) / 1000), // +30 min, Unix timestamp
  };

  try {
    const res = await withRetry('payment.razorpay.create_link', () =>
      axios.post(`${BASE_URL}/payment_links`, body, {
        headers: { ...authHeader(), 'Content-Type': 'application/json' },
        timeout: DEFAULT_TIMEOUT_MS,
      })
    );
    const data = res.data || {};
    if (!data.short_url || !data.id) {
      throw new ExternalServiceError('Razorpay response missing short_url/id', 'RAZORPAY_BAD_RESPONSE');
    }
    return {
      providerOrderId: data.id, // plink_xxx — used for fetchStatus and webhook lookup
      paymentUrl: data.short_url,
      providerRaw: {
        rzpLinkId: data.id,
        referenceId: orderId,
        paymentUrl: data.short_url,
        expireBy: data.expire_by,
      },
    };
  } catch (err) {
    if (err instanceof ExternalServiceError) throw err;
    const status = err.response && err.response.status;
    const respBody = err.response && err.response.data;
    logger.warn({ status, body: respBody, err: err.message }, 'razorpay.create_link.failed');
    throw new ExternalServiceError(
      `Razorpay createCheckout failed: ${err.message}`,
      'RAZORPAY_CREATE_FAILED'
    );
  }
}

async function fetchStatus({ providerOrderId }) {
  try {
    const res = await withRetry('payment.razorpay.fetch_link', () =>
      axios.get(`${BASE_URL}/payment_links/${encodeURIComponent(providerOrderId)}`, {
        headers: authHeader(),
        timeout: DEFAULT_TIMEOUT_MS,
      })
    );
    const data = res.data || {};
    return {
      status: normalizeLinkStatus(data.status),
      rawProviderStatus: data.status,
      // Razorpay stores amount in paise already
      amountInPaise: data.amount != null ? Number(data.amount) : undefined,
    };
  } catch (err) {
    const status = err.response && err.response.status;
    const respBody = err.response && err.response.data;
    logger.warn({ status, body: respBody, err: err.message, providerOrderId }, 'razorpay.fetch_link.failed');
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

  // payment_link.paid → payload.payment_link.entity.id = plink_xxx
  // payment.* → payload.payment.entity.order_id or notes.reference_id
  const linkEntity = (parsed.payload && parsed.payload.payment_link && parsed.payload.payment_link.entity) || {};
  const paymentEntity = (parsed.payload && parsed.payload.payment) || {};
  const providerOrderId = linkEntity.id
    || (paymentEntity.entity && paymentEntity.entity.payment_link_id)
    || undefined;

  const amountInPaise = linkEntity.amount != null
    ? Number(linkEntity.amount)
    : (paymentEntity.entity && paymentEntity.entity.amount != null ? Number(paymentEntity.entity.amount) : undefined);

  return {
    isValid: true,
    event,
    providerOrderId,
    amountInPaise,
    rawEvent: { event: eventType, status: linkEntity.status },
  };
}

module.exports = {
  name: 'razorpay',
  createCheckout,
  fetchStatus,
  verifyWebhook,
};
