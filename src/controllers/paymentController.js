'use strict';

const env = require('../config/env');
const { getGateway } = require('../services/payments');
const { getOrderById, updateOrder, getCustomer } = require('../services/firestoreService');
const { confirmOnlinePayment, recordFailedPaymentAttempt, proceedAsPendingPayment, markOnlinePaymentCancelled, buildCartData, buildAndSaveOnlineOrder } = require('../services/orderService');
const { toOrderDTO } = require('../models/orderDTO');
const { ValidationError, NotFoundError, UnauthorizedError, AppError } = require('../utils/errors');
const { invalidateOrder } = require('../cache/invalidate');

function rupeesToPaise(amount) {
  return Math.round(Number(amount) * 100);
}

function sendError(res, err, log) {
  if (err && err.statusCode) {
    return res.status(err.statusCode).json({ success: false, error: err.code, message: err.message });
  }
  if (log) log.error({ err: err.response?.data || err.message }, 'payment.controller.failed');
  return res.status(500).json({ success: false, error: 'SERVER_ERROR', message: err.message });
}

/**
 * POST /api/v1/payments/session
 * Body: { orderId }
 * Header: X-Idempotency-Key (recommended; handled by idempotency middleware)
 * Auth: required.
 */
async function createSession(req, res) {
  try {
    const { orderId, customerPhone: bodyPhone } = req.body || {};
    if (!orderId) throw new ValidationError('orderId is required', 'MISSING_PARAM');

    const order = await getOrderById(orderId, req.traceContext);
    if (!order) throw new NotFoundError('Order not found', 'ORDER_NOT_FOUND');
    if (order.userId !== req.user.uid) throw new UnauthorizedError('Not your order', 'NOT_ORDER_OWNER');
    if (order.paymentType !== 'ONLINE') {
      throw new ValidationError('Order is not an online payment order', 'NOT_ONLINE_ORDER');
    }
    if (order.status !== 'pending_payment') {
      throw new ValidationError(`Order is not awaiting payment (status=${order.status})`, 'ORDER_NOT_PENDING_PAYMENT');
    }

    const gateway = getGateway();

    // Resolve the buyer's phone/name authoritatively. The auth token's `phone`
    // claim is not always present (custom JWTs may omit it), and the
    // Flutter-sent `bodyPhone` can be empty if the profile hasn't loaded — so
    // fall back to the customer record (keyed by Firebase UID = order owner),
    // which always carries a normalized phone. Without this, `prefill.contact`
    // came back empty and Razorpay asked the user to type their number.
    let customerPhone = bodyPhone || req.user.phone || order.customerPhone || '';
    let customerName = req.user.name || order.customerName || '';
    if (!customerPhone || !customerName) {
      try {
        const customer = await getCustomer(req.user.uid, req.traceContext);
        if (!customerPhone && customer?.phone) customerPhone = customer.phone;
        if (!customerName && customer?.name) customerName = customer.name;
      } catch (custErr) {
        req.log.warn({ err: custErr.message, orderId }, 'payment.session.customer_lookup_failed');
      }
    }
    const customer = {
      customerId: req.user.uid,
      customerPhone,
      customerName,
      customerEmail: req.user.email || '',
    };
    // Fresh prefill rebuilt from the resolved phone, used to self-heal a stored
    // session whose prefill was empty (created before the phone was available).
    const freshPrefill = gateway.buildPrefill ? gateway.buildPrefill(customer) : null;
    req.log.info({
      orderId,
      bodyPhone: bodyPhone || null,
      userPhone: req.user.phone || null,
      orderPhone: order.customerPhone || null,
      resolvedPhone: customerPhone || null,
      prefillContact: freshPrefill?.contact || null,
      hasStoredClient: !!order.payment?.client,
    }, 'payment.session.prefill_debug');

    // Reuse-when-active: if a prior session exists and is still PENDING with
    // the provider, return the same session. Cashfree stores paymentUrl;
    // Razorpay stores client (keyId/amount/currency/prefill/notes).
    if (order.payment?.providerOrderId && (order.payment?.providerRaw?.paymentUrl || order.payment?.client)) {
      try {
        const status = await gateway.fetchStatus({ providerOrderId: order.payment.providerOrderId });
        if (status.status === 'PENDING') {
          req.log.info({ orderId, providerOrderId: order.payment.providerOrderId }, 'payment.session.reused');
          const storedClient = order.payment.client || {};
          // If the stored client has no (or empty) prefill but we now have a
          // phone, inject the fresh prefill so the reused session is no longer
          // poisoned by the empty value captured at first creation.
          const client = (freshPrefill && Object.keys(freshPrefill).length &&
              !(storedClient.prefill && storedClient.prefill.contact))
            ? { ...storedClient, prefill: { ...(storedClient.prefill || {}), ...freshPrefill } }
            : storedClient;
          return res.json({
            success: true,
            data: {
              gateway: gateway.name,
              paymentUrl: order.payment.providerRaw?.paymentUrl || '',
              providerOrderId: order.payment.providerOrderId,
              ...client,
            },
          });
        }
        // PAID: order should already be confirmed by webhook/verify, but be defensive.
        if (status.status === 'PAID') {
          throw new ValidationError('Order is already paid', 'ALREADY_PAID');
        }
        // FAILED/EXPIRED → fall through and create a new link with bumped attempt counter.
      } catch (statusErr) {
        if (statusErr instanceof ValidationError) throw statusErr;
        // If status lookup fails (network blip), don't block payment — create a fresh link.
        req.log.warn({ err: statusErr.message, orderId }, 'payment.session.status_check_failed_creating_new');
      }
    }

    const returnUrl = `${env.PAYMENT_RETURN_URL_BASE}/api/v1/payments/return?orderId=${encodeURIComponent(orderId)}`;
    const notifyUrl = `${env.PAYMENT_RETURN_URL_BASE}/api/v1/payments/webhook/${gateway.name}`;
    const attemptCount = Array.isArray(order.payment?.attempts) ? order.payment.attempts.length : 0;

    const session = await gateway.createCheckout({
      orderId,
      amountInPaise: rupeesToPaise(order.grand_total),
      currency: 'INR',
      customer,
      returnUrl,
      notifyUrl,
      attemptCount,
    });

    await updateOrder(orderId, {
      payment: {
        gateway: gateway.name,
        providerOrderId: session.providerOrderId,
        attempts: order.payment?.attempts || [],
        ...(session.providerRaw ? { providerRaw: session.providerRaw } : {}),
        ...(session.client ? { client: session.client } : {}),
      },
    }, req.traceContext);

    res.json({
      success: true,
      data: {
        gateway: gateway.name,
        paymentUrl: session.paymentUrl,
        providerOrderId: session.providerOrderId,
        ...(session.client || {}),
      },
    });
  } catch (err) {
    sendError(res, err, req.log);
  }
}

