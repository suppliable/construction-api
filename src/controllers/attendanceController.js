'use strict';

// Attendance endpoints.
//
// Clock-in/out and status are open to any signed-in user who has attendance
// switched on (the service enforces that). The report and corrections are
// admin-only, gated in routes/admin.js by capability.

const attendance = require('../services/attendanceService');

function sendError(res, err, log, label) {
  if (err && err.statusCode) {
    return res.status(err.statusCode).json({ success: false, error: err.code, message: err.message });
  }
  if (log) log.error({ err: err.message }, label);
  return res.status(500).json({ success: false, error: 'SERVER_ERROR', message: err.message });
}

/** Location as the browser reports it. All optional: a denied permission is a
 *  normal case that must still produce a (flagged) clock-in, not an error. */
function readingFrom(body) {
  return { lat: body?.lat, lng: body?.lng, accuracy: body?.accuracy };
}

// The shared-token session has no identity, so it cannot have attendance.
function who(req, res) {
  if (!req.adminUser || req.adminUser.isLegacy) {
    res.status(403).json({
      success: false, error: 'ATTENDANCE_NOT_ENABLED',
      message: 'Sign in with your own account to use attendance.',
    });
    return null;
  }
  return req.adminUser.userId;
}

// GET /api/v1/admin/attendance/me
const me = async (req, res) => {
  try {
    const userId = who(req, res); if (!userId) return;
    res.json({ success: true, data: await attendance.status(userId, req.traceContext) });
  } catch (err) { sendError(res, err, req.log, 'attendance status failed'); }
};

// POST /api/v1/admin/attendance/clock-in   { lat, lng, accuracy }
const clockIn = async (req, res) => {
  try {
    const userId = who(req, res); if (!userId) return;
    res.json({ success: true, data: await attendance.clockIn(userId, readingFrom(req.body), req.traceContext) });
  } catch (err) { sendError(res, err, req.log, 'attendance clock-in failed'); }
};

// POST /api/v1/admin/attendance/clock-out   { lat, lng, accuracy }
const clockOut = async (req, res) => {
  try {
    const userId = who(req, res); if (!userId) return;
    res.json({ success: true, data: await attendance.clockOut(userId, readingFrom(req.body), req.traceContext) });
  } catch (err) { sendError(res, err, req.log, 'attendance clock-out failed'); }
};

// GET /api/v1/admin/attendance?from=&to=&userId=
const report = async (req, res) => {
  try {
    const { from, to, userId } = req.query;
    res.json({ success: true, data: await attendance.report({ from, to, userId }, req.traceContext) });
  } catch (err) { sendError(res, err, req.log, 'attendance report failed'); }
};

// PUT /api/v1/admin/attendance/:id   { inAt?, outAt? }
const edit = async (req, res) => {
  try {
    const record = await attendance.editPunch(
      decodeURIComponent(req.params.id), req.body || {}, req, req.traceContext
    );
    res.json({ success: true, data: record });
  } catch (err) { sendError(res, err, req.log, 'attendance edit failed'); }
};

module.exports = { me, clockIn, clockOut, report, edit };
