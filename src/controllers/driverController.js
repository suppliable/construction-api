const multer = require('multer');
const bcrypt = require('bcrypt');
const { getOrderById, updateOrder, getAddressById, updateVehicle, updateDriver, getDriverByPhone, getDriverById, getOrdersByDriver } = require('../services/firestoreService');
const { getETA } = require('../services/googleMapsService');
const { uploadImage } = require('../services/cloudinaryService');
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

    const driver = await getDriverByPhone(phone);

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
    await updateDriver(driver.driverId, { currentToken: token, lastLoginAt: new Date().toISOString() });

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
    const order = await getOrderById(orderId);
    if (!order) return res.status(404).json({ success: false, error: 'ORDER_NOT_FOUND', message: 'Order not found' });
    if (order.status !== 'loading') {
      return res.status(400).json({ success: false, error: 'INVALID_STATUS', message: `Order must be in loading status (current: ${order.status})` });
    }
    const updated = await updateOrder(orderId, {
      status: 'out_for_delivery',
      loadingCompleteAt: new Date().toISOString()
    });
    res.json({ success: true, data: { order: formatTimestamps(updated) } });
  } catch (err) {
    res.status(500).json({ success: false, error: 'SERVER_ERROR', message: err.message });
  }
};

// GET /api/driver/orders/:orderId/eta
const getEta = async (req, res) => {
  try {
    const { orderId } = req.params;
    const order = await getOrderById(orderId);
    if (!order) return res.status(404).json({ success: false, error: 'ORDER_NOT_FOUND', message: 'Order not found' });

    const address = await getAddressById(order.addressId);
    if (!address) return res.status(404).json({ success: false, error: 'ADDRESS_NOT_FOUND', message: 'Delivery address not found' });

    if (!process.env.GOOGLE_MAPS_API_KEY) {
      return res.status(503).json({ success: false, error: 'SERVICE_UNAVAILABLE', message: 'Google Maps API key not configured' });
    }

    const addressString = [address.streetAddress, address.city, address.state, address.pincode]
      .filter(Boolean).join(', ');

    const eta = await getETA(addressString);
    res.json({ success: true, data: eta });
  } catch (err) {
    res.status(500).json({ success: false, error: 'SERVER_ERROR', message: err.message });
  }
};

// POST /api/driver/orders/:orderId/arrived
const arrived = async (req, res) => {
  try {
    const { orderId } = req.params;
    const order = await getOrderById(orderId);
    if (!order) return res.status(404).json({ success: false, error: 'ORDER_NOT_FOUND', message: 'Order not found' });
    if (order.status !== 'out_for_delivery') {
      return res.status(400).json({ success: false, error: 'INVALID_STATUS', message: `Order must be out_for_delivery (current: ${order.status})` });
    }
    const updated = await updateOrder(orderId, {
      status: 'arrived',
      arrivedAt: new Date().toISOString()
    });
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
    const order = await getOrderById(orderId);
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
    });
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

      const order = await getOrderById(orderId);
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
      const base64 = req.file.buffer.toString('base64');
      const dataUri = `data:${req.file.mimetype};base64,${base64}`;
      const deliveryPhotoUrl = await uploadImage(dataUri);

      const updated = await updateOrder(orderId, {
        status: 'delivered',
        deliveredAt: new Date().toISOString(),
        deliveryPhotoUrl,
        otpVerified: true
      });

      if (order.zoho_so_id) {
        updateZohoShipment(order.zoho_so_id).catch(err => {
          console.error('Zoho shipment update failed (non-fatal):', err.response?.data || err.message);
        });
      }

      if (order.vehicleId) updateVehicle(order.vehicleId, { isAvailable: true }).catch(() => {});
      if (order.driverId) updateDriver(order.driverId, { isAvailable: true }).catch(() => {});

      res.json({ success: true, data: { order: formatTimestamps(updated) } });
    } catch (err) {
      res.status(500).json({ success: false, error: 'SERVER_ERROR', message: err.message });
    }
  }
];

// GET /api/driver/profile
const getDriverProfile = async (req, res) => {
  try {
    const { driverId } = req.driver;
    const driver = await getDriverById(driverId);
    if (!driver) return res.status(404).json({ success: false, error: 'DRIVER_NOT_FOUND', message: 'Driver not found' });

    const allDriverOrders = await getOrdersByDriver(driverId, null, null);
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
      const allOrders = await getOrdersByDriver(driverId, null, null);
      const hasActive = allOrders.some(o => IN_PROGRESS.includes(o.status));
      if (hasActive) {
        return res.status(400).json({ success: false, error: 'ORDER_IN_PROGRESS', message: 'Cannot go offline while an order is in progress' });
      }
    }

    await updateDriver(driverId, { isAvailable });
    const driver = await getDriverById(driverId);

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

module.exports = { driverAuth, loadingComplete, getEta, arrived, codCollected, completeDelivery, getDriverProfile, updateDriverStatus };
