'use strict';

const express = require('express');
const router = express.Router();
const authenticate = require('../middleware/auth');
const { authenticateOptional } = require('../middleware/auth');
const { guestFcmRateLimiter } = require('../middleware/rateLimiter');
const fcm = require('../services/fcmService');
const { buildRuntimeDiagnostics, ensureAllowlistedAdminPhone } = require('../services/diagnosticsService');

// Shape check for guest tokens on the unauthenticated path — bounds length and
// charset so junk can't be persisted. Real FCM registration tokens are long
// URL-safe strings, often containing ':', '-', '_' and '.'.
function looksLikeFcmToken(token) {
  return typeof token === 'string'
    && token.length >= 100 && token.length <= 4096
    && /^[A-Za-z0-9_:.-]+$/.test(token);
}

// POST /api/v1/users/fcm-token
// Serves both logged-in users (stored under their uid) and guests browsing
// before OTP login (stored by token hash in guestFcmTokens). Optional auth so a
// missing/invalid token is treated as a guest instead of a 401.
router.post('/fcm-token', authenticateOptional, guestFcmRateLimiter, async (req, res) => {
  try {
    const { token } = req.body || {};

    if (!token || typeof token !== 'string' || !token.trim()) {
      return res.status(400).json({ success: false, error: 'MISSING_PARAM', message: 'token is required' });
    }
    const trimmed = token.trim();

    if (req.user && req.user.uid) {
      await fcm.registerUserToken(req.user.uid, trimmed);
      return res.json({ success: true });
    }

    // Guest path — stricter validation since it's unauthenticated.
    if (!looksLikeFcmToken(trimmed)) {
      return res.status(400).json({ success: false, error: 'INVALID_PARAM', message: 'invalid token' });
    }
    await fcm.registerGuestToken(trimmed);
    return res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: 'SERVER_ERROR', message: err.message });
  }
});

router.get('/environment-info', authenticate, async (req, res, next) => {
  try {
    await ensureAllowlistedAdminPhone(req.user.phone);
    return res.json({
      success: true,
      data: buildRuntimeDiagnostics(),
    });
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
