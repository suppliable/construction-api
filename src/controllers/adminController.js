const {
  getAllOrders, getOrderById, updateOrder,
  getCustomer, getAddressById,
  getVehicles, addVehicle, deleteVehicle, getVehicleById,
  getDrivers, addDriver, softDeleteDriver, getDriverById
} = require('../services/firestoreService');
const { createZohoSalesOrder, confirmZohoSalesOrder, createZohoInvoiceFromSO } = require('../services/zohoOrderService');

// GET /api/admin/orders
const listOrders = async (req, res) => {
  try {
    const { status, date } = req.query;
    let orders = await getAllOrders();

    if (status) {
      orders = orders.filter(o => o.status === status);
    }
    if (date) {
      orders = orders.filter(o => o.createdAt && o.createdAt.startsWith(date));
    }

    // Join customer details
    const enriched = await Promise.all(orders.map(async (order) => {
      const customer = await getCustomer(order.userId).catch(() => null);
      return {
        ...order,
        customer: customer ? { name: customer.name, phone: customer.phone } : null
      };
    }));

    res.json({ success: true, count: enriched.length, orders: enriched });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
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
    res.json({ success: true, count: newOrders.length, orders: newOrders });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// GET /api/admin/orders/:orderId
const getOrderDetail = async (req, res) => {
  try {
    const { orderId } = req.params;
    const order = await getOrderById(orderId);
    if (!order) return res.status(404).json({ success: false, message: 'Order not found' });

    const [customer, address] = await Promise.all([
      getCustomer(order.userId).catch(() => null),
      getAddressById(order.addressId).catch(() => null)
    ]);

    res.json({
      success: true,
      order: {
        ...order,
        customer: customer ? { name: customer.name, phone: customer.phone, email: customer.email || null } : null,
        deliveryAddress: address || null
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// POST /api/admin/orders/:orderId/accept
const acceptOrder = async (req, res) => {
  try {
    const { orderId } = req.params;
    const order = await getOrderById(orderId);
    if (!order) return res.status(404).json({ success: false, message: 'Order not found' });
    if (order.status !== 'warehouse_review') {
      return res.status(400).json({ success: false, message: `Order is already ${order.status}` });
    }

    const [customer, address] = await Promise.all([
      getCustomer(order.userId),
      getAddressById(order.addressId)
    ]);

    if (!customer || !customer.zoho_contact_id) {
      return res.status(400).json({ success: false, message: 'Customer Zoho account not found' });
    }

    // 1. Create Zoho Sales Order
    const zohoSO = await createZohoSalesOrder(
      customer.zoho_contact_id,
      order.items,
      address,
      order.delivery_charge || 0,
      customer.phone || null
    );

    // 2. Confirm the SO (draft → confirmed)
    try {
      const confirmResult = await confirmZohoSalesOrder(zohoSO.salesorder_id);
      if (confirmResult.code !== 0) {
        console.error('SO confirm returned non-zero code:', confirmResult);
      }
    } catch (confirmErr) {
      console.error('SO confirm failed (non-fatal):', confirmErr.response?.data || confirmErr.message);
    }

    // 3. Create invoice from confirmed SO
    let zohoInvoice = null;
    try {
      zohoInvoice = await createZohoInvoiceFromSO(zohoSO.salesorder_id);
    } catch (invoiceErr) {
      console.error('Invoice creation failed (non-fatal):', invoiceErr.response?.data || invoiceErr.message);
    }

    // 4. Generate delivery OTP
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

    res.json({ success: true, order: updated });
  } catch (err) {
    console.error('acceptOrder error:', err.response?.data || err.message);
    res.status(500).json({ success: false, message: err.response?.data?.message || err.message });
  }
};

// POST /api/admin/orders/:orderId/decline
const declineOrder = async (req, res) => {
  try {
    const { orderId } = req.params;
    const order = await getOrderById(orderId);
    if (!order) return res.status(404).json({ success: false, message: 'Order not found' });
    if (order.status !== 'warehouse_review') {
      return res.status(400).json({ success: false, message: `Order is already ${order.status}` });
    }

    const updated = await updateOrder(orderId, {
      status: 'declined',
      declinedAt: new Date().toISOString()
    });

    res.json({ success: true, order: updated });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// POST /api/admin/orders/:orderId/packed
const markPacked = async (req, res) => {
  try {
    const { orderId } = req.params;
    const order = await getOrderById(orderId);
    if (!order) return res.status(404).json({ success: false, message: 'Order not found' });
    if (order.status !== 'accepted') {
      return res.status(400).json({ success: false, message: `Order must be accepted before packing (current: ${order.status})` });
    }

    const updated = await updateOrder(orderId, {
      status: 'ready_for_dispatch',
      packedAt: new Date().toISOString()
    });

    res.json({ success: true, order: updated });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// POST /api/admin/orders/:orderId/assign-vehicle
const assignVehicle = async (req, res) => {
  try {
    const { orderId } = req.params;
    const { vehicleId, driverId } = req.body;

    if (!vehicleId) return res.status(400).json({ success: false, message: 'vehicleId is required' });
    if (!driverId) return res.status(400).json({ success: false, message: 'driverId is required' });

    const order = await getOrderById(orderId);
    if (!order) return res.status(404).json({ success: false, message: 'Order not found' });
    if (order.status !== 'ready_for_dispatch') {
      return res.status(400).json({ success: false, message: `Order must be ready_for_dispatch (current: ${order.status})` });
    }

    const [vehicle, driver] = await Promise.all([
      getVehicleById(vehicleId),
      getDriverById(driverId)
    ]);
    if (!vehicle) return res.status(404).json({ success: false, message: 'Vehicle not found' });
    if (!driver) return res.status(404).json({ success: false, message: 'Driver not found' });

    const { updateVehicle, updateDriver } = require('../services/firestoreService');
    await Promise.all([
      updateVehicle(vehicleId, { isAvailable: false }),
      updateDriver(driverId, { isAvailable: false })
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

    res.json({ success: true, order: updated });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// GET /api/admin/orders/:orderId/picking-list
const getPickingList = async (req, res) => {
  try {
    const { orderId } = req.params;
    const order = await getOrderById(orderId);
    if (!order) return res.status(404).json({ success: false, message: 'Order not found' });

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
      orderId,
      customerName: customer?.name || null,
      zoho_so_number: order.zoho_so_number || null,
      items,
      deliveryAddress,
      grandTotal: order.grand_total
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
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
    res.json({ success: true, count: pending.length, orders: pending });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// POST /api/admin/cod/:orderId/reconcile
const reconcileCOD = async (req, res) => {
  try {
    const { orderId } = req.params;
    const { amountReceived, reconciledBy } = req.body;

    if (amountReceived === undefined || amountReceived === null) {
      return res.status(400).json({ success: false, message: 'amountReceived is required' });
    }

    const order = await getOrderById(orderId);
    if (!order) return res.status(404).json({ success: false, message: 'Order not found' });
    if (order.paymentType !== 'COD') {
      return res.status(400).json({ success: false, message: 'Order is not a COD order' });
    }
    if (order.codCollected) {
      return res.status(400).json({ success: false, message: 'COD already reconciled' });
    }

    const updated = await updateOrder(orderId, {
      codCollected: true,
      codAmount: parseFloat(amountReceived),
      reconciledAt: new Date().toISOString(),
      reconciledBy: reconciledBy || null
    });

    res.json({ success: true, order: updated });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// GET /api/admin/vehicles
const listVehicles = async (req, res) => {
  try {
    const vehicles = await getVehicles();
    res.json({ success: true, vehicles });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// POST /api/admin/vehicles
const createVehicle = async (req, res) => {
  try {
    const { name } = req.body;
    if (!name) return res.status(400).json({ success: false, message: 'name is required' });
    const vehicle = await addVehicle(name.trim());
    res.json({ success: true, vehicle });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// DELETE /api/admin/vehicles/:vehicleId
const removeVehicle = async (req, res) => {
  try {
    const { vehicleId } = req.params;
    await deleteVehicle(vehicleId);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// GET /api/admin/drivers
const listDrivers = async (req, res) => {
  try {
    const drivers = await getDrivers();
    res.json({ success: true, drivers });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// POST /api/admin/drivers
const createDriver = async (req, res) => {
  try {
    const { name, phone } = req.body;
    if (!name) return res.status(400).json({ success: false, message: 'name is required' });
    if (!phone) return res.status(400).json({ success: false, message: 'phone is required' });
    const driver = await addDriver(name.trim(), phone.trim());
    res.json({ success: true, driver });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// DELETE /api/admin/drivers/:driverId
const removeDriver = async (req, res) => {
  try {
    const { driverId } = req.params;
    await softDeleteDriver(driverId);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
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
  getPendingCOD,
  reconcileCOD,
  listVehicles,
  createVehicle,
  removeVehicle,
  listDrivers,
  createDriver,
  removeDriver
};
