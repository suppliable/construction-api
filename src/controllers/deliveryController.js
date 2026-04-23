const { calculateDelivery } = require('../services/deliveryService');
const { updateDeliveryConfig, getDeliveryConfig, getAddressById } = require('../services/firestoreService');

const calculateDeliveryCharge = async (req, res) => {
  try {
    const { userId, addressId } = req.body;
    if (!userId) return res.status(400).json({ success: false, error: 'MISSING_PARAM', message: 'userId is required' });
    if (!addressId) return res.status(400).json({ success: false, error: 'MISSING_PARAM', message: 'addressId is required' });

    const address = await getAddressById(addressId, req.traceContext);
    if (!address || address.userId !== userId) {
      return res.status(404).json({ success: false, error: 'ADDRESS_NOT_FOUND', message: 'Address not found' });
    }

    const addressString = [address.streetAddress, address.city, address.state, address.pincode]
      .filter(Boolean).join(', ');

    const result = await calculateDelivery(
      address.pincode,
      parseFloat(address.latitude),
      parseFloat(address.longitude),
      0,
      addressString,
      req.traceContext
    );

    if (!result.serviceable) {
      return res.status(400).json({
        success: false,
        error: 'NOT_SERVICEABLE',
        message: 'Sorry, we do not deliver to this area.'
      });
    }

    res.json({
      success: true,
      data: {
        deliveryCharge: result.delivery_charge,
        distanceKm: result.one_way_km,
        distanceText: result.distance_text,
        serviceable: true,
        distanceSource: result.distance_source
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: 'SERVER_ERROR', message: err.message });
  }
};

const getConfig = async (req, res) => {
  try {
    const config = await getDeliveryConfig(req.traceContext);
    res.json({ success: true, data: { config } });
  } catch (err) {
    res.status(500).json({ success: false, error: 'SERVER_ERROR', message: err.message });
  }
};

const updateConfig = async (req, res) => {
  try {
    const { freeDeliveryEnabled, freeDeliveryThreshold, freeDeliveryPincodes } = req.body;
    const config = await updateDeliveryConfig({
      freeDeliveryEnabled: freeDeliveryEnabled !== undefined ? freeDeliveryEnabled : false,
      freeDeliveryThreshold: freeDeliveryThreshold || null,
      freeDeliveryPincodes: freeDeliveryPincodes || []
    }, req.traceContext);
    res.json({ success: true, message: 'Delivery config updated', data: { config } });
  } catch (err) {
    res.status(500).json({ success: false, error: 'SERVER_ERROR', message: err.message });
  }
};

module.exports = { calculateDeliveryCharge, getConfig, updateConfig };
