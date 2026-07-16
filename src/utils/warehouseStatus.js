'use strict';

const { getScheduleStatus, scheduleClosedMessage, parseSchedule, formatISTTime } = require('./storeSchedule');
const remoteConfig = require('../services/remoteConfigService');

const DEFAULT_CLOSED_MESSAGE = 'We are currently closed. You can add items to cart and place your order when we reopen.';

// Whether an admin manual close is currently in effect. A manual close can be
// indefinite (warehouseOpen === false, no expiry) or timed (warehouseClosedUntil
// set): once the timed window passes, the close expires and the schedule resumes
// automatically — no need for the admin to reopen. A malformed timestamp fails
// safe (stays closed).
function isManuallyClosed(settings, now) {
  if (settings.warehouseOpen !== false) return false;
  const until = settings.warehouseClosedUntil;
  if (!until) return true; // indefinite
  const untilMs = Date.parse(until);
  if (Number.isNaN(untilMs)) return true;
  return now.getTime() < untilMs; // still within the maintenance window
}

// Read the store schedule from Remote Config. Falls back to the hardcoded
// business hours if the key is missing or malformed — remoteConfigService
// already caches the template and never throws, so this stays cheap per request.
async function loadSchedule() {
  const raw = await remoteConfig.getString('warehouse_schedule', '');
  return parseSchedule(raw);
}

/**
 * Combine the IST schedule with the admin kill-switch. The store is open only
 * when the schedule says so AND no manual close is in effect. A manual close
 * always wins over the schedule so the store can be shut for maintenance or an
 * emergency.
 *
 * The result is a pure function of the clock and the two config sources, so it
 * is correct the instant the schedule boundary passes — no propagation delay.
 *
 * @param {Object} settings   Firestore settings doc (warehouseOpen, warehouseClosedUntil, ...).
 * @param {Date} [now]        Injectable clock for testing.
 * @param {Object} [schedule] Injectable parsed schedule; loaded from RC when omitted.
 */
async function computeWarehouseStatus(settings, now = new Date(), schedule = null) {
  const resolved = schedule || await loadSchedule();
  const manualClosed = isManuallyClosed(settings, now);
  const status = getScheduleStatus(now, resolved);
  const isOpen = status.open && !manualClosed;

  const data = { isOpen, closedMessage: '' };
  if (!isOpen) {
    if (manualClosed) {
      const until = settings.warehouseClosedUntil;
      if (until && !Number.isNaN(Date.parse(until))) {
        data.closedUntil = until;
        data.closedMessage = settings.warehouseClosedMessage
          || `We're temporarily closed for maintenance. We'll reopen around ${formatISTTime(new Date(until))} IST.`;
      } else {
        data.closedMessage = settings.warehouseClosedMessage || DEFAULT_CLOSED_MESSAGE;
      }
    } else {
      data.closedMessage = scheduleClosedMessage(status);
    }
  }
  return data;
}

// Resolve an optional expiry for a timed maintenance close from the request body.
// Accepts `closedForMinutes` (relative) or `closedUntil` (absolute ISO string).
// Returns { until } on success, { error } on invalid input, or {} if neither given.
function resolveClosedUntil(body, now) {
  const { closedForMinutes, closedUntil } = body;
  if (closedForMinutes !== undefined && closedForMinutes !== null) {
    const mins = Number(closedForMinutes);
    if (!Number.isFinite(mins) || mins <= 0) {
      return { error: 'closedForMinutes must be a positive number' };
    }
    return { until: new Date(now.getTime() + mins * 60_000).toISOString() };
  }
  if (closedUntil !== undefined && closedUntil !== null) {
    const ms = Date.parse(closedUntil);
    if (Number.isNaN(ms)) return { error: 'closedUntil must be a valid ISO timestamp' };
    if (ms <= now.getTime()) return { error: 'closedUntil must be in the future' };
    return { until: new Date(ms).toISOString() };
  }
  return {};
}

module.exports = {
  computeWarehouseStatus,
  resolveClosedUntil,
  isManuallyClosed,
  loadSchedule,
  DEFAULT_CLOSED_MESSAGE,
};
