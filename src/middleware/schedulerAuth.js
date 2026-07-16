'use strict';

const { OAuth2Client } = require('google-auth-library');
const env = require('../config/env');
const logger = require('../utils/logger');

// Verifies the OIDC token Cloud Scheduler attaches to its request. The scheduler
// holds no admin credentials — it presents a Google-signed identity token for a
// dedicated service account, and we check both the signature and that the caller
// is the service account we expect.
//
// Requires SCHEDULER_SERVICE_ACCOUNT_EMAIL to be set; without it the endpoint is
// closed rather than open, so a misconfigured deploy can't expose it.

const client = new OAuth2Client();

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
  if (!expectedEmail) {
    logger.warn('Scheduler endpoint called but SCHEDULER_SERVICE_ACCOUNT_EMAIL is unset — refusing');
    return res.status(503).json({ success: false, error: 'NOT_CONFIGURED', message: 'Scheduler auth not configured' });
  }

  const header = req.headers.authorization || '';
  if (!header.startsWith('Bearer ')) {
    return res.status(401).json({ success: false, error: 'UNAUTHORIZED', message: 'Unauthorized' });
  }
  const token = header.slice('Bearer '.length).trim();

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
