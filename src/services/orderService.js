'use strict';

const { getCustomer, getAddressById, saveOrder, getSettings } = require('./firestoreService');
const { getCart, saveCart } = require('../data/cart');
const { getProductById } = require('./productService');
const { ValidationError, NotFoundError } = require('../utils/errors');

async function createOrder({ userId, addressId, paymentType }, traceContext, log) {
  if (!userId) throw new ValidationError('userId is required', 'MISSING_PARAM');
  if (!addressId) throw new ValidationError('addressId is required', 'MISSING_PARAM');
  if (!paymentType || !['COD', 'ONLINE'].includes(paymentType)) {
    throw new ValidationError('paymentType must be COD or ONLINE', 'INVALID_PARAM');
  }

  const settings = await getSettings();
  if (settings.warehouseOpen === false) {
    const err = new ValidationError(
      settings.warehouseClosedMessage || 'We are currently closed.',
      'WAREHOUSE_CLOSED'
    );
    err.canAddToCart = true;
    throw err;
  }

  const cart = await getCart(userId);
  if (!cart.items || cart.items.length === 0) {
    throw new ValidationError('Cart is empty', 'CART_EMPTY');
  }

  const address = await getAddressById(addressId);
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

    const totalWithoutGST = parseFloat((product.price * cartItem.quantity).toFixed(2));
    const gstAmount = parseFloat((totalWithoutGST * product.gst_percentage / 100).toFixed(2));
    const grandTotal = parseFloat((totalWithoutGST + gstAmount).toFixed(2));

    lineItems.push({
      productId: cartItem.productId,
      name: product.name,
      quantity: cartItem.quantity,
      unit: product.unit,
      unitPrice: product.price,
      totalWithoutGST,
      gstRate: product.gst_percentage,
      gstAmount,
      grandTotal
    });
  }));

  if (stockIssues.length > 0) {
    const err = new ValidationError('Stock validation failed', 'STOCK_ISSUE');
    err.issues = stockIssues;
    throw err;
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
    await saveOrder(order);
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

  const customer = await getCustomer(userId);
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
  await saveOrder(order);
  await saveCart(userId, { items: [] });

  return order;
}

module.exports = { createOrder };
