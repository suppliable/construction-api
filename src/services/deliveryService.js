const { getDeliveryConfig } = require('./firestoreService');
const { getRoadDistance } = require('./googleMapsService');

const WAREHOUSE = {
  latitude: parseFloat(process.env.WAREHOUSE_LAT) || 12.863326,
  longitude: parseFloat(process.env.WAREHOUSE_LNG) || 80.226196,
  pincode: '600119'
};

const RATE_PER_KM = 25;
const MIN_DELIVERY_CHARGE = 50;

const serviceablePincodes = [
  '600119', // Sholinganallur, Semmancheri, Akkarai, Paniyur, Uthandi
  '600130', // Navalur
  '603103', // Siruseri, Padur
  '600097', // Karapakkam, Thoraipakkam
  '600100', // Perumbakkam, Medavakkam
  '600126', // Sithalapakkam
  '600115'  // Injambakkam, Neelankarai
];

function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

async function calculateDelivery(pincode, latitude, longitude, orderValue = 0, addressString = null) {
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
      const result = await getRoadDistance(WAREHOUSE.latitude, WAREHOUSE.longitude, addressString);
      distanceKm = result.distanceKm;
      distanceText = result.distanceText;
      distanceSource = 'google_maps';
    } catch (err) {
      console.warn('Google Maps distance failed, falling back to Haversine:', err.message);
      distanceKm = haversine(WAREHOUSE.latitude, WAREHOUSE.longitude, latitude, longitude);
    }
  } else {
    distanceKm = haversine(WAREHOUSE.latitude, WAREHOUSE.longitude, latitude, longitude);
  }

  // Round up to nearest even km (existing logic)
  const distance_km = Math.ceil(distanceKm / 2) * 2;

  // Step 3 — Get delivery config from Firestore
  const config = await getDeliveryConfig();

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
      const calculated = distance_km * RATE_PER_KM;
      delivery_charge = Math.max(calculated, MIN_DELIVERY_CHARGE);
    }
  } else {
    const calculated = distance_km * RATE_PER_KM;
    delivery_charge = Math.max(calculated, MIN_DELIVERY_CHARGE);
  }

  const min_charge_applied = !is_free_delivery && (distance_km * RATE_PER_KM) < MIN_DELIVERY_CHARGE;

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
