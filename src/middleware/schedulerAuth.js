'use strict';

const { OAuth2Client } = require('google-auth-library');
const env = require('../config/env');
const logger = require('../utils/logger');

// Verifies the caller triggering the warehouse schedule tick. Two schemes are
// accepted:
//
// 1. Google OIDC (Cloud Run/Cloud Scheduler deploys): the scheduler presents a
//    Google-signed identity token for a dedicated service account, checked
//    against SCHEDULER_SERVICE_ACCOUNT_EMAIL below.
// 2. Shared secret (Render/GitHub Actions deploys, which have no GCP identity
//    to present): a static Bearer token compared against SCHEDULER_TOKEN.
//
// Both are opt-in via env var; whichever is configured, is accepted. If neither
// is set the endpoint is closed rather than open, so a misconfigured deploy
// can't expose it.

const client = new OAuth2Client();

function timingSafeEqual(a, b) {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return require('crypto').timingSafeEqual(bufA, bufB);
}

// The audience Cloud Scheduler signs its token for: this service's own URL.
// Cloud Run does not inject its URL as an env var, so derive it from the request
// the scheduler actually made. Host is safe to trust here only because the token
// signature is verified against it — an attacker forging Host can't also mint a
// Google-signed token for that audience.
function audienceFromRequest(req) {
  const proto = req.get('x-forwarded-proto') || 'https';
  const host = req.get('host');
  return host ? `${proto}://${host}` : null;
}

async function requireScheduler(req, res, next) {
  const expectedEmail = env.SCHEDULER_SERVICE_ACCOUNT_EMAIL;
  const sharedSecret = env.SCHEDULER_TOKEN;
  if (!expectedEmail && !sharedSecret) {
    logger.warn('Scheduler endpoint called but neither SCHEDULER_SERVICE_ACCOUNT_EMAIL nor SCHEDULER_TOKEN is set — refusing');
    return res.status(503).json({ success: false, error: 'NOT_CONFIGURED', message: 'Scheduler auth not configured' });
  }

  const header = req.headers.authorization || '';
  if (!header.startsWith('Bearer ')) {
    return res.status(401).json({ success: false, error: 'UNAUTHORIZED', message: 'Unauthorized' });
  }
  const token = header.slice('Bearer '.length).trim();

  // Shared-secret path: Render/GitHub Actions have no GCP identity to present,
  // so a static token stands in for the OIDC check below.
  if (sharedSecret && timingSafeEqual(token, sharedSecret)) {
    return next();
  }

  if (!expectedEmail) {
    return res.status(401).json({ success: false, error: 'UNAUTHORIZED', message: 'Unauthorized' });
  }

  // Pin the audience so a token minted for this service account but addressed to
  // some other service can't be replayed here. deploy.sh passes the service URL
  // as --oidc-token-audience, which is what the derived value matches; the env
  // var overrides for setups where the two differ (custom domain, proxy).
  const audience = env.SCHEDULER_OIDC_AUDIENCE || audienceFromRequest(req);
  if (!audience) {
    logger.warn('Scheduler auth: could not determine expected audience — refusing');
    return res.status(401).json({ success: false, error: 'UNAUTHORIZED', message: 'Unauthorized' });
  }

  try {
    const ticket = await client.verifyIdToken({ idToken: token, audience });
    const payload = ticket.getPayload();
    if (!payload || payload.email !== expectedEmail || payload.email_verified !== true) {
      logger.warn({ email: payload && payload.email }, 'Scheduler auth rejected: unexpected caller');
      return res.status(403).json({ success: false, error: 'FORBIDDEN', message: 'Forbidden' });
    }
    return next();
  } catch (err) {
    logger.warn({ err: err.message }, 'Scheduler auth rejected: token verification failed');
    return res.status(401).json({ success: false, error: 'UNAUTHORIZED', message: 'Unauthorized' });
  }
}

module.exports = { requireScheduler };
