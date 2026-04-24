const axios = require('axios');
const { createSpan } = require('../utils/spanTracer');

async function getRoadDistance(originLat, originLng, destinationAddress, traceContext = null) {
  const span = createSpan(traceContext, 'google_maps.api.distancematrix', {
    endpoint: '/maps/api/distancematrix/json'
  });
  try {
    const origin = `${originLat},${originLng}`;
    const destination = encodeURIComponent(destinationAddress);
    const apiKey = process.env.GOOGLE_MAPS_API_KEY;
    const url = `https://maps.googleapis.com/maps/api/distancematrix/json?origins=${origin}&destinations=${destination}&key=${apiKey}&units=metric`;

    const response = await axios.get(url);
    const data = response.data;

    if (data.status !== 'OK') {
      throw new Error(`Google Maps API error: ${data.status}`);
    }

    const element = data.rows[0].elements[0];
    if (element.status !== 'OK') {
      throw new Error(`Route not found: ${element.status}`);
    }

    const result = {
      distanceMeters: element.distance.value,
      distanceKm: element.distance.value / 1000,
      distanceText: element.distance.text,
      durationSeconds: element.duration.value,
      durationText: element.duration.text
    };
    span.end({ success: true, distanceKm: result.distanceKm, durationText: result.durationText });
    return result;
  } catch (error) {
    span.end({ success: false, error: error.message });
    throw error;
  }
}

async function getETA(destinationAddress, traceContext = null) {
  const result = await getRoadDistance(
    process.env.WAREHOUSE_LAT,
    process.env.WAREHOUSE_LNG,
    destinationAddress,
    traceContext
  );
  return {
    eta_minutes: Math.ceil(result.durationSeconds / 60),
    eta_text: result.durationText,
    distance: result.distanceText
  };
}

async function geocodeAddress(addressString, traceContext = null) {
  const span = createSpan(traceContext, 'google_maps.api.geocode', { endpoint: '/maps/api/geocode/json' });
  try {
    const response = await axios.get('https://maps.googleapis.com/maps/api/geocode/json', {
      params: { address: addressString, key: process.env.GOOGLE_MAPS_API_KEY },
      timeout: 8000
    });
    if (response.data.status !== 'OK' || !response.data.results?.length) {
      throw new Error(`Geocode failed: ${response.data.status}`);
    }
    const { lat, lng } = response.data.results[0].geometry.location;
    span.end({ success: true, lat, lng });
    return { latitude: lat, longitude: lng };
  } catch (error) {
    span.end({ success: false, error: error.message });
    throw error;
  }
}

async function getDirectionsETA(originLat, originLng, destLat, destLng, traceContext = null) {
  const span = createSpan(traceContext, 'google_maps.api.directions', { endpoint: '/maps/api/directions/json' });
  try {
    const response = await axios.get('https://maps.googleapis.com/maps/api/directions/json', {
      params: {
        origin: `${originLat},${originLng}`,
        destination: `${destLat},${destLng}`,
        key: process.env.GOOGLE_MAPS_API_KEY,
        departure_time: 'now',
        traffic_model: 'best_guess',
      },
      timeout: 8000
    });
    const data = response.data;
    if (data.status !== 'OK' || !data.routes?.length) {
      throw new Error(`Directions API error: ${data.status}`);
    }
    const leg = data.routes[0].legs[0];
    const seconds = (leg.duration_in_traffic ?? leg.duration).value;
    span.end({ success: true, seconds });
    return { seconds, distanceText: leg.distance.text };
  } catch (error) {
    span.end({ success: false, error: error.message });
    throw error;
  }
}

function formatEtaString(seconds) {
  if (seconds < 60) return 'Arriving now';
  if (seconds < 3600) return `Arriving in ${Math.ceil(seconds / 60)} minutes`;
  const h = Math.floor(seconds / 3600);
  const m = Math.ceil((seconds % 3600) / 60);
  return m > 0 ? `Arriving in ${h}h ${m}m` : `Arriving in ${h}h`;
}

module.exports = { getRoadDistance, getETA, geocodeAddress, getDirectionsETA, formatEtaString };
