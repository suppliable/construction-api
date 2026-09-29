'use strict';

const {
  getScheduleStatus, scheduleClosedMessage, parseSchedule, formatISTTime,
  istInstantFromMinutes, nextBoundaryMinutes, DAY_MINUTES,
} = require('./storeSchedule');
const remoteConfig = require('../services/remoteConfigService');

const DEFAULT_CLOSED_MESSAGE = 'We are currently closed. You can add items to cart and place your order when we reopen.';

// ── THE MODEL ────────────────────────────────────────────────
// The schedule is the standing instruction and always runs. An admin override is
// a temporary exception for TODAY ONLY that expires by itself, so the store can
// never be left stranded: the worst case is that it corrects itself at the next
// IST midnight.
//
// Two fields carry it:
//   override      'open' | 'closed' | null
//   overrideUntil ISO timestamp — ALWAYS set whenever override is set
//
// An override with no expiry cannot be represented, which is what makes a
// stuck-closed store impossible. Multi-day closures are deliberately NOT done
// here — they belong in the schedule's `holidays` list, set by a developer.
//
// The legacy fields (warehouseOpen, warehouseClosedUntil, warehouseForceOpen,
// warehouseForceOpenUntil) are intentionally IGNORED. They are the previous
// model, and an indefinite warehouseOpen:false left the store shut until a human
// noticed. Ignoring them means any such state clears itself on deploy.

// Whether an override is set AND still within its window. A missing or malformed
// expiry is treated as already expired: an override we cannot time-bound is
// exactly the failure this model exists to prevent, so it is discarded and the
// schedule resumes.
function activeOverride(settings, now = new Date()) {
  const state = settings.override;
  if (state !== 'open' && state !== 'closed') return null;
  const untilMs = Date.parse(settings.overrideUntil);
  if (Number.isNaN(untilMs)) return null;
  if (now.getTime() >= untilMs) return null;
  return state;
}

// Read the store schedule from Remote Config. Falls back to the hardcoded
// business hours if the key is missing or malformed — remoteConfigService
// already caches the template and never throws, so this stays cheap per request.
async function loadSchedule() {
  const raw = await remoteConfig.getString('warehouse_schedule', '');
  return parseSchedule(raw);
}

/**
 * When an override starting now should expire. Asymmetric, because the two
 * actions mean different things:
 *
 *   'closed' → the rest of today. "Close" before opening time must mean "we are
 *              not opening today"; expiring at the next boundary would let the
 *              schedule open the store anyway, which is the opposite of intent.
 *   'open'   → the next boundary today, else the rest of today. Opening early
 *              must not also cancel the normal closing time, so the override
 *              hands back to the schedule at the next boundary.
 *
 * Either way the expiry never crosses IST midnight.
 */
function resolveOverrideExpiry(state, now = new Date(), schedule = null) {
  if (state === 'closed') return istInstantFromMinutes(now, DAY_MINUTES);
  const boundary = nextBoundaryMinutes(now, schedule || undefined);
  return istInstantFromMinutes(now, boundary === null ? DAY_MINUTES : boundary);
}

/**
 * Combine the schedule with an active override.
 *
 * The override, while live, simply replaces the schedule's answer — there is no
 * precedence tangle to reason about. Once it expires the schedule resumes with
 * no action from anyone.
 *
 * A pure function of the clock and the two config sources, so it is correct the
 * instant a boundary passes — no propagation delay.
 *
 * @param {Object} settings   Firestore settings doc (override, overrideUntil, warehouseClosedMessage).
 * @param {Date} [now]        Injectable clock for testing.
 * @param {Object} [schedule] Injectable parsed schedule; loaded from RC when omitted.
 */
async function computeWarehouseStatus(settings, now = new Date(), schedule = null) {
  const resolved = schedule || await loadSchedule();
  const status = getScheduleStatus(now, resolved);
  const override = activeOverride(settings, now);

  const isOpen = override ? override === 'open' : status.open;

  const data = { isOpen, closedMessage: '' };

  if (override) {
    // Surfaced so the admin panel can state when normal hours resume, instead of
    // showing a toggle whose effect and duration are invisible.
    data.override = override;
    data.overrideUntil = settings.overrideUntil;
  }
  if (isOpen && override === 'open' && !status.open) {
    data.forcedOpen = true;
  }
  if (!isOpen) {
    // Why the store is closed: an admin's override, or the schedule itself.
    data.closedReason = override ? 'override' : 'schedule';
    if (override) {
      data.closedMessage = settings.warehouseClosedMessage
        || `We're temporarily closed. We'll reopen around ${formatISTTime(new Date(settings.overrideUntil))} IST.`;
    } else {
      data.closedMessage = scheduleClosedMessage(status);
    }
  }
  return data;
}

module.exports = {
  computeWarehouseStatus,
  resolveOverrideExpiry,
  activeOverride,
  loadSchedule,
  DEFAULT_CLOSED_MESSAGE,
};
