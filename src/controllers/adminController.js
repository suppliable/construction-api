const axios = require('axios');
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const { withRetry, DEFAULT_TIMEOUT_MS } = require('../utils/httpClient');
const {
  findOrders, getAllOrders, getOrdersPage, getOrderById, updateOrder,
  getCustomer, getCustomerByPhone, getAddressById, getOrdersByUser,
  getVehicles, addVehicle, deleteVehicle, getVehicleById,
  getDrivers, addDriver, softDeleteDriver, getDriverById, updateDriver, updateVehicle,
  getAllHandovers, getHandoverById, updateHandover
} = require('../services/firestoreService');
const { updateLiveOrderStatus, deleteLiveOrder } = require('../services/realtimeDBService');
const fcm = require('../services/fcmService');

const { DEFAULT_ADMIN_LIST_LIMIT, MAX_ACTIVE_ORDERS_PER_ASSIGNMENT, NEW_ORDER_THRESHOLD_MS } = require('../constants');
const { normalizePhone } = require('../utils/phone');

function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function formatDuration(ms) {
  const totalMins = Math.floor(ms / 60000);
  const h = Math.floor(totalMins / 60);
  const m = totalMins % 60;
  if (h === 0) return `${m}m`;
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}
const { createZohoSalesOrder, confirmZohoSalesOrder, createZohoInvoiceFromSO, updateZohoSOOrderId } = require('../services/zohoOrderService');
const { getAccessToken, updateZohoItemFeatured, getZohoItemGroupById } = require('../services/zohoService');
const { setFeatured } = require('../services/firestoreService');
const { clearCache } = require('../services/productService');
const { formatTimestamps } = require('../utils/formatDoc');

async function markZohoInvoiceAsSent(invoiceId) {
  const token = await getAccessToken();
  await axios.post(
    `${process.env.ZOHO_API_DOMAIN}/inventory/v1/invoices/${invoiceId}/status/sent`,
    {},
    {
      headers: { Authorization: `Zoho-oauthtoken ${token}` },
      params: { organization_id: process.env.ZOHO_ORG_ID }
    }
  );
}

// GET /api/admin/orders
const listOrders = async (req, res) => {
  try {
    const { status, date, startAfter } = req.query;
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 10));

    let orders, hasMore = false, lastOrderId = null;

    if (status || date) {
      let all = await getAllOrders(req.traceContext);
      if (status) all = all.filter(o => o.status === status);
      if (date) all = all.filter(o => o.createdAt && o.createdAt.startsWith(date));
      if (startAfter) {
        const idx = all.findIndex(o => o.orderId === startAfter);
        if (idx >= 0) all = all.slice(idx + 1);
      }
      hasMore = all.length > limit;
      orders = all.slice(0, limit);
      lastOrderId = orders.length ? orders[orders.length - 1].orderId : null;
    } else {
      const page = await getOrdersPage(limit, startAfter || null, req.traceContext);
      orders = page.orders;
      hasMore = page.hasMore;
      lastOrderId = page.lastOrderId;
    }

    const enriched = await Promise.all(orders.map(async (order) => {
      const customer = await getCustomer(order.userId, req.traceContext).catch(() => null);
      const o = formatTimestamps(order);
      const fulfillmentDuration = (o.acceptedAt && o.deliveredAt)
        ? formatDuration(new Date(o.deliveredAt) - new Date(o.acceptedAt))
        : null;
      return {
        ...o,
        acceptedAt: o.acceptedAt || null,
        deliveredAt: o.deliveredAt || null,
        fulfillmentDuration,
        customer: customer ? { name: customer.name, phone: customer.phone } : null
      };
    }));

    res.json({ success: true, data: { count: enriched.length, orders: enriched, hasMore, lastOrderId } });
  } catch (err) {
    res.status(500).json({ success: false, error: 'SERVER_ERROR', message: err.message });
  }
};

