const multer = require('multer');
const bcrypt = require('bcrypt');
const { getOrderById, updateOrder, getAddressById, updateVehicle, updateDriver, getDriverByPhone, getDriverById, getVehicleById, getOrdersByDriver, createHandover, getHandoversByDriver, getAllHandoversForDriver } = require('../services/firestoreService');
const { getETA } = require('../services/googleMapsService');
const { uploadToFirebase } = require('../services/storageService');
const { updateZohoShipment } = require('../services/zohoOrderService');
const { formatTimestamps } = require('../utils/formatDoc');

const upload = multer({ storage: multer.memoryStorage() });

// POST /api/driver/auth
const driverAuth = async (req, res) => {
  try {
    const { phone, pin } = req.body;
    if (!phone || !pin) {
      return res.status(400).json({ success: false, error: 'MISSING_PARAM', message: 'phone and pin are required' });
    }

    const driver = await getDriverByPhone(phone, req.traceContext);

    if (!driver) {
      return res.status(401).json({ success: false, error: 'DRIVER_NOT_FOUND', message: 'Phone number not registered as a driver' });
    }
    if (!driver.isActive) {
      return res.status(401).json({ success: false, error: 'DRIVER_INACTIVE', message: 'Your account is inactive. Contact admin.' });
    }
    if (!driver.pin) {
      return res.status(401).json({ success: false, error: 'PIN_NOT_SET', message: 'PIN not set. Contact admin.' });
    }

    const pinMatch = await bcrypt.compare(String(pin), driver.pin);
    if (!pinMatch) {
      return res.status(401).json({ success: false, error: 'INVALID_PIN', message: 'Incorrect PIN. Please try again.' });
    }

    const token = Buffer.from(`${driver.driverId}:${driver.phone}:${Date.now()}`).toString('base64');
    await updateDriver(driver.driverId, { currentToken: token, lastLoginAt: new Date().toISOString() }, req.traceContext);

    res.json({
      success: true,
      data: {
        driverId: driver.driverId,
        name: driver.name,
        phone: driver.phone,
        token,
        isActive: driver.isActive,
        isAvailable: driver.isAvailable
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: 'SERVER_ERROR', message: err.message });
  }
};

// POST /api/driver/orders/:orderId/loading-complete
const loadingComplete = async (req, res) => {
  try {
    const { orderId } = req.params;
    const order = await getOrderById(orderId, req.traceContext);
    if (!order) return res.status(404).json({ success: false, error: 'ORDER_NOT_FOUND', message: 'Order not found' });
    if (order.status !== 'loading') {
      return res.status(400).json({ success: false, error: 'INVALID_STATUS', message: `Order must be in loading status (current: ${order.status})` });
    }
    const updated = await updateOrder(orderId, {
      status: 'out_for_delivery',
      loadingCompleteAt: new Date().toISOString()
    }, req.traceContext);
    res.json({ success: true, data: { order: formatTimestamps(updated) } });
  } catch (err) {
    res.status(500).json({ success: false, error: 'SERVER_ERROR', message: err.message });
  }
};

// GET /api/driver/orders/:orderId/eta
const getEta = async (req, res) => {
  try {
    const { orderId } = req.params;
    const order = await getOrderById(orderId, req.traceContext);
    if (!order) return res.status(404).json({ success: false, error: 'ORDER_NOT_FOUND', message: 'Order not found' });

    const address = await getAddressById(order.addressId, req.traceContext);
    if (!address) return res.status(404).json({ success: false, error: 'ADDRESS_NOT_FOUND', message: 'Delivery address not found' });

    if (!process.env.GOOGLE_MAPS_API_KEY) {
      return res.status(503).json({ success: false, error: 'SERVICE_UNAVAILABLE', message: 'Google Maps API key not configured' });
    }

    const addressString = [address.streetAddress, address.city, address.state, address.pincode]
      .filter(Boolean).join(', ');

    const eta = await getETA(addressString, req.traceContext);
    res.json({ success: true, data: eta });
  } catch (err) {
    res.status(500).json({ success: false, error: 'SERVER_ERROR', message: err.message });
  }
};

// POST /api/driver/orders/:orderId/arrived
const arrived = async (req, res) => {
  try {
    const { orderId } = req.params;
    const order = await getOrderById(orderId, req.traceContext);
    if (!order) return res.status(404).json({ success: false, error: 'ORDER_NOT_FOUND', message: 'Order not found' });
    if (order.status !== 'out_for_delivery') {
      return res.status(400).json({ success: false, error: 'INVALID_STATUS', message: `Order must be out_for_delivery (current: ${order.status})` });
    }
    const updated = await updateOrder(orderId, {
      status: 'arrived',
      arrivedAt: new Date().toISOString()
    }, req.traceContext);
    res.json({ success: true, data: { order: formatTimestamps(updated) } });
  } catch (err) {
    res.status(500).json({ success: false, error: 'SERVER_ERROR', message: err.message });
  }
};

// POST /api/driver/orders/:orderId/cod-collected
const codCollected = async (req, res) => {
  try {
    const { orderId } = req.params;
    const { amount } = req.body;
    const order = await getOrderById(orderId, req.traceContext);
    if (!order) return res.status(404).json({ success: false, error: 'ORDER_NOT_FOUND', message: 'Order not found' });
    if (order.paymentType !== 'COD') {
      return res.status(400).json({ success: false, error: 'NOT_COD_ORDER', message: 'Order is not a COD order' });
    }
    if (order.status !== 'arrived') {
      return res.status(400).json({ success: false, error: 'INVALID_STATUS', message: `Order must be in arrived status (current: ${order.status})` });
    }
    if (amount === undefined || amount === null) {
      return res.status(400).json({ success: false, error: 'MISSING_PARAM', message: 'amount is required' });
    }
    const updated = await updateOrder(orderId, {
      codCollectedByDriver: true,
      codAmountCollected: parseFloat(amount),
      codCollectedAt: new Date().toISOString()
    }, req.traceContext);
    res.json({ success: true, data: { order: formatTimestamps(updated) } });
  } catch (err) {
    res.status(500).json({ success: false, error: 'SERVER_ERROR', message: err.message });
  }
};

// POST /api/driver/orders/:orderId/complete
const completeDelivery = [
  upload.single('photo'),
  async (req, res) => {
    try {
      const { orderId } = req.params;
      const { otp } = req.body;

      const order = await getOrderById(orderId, req.traceContext);
      if (!order) return res.status(404).json({ success: false, error: 'ORDER_NOT_FOUND', message: 'Order not found' });
      if (order.status !== 'arrived') {
        return res.status(400).json({ success: false, error: 'INVALID_STATUS', message: `Order must be in arrived status (current: ${order.status})` });
      }

      if (order.paymentType === 'COD' && !order.codCollectedByDriver) {
        return res.status(400).json({ success: false, error: 'COD_NOT_COLLECTED', message: 'COD payment must be collected before completing delivery' });
      }

      if (!otp) return res.status(400).json({ success: false, error: 'MISSING_PARAM', message: 'otp is required' });
      if (String(otp) !== String(order.deliveryOtp)) {
        return res.status(400).json({ success: false, error: 'INVALID_OTP', message: 'Invalid OTP' });
      }

      if (!req.file) return res.status(400).json({ success: false, error: 'MISSING_PARAM', message: 'photo is required' });
      const deliveryPhotoUrl = await uploadToFirebase(req.file.buffer, req.file.mimetype, 'deliveries');

      const updated = await updateOrder(orderId, {
        status: 'delivered',
        deliveredAt: new Date().toISOString(),
        deliveryPhotoUrl,
        otpVerified: true
      }, req.traceContext);

      if (order.zoho_so_id) {
        updateZohoShipment(order.zoho_so_id, req.traceContext).catch(err => {
          req.log.warn({ err: err.response?.data || err.message }, 'Zoho shipment update failed (non-fatal)');
        });
      }

      if (order.vehicleId) {
        (async () => {
          try {
            const v = await getVehicleById(order.vehicleId, req.traceContext);
            const newCount = Math.max(0, (v?.activeOrderCount ?? 1) - 1);
            await updateVehicle(order.vehicleId, { isAvailable: newCount < 2, activeOrderCount: newCount }, req.traceContext);
          } catch (e) { req.log.warn({ err: e.message }, 'Vehicle count decrement failed'); }
        })();
      }
      if (order.driverId) {
        (async () => {
          try {
            const d = await getDriverById(order.driverId, req.traceContext);
            const newCount = Math.max(0, (d?.activeOrderCount ?? 1) - 1);
            await updateDriver(order.driverId, { isAvailable: newCount < 2, activeOrderCount: newCount }, req.traceContext);
          } catch (e) { req.log.warn({ err: e.message }, 'Driver count decrement failed'); }
        })();
      }

      res.json({ success: true, data: { order: formatTimestamps(updated) } });
    } catch (err) {
      res.status(500).json({ success: false, error: 'SERVER_ERROR', message: err.message });
    }
  }
];

const STATUS_LABELS = {
  accepted: 'Order Accepted',
  ready_for_dispatch: 'Ready for Dispatch',
  loading: 'Loading',
  out_for_delivery: 'Out for Delivery',
  arrived: 'Arrived',
  delivered: 'Delivered',
  declined: 'Declined'
};

// GET /api/driver/orders/today
// Note: endpoint name kept for Flutter compatibility — now returns ALL incomplete
// orders (status not delivered/declined), not just today's
const getTodayOrders = async (req, res) => {
  try {
    const { driverId } = req.driver;
    const allOrders = await getOrdersByDriver(driverId, null, null, req.traceContext);

    const DONE = ['delivered', 'declined'];
    const todayOrders = allOrders.filter(o => !DONE.includes(o.status));

    todayOrders.sort((a, b) => (a.assignedAt || '').localeCompare(b.assignedAt || ''));

    const orders = await Promise.all(todayOrders.map(async (o) => {
      const address = o.addressId ? await getAddressById(o.addressId, req.traceContext).catch(() => null) : null;
      const parts = [address?.flatNo, address?.buildingName, address?.streetAddress, address?.city, address?.pincode].filter(Boolean);
      const lat = address?.latitude;
      const lng = address?.longitude;

      return {
        orderId: o.orderId,
        status: o.status,
        statusLabel: STATUS_LABELS[o.status] || o.status,
        customerName: o.customerName || '',
        customerPhone: o.customerPhone || '',
        deliveryAddress: {
          fullAddress: parts.join(', '),
          latitude: lat || null,
          longitude: lng || null,
          googleMapsUrl: lat && lng ? `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}` : null
        },
        items: (o.items || []).map(i => ({ productName: i.productName || i.name, quantity: i.quantity, unit: i.unit || '' })),
        itemCount: (o.items || []).length,
        grandTotal: o.grand_total ?? o.grandTotal ?? 0,
        deliveryCharge: o.delivery_charge ?? o.deliveryCharge ?? 0,
        paymentType: o.paymentType || '',
        paymentStatus: o.paymentStatus || '',
        codCollected: o.codCollectedByDriver || false,
        codAmountToCollect: o.paymentType === 'COD' ? (o.grand_total ?? o.grandTotal ?? 0) : 0,
        assignedAt: o.assignedAt || null
      };
    }));

    res.json({ success: true, data: { orders, count: orders.length } });
  } catch (err) {
    res.status(500).json({ success: false, error: 'SERVER_ERROR', message: err.message });
  }
};

// GET /api/driver/profile
const getDriverProfile = async (req, res) => {
  try {
    const { driverId } = req.driver;
    const driver = await getDriverById(driverId, req.traceContext);
    if (!driver) return res.status(404).json({ success: false, error: 'DRIVER_NOT_FOUND', message: 'Driver not found' });

    const allDriverOrders = await getOrdersByDriver(driverId, null, null, req.traceContext);
    const todayIST = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }).split(',')[0];
    const todayOrders = allDriverOrders.filter(o => {
      if (!o.assignedAt) return false;
      return new Date(o.assignedAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }).split(',')[0] === todayIST;
    });
    const deliveredOrders = todayOrders.filter(o => o.status === 'delivered');
    const pendingOrders = todayOrders.filter(o => o.status !== 'delivered' && o.status !== 'declined');
    const todayCodCollected = deliveredOrders
      .filter(o => o.paymentType === 'COD' && o.codCollectedByDriver)
      .reduce((sum, o) => sum + (o.codAmountCollected || 0), 0);

    res.json({
      success: true,
      data: {
        driverId: driver.driverId,
        name: driver.name,
        phone: driver.phone,
        isActive: driver.isActive,
        isAvailable: driver.isAvailable,
        todayStats: {
          totalOrders: todayOrders.length,
          deliveredOrders: deliveredOrders.length,
          pendingOrders: pendingOrders.length,
          todayCodCollected
        }
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: 'SERVER_ERROR', message: err.message });
  }
};

