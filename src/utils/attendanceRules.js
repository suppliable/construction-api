'use strict';

// The decisions behind attendance, kept free of I/O so each one can be tested
// directly: where a clock-in counts as, when a forgotten one closes itself, and
// how long a day was.
//
// Everything is the IST calendar day, not UTC. A UTC day would split a 9am
// arrival and a 7pm departure across two dates for no reason anyone could see.

const { haversineKm } = require('./geo');
const { istDateKey } = require('./istDate');

const DEFAULT_RADIUS_M = 200;
const DEFAULT_AUTO_OUT = '20:00';

// Same fallback deliveryService uses for the warehouse. Duplicated rather than
// imported because deliveryService does not export it and is live delivery
// code that this feature should not touch — keep the two in step.
const FALLBACK_SHOP = Object.freeze({ lat: 12.863326, lng: 80.226196 });

function shopLocation(env = process.env) {
  const lat = parseFloat(env.WAREHOUSE_LAT);
  const lng = parseFloat(env.WAREHOUSE_LNG);
  return {
    lat: Number.isFinite(lat) ? lat : FALLBACK_SHOP.lat,
    lng: Number.isFinite(lng) ? lng : FALLBACK_SHOP.lng,
  };
}

function radiusMeters(env = process.env) {
  const n = Number(env.ATTENDANCE_RADIUS_M);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_RADIUS_M;
}

const validCoords = (lat, lng) =>
  Number.isFinite(lat) && Number.isFinite(lng) &&
  Math.abs(lat) <= 90 && Math.abs(lng) <= 180 &&
  // 0,0 is what a broken location stack reports; it is never the shop.
  !(lat === 0 && lng === 0);

/**
 * Decide whether a reading counts as "at the shop".
 *
 * Three verdicts, because "I could not tell" must not read as "was elsewhere":
 *
 *   inside      — a trustworthy reading within the radius
 *   outside     — a reading that is clearly beyond it
 *   unverified  — nothing usable: permission denied, no fix, or a fix too loose
 *                 to say either way
 *
 * Desktops have no GPS and estimate from nearby Wi-Fi, so an accuracy of a few
 * hundred metres is normal. A reading is therefore only called `outside` when
 * it is wrong even after giving it the benefit of its own error margin
 * (distance - accuracy > radius). A ±500 m reading 100 m from the shop is
 * unverified, not a violation; the same reading 5 km away is outside however
 * loose it is.
 *
 * Only distance, accuracy and the verdict are returned — never the coordinates.
 * Someone who clocks in from home would otherwise have their address stored.
 */
function evaluateLocation(reading, { shop = shopLocation(), radiusM = radiusMeters() } = {}) {
  const lat = Number(reading?.lat);
  const lng = Number(reading?.lng);

  if (!validCoords(lat, lng)) {
    return { verdict: 'unverified', reason: 'no_location', distanceM: null, accuracyM: null };
  }

  const distanceM = Math.round(haversineKm(shop.lat, shop.lng, lat, lng) * 1000);
  const acc = Number(reading?.accuracy);
  const accuracyM = Number.isFinite(acc) && acc >= 0 ? Math.round(acc) : null;

  if (accuracyM !== null && distanceM - accuracyM > radiusM) {
    return { verdict: 'outside', reason: null, distanceM, accuracyM };
  }
  if (accuracyM === null) {
    return { verdict: 'unverified', reason: 'no_accuracy', distanceM, accuracyM };
  }
  if (accuracyM > radiusM) {
    return { verdict: 'unverified', reason: 'low_accuracy', distanceM, accuracyM };
  }
  return distanceM <= radiusM
    ? { verdict: 'inside', reason: null, distanceM, accuracyM }
    : { verdict: 'outside', reason: null, distanceM, accuracyM };
}

// ── day boundaries ──────────────────────────────────────────────────────────

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

function autoOutTime(env = process.env) {
  const v = String(env.ATTENDANCE_AUTO_OUT || '').trim();
  return HHMM.test(v) ? v : DEFAULT_AUTO_OUT;
}

/** The instant a day's open record is closed automatically, as an ISO string. */
function autoOutInstant(dateKey, hhmm = autoOutTime()) {
  // India has no daylight saving, so +05:30 is correct year-round.
  return new Date(`${dateKey}T${hhmm}:00+05:30`).toISOString();
}

/**
 * Should this still-open record be closed now?
 *
 * Yes if it belongs to an earlier day (it can never be clocked out normally
 * again), or if it is today's and the cut-off has passed.
 */
function isStale(record, now = new Date(), hhmm = autoOutTime()) {
  if (!record || record.outAt) return false;
  const today = istDateKey(now);
  if (record.date < today) return true;
  return record.date === today && now.getTime() >= Date.parse(autoOutInstant(record.date, hhmm));
}

/**
 * The time an auto clock-out is stamped with.
 *
 * Never earlier than the clock-in: someone who arrives after the cut-off and
 * is closed by it would otherwise get a negative day.
 */
function autoOutAt(record, hhmm = autoOutTime()) {
  const cutoff = autoOutInstant(record.date, hhmm);
  return Date.parse(cutoff) < Date.parse(record.inAt) ? record.inAt : cutoff;
}

// ── durations ───────────────────────────────────────────────────────────────

function minutesBetween(inAt, outAt) {
  if (!inAt || !outAt) return null;
  const ms = Date.parse(outAt) - Date.parse(inAt);
  return Number.isFinite(ms) && ms >= 0 ? Math.round(ms / 60000) : null;
}

/** 586 -> "9h 46m"; under an hour -> "42m". */
function formatDuration(minutes) {
  if (minutes === null || minutes === undefined) return '—';
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}m`;
}

function formatDistance(m) {
  if (m === null || m === undefined) return '';
  return m < 1000 ? `${m} m` : `${(m / 1000).toFixed(1)} km`;
}

/** Human text for a verdict, for the Slack line and the report. */
function describeVerdict(loc) {
  if (!loc || loc.verdict === 'inside') return null;
  if (loc.verdict === 'outside') return `Outside geofence — ${formatDistance(loc.distanceM)} away`;
  const why = {
    no_location: 'location unavailable or permission denied',
    low_accuracy: `location too imprecise (±${formatDistance(loc.accuracyM)})`,
    no_accuracy: 'location accuracy unknown',
  }[loc.reason] || 'could not be checked';
  return `Location unverified — ${why}`;
}

module.exports = {
  shopLocation, radiusMeters, evaluateLocation, validCoords,
  autoOutTime, autoOutInstant, autoOutAt, isStale,
  minutesBetween, formatDuration, formatDistance, describeVerdict,
  DEFAULT_RADIUS_M, DEFAULT_AUTO_OUT, FALLBACK_SHOP,
};
