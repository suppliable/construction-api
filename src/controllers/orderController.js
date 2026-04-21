const { getCustomer, getAddressById, saveOrder, getOrdersByUser, getOrderById, getSettings } = require('../services/firestoreService');
const { getCart, saveCart } = require('../data/cart');
const { getProductById } = require('../services/productService');
const { formatTimestamps } = require('../utils/formatDoc');

const STATUS_LABELS = {
  pending_payment: 'Awaiting Payment',
  payment_confirmed: 'Payment Confirmed',
  warehouse_review: 'Order Placed',
  accepted: 'Order Accepted',
  packing: 'Order Accepted',
  ready_for_dispatch: 'Ready for Pickup',
  loading: 'Loading into Vehicle',
  out_for_delivery: 'Out for Delivery',
  arrived: 'Driver has Arrived',
  delivered: 'Delivered',
  declined: 'Order Cancelled'
};

function enrichOrderForCustomer(order) {
  const o = formatTimestamps(order);
  return {
    orderId: o.orderId || null,
    zoho_so_number: o.zoho_so_number || null,
    zoho_invoice_number: o.zoho_invoice_number || null,
    status: o.status || null,
    statusLabel: STATUS_LABELS[o.status] || o.status || null,
    paymentType: o.paymentType || null,
    paymentStatus: o.paymentStatus || null,
    items: o.items || [],
    subtotal: Number(o.subtotal ?? 0),
    gstTotal: Number(o.gst_total ?? 0),
    deliveryCharge: Number(o.delivery_charge ?? o.deliveryCharge ?? 0),
    grandTotal: Number(o.grand_total ?? o.grandTotal ?? 0),
    driverName: o.driverName || o.vehicle?.driverName || null,
    driverPhone: o.driverPhone || o.vehicle?.driverPhone || null,
    deliveryOtp: o.status === 'arrived' ? o.deliveryOtp : undefined,
    estimatedDelivery: o.estimatedDelivery || null,
    createdAt: o.createdAt || null,
    acceptedAt: o.acceptedAt || null,
    declinedAt: o.declinedAt || null,
    deliveredAt: o.deliveredAt || null
  };
}

const createOrder = async (req, res) => {
  try {
    const { userId, addressId, paymentType } = req.body;
    if (!userId) return res.status(400).json({ success: false, error: 'MISSING_PARAM', message: 'userId is required' });
    if (!addressId) return res.status(400).json({ success: false, error: 'MISSING_PARAM', message: 'addressId is required' });
    if (!paymentType || !['COD', 'ONLINE'].includes(paymentType)) {
      return res.status(400).json({ success: false, error: 'INVALID_PARAM', message: 'paymentType must be COD or ONLINE' });
    }

    // 0. Check warehouse is open
    const settings = await getSettings();
    if (settings.warehouseOpen === false) {
      return res.status(400).json({
        success: false,
        error: 'WAREHOUSE_CLOSED',
        message: settings.warehouseClosedMessage || 'We are currently closed.',
        canAddToCart: true
      });
    }

    // 1. Fetch cart
    const cart = await getCart(userId);
    if (!cart.items || cart.items.length === 0) {
      return res.status(400).json({ success: false, error: 'CART_EMPTY', message: 'Cart is empty' });
    }

    // 2. Fetch address
    const address = await getAddressById(addressId);
    if (!address || address.userId !== userId) {
      return res.status(404).json({ success: false, error: 'ADDRESS_NOT_FOUND', message: 'Address not found' });
    }

    // 3. Re-validate stock and build enriched line items
    const stockIssues = [];
    const lineItems = [];

    await Promise.all(cart.items.map(async (cartItem) => {
      const product = await getProductById(cartItem.productId);
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
      return res.status(400).json({ success: false, error: 'STOCK_ISSUE', message: 'Stock validation failed', issues: stockIssues });
    }

    // 4. Compute totals
    const subtotal = parseFloat(lineItems.reduce((sum, i) => sum + i.totalWithoutGST, 0).toFixed(2));
    const gst_total = parseFloat(lineItems.reduce((sum, i) => sum + i.gstAmount, 0).toFixed(2));
    const deliveryCharge = Number(cart.deliveryCharge || cart.delivery_charge || 0);
    const grand_total = parseFloat((subtotal + gst_total + deliveryCharge).toFixed(2));

    // 5. Handle ONLINE payment — save order, skip Zoho
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
      return res.json({
        success: true,
        data: {
          orderId,
          paymentRequired: true,
          paymentStatus: 'pending',
          message: 'Online payment coming soon. Your order is saved.'
        }
      });
    }

    // 6. COD threshold check
    const cod_threshold = settings.cod_threshold ?? 7500;
    if (grand_total > cod_threshold) {
      return res.status(400).json({
        success: false,
        error: 'COD_THRESHOLD_EXCEEDED',
        message: `COD not available for orders above ₹${cod_threshold}. Please use online payment.`
      });
    }

    // 7. Fetch customer record
    const customer = await getCustomer(userId);
    if (!customer) {
      return res.status(400).json({ success: false, error: 'CUSTOMER_NOT_FOUND', message: 'Customer not found' });
    }

    // 8. Save order to Firestore
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

    // 9. Clear cart
    await saveCart(userId, { items: [] });

    res.json({ success: true, data: { order: enrichOrderForCustomer(order) } });
  } catch (err) {
    console.error('createOrder error:', err.response?.data || err.message);
    res.status(500).json({ success: false, error: 'SERVER_ERROR', message: err.response?.data?.message || err.message });
  }
};

const getUserOrders = async (req, res) => {
  try {
    const { userId } = req.params;
    if (!userId) return res.status(400).json({ success: false, error: 'MISSING_PARAM', message: 'userId is required' });
    const orders = await getOrdersByUser(userId);
    res.json({ success: true, data: { orders: orders.map(enrichOrderForCustomer) } });
  } catch (err) {
    res.status(500).json({ success: false, error: 'SERVER_ERROR', message: err.message });
  }
};

const getOrderDetail = async (req, res) => {
  try {
    const { orderId } = req.params;
    const order = await getOrderById(orderId);
    if (!order) return res.status(404).json({ success: false, error: 'ORDER_NOT_FOUND', message: 'Order not found' });
    res.json({ success: true, data: { order: enrichOrderForCustomer(order) } });
  } catch (err) {
    res.status(500).json({ success: false, error: 'SERVER_ERROR', message: err.message });
  }
};

module.exports = { createOrder, getUserOrders, getOrderDetail };
