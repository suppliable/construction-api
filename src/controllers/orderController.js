const axios = require('axios');
const { getOrdersByUser, getOrderById, getAddressById } = require('../services/firestoreService');
const { getAccessToken } = require('../services/zohoService');
const { toOrderDTO } = require('../models/orderDTO');
const { createOrder: createOrderService } = require('../services/orderService');
const { withRetry, DEFAULT_TIMEOUT_MS } = require('../utils/httpClient');

const { DEFAULT_USER_ORDER_LIMIT } = require('../constants');

function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

const createOrder = async (req, res) => {
  try {
    const order = await createOrderService(req.body, req.traceContext, req.log);

    if (order.paymentType === 'ONLINE') {
      return res.json({
        success: true,
        data: {
          orderId: order.orderId,
          paymentRequired: true,
          paymentStatus: 'pending',
          message: 'Online payment coming soon. Your order is saved.'
        }
      });
    }

    res.json({ success: true, data: { order: toOrderDTO(order) } });
  } catch (err) {
    if (err.statusCode) {
      const body = { success: false, error: err.code, message: err.message };
      if (err.issues) body.issues = err.issues;
      if (err.canAddToCart) body.canAddToCart = true;
      return res.status(err.statusCode).json(body);
    }
    req.log.error({ err: err.response?.data || err.message }, 'createOrder failed');
    res.status(500).json({ success: false, error: 'SERVER_ERROR', message: err.response?.data?.message || err.message });
  }
};

const getUserOrders = async (req, res) => {
  try {
    const { userId } = req.params;
    if (!userId) return res.status(400).json({ success: false, error: 'MISSING_PARAM', message: 'userId is required' });
    const limit = parsePositiveInt(req.query.limit, DEFAULT_USER_ORDER_LIMIT);
    const orders = await getOrdersByUser(userId, limit, req.traceContext);
    const enriched = await Promise.all(orders.map(async (o) => {
      if (!o.addressId || o.deliveryAddress) return o;
      const addr = await getAddressById(o.addressId, req.traceContext).catch(() => null);
      return addr ? { ...o, deliveryAddress: addr } : o;
    }));
    res.json({ success: true, data: { orders: enriched.map(toOrderDTO) } });
  } catch (err) {
    res.status(500).json({ success: false, error: 'SERVER_ERROR', message: err.message });
  }
};

const getOrderDetail = async (req, res) => {
  try {
    const { orderId } = req.params;
    const order = await getOrderById(orderId, req.traceContext);
    if (!order) return res.status(404).json({ success: false, error: 'ORDER_NOT_FOUND', message: 'Order not found' });

    const address = (!order.deliveryAddress && order.addressId)
      ? await getAddressById(order.addressId, req.traceContext).catch(() => null)
      : null;
    const dto = toOrderDTO(address ? { ...order, deliveryAddress: address } : order);

    // Provide Realtime DB path when order is actively being delivered
    const liveStatuses = ['out_for_delivery', 'arrived'];
    if (liveStatuses.includes(order.status) && process.env.FIREBASE_DATABASE_URL) {
      dto.liveTrackingPath = `liveOrders/${orderId}`;
      dto.realtimeDbUrl = process.env.FIREBASE_DATABASE_URL.trim();
    }

    res.json({ success: true, data: { order: dto } });
  } catch (err) {
    res.status(500).json({ success: false, error: 'SERVER_ERROR', message: err.message });
  }
};

const getCustomerInvoice = async (req, res) => {
  try {
    const { orderId } = req.params;
    if (!orderId || !orderId.startsWith('ORD')) {
      return res.status(400).json({ success: false, error: 'INVALID_PARAM', message: 'Invalid orderId' });
    }
    const order = await getOrderById(orderId, req.traceContext);
    if (!order) return res.status(404).json({ success: false, error: 'ORDER_NOT_FOUND', message: 'Order not found' });

    if (!order.zoho_invoice_id) {
      return res.status(404).json({ success: false, message: 'Invoice not available yet' });
    }

    try {
      const token = await getAccessToken();
      const response = await withRetry('zoho.api.getInvoice', () =>
        axios.get(
          `${process.env.ZOHO_API_DOMAIN}/inventory/v1/invoices/${order.zoho_invoice_id}`,
          {
            headers: { Authorization: `Zoho-oauthtoken ${token}` },
            params: { organization_id: process.env.ZOHO_ORG_ID },
            timeout: DEFAULT_TIMEOUT_MS,
          }
        ), { log: req.log }
      );
      const invoice = response.data.invoice || {};
      const invoiceUrl = invoice.invoice_pdf_url || invoice.pdf_url || invoice.invoice_url
        || `${process.env.ZOHO_API_DOMAIN}/inventory/v1/invoices/${order.zoho_invoice_id}/pdf?organization_id=${process.env.ZOHO_ORG_ID}`;
      return res.json({ success: true, invoiceUrl });
    } catch (_zohoErr) {
      const invoiceUrl = `${process.env.ZOHO_API_DOMAIN}/inventory/v1/invoices/${order.zoho_invoice_id}/pdf?organization_id=${process.env.ZOHO_ORG_ID}`;
      return res.json({ success: true, invoiceUrl });
    }
  } catch (err) {
    res.status(500).json({ success: false, error: 'SERVER_ERROR', message: err.message });
  }
};

module.exports = { createOrder, getUserOrders, getOrderDetail, getCustomerInvoice };
