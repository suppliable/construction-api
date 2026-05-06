'use strict';

const { geocodeAddress, reverseGeocode } = require('./googleMapsService');
const { haversineKm } = require('../utils/geo');
const redis = require('../cache/redis');
const logger = require('../utils/logger');

// Only used as a sanity fallback when Google returns no postal_code for the
// pinned location (rare — sparse rural areas, water bodies). For the common
// case we trust the reverse-geocoded postalCode and skip distance entirely,
// because pincode polygons are non-circular and a single centroid radius
// rejects legitimate edges of long/narrow pincodes.
const FALLBACK_MAX_DISTANCE_KM = 15;
const PINCODE_CACHE_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days

async function getPincodeCentroid(pincode, traceContext) {
  const cacheKey = `geo:pincode:${pincode}`;
  try {
    const cached = await redis.get(cacheKey);
    if (cached && cached.latitude != null && cached.longitude != null) {
      return cached;
    }
  } catch (err) {
    logger.warn({ err: err.message, pincode }, 'pincode_centroid_cache_read_failed');
  }

  const coords = await geocodeAddress(`${pincode},India`, traceContext);
  try {
    await redis.set(cacheKey, coords, { ex: PINCODE_CACHE_TTL_SECONDS });
  } catch (err) {
    logger.warn({ err: err.message, pincode }, 'pincode_centroid_cache_write_failed');
  }
  return coords;
}

function looselyMatches(a, b) {
  if (!a || !b) return false;
  const na = String(a).trim().toLowerCase();
  const nb = String(b).trim().toLowerCase();
  return na === nb || na.includes(nb) || nb.includes(na);
}

async function validateAddress({ pincode, latitude, longitude, city, state, traceContext = null }) {
  let resolved;
  try {
    resolved = await reverseGeocode(latitude, longitude, traceContext);
  } catch (err) {
    logger.warn({ err: err.message, latitude, longitude }, 'address_validation_reverse_geocode_failed');
    return {
      ok: false,
      reason: 'LOCATION_UNRESOLVED',
      message: 'Could not resolve the pinned location',
    };
  }

  // Strong signal: Google tells us which pincode this point sits in.
  // Trust it over any distance heuristic.
  if (resolved.postalCode) {
    if (resolved.postalCode !== pincode) {
      return {
        ok: false,
        reason: 'PINCODE_MISMATCH',
        message: `Selected location is in pincode ${resolved.postalCode}, not ${pincode}`,
        resolved,
      };
    }
    // postalCode matches — accept. Skip distance check entirely; pincode
    // polygons aren't circular and a centroid-radius test rejects legitimate
    // addresses on long/narrow pincode edges.
    return { ok: true, resolved };
  }

  // Fallback: Google has no postal_code for this point (sparse rural, water).
  // Use a loose centroid distance as a sanity check only.
  let centroid;
  try {
    centroid = await getPincodeCentroid(pincode, traceContext);
  } catch (err) {
    logger.warn({ err: err.message, pincode }, 'address_validation_pincode_geocode_failed');
    return {
      ok: false,
      reason: 'PINCODE_NOT_FOUND',
      message: `Pincode ${pincode} could not be located`,
    };
  }

  const distanceKm = haversineKm(centroid.latitude, centroid.longitude, latitude, longitude);
  if (distanceKm > FALLBACK_MAX_DISTANCE_KM) {
    return {
      ok: false,
      reason: 'DISTANCE_EXCEEDED',
      message: `Pin is ${distanceKm.toFixed(1)} km from pincode ${pincode}; please verify the location`,
      distanceKm,
      resolved,
    };
  }

  // City/state mismatch is only blocking if BOTH disagree.
  const cityMatches = !city || looselyMatches(city, resolved.locality);
  const stateMatches = !state || looselyMatches(state, resolved.adminArea);
  if (!cityMatches && !stateMatches) {
    return {
      ok: false,
      reason: 'CITY_MISMATCH',
      message: `Selected location is in ${resolved.locality || 'an unknown city'}, ${resolved.adminArea || 'unknown state'}`,
      distanceKm,
      resolved,
    };
  }

  return { ok: true, distanceKm, resolved };
}

module.exports = { validateAddress, FALLBACK_MAX_DISTANCE_KM };
