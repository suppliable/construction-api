'use strict';

const { istDateKey } = require('./istDate');

// Store business hours, expressed in IST (Asia/Kolkata — India has no DST).
// These are the FALLBACK schedule, used when Remote Config is unreachable or
// carries a malformed `warehouse_schedule`. Failing back to the real business
// hours keeps the store correctly closed overnight rather than failing open.
// Open Monday–Saturday 08:45–19:30. Closed all day Sunday.
const OPEN_MINUTES = 8 * 60 + 45;   // 08:45
const CLOSE_MINUTES = 19 * 60 + 30; // 19:30
const OPEN_LABEL = '8:45 AM';
const CLOSE_LABEL = '7:30 PM';

const DAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

const FALLBACK_SCHEDULE = {
  days: {
    sun: null,
    mon: [OPEN_MINUTES, CLOSE_MINUTES],
    tue: [OPEN_MINUTES, CLOSE_MINUTES],
    wed: [OPEN_MINUTES, CLOSE_MINUTES],
    thu: [OPEN_MINUTES, CLOSE_MINUTES],
    fri: [OPEN_MINUTES, CLOSE_MINUTES],
    sat: [OPEN_MINUTES, CLOSE_MINUTES],
  },
  holidays: [],
};

// Read the current wall-clock hour/minute/weekday in IST regardless of the
// server's own timezone, using Intl rather than manual offset math.
function nowInIST(now) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Kolkata',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(now);

  const map = {};
  for (const p of parts) map[p.type] = p.value;

  let hour = parseInt(map.hour, 10);
  if (hour === 24) hour = 0; // some ICU builds render midnight as "24"
  const minute = parseInt(map.minute, 10);

  return { weekday: map.weekday, minutes: hour * 60 + minute };
}

// "HH:MM" → minutes since midnight. Returns null on anything unparseable so the
// caller can reject the whole schedule rather than silently mis-scheduling.
function parseHHMM(value) {
  if (typeof value !== 'string') return null;
  const m = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!m) return null;
  const hours = parseInt(m[1], 10);
  const mins = parseInt(m[2], 10);
  if (hours > 23 || mins > 59) return null;
  return hours * 60 + mins;
}

/**
 * Parse the `warehouse_schedule` RC payload into minute offsets.
 *
 * Shape: { days: { mon: ["08:45","19:30"], sun: null, ... }, holidays: ["YYYY-MM-DD"] }
 *
 * Returns the FALLBACK_SCHEDULE on any structural problem — malformed JSON, a
 * bad time string, or a close time that isn't after its open. A broken schedule
 * must never widen the store's hours, so anything we can't fully trust is
 * discarded in favour of the known-good business hours.
 *
 * @param {string} raw  JSON string from Remote Config.
 * @returns {{ days: Object, holidays: string[], usedFallback: boolean }}
 */
function parseSchedule(raw) {
  if (!raw || typeof raw !== 'string') return { ...FALLBACK_SCHEDULE, usedFallback: true };

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ...FALLBACK_SCHEDULE, usedFallback: true };
  }

  if (!parsed || typeof parsed !== 'object' || !parsed.days || typeof parsed.days !== 'object') {
    return { ...FALLBACK_SCHEDULE, usedFallback: true };
  }

  const days = {};
  for (const key of DAY_KEYS) {
    const entry = parsed.days[key];
    // An absent or explicitly-null day means closed all day.
    if (entry === null || entry === undefined) {
      days[key] = null;
      continue;
    }
    if (!Array.isArray(entry) || entry.length !== 2) {
      return { ...FALLBACK_SCHEDULE, usedFallback: true };
    }
    const open = parseHHMM(entry[0]);
    const close = parseHHMM(entry[1]);
    if (open === null || close === null || close <= open) {
      return { ...FALLBACK_SCHEDULE, usedFallback: true };
    }
    days[key] = [open, close];
  }

  const holidays = Array.isArray(parsed.holidays)
    ? parsed.holidays.filter(h => typeof h === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(h))
    : [];

  return { days, holidays, usedFallback: false };
}

// Minutes-since-midnight → "8:45 AM" style label, for customer-facing copy.
function minutesLabel(minutes) {
  const h24 = Math.floor(minutes / 60);
  const mins = minutes % 60;
  const suffix = h24 < 12 ? 'AM' : 'PM';
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${h12}:${String(mins).padStart(2, '0')} ${suffix}`;
}

/**
 * Whether the store should be open right now per its schedule.
 * @param {Date} [now]        Injectable clock for testing; defaults to real time.
 * @param {Object} [schedule] Parsed schedule from parseSchedule(); defaults to
 *                            the hardcoded fallback hours.
 * @returns {{ open: boolean, reason: 'holiday'|'closed-day'|'before-open'|'after-close'|null,
 *             opensAt: number|null, closesAt: number|null }}
 */
function getScheduleStatus(now = new Date(), schedule = FALLBACK_SCHEDULE) {
  const { weekday, minutes } = nowInIST(now);
  const dayKey = weekday.toLowerCase().slice(0, 3);
  const hours = schedule.days ? schedule.days[dayKey] : null;

  if (schedule.holidays && schedule.holidays.includes(istDateKey(now))) {
    return { open: false, reason: 'holiday', opensAt: null, closesAt: null };
  }
  if (!hours) return { open: false, reason: 'closed-day', opensAt: null, closesAt: null };

  const [openAt, closeAt] = hours;
  if (minutes < openAt) return { open: false, reason: 'before-open', opensAt: openAt, closesAt: closeAt };
  if (minutes >= closeAt) return { open: false, reason: 'after-close', opensAt: openAt, closesAt: closeAt };
  return { open: true, reason: null, opensAt: openAt, closesAt: closeAt };
}

// Customer-facing message for a schedule-driven closure. `status` is the object
// returned by getScheduleStatus, so the copy reflects the live schedule's hours
// rather than the hardcoded defaults.
function scheduleClosedMessage(status) {
  const openLabel = status && status.opensAt !== null && status.opensAt !== undefined
    ? minutesLabel(status.opensAt) : OPEN_LABEL;
  const closeLabel = status && status.closesAt !== null && status.closesAt !== undefined
    ? minutesLabel(status.closesAt) : CLOSE_LABEL;
  const hours = `${openLabel}–${closeLabel}`;
  const reason = status && status.reason;

  switch (reason) {
    case 'holiday':
      return `We're closed today for a holiday. You can add items to your cart and place your order when we reopen.`;
    case 'closed-day':
      return `We're closed today. You can add items to your cart and place your order when we reopen.`;
    case 'before-open':
      return `We open at ${openLabel} IST. You can add items to your cart now and place your order once we're open.`;
    case 'after-close':
      return `We're closed for the day (open ${hours} IST). You can add items to your cart and place your order when we reopen.`;
    default:
      return `We are currently closed. You can add items to your cart and place your order when we reopen.`;
  }
}

// Human-readable IST clock time for a given instant, e.g. "2:00 PM".
function formatISTTime(date) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Kolkata',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(date);
}

module.exports = {
  getScheduleStatus,
  scheduleClosedMessage,
  parseSchedule,
  formatISTTime,
  minutesLabel,
  FALLBACK_SCHEDULE,
  OPEN_MINUTES,
  CLOSE_MINUTES,
  OPEN_LABEL,
  CLOSE_LABEL,
};