/**
 * POST /api/v1/payments/verify
 * Body: { orderId, proceedIfPending?: boolean }
 * Auth: required.
 * Called by Flutter when the WebView returns. Idempotent.
 *
 * When `proceedIfPending` is true and the gateway still reports PENDING, we
 * transition the order to `warehouse_review` with
 * `paymentStatus: 'pending_proceeding'` rather than leaving it stuck.
 * Flutter sets this only after exhausting its
 * 3-poll verify-grace window (~16s) — gives time for fast webhooks but
 * doesn't block the customer on slow ones.
 */
async function verifyPayment(req, res) {
  try {
    const { orderId, proceedIfPending, cancelled } = req.body || {};
    if (!orderId) throw new ValidationError('orderId is required', 'MISSING_PARAM');

    const order = await getOrderById(orderId, req.traceContext);
    if (!order) throw new NotFoundError('Order not found', 'ORDER_NOT_FOUND');
    if (order.userId !== req.user.uid) throw new UnauthorizedError('Not your order', 'NOT_ORDER_OWNER');

    const providerOrderId = order.payment?.providerOrderId;
    if (!providerOrderId) {
      // No session was created yet — nothing to verify.
      return res.json({
        success: true,
        data: { paymentStatus: order.paymentStatus || 'pending', orderStatus: order.status },
      });
    }

    // Trust a webhook-recorded outcome on the order doc over the live link
    // status. Cashfree's link-status API is blind to a single failed/dropped
    // attempt (the link stays ACTIVE for retry), so fetchStatus would report
    // PENDING and the client would show the "Confirming your payment" spinner.
    // The PAYMENT_FAILED webhook already flipped paymentStatus to 'failed'
    // (while still pending_payment) — surface that immediately so the client
    // shows the retry dialog instead.
    if (order.paymentStatus === 'failed' && order.status === 'pending_payment') {
      return res.json({
        success: true,
        data: { paymentStatus: 'failed', orderStatus: order.status },
      });
    }

    const gateway = getGateway();
    const status = await gateway.fetchStatus({ providerOrderId });

    if (status.status === 'PAID') {
      const result = await confirmOnlinePayment(orderId, {
        status: 'paid',
        rawProviderStatus: status.rawProviderStatus,
        source: 'verify',
      }, req.traceContext);
      invalidateOrder(orderId).catch(() => {});
      return res.json({
        success: true,
        data: { paymentStatus: 'confirmed', orderStatus: result.status, order: toOrderDTO(result) },
      });
    }

    if (status.status === 'FAILED') {
      await recordFailedPaymentAttempt(orderId, {
        rawProviderStatus: status.rawProviderStatus,
        source: 'verify',
      }, req.traceContext);
      return res.json({
        success: true,
        data: { paymentStatus: 'failed', orderStatus: order.status },
      });
    }

    // PENDING. If the caller asked us to proceed anyway (verify-grace exhausted
    // client-side), transition the order to warehouse_review with
    // paymentStatus='pending_proceeding'.
    //
    // BUT: only proceed when a payment was actually attempted. A Razorpay link
    // still in `created` state with no payment entities means the customer
    // closed the hosted page without paying — that's an abandonment, not an
    // in-flight payment, and must leave the order in pending_payment. Without
    // this guard, closing the link would (via proceed-as-pending) place the
    // order in warehouse_review. `attempted` is undefined for gateways that
    // don't report it → default to the old behaviour (treat as attempted).
    const everAttempted = status.attempted !== false;
    if (proceedIfPending === true && order.status === 'pending_payment' && everAttempted) {
      const result = await proceedAsPendingPayment(orderId, {
        rawProviderStatus: status.rawProviderStatus,
        source: 'verify_timeout',
      }, req.traceContext);
      invalidateOrder(orderId).catch(() => {});
      return res.json({
        success: true,
        data: {
          paymentStatus: 'pending_proceeding',
          orderStatus: result.status,
          order: toOrderDTO(result),
        },
      });
    }

    // Still PENDING and the customer explicitly cancelled (closed the hosted
    // page). The gateway confirmed it's not PAID/FAILED above, so this is a
    // genuine abandonment: leave the order in pending_payment (retry/COD still
    // possible) but flip the stale "Awaiting payment" Slack card to "Cancelled"
    // so ops isn't left staring at a perpetual in-flight card. Best-effort.
    if (cancelled === true) {
      await markOnlinePaymentCancelled(orderId, req.traceContext);
    }

    return res.json({
      success: true,
      data: {
        paymentStatus: 'pending',
        orderStatus: order.status,
        // Let the client know whether any payment was ever attempted on this
        // order. When false (Razorpay: no payment entities on the order),
        // Flutter can safely call DELETE /orders/:orderId to cancel silently.
        attempted: everAttempted,
      },
    });
  } catch (err) {
    sendError(res, err, req.log);
  }
}

