'use strict';

const jwt = require('jsonwebtoken');
const admin = require('../utils/firebaseAdmin');
const logger = require('../utils/logger');

// JWT errors that mean "not a custom JWT" — fall through to Firebase.
const JWT_STRUCTURAL_ERRORS = new Set([
  'JsonWebTokenError',
  'TokenExpiredError',
  'NotBeforeError',
]);

/**
 * Dual-token authentication middleware.
 * Accepts either a custom JWT (MSG91 flow) or a Firebase ID token.
 * Tries custom JWT first (no network), falls back to Firebase.
 * Sets req.user = { uid, phone, email, name } on success.
 */
async function authenticate(req, res, next) {
  // Dev-only bypass: pass X-User-Id header to skip token verification.
  // Never active in production.
  if (process.env.NODE_ENV !== 'production' && req.headers['x-user-id']) {
    req.user = { uid: req.headers['x-user-id'] };
    req.log = req.log.child({ userId: req.user.uid });
    return next();
  }

  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({
      success: false,
      code: 'UNAUTHORIZED',
      message: 'Missing or invalid Authorization header',
    });
  }

  const token = authHeader.slice(7);

  // ── Step 1: try custom JWT (MSG91 / future providers) ─────────────────────
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    // Signup tokens are one-time tokens for the /complete-signup endpoint only.
    if (decoded.type === 'signup') {
      return res.status(401).json({
        success: false,
        code: 'UNAUTHORIZED',
        message: 'Signup tokens cannot be used for API authentication',
      });
    }
    req.user = {
      uid: decoded.userId,
      phone: decoded.phone || null,
      email: null,
      name: null,
    };
    req.log = req.log.child({ userId: req.user.uid });
    return next();
  } catch (err) {
    if (!JWT_STRUCTURAL_ERRORS.has(err.name)) {
      // Unexpected error (e.g. key read failure) — don't silently swallow it.
      const log = req.log || logger;
      log.error({ err: err.message }, 'Unexpected error during custom JWT verification');
    }
    // Fall through to Firebase verification.
  }

  // ── Step 2: Firebase ID token ─────────────────────────────────────────────
  try {
    const decoded = await admin.auth().verifyIdToken(token);
    req.user = {
      uid: decoded.uid,
      phone: decoded.phone_number || null,
      email: decoded.email || null,
      name: decoded.name || null,
    };
    req.log = req.log.child({ userId: req.user.uid });
    return next();
  } catch (err) {
    const log = req.log || logger;
    log.warn({ err: err.message, code: err.code }, 'Token verification failed');
    return res.status(401).json({
      success: false,
      code: 'UNAUTHORIZED',
      message: 'Invalid or expired token',
    });
  }
}

module.exports = authenticate;
