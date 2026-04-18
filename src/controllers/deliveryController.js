const { calculateDelivery } = require('../services/deliveryService');
const { updateDeliveryConfig, getDeliveryConfig, getAddressById } = require('../services/firestoreService');

const calculateDeliveryCharge = async (req, res) => {
  try {
    let { pincode, latitude, longitude, orderValue, addressId } = req.body;

    // Support address lookup by addressId
    if (addressId) {
      const address = await getAddressById(addressId);
      if (!address) return res.status(404).json({ success: false, message: 'Address not found' });
      pincode = pincode || address.pincode;
      latitude = latitude ?? address.latitude;
      longitude = longitude ?? address.longitude;

      const addressString = [address.streetAddress, address.city, address.state, address.pincode]
        .filter(Boolean).join(', ');

      const result = await calculateDelivery(
        pincode,
        parseFloat(latitude),
        parseFloat(longitude),
        parseFloat(orderValue) || 0,
        addressString
      );
      return res.json({ success: true, data: result });
    }

    // Legacy: direct coords
    if (!pincode) return res.status(400).json({ success: false, message: 'pincode is required' });
    if (latitude === undefined || latitude === null) return res.status(400).json({ success: false, message: 'latitude is required' });
    if (longitude === undefined || longitude === null) return res.status(400).json({ success: false, message: 'longitude is required' });
    if (isNaN(latitude)) return res.status(400).json({ success: false, message: 'latitude must be a number' });
    if (isNaN(longitude)) return res.status(400).json({ success: false, message: 'longitude must be a number' });

    const result = await calculateDelivery(
      pincode,
      parseFloat(latitude),
      parseFloat(longitude),
      parseFloat(orderValue) || 0
    );
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

const getConfig = async (req, res) => {
  try {
    const config = await getDeliveryConfig();
    res.json({ success: true, data: config });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

const updateConfig = async (req, res) => {
  try {
    const { freeDeliveryEnabled, freeDeliveryThreshold, freeDeliveryPincodes } = req.body;
    const config = await updateDeliveryConfig({
      freeDeliveryEnabled: freeDeliveryEnabled !== undefined ? freeDeliveryEnabled : false,
      freeDeliveryThreshold: freeDeliveryThreshold || null,
      freeDeliveryPincodes: freeDeliveryPincodes || []
    });
    res.json({ success: true, message: 'Delivery config updated', data: config });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

module.exports = { calculateDeliveryCharge, getConfig, updateConfig };
