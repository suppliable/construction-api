'use strict';

const { getCustomer, getAddressById, saveOrder, getSettings } = require('./firestoreService');
const { getCart, saveCart } = require('../data/cart');
const { getProductById } = require('./productService');
const { ValidationError, NotFoundError, StockError } = require('../utils/errors');

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
  const deliveryCharge = Number(cart.deliveryCharge || cart.delivery_charge || 0);
  const grand_total = parseFloat((subtotal + gst_total + deliveryCharge).toFixed(2));

  // ONLINE orders are saved immediately; Zoho SO is created only after payment confirmation
  if (paymentType === 'ONLINE') {
    const orderId = 'ORD' + Date.now();
    const order = {
      orderId, userId, addressId, items: lineItems,
      subtotal, gst_total, delivery_charge: deliveryCharge,
      grand_total, paymentType, paymentStatus: 'pending',
      status: 'pending_payment',
      createdAt: new Date().toISOString()
    };
    await saveOrder(order, traceContext);
    await saveCart(userId, { items: [] });
    return order;
  }

  const cod_threshold = settings.cod_threshold ?? 7500;
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
    createdAt: new Date().toISOString()
  };
  await saveOrder(order, traceContext);
  await saveCart(userId, { items: [] });

  return order;
}

module.exports = { createOrder };
