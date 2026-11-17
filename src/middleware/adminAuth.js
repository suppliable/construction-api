'use strict';

// Identifies the person behind an admin request.
//
// Replaces two copies of `token !== process.env.ADMIN_TOKEN`. The shared token
// is still accepted so the portal keeps working while people are moved across —
// but every use is logged as legacy, so the migration can be finished on
// evidence rather than hope. Set ADMIN_LEGACY_TOKEN=off to refuse it.
//
// The important line here is req.log.child({ adminUserId }): from that point
// every log line in the request carries who made it, which is most of "who did
// what" without any new storage.

const { resolveSession, can } = require('../services/adminAuthService');
const logger = require('../utils/logger');

const LEGACY_USER = Object.freeze({
  userId: 'legacy-shared-token',
  name: 'Shared admin token',
  role: 'admin',
  isLegacy: true,
});

function bearer(req) {
  return (req.headers.authorization || '').replace('Bearer ', '').trim();
}

function unauthorized(res, message = 'Unauthorized') {
  return res.status(401).json({ success: false, error: 'UNAUTHORIZED', message });
}

async function adminAuth(req, res, next) {
  const token = bearer(req);
  if (!token) return unauthorized(res);

  try {
    const session = await resolveSession(token, req.traceContext);
    if (session) {
      req.adminUser = {
        userId: session.userId,
        name: session.name,
        role: session.role || 'staff',
        isLegacy: false,
      };
      req.log = req.log.child({ adminUserId: session.userId });
      return next();
    }

    // Fall back to the shared token while the migration is in flight.
    const legacyAllowed = process.env.ADMIN_LEGACY_TOKEN !== 'off';
    if (legacyAllowed && process.env.ADMIN_TOKEN && token === process.env.ADMIN_TOKEN) {
      req.adminUser = { ...LEGACY_USER };
      req.log = req.log.child({ adminUserId: LEGACY_USER.userId, legacyToken: true });
      // Warn, not info: this is the thing the migration exists to remove, and
      // it should be visible in Grafana until it stops appearing.
      req.log.warn({ path: req.path }, 'admin.auth.legacy_shared_token');
      return next();
    }

    return unauthorized(res, 'Session expired or invalid. Please sign in again.');
  } catch (err) {
    (req.log || logger).error({ err: err.message }, 'admin.auth.failed');
    return unauthorized(res);
  }
}

/**
 * Gate an action on a capability. Separate from adminAuth so a route declares
 * what it needs rather than repeating a role string.
 */
function requireCapability(capability) {
  return (req, res, next) => {
    if (!req.adminUser) return unauthorized(res);
    if (!can(req.adminUser.role, capability)) {
      req.log.warn({ capability, role: req.adminUser.role }, 'admin.auth.forbidden');
      return res.status(403).json({
        success: false,
        error: 'FORBIDDEN',
        message: `Your account does not have permission to ${capability.replace(/_/g, ' ')}.`,
      });
    }
    return next();
  };
}

module.exports = { adminAuth, requireCapability, LEGACY_USER };
