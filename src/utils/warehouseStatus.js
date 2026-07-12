'use strict';

const { getScheduleStatus, scheduleClosedMessage, formatISTTime } = require('./storeSchedule');

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

// Combine the fixed IST schedule with the admin kill-switch. The store is open
// only when the schedule says so AND no manual close is in effect. A manual
// close always wins over the schedule so the store can be shut for maintenance
// or an emergency.
function computeWarehouseStatus(settings, now = new Date()) {
  const manualClosed = isManuallyClosed(settings, now);
  const schedule = getScheduleStatus(now);
  const isOpen = schedule.open && !manualClosed;

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
      data.closedMessage = scheduleClosedMessage(schedule.reason);
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
  DEFAULT_CLOSED_MESSAGE,
};