/**
 * POST /api/v1/payments/webhook/:gateway
 * NO auth — verified via signature in the gateway adapter.
 * Body parser must preserve req.rawBody (see server.js express.json verify).
 * Cashfree retries non-2xx for ~24h, so always 200 unless signature is bad.
 */
async function handleWebhook(req, res) {
  const gatewayName = req.params.gateway;
  try {
    const gateway = getGateway();
    if (gateway.name !== gatewayName) {
      req.log.warn({ expected: gateway.name, got: gatewayName }, 'payment.webhook.gateway_mismatch');
      return res.status(404).json({ success: false, error: 'UNKNOWN_GATEWAY' });
    }

    const verification = gateway.verifyWebhook({
      rawBody: req.rawBody,
      headers: req.headers,
    });

    if (!verification.isValid) {
      req.log.warn({ gateway: gatewayName }, 'payment.webhook.invalid_signature');
      return res.status(401).json({ success: false, error: 'INVALID_SIGNATURE' });
    }

    const { event, providerOrderId, internalOrderId } = verification;
    if (!providerOrderId && !internalOrderId) {
      req.log.warn({ event }, 'payment.webhook.missing_provider_order_id');
      return res.status(200).json({ received: true });
    }

    // Razorpay Orders: internalOrderId is echoed from notes — use it to look up
    // our order. Cashfree: internalOrderId is undefined, fall back to providerOrderId.
    const orderId = internalOrderId || providerOrderId;

    try {
      if (event === 'PAYMENT_SUCCESS') {
        const result = await confirmOnlinePayment(orderId, {
          status: 'paid',
          rawProviderStatus: verification.rawEvent?.paymentStatus,
          source: 'webhook',
        }, req.traceContext);
        invalidateOrder(orderId).catch(() => {});
        req.log.info({ orderId, transitioned: result._transitioned }, 'payment.webhook.success');
      } else if (event === 'PAYMENT_FAILED') {
        await recordFailedPaymentAttempt(orderId, {
          rawProviderStatus: verification.rawEvent?.paymentStatus,
          source: 'webhook',
        }, req.traceContext);
        // Bust the cached order so the next /verify reads paymentStatus='failed'
        // and the client shows the retry dialog (not the confirming spinner).
        invalidateOrder(orderId).catch(() => {});
        req.log.info({ orderId }, 'payment.webhook.failed_recorded');
      } else {
        req.log.info({ orderId, event }, 'payment.webhook.other_event_ignored');
      }
    } catch (workErr) {
      // Don't 500 — Cashfree would retry forever. Log and acknowledge.
      req.log.error({ err: workErr.message, orderId }, 'payment.webhook.work_failed');
    }

    return res.status(200).json({ received: true });
  } catch (err) {
    req.log.error({ err: err.message, gateway: gatewayName }, 'payment.webhook.unexpected_error');
    // Still ack — we don't want retry storms on bugs.
    return res.status(200).json({ received: true, error: 'internal' });
  }
}

