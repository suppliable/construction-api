'use strict';

// Builds the JSON body for an error response.
//
// A 5xx is an exception we did not anticipate, so its message is whatever the
// thrown object happened to carry — a stack-adjacent string, a vendor payload,
// or a Firestore FAILED_PRECONDITION complete with a console URL naming the GCP
// project. None of that belongs on a customer's screen, and the console URL in
// particular is information disclosure rather than just poor copy.
//
// So: anything the code deliberately raised (a 4xx with its own code) keeps its
// message, because that text was written to be read. Anything 5xx is replaced
// with fixed copy, and the real message goes to the logs with a correlationId
// the customer can quote back.

const crypto = require('crypto');
const { trace } = require('@opentelemetry/api');

const GENERIC_5XX_MESSAGE = 'Something went wrong. Please try again.';

// Prefer the active trace id so a reported id joins up with the logs and traces
// already being collected; fall back to a random short id when tracing is off.
function correlationId() {
  const span = trace.getActiveSpan();
  const traceId = span && span.spanContext && span.spanContext().traceId;
  if (traceId) return traceId.slice(0, 8);
  return crypto.randomBytes(4).toString('hex');
}

/**
 * @param {Error} err              the thrown error
 * @param {number} statusCode      the status being returned
 * @returns {{ body: Object, correlationId: string|null }}
 */
function buildErrorBody(err, statusCode) {
  const isServerError = statusCode >= 500;
  const body = { success: false, error: (err && err.code) || 'SERVER_ERROR' };

  if (isServerError) {
    const id = correlationId();
    body.error = 'SERVER_ERROR';
    // The ref is appended to the message as well as exposed as its own field:
    // every existing client already renders `message`, so this surfaces a
    // quotable id in the app and the admin portal with no client change. Without
    // it the generic copy is a dead end for whoever has to debug the report.
    body.message = `${GENERIC_5XX_MESSAGE} (ref: ${id})`;
    body.correlationId = id;
    return { body, correlationId: id };
  }

  body.message = (err && err.message) || 'Request failed';
  return { body, correlationId: null };
}

module.exports = { buildErrorBody, GENERIC_5XX_MESSAGE };
