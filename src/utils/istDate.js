'use strict';

// IST date key (YYYY-MM-DD) for a given instant. Used for the per-day order
// counter (which resets at midnight Asia/Kolkata, matching the warehouse's local
// day rather than UTC) and for matching holiday entries in the store schedule.
function istDateKey(d = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(d);
}

module.exports = { istDateKey };