// GET /api/admin/orders/stats
const getOrderStats = async (req, res) => {
  try {
    const orders = await getAllOrders(req.traceContext);
    const today = new Date().toISOString().slice(0, 10);
    res.json({
      success: true,
      data: {
        today: orders.filter(o => o.createdAt?.startsWith(today)).length,
        warehouse_review: orders.filter(o => o.status === 'warehouse_review').length,
        out_for_delivery: orders.filter(o => ['out_for_delivery', 'loading', 'arrived'].includes(o.status)).length,
        delivered_today: orders.filter(o => o.status === 'delivered' && o.createdAt?.startsWith(today)).length,
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: 'SERVER_ERROR', message: err.message });
  }
};

// GET /api/admin/orders/new-count
const getNewOrderCount = async (req, res) => {
  try {
    const fiveMinutesAgo = new Date(Date.now() - NEW_ORDER_THRESHOLD_MS).toISOString();
    const newOrders = await findOrders({ status: 'warehouse_review', startISO: fiveMinutesAgo, limit: 0 }, req.traceContext);
    res.json({ success: true, data: { count: newOrders.length, orders: newOrders } });
  } catch (err) {
    res.status(500).json({ success: false, error: 'SERVER_ERROR', message: err.message });
  }
};

// GET /api/admin/orders/:orderId
const getOrderDetail = async (req, res) => {
  try {
    const { orderId } = req.params;
    const order = await getOrderById(orderId, req.traceContext);
    if (!order) return res.status(404).json({ success: false, error: 'ORDER_NOT_FOUND', message: 'Order not found' });

    const [customer, address] = await Promise.all([
      getCustomer(order.userId, req.traceContext).catch(() => null),
      getAddressById(order.addressId, req.traceContext).catch(() => null)
    ]);

    const o = formatTimestamps(order);
    res.json({
      success: true,
      data: {
        order: {
          ...o,
          subtotal: Number(o.subtotal ?? 0),
          gstTotal: Number(o.gst_total ?? 0),
          deliveryCharge: Number(o.delivery_charge ?? o.deliveryCharge ?? 0),
          grandTotal: Number(o.grand_total ?? o.grandTotal ?? 0),
          customer: customer ? { name: customer.name, phone: customer.phone, email: customer.email || null } : null,
          deliveryAddress: address || null
        }
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: 'SERVER_ERROR', message: err.message });
  }
};

// POST /api/admin/orders/:orderId/accept
const acceptOrder = async (req, res) => {
  try {
    const { orderId } = req.params;
    const order = await getOrderById(orderId, req.traceContext);
    if (!order) return res.status(404).json({ success: false, error: 'ORDER_NOT_FOUND', message: 'Order not found' });
    if (order.status !== 'warehouse_review') {
      return res.status(400).json({ success: false, error: 'INVALID_STATUS', message: `Order is already ${order.status}` });
    }

    const [customer, address] = await Promise.all([
      getCustomer(order.userId, req.traceContext),
      getAddressById(order.addressId, req.traceContext)
    ]);

    if (!customer || !customer.zoho_contact_id) {
      return res.status(400).json({ success: false, error: 'CUSTOMER_NOT_FOUND', message: 'Customer Zoho account not found' });
    }

    const zohoSO = await createZohoSalesOrder(
      customer.zoho_contact_id,
      order.items,
      address,
      order.delivery_charge || 0,
      customer.phone || null,
      req.traceContext
    );

    // Write internal orderId to Zoho SO custom field (non-blocking)
    updateZohoSOOrderId(zohoSO.salesorder_id, orderId).catch(err => {
      req.log.warn({ err: err.response?.data || err.message }, 'Failed to set Suppliable Order ID on Zoho SO');
    });

    try {
      const confirmResult = await confirmZohoSalesOrder(zohoSO.salesorder_id, req.traceContext);
      if (confirmResult.code !== 0) {
        req.log.warn({ confirmResult }, 'SO confirm returned non-zero code');
      }
    } catch (confirmErr) {
      req.log.warn({ err: confirmErr.response?.data || confirmErr.message }, 'SO confirm failed (non-fatal)');
    }

    let zohoInvoice = null;
    try {
      zohoInvoice = await createZohoInvoiceFromSO(zohoSO.salesorder_id, req.traceContext);
    } catch (invoiceErr) {
      req.log.warn({ err: invoiceErr.response?.data || invoiceErr.message }, 'Invoice creation failed (non-fatal)');
    }

    if (zohoInvoice?.invoice_id) {
      try {
        await markZohoInvoiceAsSent(zohoInvoice.invoice_id);
        req.log.info({ invoiceId: zohoInvoice.invoice_id }, 'Invoice marked as sent');
      } catch (sentErr) {
        req.log.warn({ err: sentErr.response?.data || sentErr.message }, 'Mark invoice as sent failed (non-fatal)');
      }
    }

    const deliveryOtp = String(crypto.randomInt(1000, 10000));

    const updated = await updateOrder(orderId, {
      status: 'accepted',
      zoho_so_id: zohoSO.salesorder_id,
      zoho_so_number: zohoSO.salesorder_number,
      zoho_invoice_id: zohoInvoice?.invoice_id || null,
      zoho_invoice_number: zohoInvoice?.invoice_number || null,
      deliveryOtp,
      acceptedAt: new Date().toISOString()
    }, req.traceContext);

    if (order.userId) {
      fcm.notifyOrderAccepted(order.userId, orderId)
        .catch(e => req.log.warn({ err: e.message }, '[FCM] notifyOrderAccepted failed (non-fatal)'));
    }

    res.json({ success: true, data: { order: formatTimestamps(updated) } });
  } catch (err) {
    req.log.error({ err: err.response?.data || err.message }, 'acceptOrder failed');
    res.status(500).json({ success: false, error: 'SERVER_ERROR', message: err.response?.data?.message || err.message });
  }
};

// POST /api/admin/orders/:orderId/decline
const declineOrder = async (req, res) => {
  try {
    const { orderId } = req.params;
    const order = await getOrderById(orderId, req.traceContext);
    if (!order) return res.status(404).json({ success: false, error: 'ORDER_NOT_FOUND', message: 'Order not found' });
    if (order.status !== 'warehouse_review') {
      return res.status(400).json({ success: false, error: 'INVALID_STATUS', message: `Order is already ${order.status}` });
    }

    const updated = await updateOrder(orderId, {
      status: 'declined',
      declinedAt: new Date().toISOString()
    }, req.traceContext);

    res.json({ success: true, data: { order: formatTimestamps(updated) } });
  } catch (err) {
    res.status(500).json({ success: false, error: 'SERVER_ERROR', message: err.message });
  }
};

// POST /api/admin/orders/:orderId/packed
const markPacked = async (req, res) => {
  try {
    const { orderId } = req.params;
    const order = await getOrderById(orderId, req.traceContext);
    if (!order) return res.status(404).json({ success: false, error: 'ORDER_NOT_FOUND', message: 'Order not found' });
    if (order.status !== 'accepted') {
      return res.status(400).json({ success: false, error: 'INVALID_STATUS', message: `Order must be accepted before packing (current: ${order.status})` });
    }

    const updated = await updateOrder(orderId, {
      status: 'ready_for_dispatch',
      packedAt: new Date().toISOString()
    }, req.traceContext);

    res.json({ success: true, data: { order: formatTimestamps(updated) } });
  } catch (err) {
    res.status(500).json({ success: false, error: 'SERVER_ERROR', message: err.message });
  }
};

// POST /api/admin/orders/:orderId/assign-vehicle
const assignVehicle = async (req, res) => {
  try {
    const { orderId } = req.params;
    const { vehicleId, driverId } = req.body;

    if (!vehicleId) return res.status(400).json({ success: false, error: 'MISSING_PARAM', message: 'vehicleId is required' });
    if (!driverId) return res.status(400).json({ success: false, error: 'MISSING_PARAM', message: 'driverId is required' });

    const order = await getOrderById(orderId, req.traceContext);
    if (!order) return res.status(404).json({ success: false, error: 'ORDER_NOT_FOUND', message: 'Order not found' });
    if (order.status !== 'ready_for_dispatch') {
      return res.status(400).json({ success: false, error: 'INVALID_STATUS', message: `Order must be ready_for_dispatch (current: ${order.status})` });
    }

    const [vehicle, driver] = await Promise.all([
      getVehicleById(vehicleId, req.traceContext),
      getDriverById(driverId, req.traceContext)
    ]);
    if (!vehicle) return res.status(404).json({ success: false, error: 'VEHICLE_NOT_FOUND', message: 'Vehicle not found' });
    if (!driver) return res.status(404).json({ success: false, error: 'DRIVER_NOT_FOUND', message: 'Driver not found' });

    const driverCount = driver.activeOrderCount ?? 0;
    const vehicleCount = vehicle.activeOrderCount ?? 0;
    if (driverCount >= MAX_ACTIVE_ORDERS_PER_ASSIGNMENT) {
      return res.status(400).json({ success: false, error: 'DRIVER_AT_CAPACITY', message: `Driver already has ${MAX_ACTIVE_ORDERS_PER_ASSIGNMENT} active orders` });
    }
    if (vehicleCount >= MAX_ACTIVE_ORDERS_PER_ASSIGNMENT) {
      return res.status(400).json({ success: false, error: 'VEHICLE_AT_CAPACITY', message: `Vehicle already has ${MAX_ACTIVE_ORDERS_PER_ASSIGNMENT} active orders` });
    }

    const newDriverCount = driverCount + 1;
    const newVehicleCount = vehicleCount + 1;
    await Promise.all([
      updateVehicle(vehicleId, { isAvailable: newVehicleCount < MAX_ACTIVE_ORDERS_PER_ASSIGNMENT, activeOrderCount: newVehicleCount }, req.traceContext),
      updateDriver(driverId, { isAvailable: newDriverCount < MAX_ACTIVE_ORDERS_PER_ASSIGNMENT, activeOrderCount: newDriverCount }, req.traceContext)
    ]);

    const updated = await updateOrder(orderId, {
      status: 'loading',
      vehicleId,
      driverId,
      vehicleName: vehicle.name,
      driverName: driver.name,
      driverPhone: driver.phone,
      vehicle: { vehicleNumber: vehicle.name, driverName: driver.name, driverPhone: driver.phone },
      assignedAt: new Date().toISOString()
    }, req.traceContext);

    res.json({ success: true, data: { order: formatTimestamps(updated) } });
  } catch (err) {
    res.status(500).json({ success: false, error: 'SERVER_ERROR', message: err.message });
  }
};

// GET /api/admin/orders/:orderId/picking-list
const getPickingList = async (req, res) => {
  try {
    const { orderId } = req.params;
    const order = await getOrderById(orderId, req.traceContext);
    if (!order) return res.status(404).json({ success: false, error: 'ORDER_NOT_FOUND', message: 'Order not found' });

    const [customer, address] = await Promise.all([
      getCustomer(order.userId, req.traceContext).catch(() => null),
      getAddressById(order.addressId, req.traceContext).catch(() => null)
    ]);

    const deliveryAddress = address
      ? [address.flatNo, address.buildingName, address.streetAddress, address.landmark, address.area, address.city, address.pincode]
          .filter(Boolean).join(', ')
      : null;

    const items = order.items.map(item => ({
      productName: item.name,
      variantId: item.variantId || null,
      shadeCode: item.shadeCode || null,
      shadeName: item.shadeName || null,
      shadeTier: item.shadeTier || null,
      sku: item.sku || '',
      qty: item.quantity,
      unit: item.unit,
      rackNumber: item.rackNumber || 'Not assigned',
      rate: item.unitPrice,
      total: item.grandTotal
    }));

    res.json({
      success: true,
      data: {
        orderId,
        customerName: customer?.name || null,
        zoho_so_number: order.zoho_so_number || null,
        items,
        deliveryAddress,
        grandTotal: Number(order.grand_total ?? 0)
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: 'SERVER_ERROR', message: err.message });
  }
};

// GET /api/admin/orders/:orderId/invoice-url
const getInvoiceUrl = async (req, res) => {
  try {
    const { orderId } = req.params;
    const order = await getOrderById(orderId, req.traceContext);
    if (!order) return res.status(404).json({ success: false, error: 'ORDER_NOT_FOUND', message: 'Order not found' });

    const soNumber = order.zoho_so_number;
    if (!soNumber && !order.zoho_invoice_id) {
      return res.status(404).json({ success: false, error: 'NO_ZOHO_SO', message: 'No Zoho SO number on this order' });
    }

    // Return cached result if already fetched
    if (order.zohoInvoiceUrl) {
      return res.json({
        success: true,
        invoiceUrl: order.zohoInvoiceUrl,
        invoiceNumber: order.zohoInvoiceNumber || order.zoho_invoice_number || null,
        total: null,
        balance: null,
        status: null
      });
    }

    let token;
    try {
      token = await getAccessToken();
    } catch (authErr) {
      return res.status(500).json({ success: false, error: 'ZOHO_AUTH_ERROR', message: 'Failed to get Zoho access token' });
    }

    const BOOKS_ORG = process.env.ZOHO_ORG_ID;
    let invoice = null;

    // Try direct fetch using stored Books invoice ID
    if (order.zoho_invoice_id) {
      try {
        const resp = await axios.get(
          `https://www.zohoapis.in/books/v3/invoices/${order.zoho_invoice_id}`,
          {
            headers: { Authorization: `Zoho-oauthtoken ${token}` },
            params: { organization_id: BOOKS_ORG }
          }
        );
        invoice = resp.data.invoice || null;
        if (invoice) console.log('[Invoice] Raw Zoho fields:', JSON.stringify(Object.keys(invoice)), '\n[Invoice] URLs:', JSON.stringify({ invoice_url: invoice.invoice_url, client_view_url: invoice.client_view_url, portal_url: invoice.portal_url, invoice_pdf_url: invoice.invoice_pdf_url, payment_url: invoice.payment_url, share_url: invoice.share_url }));
      } catch (e) { /* fall through to search by SO number */ }
    }

    // Fallback: search Books by SO number
    if (!invoice && soNumber) {
      try {
        const searchResp = await axios.get(
          'https://www.zohoapis.in/books/v3/invoices',
          {
            headers: { Authorization: `Zoho-oauthtoken ${token}` },
            params: { organization_id: BOOKS_ORG, salesorder_number: soNumber }
          }
        );
        const invoices = searchResp.data.invoices || [];
        if (invoices.length) {
          const detailResp = await axios.get(
            `https://www.zohoapis.in/books/v3/invoices/${invoices[0].invoice_id}`,
            {
              headers: { Authorization: `Zoho-oauthtoken ${token}` },
              params: { organization_id: BOOKS_ORG }
            }
          );
          invoice = detailResp.data.invoice || null;
        }
      } catch (e) {
        return res.status(502).json({ success: false, error: 'ZOHO_API_ERROR', message: e.response?.data?.message || e.message });
      }
    }

    if (!invoice) {
      return res.status(404).json({ success: false, error: 'NO_INVOICE', message: 'No invoice found for this order in Zoho Books' });
    }

    const invoiceUrl = invoice.invoice_url || invoice.invoice_pdf_url || null;
    if (!invoiceUrl) {
      return res.status(404).json({ success: false, error: 'NO_INVOICE_URL', message: 'Invoice URL not available from Zoho' });
    }

    // Cache in Firestore (non-blocking)
    updateOrder(orderId, {
      zohoInvoiceUrl: invoiceUrl,
      zohoInvoiceNumber: invoice.invoice_number || null,
      zohoInvoiceUpdatedAt: new Date().toISOString()
    }, req.traceContext).catch(() => {});

    return res.json({
      success: true,
      invoiceUrl,
      invoiceNumber: invoice.invoice_number || null,
      total: invoice.total || null,
      balance: invoice.balance || null,
      status: invoice.status || null
    });
  } catch (err) {
    res.status(500).json({ success: false, error: 'SERVER_ERROR', message: err.message });
  }
};

// POST /api/admin/orders/:orderId/fix-invoice
const fixInvoice = async (req, res) => {
  try {
    const { orderId } = req.params;
    const order = await getOrderById(orderId, req.traceContext);
    if (!order) return res.status(404).json({ success: false, error: 'ORDER_NOT_FOUND', message: 'Order not found' });
    if (!order.zoho_invoice_id) {
      return res.status(404).json({ success: false, error: 'INVOICE_NOT_FOUND', message: 'No invoice on this order' });
    }
    await markZohoInvoiceAsSent(order.zoho_invoice_id);
    req.log.info({ invoiceId: order.zoho_invoice_id }, 'fix-invoice: marked as sent');
    res.json({ success: true, message: `Invoice ${order.zoho_invoice_id} marked as sent` });
  } catch (err) {
    req.log.error({ err: err.response?.data || err.message }, 'fix-invoice failed');
    res.status(500).json({ success: false, error: 'SERVER_ERROR', message: err.response?.data?.message || err.message });
  }
};

// GET /api/admin/cod/pending
const getPendingCOD = async (req, res) => {
  try {
    const limit = parsePositiveInt(req.query.limit, DEFAULT_ADMIN_LIST_LIMIT);
    const orders = await findOrders({ status: 'delivered', paymentType: 'COD', limit }, req.traceContext);
    const pending = orders.filter(o =>
      o.codCollected !== true &&
      o.status === 'delivered'
    );
    res.json({ success: true, data: { count: pending.length, orders: pending.map(formatTimestamps) } });
  } catch (err) {
    res.status(500).json({ success: false, error: 'SERVER_ERROR', message: err.message });
  }
};

// POST /api/admin/cod/:orderId/reconcile
const reconcileCOD = async (req, res) => {
  try {
    const { orderId } = req.params;
    const { amountReceived, reconciledBy } = req.body;

    if (amountReceived === undefined || amountReceived === null) {
      return res.status(400).json({ success: false, error: 'MISSING_PARAM', message: 'amountReceived is required' });
    }

    const order = await getOrderById(orderId, req.traceContext);
    if (!order) return res.status(404).json({ success: false, error: 'ORDER_NOT_FOUND', message: 'Order not found' });
    if (order.paymentType !== 'COD') {
      return res.status(400).json({ success: false, error: 'INVALID_PAYMENT_TYPE', message: 'Order is not a COD order' });
    }
    if (order.codCollected) {
      return res.status(400).json({ success: false, error: 'ALREADY_RECONCILED', message: 'COD already reconciled' });
    }

    const updated = await updateOrder(orderId, {
      codCollected: true,
      codAmount: parseFloat(amountReceived),
      reconciledAt: new Date().toISOString(),
      reconciledBy: reconciledBy || null
    }, req.traceContext);

    res.json({ success: true, data: { order: formatTimestamps(updated) } });
  } catch (err) {
    res.status(500).json({ success: false, error: 'SERVER_ERROR', message: err.message });
  }
};

// GET /api/admin/vehicles
const listVehicles = async (req, res) => {
  try {
    const vehicles = await getVehicles(req.traceContext);
    res.json({ success: true, data: { vehicles: vehicles.map(v => ({ ...v, activeOrderCount: v.activeOrderCount ?? 0 })) } });
  } catch (err) {
    res.status(500).json({ success: false, error: 'SERVER_ERROR', message: err.message });
  }
};

// POST /api/admin/vehicles
const createVehicle = async (req, res) => {
  try {
    const { name } = req.body;
    if (!name) return res.status(400).json({ success: false, error: 'MISSING_PARAM', message: 'name is required' });
    const vehicle = await addVehicle(name.trim(), req.traceContext);
    res.json({ success: true, data: { vehicle } });
  } catch (err) {
    res.status(500).json({ success: false, error: 'SERVER_ERROR', message: err.message });
  }
};

// DELETE /api/admin/vehicles/:vehicleId
const removeVehicle = async (req, res) => {
  try {
    const { vehicleId } = req.params;
    await deleteVehicle(vehicleId, req.traceContext);
    res.json({ success: true, message: 'Vehicle deleted' });
  } catch (err) {
    res.status(500).json({ success: false, error: 'SERVER_ERROR', message: err.message });
  }
};

// GET /api/admin/drivers
const listDrivers = async (req, res) => {
  try {
    const drivers = await getDrivers(req.traceContext);
    res.json({ success: true, data: { drivers: drivers.map(d => ({ ...d, activeOrderCount: d.activeOrderCount ?? 0 })) } });
  } catch (err) {
    res.status(500).json({ success: false, error: 'SERVER_ERROR', message: err.message });
  }
};

// POST /api/admin/drivers
const createDriver = async (req, res) => {
  try {
    const { name, phone } = req.body;
    if (!name) return res.status(400).json({ success: false, error: 'MISSING_PARAM', message: 'name is required' });
    if (!phone) return res.status(400).json({ success: false, error: 'MISSING_PARAM', message: 'phone is required' });
    const normalizedPhone = normalizePhone(phone);
    if (!normalizedPhone) return res.status(400).json({ success: false, error: 'INVALID_PHONE', message: 'Valid Indian mobile number required' });
    const driver = await addDriver(name.trim(), normalizedPhone, req.traceContext);
    res.json({ success: true, data: { driver } });
  } catch (err) {
    res.status(500).json({ success: false, error: 'SERVER_ERROR', message: err.message });
  }
};

// POST /api/admin/drivers/:driverId/set-pin
const setDriverPin = async (req, res) => {
  try {
    const { driverId } = req.params;
    const { pin } = req.body;

    if (!pin || !/^\d{4}$/.test(String(pin))) {
      return res.status(400).json({ success: false, error: 'INVALID_PIN', message: 'PIN must be exactly 4 digits' });
    }

    const driver = await getDriverById(driverId, req.traceContext);
    if (!driver) return res.status(404).json({ success: false, error: 'DRIVER_NOT_FOUND', message: 'Driver not found' });

    const hashedPin = await bcrypt.hash(String(pin), 10);
    await updateDriver(driverId, { pin: hashedPin, pinSetAt: new Date().toISOString() }, req.traceContext);

    res.json({ success: true, message: `PIN set successfully for ${driver.name}` });
  } catch (err) {
    res.status(500).json({ success: false, error: 'SERVER_ERROR', message: err.message });
  }
};

// DELETE /api/admin/drivers/:driverId
const removeDriver = async (req, res) => {
  try {
    const { driverId } = req.params;
    await softDeleteDriver(driverId, req.traceContext);
    res.json({ success: true, message: 'Driver deleted' });
  } catch (err) {
    res.status(500).json({ success: false, error: 'SERVER_ERROR', message: err.message });
  }
};

// GET /api/admin/cod/history
const listCodHistory = async (req, res) => {
  try {
    const { orderId, driverId, date, status, limit: limitParam } = req.query;
    const limit = parsePositiveInt(limitParam, DEFAULT_ADMIN_LIST_LIMIT);

    const [allOrders, handovers] = await Promise.all([
      orderId
        ? getOrderById(orderId, req.traceContext).then(order => (order ? [order] : []))
        : findOrders({ status: 'delivered', paymentType: 'COD', driverId, date, limit }, req.traceContext),
      getAllHandovers(status || null, req.traceContext, { driverId, date, limit })
    ]);

    // Order-level COD records (delivered COD orders with codCollectedByDriver)
    const orderRecords = allOrders
      .filter(o => o.paymentType === 'COD' && o.status === 'delivered' && o.driverId)
      .map(o => ({
        type: 'order',
        orderId: o.orderId,
        driverName: o.driverName || '',
        driverId: o.driverId || '',
        amount: o.codAmountCollected || o.codAmount || 0,
        status: o.codCollected ? 'reconciled' : 'delivered',
        date: (o.reconciledAt || o.deliveredAt || '').slice(0, 10),
        reconciledBy: o.reconciledBy || null,
        createdAt: o.reconciledAt || o.deliveredAt || o.createdAt
      }));

    // Handover records
    const handoverRecords = handovers.map(h => ({
      type: 'handover',
      orderId: null,
      handoverId: h.handoverId,
      driverName: h.driverName || '',
      driverId: h.driverId || '',
      amount: h.totalAmount,
      status: h.status,
      date: h.date,
      notes: h.notes || '',
      reconciledBy: null,
      createdAt: h.createdAt
    }));

    let records = [...orderRecords, ...handoverRecords];

    if (orderId) records = records.filter(r => r.orderId === orderId);
    if (driverId) records = records.filter(r => r.driverId === driverId);
    if (date) records = records.filter(r => r.date === date);
    if (status) records = records.filter(r => r.status === status);

    records.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));

    res.json({ success: true, data: { count: records.length, records } });
  } catch (err) {
    res.status(500).json({ success: false, error: 'SERVER_ERROR', message: err.message });
  }
};

// GET /api/admin/cod/handovers
const listHandovers = async (req, res) => {
  try {
    const { status, limit: limitParam } = req.query;
    const limit = parsePositiveInt(limitParam, DEFAULT_ADMIN_LIST_LIMIT);
    const handovers = await getAllHandovers(status || null, req.traceContext, { limit });
    res.json({ success: true, data: { handovers } });
  } catch (err) {
    res.status(500).json({ success: false, error: 'SERVER_ERROR', message: err.message });
  }
};

// POST /api/admin/cod/confirm-handover/:handoverId
const confirmHandover = async (req, res) => {
  try {
    const { handoverId } = req.params;
    const { amountReceived, notes } = req.body;

    const handover = await getHandoverById(handoverId, req.traceContext);
    if (!handover) {
      return res.status(404).json({ error: 'HANDOVER_NOT_FOUND', message: 'Handover not found' });
    }
    if (handover.status !== 'pending') {
      return res.status(400).json({ error: 'ALREADY_CONFIRMED', message: 'Handover already confirmed' });
    }

    await updateHandover(handoverId, {
      status: 'confirmed',
      amountReceived: amountReceived ?? null,
      confirmedNotes: notes || '',
      confirmedAt: new Date().toISOString()
    }, req.traceContext);

    res.json({
      success: true,
      data: {
        handoverId,
        status: 'confirmed',
        amountReceived: amountReceived ?? null
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: 'SERVER_ERROR', message: err.message });
  }
};

// GET /api/admin/customers/phone/:phone
const getCustomerByPhoneNumber = async (req, res) => {
  try {
    const { phone } = req.params;
    const normalizedPhone = normalizePhone(phone);
    if (!normalizedPhone) return res.status(400).json({ success: false, error: 'INVALID_PHONE', message: 'Valid Indian mobile number required' });
    const customer = await getCustomerByPhone(normalizedPhone, req.traceContext);
    if (!customer) return res.status(404).json({ success: false, error: 'CUSTOMER_NOT_FOUND', message: 'No customer found with that phone number' });
    res.json({ success: true, data: { customer } });
  } catch (err) {
    res.status(500).json({ success: false, error: 'SERVER_ERROR', message: err.message });
  }
};

// GET /api/admin/customers/:userId/orders?limit=10
const getCustomerOrders = async (req, res) => {
  try {
    const { userId } = req.params;
    const limit = Math.max(0, parseInt(req.query.limit, 10) || 10);
    const orders = await getOrdersByUser(userId, limit, req.traceContext);
    res.json({ success: true, data: { count: orders.length, orders: orders.map(formatTimestamps) } });
  } catch (err) {
    res.status(500).json({ success: false, error: 'SERVER_ERROR', message: err.message });
  }
};

// POST /api/admin/orders/:orderId/force-complete
const forceCompleteOrder = async (req, res) => {
  try {
    const { orderId } = req.params;
    const { reason, note } = req.body;

    const VALID_REASONS = ['driver_app_issue', 'phone_issue', 'technical_error', 'other'];
    if (!reason || !VALID_REASONS.includes(reason)) {
      return res.status(400).json({ success: false, error: 'INVALID_REASON', message: `reason must be one of: ${VALID_REASONS.join(', ')}` });
    }

    const order = await getOrderById(orderId, req.traceContext);
    if (!order) return res.status(404).json({ success: false, error: 'ORDER_NOT_FOUND', message: 'Order not found' });

    if (!['out_for_delivery', 'arrived'].includes(order.status)) {
      return res.status(400).json({ success: false, error: 'ORDER_NOT_IN_DELIVERY', message: `Cannot force complete order in ${order.status} status` });
    }

    const now = new Date().toISOString();
    await updateOrder(orderId, {
      status: 'delivered',
      deliveredAt: now,
      deliveryPhotoUrl: null,
      otpVerified: false,
      forcedComplete: true,
      forcedBy: 'admin',
      forceReason: reason,
      forceNote: note || null,
      forcedAt: now
    }, req.traceContext);

    if (order.driverId) {
      const driver = await getDriverById(order.driverId, req.traceContext).catch(() => null);
      if (driver) {
        const count = Math.max(0, (driver.activeOrderCount ?? 1) - 1);
        await updateDriver(order.driverId, { activeOrderCount: count, isAvailable: count < 2 }, req.traceContext).catch(() => {});
      }
    }
    if (order.vehicleId) {
      const vehicle = await getVehicleById(order.vehicleId, req.traceContext).catch(() => null);
      if (vehicle) {
        const count = Math.max(0, (vehicle.activeOrderCount ?? 1) - 1);
        await updateVehicle(order.vehicleId, { activeOrderCount: count, isAvailable: count < 2 }, req.traceContext).catch(() => {});
      }
    }

    updateLiveOrderStatus(orderId, 'delivered')
      .then(() => setTimeout(() => deleteLiveOrder(orderId).catch(() => {}), 60000))
      .catch(() => {});

    if (order.userId) {
      fcm.notifyDelivered(order.userId, orderId)
        .catch(e => console.warn('[FCM] notifyDelivered (force) failed:', e.message));
    }

    res.json({ success: true, data: { order: { orderId, status: 'delivered', forcedComplete: true } } });
  } catch (err) {
    res.status(500).json({ success: false, error: 'SERVER_ERROR', message: err.message });
  }
};

// POST /api/admin/orders/:orderId/cancel
const cancelOrder = async (req, res) => {
  try {
    const { orderId } = req.params;
    const { reason, note } = req.body;

    const VALID_REASONS = ['customer_request', 'out_of_stock', 'address_issue', 'payment_issue', 'other'];
    if (!reason || !VALID_REASONS.includes(reason)) {
      return res.status(400).json({ success: false, error: 'INVALID_REASON', message: `reason must be one of: ${VALID_REASONS.join(', ')}` });
    }

    const CANCELLABLE = ['warehouse_review', 'accepted', 'ready_for_dispatch', 'loading'];

    const order = await getOrderById(orderId, req.traceContext);
    if (!order) return res.status(404).json({ success: false, error: 'ORDER_NOT_FOUND', message: 'Order not found' });

    if (!CANCELLABLE.includes(order.status)) {
      return res.status(400).json({
        success: false,
        error: 'ORDER_NOT_CANCELLABLE',
        message: `Cannot cancel order in ${order.status} status`
      });
    }

    await updateOrder(orderId, {
      status: 'cancelled',
      cancelledAt: new Date().toISOString(),
      cancelledBy: 'admin',
      cancellationReason: reason,
      cancellationNote: note || null,
      zohoVoidRequired: true
    }, req.traceContext);

    if (order.driverId) {
      const driver = await getDriverById(order.driverId, req.traceContext).catch(() => null);
      if (driver) {
        const count = Math.max(0, (driver.activeOrderCount ?? 1) - 1);
        await updateDriver(order.driverId, { activeOrderCount: count, isAvailable: count < 2 }, req.traceContext).catch(() => {});
      }
    }
    if (order.vehicleId) {
      const vehicle = await getVehicleById(order.vehicleId, req.traceContext).catch(() => null);
      if (vehicle) {
        const count = Math.max(0, (vehicle.activeOrderCount ?? 1) - 1);
        await updateVehicle(order.vehicleId, { activeOrderCount: count, isAvailable: count < 2 }, req.traceContext).catch(() => {});
      }
    }

    if (order.userId) {
      fcm.notifyOrderCancelled(order.userId, orderId)
        .catch(e => console.warn('[FCM] notifyOrderCancelled failed:', e.message));
    }

    res.json({
      success: true,
      data: {
        order: { orderId, status: 'cancelled' },
        zohoNote: `Zoho SO must be manually voided in Zoho Inventory for order ${orderId}`
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: 'SERVER_ERROR', message: err.message });
  }
};

// PUT /api/admin/products/:id/featured
const toggleFeatured = async (req, res) => {
  const { id } = req.params;
  const featured = req.body.featured === true || req.body.featured === 'true';
  try {
    await updateZohoItemFeatured(id, featured);
    await setFeatured(id, featured, req.traceContext);
    clearCache();
    return res.json({ success: true, featured });
  } catch (err) {
    if (err.response?.data?.code === 2006) {
      try {
        const group = await getZohoItemGroupById(id);
        const groupId = group.group_id || id;
        await Promise.all(group.items.map(item => updateZohoItemFeatured(item.item_id, featured)));
        await setFeatured(groupId, featured, req.traceContext);
        clearCache();
        return res.json({ success: true, featured });
      } catch (groupErr) {
        return res.status(500).json({ success: false, message: groupErr.message });
      }
    }
    return res.status(500).json({ success: false, message: err.message });
  }
};

module.exports = {
  listOrders,
  getOrderStats,
  getNewOrderCount,
  getOrderDetail,
  acceptOrder,
  declineOrder,
  markPacked,
  forceCompleteOrder,
  cancelOrder,
  getCustomerByPhoneNumber,
  getCustomerOrders,
  assignVehicle,
  getPickingList,
  getInvoiceUrl,
  fixInvoice,
  getPendingCOD,
  reconcileCOD,
  listVehicles,
  createVehicle,
  removeVehicle,
  listDrivers,
  createDriver,
  removeDriver,
  setDriverPin,
  listHandovers,
  confirmHandover,
  listCodHistory,
  toggleFeatured
};
