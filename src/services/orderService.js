'use strict';

const admin = require('../utils/firebaseAdmin');
const { getCustomer, getAddressById, saveOrder, getSettings, getOrderById, updateOrder } = require('./firestoreService');
const remoteConfig = require('./remoteConfigService');
const { getCart, saveCart } = require('../data/cart');
const { getProductById } = require('./productService');
const { ValidationError, NotFoundError, StockError } = require('../utils/errors');
const { invalidateOrder } = require('../cache/invalidate');
const { isFreeDeliveryEligible } = require('./deliveryService');

async function createOrder({ userId, addressId, paymentType }, traceContext, _log) {
  if (!userId) throw new ValidationError('userId is required', 'MISSING_PARAM');
  if (!addressId) throw new ValidationError('addressId is required', 'MISSING_PARAM');
  if (!paymentType || !['COD', 'ONLINE'].includes(paymentType)) {
    throw new ValidationError('paymentType must be COD or ONLINE', 'INVALID_PARAM');
  }

  const settings = await getSettings(traceContext);
  if (settings.warehouseOpen === false) {
    throw new StockError(
      settings.warehouseClosedMessage || 'We are currently closed.',
      [],
      true
    );
  }

  const cart = await getCart(userId);
  if (!cart.items || cart.items.length === 0) {
    throw new ValidationError('Cart is empty', 'CART_EMPTY');
  }

  const address = await getAddressById(addressId, traceContext);
  if (!address || address.userId !== userId) {
    throw new NotFoundError('Address not found', 'ADDRESS_NOT_FOUND');
  }

  const stockIssues = [];
  const lineItems = [];

  await Promise.all(cart.items.map(async (cartItem) => {
    const product = await getProductById(cartItem.productId, traceContext);
    if (!product) {
      stockIssues.push({ productId: cartItem.productId, message: 'Product not found' });
      return;
    }
    if (product.available_stock !== undefined && product.available_stock !== null) {
      if (cartItem.quantity > product.available_stock) {
        stockIssues.push({
          productId: cartItem.productId,
          name: product.name,
          requested: cartItem.quantity,
          available: product.available_stock,
          message: product.available_stock <= 0
            ? `Sorry, ${product.name} is out of stock`
            : `Only ${product.available_stock} units available for ${product.name}`
        });
        return;
      }
    }

    const unitPrice = cartItem.price != null ? cartItem.price : product.price;
    const gstRate = product.gst_percentage || 18;
    const qty = cartItem.quantity;

    // All prices are GST-inclusive — back-calculate base price
    const divisor = 1 + (gstRate / 100);
    const basePrice = parseFloat((unitPrice / divisor).toFixed(2));
    const totalWithoutGST = parseFloat((basePrice * qty).toFixed(2));
    const gstAmount = parseFloat(((unitPrice * qty) - totalWithoutGST).toFixed(2));
    const grandTotal = parseFloat((unitPrice * qty).toFixed(2));

    const lineItem = {
      productId: cartItem.productId,
      zohoItemId: cartItem.zohoItemId || cartItem.variantId || cartItem.productId,
      variantId: cartItem.variantId || null,
      name: product.name,
      quantity: qty,
      unit: product.unit,
      unitPrice,
      totalWithoutGST,
      gstRate,
      gstAmount,
      grandTotal,
      cartItemId: cartItem.cartItemId || null,
    };

    if (cartItem.shadeCode) {
      lineItem.shadeCode = cartItem.shadeCode;
      lineItem.shadeName = cartItem.shadeName || null;
      lineItem.shadeTier = cartItem.shadeTier || null;
    }

    lineItems.push(lineItem);
  }));

  if (stockIssues.length > 0) {
    throw new StockError('Stock validation failed', stockIssues);
  }

  const subtotal = parseFloat(lineItems.reduce((sum, i) => sum + i.totalWithoutGST, 0).toFixed(2));
  const gst_total = parseFloat(lineItems.reduce((sum, i) => sum + i.gstAmount, 0).toFixed(2));
  let deliveryCharge = Number(cart.deliveryCharge || cart.delivery_charge || 0);
  const freeDeliveryApplied = await isFreeDeliveryEligible(userId);
  if (freeDeliveryApplied) deliveryCharge = 0;
  const grand_total = parseFloat((subtotal + gst_total + deliveryCharge).toFixed(2));

  // ONLINE orders are saved immediately; Zoho SO is created only after payment confirmation.
  // IMPORTANT: do NOT clear the cart here — payment may fail/abandon and the user
  // should still have their cart to switch to COD or retry. Cart is cleared by
  // `confirmOnlinePayment` once payment succeeds.
  if (paymentType === 'ONLINE') {
    const orderId = 'ORD' + Date.now();
    const order = {
      orderId, userId, addressId, items: lineItems,
      subtotal, gst_total, delivery_charge: deliveryCharge,
      grand_total, paymentType, paymentStatus: 'pending',
      status: 'pending_payment',
      freeDeliveryApplied,
      createdAt: new Date().toISOString()
    };
    await saveOrder(order, traceContext);
    return order;
  }

  const cod_threshold = await remoteConfig.getNumber('cod_threshold', settings.cod_threshold ?? 7500);
  if (grand_total > cod_threshold) {
    throw new ValidationError(
      `COD not available for orders above ₹${cod_threshold}. Please use online payment.`,
      'COD_THRESHOLD_EXCEEDED'
    );
  }

  const customer = await getCustomer(userId, traceContext);
  if (!customer) {
    throw new NotFoundError('Customer not found', 'CUSTOMER_NOT_FOUND');
  }

  const orderId = 'ORD' + Date.now();
  const order = {
    orderId, userId, addressId, items: lineItems,
    subtotal, gst_total, delivery_charge: deliveryCharge,
    grand_total, paymentType, paymentStatus: 'confirmed',
    status: 'warehouse_review',
    customerName: customer.name || '',
    customerPhone: customer.phone || '',
    freeDeliveryApplied,
    createdAt: new Date().toISOString()
  };
  await saveOrder(order, traceContext);
  await saveCart(userId, { items: [] });

  return order;
}

