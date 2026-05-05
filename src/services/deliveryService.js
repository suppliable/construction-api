const { getDeliveryConfig } = require('./firestoreService');
const { getRoadDistance } = require('./googleMapsService');
const remoteConfig = require('./remoteConfigService');
const logger = require('../utils/logger');
const { haversineKm } = require('../utils/geo');

const WAREHOUSE = {
  latitude: parseFloat(process.env.WAREHOUSE_LAT) || 12.863326,
  longitude: parseFloat(process.env.WAREHOUSE_LNG) || 80.226196,
  pincode: '600119'
};

const { DEFAULT_PINCODES } = require('../constants');

async function calculateDelivery(pincode, latitude, longitude, orderValue = 0, addressString = null, traceContext = null) {
  logger.info({ pincode, latitude, longitude, orderValue, addressString, hasMapsKey: !!process.env.GOOGLE_MAPS_API_KEY }, 'delivery_calculate_start');
  const [pincodesStr, ratePerKm, minDeliveryCharge] = await Promise.all([
    remoteConfig.getString('serviceable_pincodes', DEFAULT_PINCODES),
    remoteConfig.getNumber('rate_per_km', 50),
    remoteConfig.getNumber('min_delivery_charge', 100),
  ]);
  const serviceablePincodes = pincodesStr.split(',').map(p => p.trim()).filter(Boolean);

  // Step 1 — Pincode check
  if (!serviceablePincodes.includes(pincode)) {
    return {
      serviceable: false,
      message: 'Delivery not available in your area yet'
    };
  }

  // Step 2 — Distance via Google Maps, fallback to Haversine
  let distanceKm;
  let distanceText = null;
  let distanceSource = 'haversine';

  if (addressString && process.env.GOOGLE_MAPS_API_KEY) {
    try {
      const result = await getRoadDistance(WAREHOUSE.latitude, WAREHOUSE.longitude, addressString, traceContext);
      distanceKm = result.distanceKm;
      distanceText = result.distanceText;
      distanceSource = 'google_maps';
      logger.warn(distanceKm, distanceText, 'Google Maps distance calculated successfully');
    } catch (err) {
      logger.warn({ err: err.message, pincode, addressString }, 'Google Maps distance failed; falling back to Haversine');
      distanceKm = haversineKm(WAREHOUSE.latitude, WAREHOUSE.longitude, latitude, longitude);
    }
  } else {
    distanceKm = haversineKm(WAREHOUSE.latitude, WAREHOUSE.longitude, latitude, longitude);
  }

  // Round-trip billing: one-way × 2, rounded up to whole km.
  const distance_km = Math.ceil(distanceKm * 2);

  // Step 3 — Get delivery config from Firestore
  const config = await getDeliveryConfig(traceContext);

  // Step 4 — Check free delivery
  let delivery_charge;
  let is_free_delivery = false;
  let free_delivery_reason = null;

  if (config.freeDeliveryEnabled) {
    if (config.freeDeliveryThreshold && orderValue >= config.freeDeliveryThreshold) {
      delivery_charge = 0;
      is_free_delivery = true;
      free_delivery_reason = `Free delivery on orders above ₹${config.freeDeliveryThreshold}`;
    } else if (config.freeDeliveryPincodes && config.freeDeliveryPincodes.includes(pincode)) {
      delivery_charge = 0;
      is_free_delivery = true;
      free_delivery_reason = 'Free delivery in your area';
    } else {
      const calculated = distance_km * ratePerKm;
      delivery_charge = Math.max(calculated, minDeliveryCharge);
    }
  } else {
    const calculated = distance_km * ratePerKm;
    delivery_charge = Math.max(calculated, minDeliveryCharge);
  }

  const min_charge_applied = !is_free_delivery && (distance_km * ratePerKm) < minDeliveryCharge;

  logger.info({
    pincode,
    addressString,
    latitude,
    longitude,
    rawDistanceKm: Math.round(distanceKm * 100) / 100,
    billableKm: distance_km,
    distanceSource,
    distanceText,
    ratePerKm,
    minDeliveryCharge,
    orderValue,
    delivery_charge,
    is_free_delivery,
    min_charge_applied,
  }, 'delivery_calculated');

  return {
    serviceable: true,
    one_way_km: Math.round(distanceKm * 10) / 10,
    distance_km,
    distance_text: distanceText,
    distance_source: distanceSource,
    delivery_charge,
    is_free_delivery,
    free_delivery_reason,
    min_charge_applied
  };
}

module.exports = { calculateDelivery };
