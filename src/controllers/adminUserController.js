'use strict';

// Admin login and user management.
//
// Login is deliberately NOT behind adminAuth; everything else is, plus the
// manage_users capability.

const authService = require('../services/adminAuthService');
const audit = require('../services/auditService');

function sendError(res, err, log, label) {
  if (err && err.statusCode) {
    return res.status(err.statusCode).json({ success: false, error: err.code, message: err.message });
  }
  if (log) log.error({ err: err.message }, label);
  return res.status(500).json({ success: false, error: 'SERVER_ERROR', message: err.message });
}

// POST /api/v1/admin/auth   { email, password }  — or legacy { password }
const login = async (req, res) => {
  try {
    const { email, password } = req.body || {};

    // Legacy single-password login, kept so the portal works mid-migration.
    // Logged as a warning for the same reason the middleware does.
    if (!email) {
      if (process.env.ADMIN_LEGACY_TOKEN === 'off') {
        return res.status(401).json({
          success: false, error: 'EMAIL_REQUIRED',
          message: 'Sign in with your email address and password.',
        });
      }
      if (!password || password !== process.env.ADMIN_PASSWORD) {
        return res.status(401).json({ success: false, error: 'INVALID_PASSWORD', message: 'Invalid password' });
      }
      req.log.warn('admin.login.legacy_shared_password');
      return res.json({
        success: true,
        data: { token: process.env.ADMIN_TOKEN, user: { name: 'Shared admin token', role: 'admin', isLegacy: true } },
      });
    }

    const { token, user } = await authService.login(
      { email, password, ip: req.ip }, req.traceContext
    );
    res.json({ success: true, data: { token, user } });
  } catch (err) {
    sendError(res, err, req.log, 'admin login failed');
  }
};

// POST /api/v1/admin/logout
const logout = async (req, res) => {
  try {
    await authService.logout((req.headers.authorization || '').replace('Bearer ', '').trim(), req.traceContext);
    res.json({ success: true, data: { loggedOut: true } });
  } catch (err) {
    sendError(res, err, req.log, 'admin logout failed');
  }
};

// GET /api/v1/admin/me — who the portal is signed in as.
const me = async (req, res) => {
  res.json({ success: true, data: req.adminUser });
};

// GET /api/v1/admin/users
const listUsers = async (req, res) => {
  try {
    res.json({ success: true, data: { users: await authService.listUsers(req.traceContext) } });
  } catch (err) {
    sendError(res, err, req.log, 'listAdminUsers failed');
  }
};

// POST /api/v1/admin/users
const createUser = async (req, res) => {
  try {
    const user = await authService.createUser(req.body || {}, req.adminUser?.userId, req.traceContext);
    await audit.record(req, audit.ACTIONS.ADMIN_USER_CREATED,
      { type: 'admin_user', id: user.userId, name: user.name }, null, { role: user.role });
    res.status(201).json({ success: true, data: user });
  } catch (err) {
    sendError(res, err, req.log, 'createAdminUser failed');
  }
};

// POST /api/v1/admin/users/:userId/active   { isActive }
const setActive = async (req, res) => {
  try {
    const { isActive } = req.body || {};
    // Locking yourself out is not a thing anyone means to do.
    if (req.adminUser?.userId === String(req.params.userId).toLowerCase() && isActive === false) {
      return res.status(400).json({
        success: false, error: 'CANNOT_DEACTIVATE_SELF',
        message: 'You cannot deactivate your own account.',
      });
    }
    const user = await authService.setActive(
      req.params.userId, isActive !== false, req.adminUser?.userId, req.traceContext
    );
    await audit.record(req, audit.ACTIONS.ADMIN_USER_ACTIVE_CHANGED,
      { type: 'admin_user', id: user.userId, name: user.name },
      { before: !user.isActive, after: user.isActive });
    res.json({ success: true, data: user });
  } catch (err) {
    sendError(res, err, req.log, 'setAdminUserActive failed');
  }
};

// POST /api/v1/admin/users/:userId/attendance   { enabled }
const setAttendance = async (req, res) => {
  try {
    const enabled = req.body?.enabled === true;
    const user = await authService.setAttendance(
      req.params.userId, enabled, req.adminUser?.userId, req.traceContext
    );
    require('../services/attendanceService').forget(user.userId);
    await audit.record(req, audit.ACTIONS.ADMIN_USER_ATTENDANCE_CHANGED,
      { type: 'admin_user', id: user.userId, name: user.name },
      { before: !enabled, after: enabled });
    res.json({ success: true, data: user });
  } catch (err) {
    sendError(res, err, req.log, 'setAdminUserAttendance failed');
  }
};

// POST /api/v1/admin/users/:userId/password   { password }
const setPassword = async (req, res) => {
  try {
    const user = await authService.setPassword(
      req.params.userId, req.body?.password, req.adminUser?.userId, req.traceContext
    );
    await audit.record(req, audit.ACTIONS.ADMIN_USER_PASSWORD_RESET,
      { type: 'admin_user', id: user.userId, name: user.name });
    res.json({ success: true, data: user });
  } catch (err) {
    sendError(res, err, req.log, 'setAdminUserPassword failed');
  }
};

// GET /api/v1/admin/activity?actorId=&action=&from=&to=&limit=
const activity = async (req, res) => {
  try {
    const { actorId, action, from, to } = req.query;
    const limit = Math.min(Number(req.query.limit) || 200, 500);
    const rows = await audit.list({ actorId, action, from, to, limit }, req.traceContext);
    res.json({ success: true, data: { rows, labels: audit.LABELS } });
  } catch (err) {
    sendError(res, err, req.log, 'activity failed');
  }
};

module.exports = { login, logout, me, listUsers, createUser, setActive, setPassword, setAttendance, activity };
