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

function normalizeStatus(cfStatus) {
  switch (cfStatus) {
    case 'PAID':
      return 'PAID';
    case 'ACTIVE':
    case 'PARTIALLY_PAID':
      return 'PENDING';
    case 'EXPIRED':
    case 'CANCELLED':
    case 'TERMINATED':
    case 'TERMINATION_REQUESTED':
      return 'FAILED';
    default:
      return 'PENDING';
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
  };

  try {
    const res = await withRetry('payment.cashfree.create_checkout', () =>
      axios.post(`${baseUrl()}/orders`, body, { headers: headers(), timeout: DEFAULT_TIMEOUT_MS })
    );
    const data = res.data || {};
    if (!data.payment_session_id || !data.order_id) {
      throw new ExternalServiceError('Cashfree response missing payment_session_id/order_id', 'CASHFREE_BAD_RESPONSE');
    }
    // Hosted checkout URL pattern: payments(.sandbox).cashfree.com/order/#{session}
    const host = env.CASHFREE_ENV === 'production'
      ? 'https://payments.cashfree.com'
      : 'https://payments-test.cashfree.com';
    const paymentUrl = `${host}/order/#${data.payment_session_id}`;
    return {
      providerOrderId: data.order_id,
      paymentUrl,
      providerRaw: {
        paymentSessionId: data.payment_session_id,
        cfOrderId: data.cf_order_id,
      },
    };
  } catch (err) {
    if (err instanceof ExternalServiceError) throw err;
    const status = err.response && err.response.status;
    const body = err.response && err.response.data;
    logger.warn({ status, body, err: err.message }, 'cashfree.create_checkout.failed');
    throw new ExternalServiceError(
      `Cashfree createCheckout failed: ${err.message}`,
      'CASHFREE_CREATE_FAILED'
    );
  }
}

async function fetchStatus({ providerOrderId }) {
  try {
    const res = await withRetry('payment.cashfree.fetch_status', () =>
      axios.get(`${baseUrl()}/orders/${encodeURIComponent(providerOrderId)}`, {
        headers: headers(),
        timeout: DEFAULT_TIMEOUT_MS,
      })
    );
    const data = res.data || {};
    return {
      status: normalizeStatus(data.order_status),
      rawProviderStatus: data.order_status,
      amountInPaise: Math.round(Number(data.order_amount || 0) * 100),
    };
  } catch (err) {
    const status = err.response && err.response.status;
    const body = err.response && err.response.data;
    logger.warn({ status, body, err: err.message, providerOrderId }, 'cashfree.fetch_status.failed');
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
  return {
    isValid: true,
    event,
    providerOrderId: order.order_id,
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
