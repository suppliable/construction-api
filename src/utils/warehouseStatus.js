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

// Whether an admin force-open is currently in effect. Mirrors isManuallyClosed:
// indefinite (warehouseForceOpen === true, no expiry) or timed
// (warehouseForceOpenUntil set), expiring back to schedule-driven behaviour
// once the window passes. A malformed timestamp fails safe (NOT forced open) —
// the opposite failure direction from isManuallyClosed, since this flag widens
// hours rather than narrowing them.
function isForceOpen(settings, now) {
  if (settings.warehouseForceOpen !== true) return false;
  const until = settings.warehouseForceOpenUntil;
  if (!until) return true; // indefinite
  const untilMs = Date.parse(until);
  if (Number.isNaN(untilMs)) return false;
  return now.getTime() < untilMs;
}

/**
 * Combine the IST schedule with the admin overrides. The store is open when
 * (the schedule says so, OR an admin force-open is in effect) AND no manual
 * close is in effect. A manual close always wins over both the schedule and a
 * force-open, so the store can still be shut for maintenance or an emergency
 * no matter what else is configured.
 *
 * force-open is a deliberate policy bypass — it lets the store accept orders
 * outside its configured hours, which normally means no one is staffed to
 * fulfil them. Use it only when someone is actually on hand to pack/dispatch.
 *
 * The result is a pure function of the clock and the two config sources, so it
 * is correct the instant the schedule boundary passes — no propagation delay.
 *
 * @param {Object} settings   Firestore settings doc (warehouseOpen, warehouseClosedUntil, warehouseForceOpen, warehouseForceOpenUntil, ...).
 * @param {Date} [now]        Injectable clock for testing.
 * @param {Object} [schedule] Injectable parsed schedule; loaded from RC when omitted.
 */
async function computeWarehouseStatus(settings, now = new Date(), schedule = null) {
  const resolved = schedule || await loadSchedule();
  const manualClosed = isManuallyClosed(settings, now);
  const status = getScheduleStatus(now, resolved);
  const forceOpen = isForceOpen(settings, now);
  // A manual close overrides both the schedule and a force-open — it's
  // always the final word, regardless of what else is configured.
  const isOpen = (status.open || forceOpen) && !manualClosed;

  const data = { isOpen, closedMessage: '' };
  if (isOpen && forceOpen && !status.open) {
    data.forcedOpen = true;
  }
  if (!isOpen) {
    // Exposes *why* the store is closed (admin kill-switch vs. schedule) so
    // callers like the admin portal can explain that a manual "Open" toggle
    // clears the admin close but can never override the schedule — without
    // this, both causes look identical (isOpen: false + a message) and an
    // admin toggling Open outside business hours sees no visible effect with
    // no indication why.
    data.closedReason = manualClosed ? 'manual' : 'schedule';
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

// Resolve an optional expiry for a timed force-open from the request body.
// Same shape as resolveClosedUntil — accepts `forceOpenForMinutes` (relative)
// or `forceOpenUntil` (absolute ISO string). Returns { until } on success,
// { error } on invalid input, or {} (indefinite) if neither is given.
function resolveForceOpenUntil(body, now) {
  const { forceOpenForMinutes, forceOpenUntil } = body;
  if (forceOpenForMinutes !== undefined && forceOpenForMinutes !== null) {
    const mins = Number(forceOpenForMinutes);
    if (!Number.isFinite(mins) || mins <= 0) {
      return { error: 'forceOpenForMinutes must be a positive number' };
    }
    return { until: new Date(now.getTime() + mins * 60_000).toISOString() };
  }
  if (forceOpenUntil !== undefined && forceOpenUntil !== null) {
    const ms = Date.parse(forceOpenUntil);
    if (Number.isNaN(ms)) return { error: 'forceOpenUntil must be a valid ISO timestamp' };
    if (ms <= now.getTime()) return { error: 'forceOpenUntil must be in the future' };
    return { until: new Date(ms).toISOString() };
  }
  return {};
}

module.exports = {
  computeWarehouseStatus,
  resolveClosedUntil,
  resolveForceOpenUntil,
  isManuallyClosed,
  isForceOpen,
  loadSchedule,
  DEFAULT_CLOSED_MESSAGE,
};