/**
 * Confirm a successful online payment for an order. Transitions
 * `pending_payment` → `warehouse_review` (the same state COD orders land in,
 * so the existing admin acceptance flow takes over from here).
 *
 * Idempotent — if the order is already past `pending_payment`, returns the
 * current order unchanged. Always records the attempt for audit.
 *
 * Does NOT push to Zoho; that happens in `adminController.acceptOrder` when
 * a warehouse user accepts the order, identical to COD.
 */
async function confirmOnlinePayment(orderId, attempt, traceContext = null) {
  if (!orderId) throw new ValidationError('orderId is required', 'MISSING_PARAM');

  const order = await getOrderById(orderId, traceContext);
  if (!order) throw new NotFoundError('Order not found', 'ORDER_NOT_FOUND');

  // Always log the attempt for audit, even if no state change.
  const attemptRecord = {
    at: new Date().toISOString(),
    status: attempt && attempt.status ? attempt.status : 'unknown',
    rawProviderStatus: attempt && attempt.rawProviderStatus ? attempt.rawProviderStatus : null,
    source: attempt && attempt.source ? attempt.source : 'unknown', // 'webhook' | 'verify' | 'admin_manual'
    ...(attempt && attempt.actor ? { actor: attempt.actor } : {}),
  };

  // Idempotency: if paymentStatus is already 'confirmed', nothing changes —
  // just record the attempt for audit.
  if (order.paymentStatus === 'confirmed') {
    await updateOrder(orderId, {
      'payment.attempts': admin.firestore.FieldValue.arrayUnion(attemptRecord),
    }, traceContext);
    return { ...order, _transitioned: false };
  }

  // Always flip paymentStatus to 'confirmed' (from either 'pending' or
  // 'pending_proceeding'). Only flip `status` if the order is still in
  // pending_payment — past that, the order may have proceeded into the
  // fulfilment pipeline via proceedAsPendingPayment, and a late webhook here
  // must NOT jerk it back.
  const update = {
    paymentStatus: 'confirmed',
    paidAt: new Date().toISOString(),
    'payment.attempts': admin.firestore.FieldValue.arrayUnion(attemptRecord),
  };
  if (order.status === 'pending_payment') {
    update.status = 'warehouse_review';
  }

  const updated = await updateOrder(orderId, update, traceContext);

  // Bust the cached /orders/detail response so the customer's tracking screen
  // sees paymentStatus='confirmed' on its next poll instead of a stale value.
  // Best-effort — a cache miss is harmless, a throw here must not fail payment.
  await invalidateOrder(orderId).catch(() => {});

  // Cart wasn't cleared at order-creation time for ONLINE orders. Clear it
  // now that payment has succeeded — but only if the cart wasn't already
  // cleared by an earlier proceedAsPendingPayment transition. Best-effort.
  if (order.userId && order.status === 'pending_payment') {
    try {
      await saveCart(order.userId, { items: [] });
    } catch (cartErr) {
      // Non-fatal — order is confirmed; cart can be cleared on next checkout.
    }
  }

  return { ...updated, _transitioned: true };
}

/**
 * Record a failed payment attempt without changing order status — leaves
 * the order in `pending_payment` so the user can retry with a new session.
 */
