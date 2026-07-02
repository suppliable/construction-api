'use strict';

// Store business hours, expressed in IST (Asia/Kolkata — India has no DST).
// Open Monday–Saturday 08:45–19:30. Closed all day Sunday.
const OPEN_MINUTES = 8 * 60 + 45;   // 08:45
const CLOSE_MINUTES = 19 * 60 + 30; // 19:30
const OPEN_LABEL = '8:45 AM';
const CLOSE_LABEL = '7:30 PM';

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

/**
 * Whether the store should be open right now per its fixed IST schedule.
 * @param {Date} [now]  Injectable clock for testing; defaults to real time.
 * @returns {{ open: boolean, reason: 'sunday'|'before-open'|'after-close'|null }}
 */
function getScheduleStatus(now = new Date()) {
  const { weekday, minutes } = nowInIST(now);

  if (weekday === 'Sun') return { open: false, reason: 'sunday' };
  if (minutes < OPEN_MINUTES) return { open: false, reason: 'before-open' };
  if (minutes >= CLOSE_MINUTES) return { open: false, reason: 'after-close' };
  return { open: true, reason: null };
}

// Customer-facing message for a schedule-driven closure.
function scheduleClosedMessage(reason) {
  const hours = `${OPEN_LABEL}–${CLOSE_LABEL}`;
  switch (reason) {
    case 'sunday':
      return `We're closed on Sundays. You can add items to your cart and place your order Monday–Saturday, ${hours} IST.`;
    case 'before-open':
      return `We open at ${OPEN_LABEL} IST. You can add items to your cart now and place your order once we're open.`;
    case 'after-close':
      return `We're closed for the day (open ${hours} IST). You can add items to your cart and place your order when we reopen.`;
    default:
      return `We are currently closed (open ${hours} IST). You can add items to your cart and place your order when we reopen.`;
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
  formatISTTime,
  OPEN_MINUTES,
  CLOSE_MINUTES,
  OPEN_LABEL,
  CLOSE_LABEL,
};
