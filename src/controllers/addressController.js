const { getAddresses, addAddress, updateAddress, deleteAddress, setDefaultAddress } = require('../services/firestoreService');
const { toAddressDTO } = require('../models/addressDTO');
const { validateAddress } = require('../services/addressValidationService');

const PINCODE_REGEX = /^[0-9]{6}$/;

function bad(res, status, error, message, data) {
  const body = { success: false, error, message };
  if (data) body.data = data;
  return res.status(status).json(body);
}

function validationFailureStatus(reason) {
  // 400 for client-format errors, 422 for semantic mismatches.
  if (reason === 'PINCODE_NOT_FOUND' || reason === 'LOCATION_UNRESOLVED') return 422;
  return 422;
}

const addAddressHandler = async (req, res) => {
  try {
    const { userId } = req.params;
    const { label, flatNo, buildingName, streetAddress, landmark, area, city, state, pincode, isDefault, latitude, longitude } = req.body;

    if (!label) return bad(res, 400, 'MISSING_PARAM', 'label is required');
    if (label.length > 30) return bad(res, 400, 'INVALID_PARAM', 'label must be 30 characters or less');
    if (!streetAddress) return bad(res, 400, 'MISSING_PARAM', 'streetAddress is required');
    if (!city) return bad(res, 400, 'MISSING_PARAM', 'city is required');
    if (!pincode) return bad(res, 400, 'MISSING_PARAM', 'pincode is required');
    if (!PINCODE_REGEX.test(pincode)) return bad(res, 400, 'INVALID_PINCODE', 'pincode must be 6 digits');
    if (latitude == null || longitude == null) return bad(res, 400, 'MISSING_COORDINATES', 'latitude and longitude are required');

    const result = await validateAddress({
      pincode, latitude, longitude, city, state,
      traceContext: req.traceContext,
    });
    if (!result.ok) {
      return bad(res, validationFailureStatus(result.reason), result.reason, result.message, {
        distanceKm: result.distanceKm,
        resolved: result.resolved,
      });
    }

    const address = await addAddress(userId, {
      label, flatNo: flatNo || '', buildingName: buildingName || '',
      streetAddress, landmark: landmark || '', area: area || '',
      city, state: state || '', pincode,
      latitude, longitude,
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
      return bad(res, 400, 'INVALID_PARAM', 'label must be 30 characters or less');
    }
    if (addressData.pincode && !PINCODE_REGEX.test(addressData.pincode)) {
      return bad(res, 400, 'INVALID_PINCODE', 'pincode must be 6 digits');
    }

    const touchesGeo =
      addressData.pincode != null ||
      addressData.latitude != null ||
      addressData.longitude != null;

    if (touchesGeo) {
      if (addressData.pincode == null || addressData.latitude == null || addressData.longitude == null) {
        return bad(res, 400, 'MISSING_COORDINATES', 'pincode, latitude, and longitude must all be provided together');
      }
      const result = await validateAddress({
        pincode: addressData.pincode,
        latitude: addressData.latitude,
        longitude: addressData.longitude,
        city: addressData.city,
        state: addressData.state,
        traceContext: req.traceContext,
      });
      if (!result.ok) {
        return bad(res, validationFailureStatus(result.reason), result.reason, result.message, {
          distanceKm: result.distanceKm,
          resolved: result.resolved,
        });
      }
    }

    const updated = await updateAddress(userId, addressId, addressData, req.traceContext);
    if (!updated) return bad(res, 404, 'ADDRESS_NOT_FOUND', 'Address not found');
    res.json({ success: true, message: 'Address updated successfully', data: { address: toAddressDTO(updated) } });
  } catch (err) {
    res.status(500).json({ success: false, error: 'SERVER_ERROR', message: err.message });
  }
};

const deleteAddressHandler = async (req, res) => {
  try {
    const { userId, addressId } = req.params;
    const deleted = await deleteAddress(userId, addressId, req.traceContext);
    if (!deleted) return bad(res, 404, 'ADDRESS_NOT_FOUND', 'Address not found');
    res.json({ success: true, message: 'Address deleted successfully' });
  } catch (err) {
    res.status(500).json({ success: false, error: 'SERVER_ERROR', message: err.message });
  }
};

const setDefaultAddressHandler = async (req, res) => {
  try {
    const { userId, addressId } = req.params;
    const success = await setDefaultAddress(userId, addressId, req.traceContext);
    if (!success) return bad(res, 404, 'ADDRESS_NOT_FOUND', 'Address not found');
    res.json({ success: true, message: 'Default address updated successfully' });
  } catch (err) {
    res.status(500).json({ success: false, error: 'SERVER_ERROR', message: err.message });
  }
};

module.exports = { addAddressHandler, getAddressesHandler, updateAddressHandler, deleteAddressHandler, setDefaultAddressHandler };