async function recordFailedPaymentAttempt(orderId, attempt, traceContext = null) {
  if (!orderId) throw new ValidationError('orderId is required', 'MISSING_PARAM');
  const order = await getOrderById(orderId, traceContext);
  if (!order) throw new NotFoundError('Order not found', 'ORDER_NOT_FOUND');

  const attemptRecord = {
    at: new Date().toISOString(),
    status: 'failed',
    rawProviderStatus: attempt && attempt.rawProviderStatus ? attempt.rawProviderStatus : null,
    source: attempt && attempt.source ? attempt.source : 'unknown',
  };

  await updateOrder(orderId, {
    'payment.attempts': admin.firestore.FieldValue.arrayUnion(attemptRecord),
  }, traceContext);
}

/**
 * Transition `pending_payment → warehouse_review` while the online payment is
 * still PENDING with the gateway. Flips paymentStatus to `pending_proceeding`
 * so every UI can surface a "Payment pending" chip on the current lifecycle
 * step. The order proceeds through normal fulfilment; when the webhook
 * eventually lands, `confirmOnlinePayment` promotes it to `confirmed`. If it
 * never lands, the driver's `arrived` handler converts to COD.
 *
 * Idempotent — if the order is past `pending_payment`, no-op (but still
 * records the attempt for audit).
 */
async function proceedAsPendingPayment(orderId, attempt, traceContext = null) {
  if (!orderId) throw new ValidationError('orderId is required', 'MISSING_PARAM');
  const order = await getOrderById(orderId, traceContext);
  if (!order) throw new NotFoundError('Order not found', 'ORDER_NOT_FOUND');

  const attemptRecord = {
    at: new Date().toISOString(),
    status: 'pending_proceeding',
    rawProviderStatus: attempt && attempt.rawProviderStatus ? attempt.rawProviderStatus : null,
    source: attempt && attempt.source ? attempt.source : 'verify_timeout',
  };

  // Already proceeded or further along — no-op.
  if (order.status !== 'pending_payment') {
    await updateOrder(orderId, {
      'payment.attempts': admin.firestore.FieldValue.arrayUnion(attemptRecord),
    }, traceContext);
    return { ...order, _transitioned: false };
  }

  const updated = await updateOrder(orderId, {
    status: 'warehouse_review',
    paymentStatus: 'pending_proceeding',
    'payment.attempts': admin.firestore.FieldValue.arrayUnion(attemptRecord),
  }, traceContext);

  // Bust the cached /orders/detail response — this is the transition that
  // produced the customer-facing "Payment pending" flicker: the order flipped
  // to pending_proceeding but the tracking screen kept polling a stale cache.
  await invalidateOrder(orderId).catch(() => {});

  // Cart is no longer needed — the order is proceeding through fulfilment.
  // Best-effort.
  if (order.userId) {
    try {
      await saveCart(order.userId, { items: [] });
    } catch (cartErr) {
      // Non-fatal.
    }
  }

  return { ...updated, _transitioned: true };
}

/**
 * Auto-convert a pending-payment online order to COD. Called from the driver's
 * `arrived` handler when paymentStatus is still `pending_proceeding` at
 * delivery time. The existing COD-collection flow takes over — driver sees
 * "COLLECT CASH" and the standard codCollected → completeDelivery sequence
 * runs.
 *
 * Idempotent — if paymentType is already COD or paymentStatus is confirmed,
 * no-op. paymentStatus is reset to `pending` since the online payment is now
 * moot (order is COD); the audit trail in payment.attempts records the
 * conversion source.
 */
async function convertPendingToCod(orderId, source = 'auto_cod_at_arrived', traceContext = null) {
  if (!orderId) throw new ValidationError('orderId is required', 'MISSING_PARAM');
  const order = await getOrderById(orderId, traceContext);
  if (!order) throw new NotFoundError('Order not found', 'ORDER_NOT_FOUND');

  // Nothing to do if already COD or payment already confirmed.
  if (order.paymentType === 'COD' || order.paymentStatus === 'confirmed') {
    return { ...order, _converted: false };
  }

  const attemptRecord = {
    at: new Date().toISOString(),
    status: 'converted_to_cod',
    rawProviderStatus: null,
    source,
  };

  const updated = await updateOrder(orderId, {
    paymentType: 'COD',
    paymentStatus: 'pending',
    convertedFromOnlineAt: new Date().toISOString(),
    'payment.attempts': admin.firestore.FieldValue.arrayUnion(attemptRecord),
  }, traceContext);

  // Bust the cached /orders/detail response so the driver/customer see the
  // COD conversion (paymentType=COD) on the next poll. Best-effort.
  await invalidateOrder(orderId).catch(() => {});

  return { ...updated, _converted: true };
}

module.exports = {
  createOrder,
  confirmOnlinePayment,
  recordFailedPaymentAttempt,
  proceedAsPendingPayment,
  convertPendingToCod,
};
