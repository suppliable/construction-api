const axios = require('axios');

async function getRoadDistance(originLat, originLng, destinationAddress) {
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

  return {
    distanceMeters: element.distance.value,
    distanceKm: element.distance.value / 1000,
    distanceText: element.distance.text,
    durationSeconds: element.duration.value,
    durationText: element.duration.text
  };
}

async function getETA(destinationAddress) {
  const result = await getRoadDistance(
    process.env.WAREHOUSE_LAT,
    process.env.WAREHOUSE_LNG,
    destinationAddress
  );
  return {
    eta_minutes: Math.ceil(result.durationSeconds / 60),
    eta_text: result.durationText,
    distance: result.distanceText
  };
}

module.exports = { getRoadDistance, getETA };
