'use strict';

// Last line of defence against leaking exception text to clients.
//
// The global error handler only sees errors that reach it — but ~119 handlers
// across the codebase catch their own errors and respond directly with
// `message: err.message`. On a 5xx that message is whatever the thrown object
// carried: a Firestore FAILED_PRECONDITION with a console URL naming the GCP
// project, a vendor payload, a driver stack string. That is information
// disclosure, not just poor copy.
//
// Patching 119 call sites would miss the next one written. Instead this wraps
// res.json once, so any 5xx body is sanitised on the way out no matter which
// handler produced it.

const { buildErrorBody } = require('../utils/safeError');

function sanitizeServerErrors(req, res, next) {
  const originalJson = res.json.bind(res);

  res.json = (body) => {
    const status = res.statusCode || 200;
    if (status >= 500 && body && typeof body === 'object' && !Array.isArray(body)) {
      // Already sanitised (a handler used buildErrorBody itself) — leave it
      // alone rather than minting a second, conflicting correlationId.
      if (body.correlationId) return originalJson(body);

      const raw = body.message;
      const { body: safe, correlationId } = buildErrorBody({ code: body.error }, status);
      const log = req.log || console;
      if (raw && log.error) {
        log.error({ correlationId, rawMessage: raw, path: req.path }, 'server error message withheld from client');
      }
      // Keep whatever else the handler set (issues, canAddToCart, …) and
      // replace only the parts that can carry exception text.
      return originalJson({ ...body, ...safe });
    }
    return originalJson(body);
  };

  next();
}

module.exports = { sanitizeServerErrors };
