const multer = require('multer');
const axios = require('axios');
const { getOrderById, updateOrder, getAddressById, updateVehicle, updateDriver } = require('../services/firestoreService');
const { getETA } = require('../services/googleMapsService');
const { uploadImage } = require('../services/cloudinaryService');
const { updateZohoShipment } = require('../services/zohoOrderService');

const upload = multer({ storage: multer.memoryStorage() });

// POST /api/driver/orders/:orderId/loading-complete
const loadingComplete = async (req, res) => {
  try {
    const { orderId } = req.params;
    const order = await getOrderById(orderId);
    if (!order) return res.status(404).json({ success: false, message: 'Order not found' });
    if (order.status !== 'loading') {
      return res.status(400).json({ success: false, message: `Order must be in loading status (current: ${order.status})` });
    }
    const updated = await updateOrder(orderId, {
      status: 'out_for_delivery',
      loadingCompleteAt: new Date().toISOString()
    });
    res.json({ success: true, order: updated });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// GET /api/driver/orders/:orderId/eta
const getEta = async (req, res) => {
  try {
    const { orderId } = req.params;
    const order = await getOrderById(orderId);
    if (!order) return res.status(404).json({ success: false, message: 'Order not found' });

    const address = await getAddressById(order.addressId);
    if (!address) return res.status(404).json({ success: false, message: 'Delivery address not found' });

    if (!process.env.GOOGLE_MAPS_API_KEY) {
      return res.status(503).json({ success: false, message: 'Google Maps API key not configured' });
    }

    const addressString = [address.streetAddress, address.city, address.state, address.pincode]
      .filter(Boolean).join(', ');

    const eta = await getETA(addressString);
    res.json({ success: true, ...eta });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// POST /api/driver/orders/:orderId/arrived
const arrived = async (req, res) => {
  try {
    const { orderId } = req.params;
    const order = await getOrderById(orderId);
    if (!order) return res.status(404).json({ success: false, message: 'Order not found' });
    if (order.status !== 'out_for_delivery') {
      return res.status(400).json({ success: false, message: `Order must be out_for_delivery (current: ${order.status})` });
    }
    const updated = await updateOrder(orderId, {
      status: 'arrived',
      arrivedAt: new Date().toISOString()
    });
    res.json({ success: true, order: updated });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// POST /api/driver/orders/:orderId/cod-collected
const codCollected = async (req, res) => {
  try {
    const { orderId } = req.params;
    const { amount } = req.body;
    const order = await getOrderById(orderId);
    if (!order) return res.status(404).json({ success: false, message: 'Order not found' });
    if (order.paymentType !== 'COD') {
      return res.status(400).json({ success: false, message: 'Order is not a COD order' });
    }
    if (order.status !== 'arrived') {
      return res.status(400).json({ success: false, message: `Order must be in arrived status (current: ${order.status})` });
    }
    if (amount === undefined || amount === null) {
      return res.status(400).json({ success: false, message: 'amount is required' });
    }
    const updated = await updateOrder(orderId, {
      codCollectedByDriver: true,
      codAmountCollected: parseFloat(amount),
      codCollectedAt: new Date().toISOString()
    });
    res.json({ success: true, order: updated });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
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
      if (!order) return res.status(404).json({ success: false, message: 'Order not found' });
      if (order.status !== 'arrived') {
        return res.status(400).json({ success: false, message: `Order must be in arrived status (current: ${order.status})` });
      }

      if (order.paymentType === 'COD' && !order.codCollectedByDriver) {
        return res.status(400).json({ success: false, error: 'COD payment must be collected before completing delivery' });
      }

      if (!otp) return res.status(400).json({ success: false, message: 'otp is required' });
      if (String(otp) !== String(order.deliveryOtp)) {
        return res.status(400).json({ success: false, error: 'Invalid OTP' });
      }

      if (!req.file) return res.status(400).json({ success: false, message: 'photo is required' });
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

      // Free up vehicle and driver
      if (order.vehicleId) updateVehicle(order.vehicleId, { isAvailable: true }).catch(() => {});
      if (order.driverId) updateDriver(order.driverId, { isAvailable: true }).catch(() => {});

      res.json({ success: true, order: updated });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  }
];

module.exports = { loadingComplete, getEta, arrived, codCollected, completeDelivery };
