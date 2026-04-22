const axios = require('axios');
const bcrypt = require('bcrypt');
const {
  getAllOrders, getOrderById, updateOrder,
  getCustomer, getAddressById,
  getVehicles, addVehicle, deleteVehicle, getVehicleById,
  getDrivers, addDriver, softDeleteDriver, getDriverById, updateDriver, updateVehicle,
  getAllHandovers, getHandoverById, updateHandover
} = require('../services/firestoreService');

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
    const { status, date } = req.query;
    let orders = await getAllOrders();

    if (status) orders = orders.filter(o => o.status === status);
    if (date) orders = orders.filter(o => o.createdAt && o.createdAt.startsWith(date));

    const enriched = await Promise.all(orders.map(async (order) => {
      const customer = await getCustomer(order.userId).catch(() => null);
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

    res.json({ success: true, data: { count: enriched.length, orders: enriched } });
  } catch (err) {
    res.status(500).json({ success: false, error: 'SERVER_ERROR', message: err.message });
  }
};

// GET /api/admin/orders/new-count
const getNewOrderCount = async (req, res) => {
  try {
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    const orders = await getAllOrders();
    const newOrders = orders.filter(o =>
      o.status === 'warehouse_review' && o.createdAt > fiveMinutesAgo
    );
    res.json({ success: true, data: { count: newOrders.length, orders: newOrders } });
  } catch (err) {
    res.status(500).json({ success: false, error: 'SERVER_ERROR', message: err.message });
  }
};

// GET /api/admin/orders/:orderId
const getOrderDetail = async (req, res) => {
  try {
    const { orderId } = req.params;
    const order = await getOrderById(orderId);
    if (!order) return res.status(404).json({ success: false, error: 'ORDER_NOT_FOUND', message: 'Order not found' });

    const [customer, address] = await Promise.all([
      getCustomer(order.userId).catch(() => null),
      getAddressById(order.addressId).catch(() => null)
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
    const order = await getOrderById(orderId);
    if (!order) return res.status(404).json({ success: false, error: 'ORDER_NOT_FOUND', message: 'Order not found' });
    if (order.status !== 'warehouse_review') {
      return res.status(400).json({ success: false, error: 'INVALID_STATUS', message: `Order is already ${order.status}` });
    }

    const [customer, address] = await Promise.all([
      getCustomer(order.userId),
      getAddressById(order.addressId)
    ]);

    if (!customer || !customer.zoho_contact_id) {
      return res.status(400).json({ success: false, error: 'CUSTOMER_NOT_FOUND', message: 'Customer Zoho account not found' });
    }

    const zohoSO = await createZohoSalesOrder(
      customer.zoho_contact_id,
      order.items,
      address,
      order.delivery_charge || 0,
      customer.phone || null
    );

    // Write internal orderId to Zoho SO custom field (non-blocking)
    updateZohoSOOrderId(zohoSO.salesorder_id, orderId).catch(err => {
      console.warn('Failed to set Suppliable Order ID on Zoho SO:', err.response?.data || err.message);
    });

    try {
      const confirmResult = await confirmZohoSalesOrder(zohoSO.salesorder_id);
      if (confirmResult.code !== 0) {
        console.error('SO confirm returned non-zero code:', confirmResult);
      }
    } catch (confirmErr) {
      console.error('SO confirm failed (non-fatal):', confirmErr.response?.data || confirmErr.message);
    }

    let zohoInvoice = null;
    try {
      zohoInvoice = await createZohoInvoiceFromSO(zohoSO.salesorder_id);
    } catch (invoiceErr) {
      console.error('Invoice creation failed (non-fatal):', invoiceErr.response?.data || invoiceErr.message);
    }

    if (zohoInvoice?.invoice_id) {
      try {
        await markZohoInvoiceAsSent(zohoInvoice.invoice_id);
        console.log('Invoice marked as sent:', zohoInvoice.invoice_id);
      } catch (sentErr) {
        console.error('Mark invoice as sent failed (non-fatal):', sentErr.response?.data || sentErr.message);
      }
    }

    const deliveryOtp = String(Math.floor(1000 + Math.random() * 9000));

    const updated = await updateOrder(orderId, {
      status: 'accepted',
      zoho_so_id: zohoSO.salesorder_id,
      zoho_so_number: zohoSO.salesorder_number,
      zoho_invoice_id: zohoInvoice?.invoice_id || null,
      zoho_invoice_number: zohoInvoice?.invoice_number || null,
      deliveryOtp,
      acceptedAt: new Date().toISOString()
    });

    res.json({ success: true, data: { order: formatTimestamps(updated) } });
  } catch (err) {
    console.error('acceptOrder error:', err.response?.data || err.message);
    res.status(500).json({ success: false, error: 'SERVER_ERROR', message: err.response?.data?.message || err.message });
  }
};

// POST /api/admin/orders/:orderId/decline
const declineOrder = async (req, res) => {
  try {
    const { orderId } = req.params;
    const order = await getOrderById(orderId);
    if (!order) return res.status(404).json({ success: false, error: 'ORDER_NOT_FOUND', message: 'Order not found' });
    if (order.status !== 'warehouse_review') {
      return res.status(400).json({ success: false, error: 'INVALID_STATUS', message: `Order is already ${order.status}` });
    }

    const updated = await updateOrder(orderId, {
      status: 'declined',
      declinedAt: new Date().toISOString()
    });

    res.json({ success: true, data: { order: formatTimestamps(updated) } });
  } catch (err) {
    res.status(500).json({ success: false, error: 'SERVER_ERROR', message: err.message });
  }
};

// POST /api/admin/orders/:orderId/packed
const markPacked = async (req, res) => {
  try {
    const { orderId } = req.params;
    const order = await getOrderById(orderId);
    if (!order) return res.status(404).json({ success: false, error: 'ORDER_NOT_FOUND', message: 'Order not found' });
    if (order.status !== 'accepted') {
      return res.status(400).json({ success: false, error: 'INVALID_STATUS', message: `Order must be accepted before packing (current: ${order.status})` });
    }

    const updated = await updateOrder(orderId, {
      status: 'ready_for_dispatch',
      packedAt: new Date().toISOString()
    });

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

    const order = await getOrderById(orderId);
    if (!order) return res.status(404).json({ success: false, error: 'ORDER_NOT_FOUND', message: 'Order not found' });
    if (order.status !== 'ready_for_dispatch') {
      return res.status(400).json({ success: false, error: 'INVALID_STATUS', message: `Order must be ready_for_dispatch (current: ${order.status})` });
    }

    const [vehicle, driver] = await Promise.all([
      getVehicleById(vehicleId),
      getDriverById(driverId)
    ]);
    if (!vehicle) return res.status(404).json({ success: false, error: 'VEHICLE_NOT_FOUND', message: 'Vehicle not found' });
    if (!driver) return res.status(404).json({ success: false, error: 'DRIVER_NOT_FOUND', message: 'Driver not found' });

    const driverCount = driver.activeOrderCount ?? 0;
    const vehicleCount = vehicle.activeOrderCount ?? 0;
    if (driverCount >= 2) {
      return res.status(400).json({ success: false, error: 'DRIVER_AT_CAPACITY', message: 'Driver already has 2 active orders' });
    }
    if (vehicleCount >= 2) {
      return res.status(400).json({ success: false, error: 'VEHICLE_AT_CAPACITY', message: 'Vehicle already has 2 active orders' });
    }

    const newDriverCount = driverCount + 1;
    const newVehicleCount = vehicleCount + 1;
    await Promise.all([
      updateVehicle(vehicleId, { isAvailable: newVehicleCount < 2, activeOrderCount: newVehicleCount }),
      updateDriver(driverId, { isAvailable: newDriverCount < 2, activeOrderCount: newDriverCount })
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
    });

    res.json({ success: true, data: { order: formatTimestamps(updated) } });
  } catch (err) {
    res.status(500).json({ success: false, error: 'SERVER_ERROR', message: err.message });
  }
};

// GET /api/admin/orders/:orderId/picking-list
const getPickingList = async (req, res) => {
  try {
    const { orderId } = req.params;
    const order = await getOrderById(orderId);
    if (!order) return res.status(404).json({ success: false, error: 'ORDER_NOT_FOUND', message: 'Order not found' });

    const [customer, address] = await Promise.all([
      getCustomer(order.userId).catch(() => null),
      getAddressById(order.addressId).catch(() => null)
    ]);

    const deliveryAddress = address
      ? [address.flatNo, address.buildingName, address.streetAddress, address.landmark, address.area, address.city, address.pincode]
          .filter(Boolean).join(', ')
      : null;

    const items = order.items.map(item => ({
      productName: item.name,
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
    const order = await getOrderById(orderId);
    if (!order) return res.status(404).json({ success: false, error: 'ORDER_NOT_FOUND', message: 'Order not found' });

    if (!order.zoho_invoice_id) {
      return res.status(404).json({ success: false, error: 'INVOICE_NOT_FOUND', message: 'Invoice not created yet' });
    }

    try {
      const token = await getAccessToken();
      const response = await axios.get(
        `${process.env.ZOHO_API_DOMAIN}/inventory/v1/invoices/${order.zoho_invoice_id}`,
        {
          headers: { Authorization: `Zoho-oauthtoken ${token}` },
          params: { organization_id: process.env.ZOHO_ORG_ID }
        }
      );
      const invoice = response.data.invoice || {};
      const invoiceUrl = invoice.invoice_pdf_url || invoice.pdf_url || invoice.invoice_url
        || `${process.env.ZOHO_API_DOMAIN}/inventory/v1/invoices/${order.zoho_invoice_id}/pdf?organization_id=${process.env.ZOHO_ORG_ID}`;
      return res.json({ success: true, data: { invoiceUrl } });
    } catch (zohoErr) {
      const invoiceUrl = `${process.env.ZOHO_API_DOMAIN}/inventory/v1/invoices/${order.zoho_invoice_id}/pdf?organization_id=${process.env.ZOHO_ORG_ID}`;
      return res.json({ success: true, data: { invoiceUrl } });
    }
  } catch (err) {
    res.status(500).json({ success: false, error: 'SERVER_ERROR', message: err.message });
  }
};

// POST /api/admin/orders/:orderId/fix-invoice
const fixInvoice = async (req, res) => {
  try {
    const { orderId } = req.params;
    const order = await getOrderById(orderId);
    if (!order) return res.status(404).json({ success: false, error: 'ORDER_NOT_FOUND', message: 'Order not found' });
    if (!order.zoho_invoice_id) {
      return res.status(404).json({ success: false, error: 'INVOICE_NOT_FOUND', message: 'No invoice on this order' });
    }
    await markZohoInvoiceAsSent(order.zoho_invoice_id);
    console.log('fix-invoice: marked as sent:', order.zoho_invoice_id);
    res.json({ success: true, message: `Invoice ${order.zoho_invoice_id} marked as sent` });
  } catch (err) {
    console.error('fix-invoice error:', err.response?.data || err.message);
    res.status(500).json({ success: false, error: 'SERVER_ERROR', message: err.response?.data?.message || err.message });
  }
};

// GET /api/admin/cod/pending
const getPendingCOD = async (req, res) => {
  try {
    const orders = await getAllOrders();
    const pending = orders.filter(o =>
      o.paymentType === 'COD' &&
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

    const order = await getOrderById(orderId);
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
    });

    res.json({ success: true, data: { order: formatTimestamps(updated) } });
  } catch (err) {
    res.status(500).json({ success: false, error: 'SERVER_ERROR', message: err.message });
  }
};

// GET /api/admin/vehicles
const listVehicles = async (req, res) => {
  try {
    const vehicles = await getVehicles();
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
    const vehicle = await addVehicle(name.trim());
    res.json({ success: true, data: { vehicle } });
  } catch (err) {
    res.status(500).json({ success: false, error: 'SERVER_ERROR', message: err.message });
  }
};

// DELETE /api/admin/vehicles/:vehicleId
const removeVehicle = async (req, res) => {
  try {
    const { vehicleId } = req.params;
    await deleteVehicle(vehicleId);
    res.json({ success: true, message: 'Vehicle deleted' });
  } catch (err) {
    res.status(500).json({ success: false, error: 'SERVER_ERROR', message: err.message });
  }
};

// GET /api/admin/drivers
const listDrivers = async (req, res) => {
  try {
    const drivers = await getDrivers();
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
    const driver = await addDriver(name.trim(), phone.trim());
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

    const driver = await getDriverById(driverId);
    if (!driver) return res.status(404).json({ success: false, error: 'DRIVER_NOT_FOUND', message: 'Driver not found' });

    const hashedPin = await bcrypt.hash(String(pin), 10);
    await updateDriver(driverId, { pin: hashedPin, pinSetAt: new Date().toISOString() });

    res.json({ success: true, message: `PIN set successfully for ${driver.name}` });
  } catch (err) {
    res.status(500).json({ success: false, error: 'SERVER_ERROR', message: err.message });
  }
};

// DELETE /api/admin/drivers/:driverId
const removeDriver = async (req, res) => {
  try {
    const { driverId } = req.params;
    await softDeleteDriver(driverId);
    res.json({ success: true, message: 'Driver deleted' });
  } catch (err) {
    res.status(500).json({ success: false, error: 'SERVER_ERROR', message: err.message });
  }
};

// GET /api/admin/cod/history
const listCodHistory = async (req, res) => {
  try {
    const { orderId, driverId, date, status } = req.query;

    const [allOrders, handovers] = await Promise.all([
      getAllOrders(),
      getAllHandovers(null)
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
    const { status } = req.query;
    const handovers = await getAllHandovers(status || null);
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

    const handover = await getHandoverById(handoverId);
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
    });

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

// PUT /api/admin/products/:id/featured
const toggleFeatured = async (req, res) => {
  const { id } = req.params;
  const featured = req.body.featured === true || req.body.featured === 'true';
  try {
    await updateZohoItemFeatured(id, featured);
    await setFeatured(id, featured);
    clearCache();
    return res.json({ success: true, featured });
  } catch (err) {
    if (err.response?.data?.code === 2006) {
      try {
        const group = await getZohoItemGroupById(id);
        const groupId = group.group_id || id;
        await Promise.all(group.items.map(item => updateZohoItemFeatured(item.item_id, featured)));
        await setFeatured(groupId, featured);
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
  getNewOrderCount,
  getOrderDetail,
  acceptOrder,
  declineOrder,
  markPacked,
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
