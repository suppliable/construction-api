'use strict';

// Refuses the admin API to anyone who has attendance on but has not clocked in
// today. Mounted after adminAuth, and AFTER the routes that must stay open so
// they can clock in: sign-out, "who am I", and the attendance status/clock-in/
// clock-out calls. Everything declared below it is locked until they do.
//
// Fails OPEN on an infrastructure error. A Firestore blip must not lock every
// member of staff out of taking orders; the error is logged loudly instead.
// The shared legacy token has no identity, so it has no attendance to require —
// closing that door is what ADMIN_LEGACY_TOKEN=off is for.

const attendance = require('../services/attendanceService');
const logger = require('../utils/logger');

async function requireClockIn(req, res, next) {
  const user = req.adminUser;
  if (!user || user.isLegacy) return next();

  try {
    if (await attendance.mustClockIn(user.userId, req.traceContext)) {
      return res.status(403).json({
        success: false,
        error: 'ATTENDANCE_REQUIRED',
        message: 'Clock in to continue.',
      });
    }
  } catch (err) {
    (req.log || logger).error({ err: err.message }, 'attendance.gate_failed_open');
  }
  return next();
}

module.exports = { requireClockIn };