// PATCH /api/driver/status
const updateDriverStatus = async (req, res) => {
  try {
    const { driverId } = req.driver;
    const { isAvailable } = req.body;

    if (req.body.isAvailable === undefined) {
      return res.status(400).json({ success: false, error: 'MISSING_PARAM', message: 'isAvailable is required' });
    }
    if (typeof isAvailable !== 'boolean') {
      return res.status(400).json({ success: false, error: 'INVALID_PARAM', message: 'isAvailable must be true or false' });
    }

    if (!isAvailable) {
      const IN_PROGRESS = ['loading', 'out_for_delivery', 'arrived'];
      const allOrders = await getOrdersByDriver(driverId, null, null, req.traceContext);
      const hasActive = allOrders.some(o => IN_PROGRESS.includes(o.status));
      if (hasActive) {
        return res.status(400).json({ success: false, error: 'ORDER_IN_PROGRESS', message: 'Cannot go offline while an order is in progress' });
      }
    }

    await updateDriver(driverId, { isAvailable }, req.traceContext);
    const driver = await getDriverById(driverId, req.traceContext);

    res.json({
      success: true,
      data: {
        driverId: driver.driverId,
        name: driver.name,
        isAvailable: driver.isAvailable
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: 'SERVER_ERROR', message: err.message });
  }
};

// GET /api/driver/orders/:orderId
const getDriverOrderDetail = async (req, res) => {
  try {
    const { orderId } = req.params;
    const order = await getOrderById(orderId, req.traceContext);
    if (!order) return res.status(404).json({ success: false, error: 'ORDER_NOT_FOUND', message: 'Order not found' });

    if (order.driverId !== req.driver.driverId) {
      return res.status(403).json({ success: false, error: 'FORBIDDEN', message: 'This order is not assigned to you' });
    }

    const address = order.addressId ? await getAddressById(order.addressId, req.traceContext).catch(() => null) : null;
    const parts = [address?.flatNo, address?.buildingName, address?.streetAddress, address?.city, address?.state, address?.pincode].filter(Boolean);
    const fullAddress = parts.join(', ');
    const lat = address?.latitude;
    const lng = address?.longitude;
    const googleMapsUrl = lat && lng
      ? `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}`
      : `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(fullAddress)}`;

    res.json({
      success: true,
      data: {
        order: {
          orderId: order.orderId,
          status: order.status,
          statusLabel: STATUS_LABELS[order.status] || order.status,
          customerName: order.customerName || '',
          customerPhone: order.customerPhone || '',
          deliveryAddress: {
            fullAddress,
            landmark: address?.landmark || '',
            area: address?.area || '',
            latitude: lat || null,
            longitude: lng || null,
            googleMapsUrl
          },
          items: (order.items || []).map(i => ({
            productName: i.productName || i.name || '',
            quantity: i.quantity,
            unit: i.unit || '',
            unitPrice: i.unitPrice || i.price || 0,
            itemTotal: i.grandTotal || i.itemTotal || i.totalPrice || 0
          })),
          grandTotal: order.grand_total ?? order.grandTotal ?? 0,
          subtotal: order.subtotal ?? order.totalWithoutGST ?? 0,
          gstTotal: order.gst_total ?? order.gstTotal ?? order.totalGST ?? 0,
          deliveryCharge: order.delivery_charge ?? order.deliveryCharge ?? 0,
          paymentType: order.paymentType || '',
          paymentStatus: order.paymentStatus || '',
          codCollected: order.codCollectedByDriver || false,
          codAmountToCollect: order.paymentType === 'COD' ? (order.grand_total ?? order.grandTotal ?? 0) : 0,
          deliveryOtp: order.status === 'arrived' ? order.deliveryOtp : null,
          assignedAt: order.assignedAt || null,
          acceptedAt: order.acceptedAt || null
        }
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: 'SERVER_ERROR', message: err.message });
  }
};

// GET /api/driver/cod/history
const getDriverCodHistory = async (req, res) => {
  try {
    const { driverId } = req.driver;
    const { date, orderId } = req.query;

    const [allOrders, handovers] = await Promise.all([
      getOrdersByDriver(driverId, null, null, req.traceContext),
      getAllHandoversForDriver(driverId, req.traceContext)
    ]);

    const orderRecords = allOrders
      .filter(o => o.paymentType === 'COD' && o.status === 'delivered')
      .map(o => ({
        type: 'order',
        orderId: o.orderId,
        amount: o.codAmountCollected || o.codAmount || 0,
        status: o.codCollected ? 'reconciled' : 'delivered',
        date: (o.reconciledAt || o.deliveredAt || '').slice(0, 10),
        createdAt: o.reconciledAt || o.deliveredAt || o.createdAt
      }));

    const handoverRecords = handovers.map(h => ({
      type: 'handover',
      handoverId: h.handoverId,
      amount: h.totalAmount,
      status: h.status,
      date: h.date,
      notes: h.notes || '',
      createdAt: h.createdAt
    }));

    let records = [...orderRecords, ...handoverRecords];
    if (orderId) records = records.filter(r => r.orderId === orderId);
    if (date) records = records.filter(r => r.date === date);
    records.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));

    res.json({ success: true, data: { count: records.length, records } });
  } catch (err) {
    res.status(500).json({ success: false, error: 'SERVER_ERROR', message: err.message });
  }
};

