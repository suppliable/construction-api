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

module.exports = { getRoadDistance, getETA };