/**
 * GET /api/v1/payments/return
 * NO auth, public. Tiny landing page Flutter intercepts; only renders if the
 * WebView fails to intercept (e.g. cold WebView, edge case).
 */
function paymentReturn(req, res) {
  const orderId = String(req.query.orderId || '');
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!doctype html>
<html><head><meta charset="utf-8"><title>Payment complete</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>body{font-family:-apple-system,system-ui,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#f7f8fa;color:#222}
.box{text-align:center;padding:32px;max-width:360px}
h1{font-size:20px;margin:0 0 8px}p{margin:0;color:#666;font-size:14px}</style>
</head><body><div class="box"><h1>Payment complete</h1><p>You can return to the app.</p><p style="margin-top:12px;font-size:12px">Order: ${orderId.replace(/[^A-Za-z0-9_-]/g, '')}</p></div></body></html>`);
}

/**
 * POST /api/v1/payments/checkout
 * Body: { addressId, customerPhone? }
 * Auth: required. Idempotency-Key: recommended.
 *
 * Single-shot checkout for online orders:
 *   1. Validate cart + stock
 *   2. Create the Razorpay/Cashfree order
 *   3. Only then write the Firestore order (status=pending_payment)
 * This ensures no order exists unless the payment gateway accepted it.
 */
async function checkout(req, res) {
  try {
    const { addressId, customerPhone: bodyPhone } = req.body || {};
    if (!addressId) throw new ValidationError('addressId is required', 'MISSING_PARAM');
    const userId = req.user.uid;

    // Step 1: validate cart, stock, and compute totals — no Firestore write yet
    const cartData = await buildCartData(userId, addressId, req.traceContext);

    // Step 2: resolve customer info
    let customerPhone = bodyPhone || req.user.phone || '';
    let customerName = req.user.name || '';
    if (!customerPhone || !customerName) {
      try {
        const customer = await getCustomer(userId, req.traceContext);
        if (!customerPhone && customer?.phone) customerPhone = customer.phone;
        if (!customerName && customer?.name) customerName = customer.name;
      } catch (_) {}
    }

    const gateway = getGateway();
    const orderId = 'ORD' + Date.now();
    const returnUrl = `${env.PAYMENT_RETURN_URL_BASE}/api/v1/payments/return?orderId=${encodeURIComponent(orderId)}`;
    const notifyUrl = `${env.PAYMENT_RETURN_URL_BASE}/api/v1/payments/webhook/${gateway.name}`;

    // Step 3: create gateway order (fails fast if gateway is down)
    const session = await gateway.createCheckout({
      orderId,
      amountInPaise: rupeesToPaise(cartData.grand_total),
      currency: 'INR',
      customer: { customerId: userId, customerPhone, customerName, customerEmail: req.user.email || '' },
      returnUrl,
      notifyUrl,
      attemptCount: 0,
    });

    // Step 4: only now persist the order — gateway accepted it
    const order = await buildAndSaveOnlineOrder({
      orderId,
      userId,
      addressId,
      cartData,
      paymentSession: {
        gateway: gateway.name,
        providerOrderId: session.providerOrderId,
        providerRaw: session.providerRaw,
        client: session.client,
      },
      customerName,
      customerPhone,
    }, req.traceContext);

    res.json({
      success: true,
      data: {
        order: toOrderDTO(order),
        gateway: gateway.name,
        paymentUrl: session.paymentUrl,
        providerOrderId: session.providerOrderId,
        ...(session.client || {}),
      },
    });
  } catch (err) {
    sendError(res, err, req.log);
  }
}

module.exports = { createSession, verifyPayment, handleWebhook, paymentReturn, checkout };