// GET /api/driver/cod/summary
const getCodSummary = async (req, res) => {
  try {
    const { driverId } = req.driver;
    const allOrders = await getOrdersByDriver(driverId, null, null, req.traceContext);

    const todayIST = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }).split(',')[0];
    const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });

    const todayOrders = allOrders.filter(o => {
      if (!o.assignedAt) return false;
      return new Date(o.assignedAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }).split(',')[0] === todayIST;
    });

    const codOrders = todayOrders.filter(o =>
      o.status === 'delivered' && o.paymentType === 'COD'
    );

    const totalCodCollected = codOrders.reduce((sum, o) => sum + (o.codAmountCollected || 0), 0);

    const existing = await getHandoversByDriver(driverId, todayStr, req.traceContext);
    const handoverStatus = existing.length > 0 ? 'completed' : 'pending';

    res.json({
      success: true,
      data: {
        date: todayStr,
        totalOrders: todayOrders.length,
        codOrders: codOrders.length,
        totalCodCollected,
        handoverStatus,
        orders: codOrders.map(o => ({
          orderId: o.orderId,
          customerName: o.customerName || '',
          amountCollected: o.codAmountCollected || 0,
          deliveredAt: o.deliveredAt || null
        }))
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: 'SERVER_ERROR', message: err.message });
  }
};

