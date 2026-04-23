const axios = require('axios');
const { getAddresses, addAddress, updateAddress, deleteAddress, setDefaultAddress } = require('../services/firestoreService');
const { toAddressDTO } = require('../models/addressDTO');

async function geocodeFromPincode(pincode) {
  if (!process.env.GOOGLE_MAPS_API_KEY) return { latitude: null, longitude: null };
  try {
    const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(pincode + ',India')}&key=${process.env.GOOGLE_MAPS_API_KEY}`;
    const res = await axios.get(url);
    const result = res.data.results?.[0];
    if (!result) return { latitude: null, longitude: null };
    const { lat, lng } = result.geometry.location;
    return { latitude: lat, longitude: lng };
  } catch {
    return { latitude: null, longitude: null };
  }
}

const addAddressHandler = async (req, res) => {
  try {
    const { userId } = req.params;
    const { label, flatNo, buildingName, streetAddress, landmark, area, city, state, pincode, isDefault } = req.body;
    let { latitude, longitude } = req.body;

    if (!label) return res.status(400).json({ success: false, error: 'MISSING_PARAM', message: 'label is required' });
    if (!streetAddress) return res.status(400).json({ success: false, error: 'MISSING_PARAM', message: 'streetAddress is required' });
    if (!city) return res.status(400).json({ success: false, error: 'MISSING_PARAM', message: 'city is required' });
    if (!pincode) return res.status(400).json({ success: false, error: 'MISSING_PARAM', message: 'pincode is required' });
    if (label.length > 30) return res.status(400).json({ success: false, error: 'INVALID_PARAM', message: 'label must be 30 characters or less' });

    // Geocode from pincode if lat/lng not provided
    if (latitude == null || longitude == null) {
      const coords = await geocodeFromPincode(pincode);
      latitude = coords.latitude;
      longitude = coords.longitude;
    }

    const address = await addAddress(userId, {
      label, flatNo: flatNo || '', buildingName: buildingName || '',
      streetAddress, landmark: landmark || '', area: area || '',
      city, state: state || '', pincode,
      latitude: latitude ?? null,
      longitude: longitude ?? null,
      isDefault: isDefault || false
    }, req.traceContext);

    res.json({ success: true, message: 'Address added successfully', data: { addressId: address.addressId } });
  } catch (err) {
    res.status(500).json({ success: false, error: 'SERVER_ERROR', message: err.message });
  }
};

const getAddressesHandler = async (req, res) => {
  try {
    const { userId } = req.params;
    const addresses = await getAddresses(userId, req.traceContext);
    res.json({ success: true, data: { addresses: addresses.map(toAddressDTO) } });
  } catch (err) {
    res.status(500).json({ success: false, error: 'SERVER_ERROR', message: err.message });
  }
};

const updateAddressHandler = async (req, res) => {
  try {
    const { userId, addressId } = req.params;
    const addressData = req.body;
    if (addressData.label && addressData.label.length > 30) {
      return res.status(400).json({ success: false, error: 'INVALID_PARAM', message: 'label must be 30 characters or less' });
    }

    const updated = await updateAddress(userId, addressId, addressData, req.traceContext);
    if (!updated) return res.status(404).json({ success: false, error: 'ADDRESS_NOT_FOUND', message: 'Address not found' });
    res.json({ success: true, message: 'Address updated successfully', data: { address: toAddressDTO(updated) } });
  } catch (err) {
    res.status(500).json({ success: false, error: 'SERVER_ERROR', message: err.message });
  }
};

const deleteAddressHandler = async (req, res) => {
  try {
    const { userId, addressId } = req.params;
    const deleted = await deleteAddress(userId, addressId, req.traceContext);
    if (!deleted) return res.status(404).json({ success: false, error: 'ADDRESS_NOT_FOUND', message: 'Address not found' });
    res.json({ success: true, message: 'Address deleted successfully' });
  } catch (err) {
    res.status(500).json({ success: false, error: 'SERVER_ERROR', message: err.message });
  }
};

const setDefaultAddressHandler = async (req, res) => {
  try {
    const { userId, addressId } = req.params;
    const success = await setDefaultAddress(userId, addressId, req.traceContext);
    if (!success) return res.status(404).json({ success: false, error: 'ADDRESS_NOT_FOUND', message: 'Address not found' });
    res.json({ success: true, message: 'Default address updated successfully' });
  } catch (err) {
    res.status(500).json({ success: false, error: 'SERVER_ERROR', message: err.message });
  }
};

module.exports = { addAddressHandler, getAddressesHandler, updateAddressHandler, deleteAddressHandler, setDefaultAddressHandler };