// POST /api/driver/cod/handover
const submitHandover = async (req, res) => {
  try {
    const { driverId, name: driverName } = req.driver;
    const { totalAmount, notes } = req.body;

    if (totalAmount === undefined || totalAmount === null || typeof totalAmount !== 'number' || totalAmount <= 0) {
      return res.status(400).json({ error: 'INVALID_AMOUNT', message: 'totalAmount must be a positive number' });
    }

    const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
    const existing = await getHandoversByDriver(driverId, todayStr, req.traceContext);
    if (existing.length > 0) {
      return res.status(400).json({ error: 'HANDOVER_EXISTS', message: 'Handover already submitted for today' });
    }

    const handover = {
      handoverId: 'HO' + Date.now(),
      driverId,
      driverName,
      totalAmount,
      notes: notes || '',
      date: todayStr,
      status: 'pending',
      createdAt: new Date().toISOString()
    };

    await createHandover(handover, req.traceContext);

    res.json({
      success: true,
      data: {
        handoverId: handover.handoverId,
        totalAmount: handover.totalAmount,
        status: handover.status,
        message: 'Handover submitted. Warehouse will confirm receipt.'
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: 'SERVER_ERROR', message: err.message });
  }
};

module.exports = { driverAuth, loadingComplete, getEta, arrived, codCollected, completeDelivery, getTodayOrders, getDriverOrderDetail, getDriverProfile, updateDriverStatus, getCodSummary, submitHandover, getDriverCodHistory };
