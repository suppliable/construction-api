'use strict';

const { randomBytes } = require('crypto');

/**
 * W3C Trace Context middleware.
 * Parses the incoming traceparent header if present, or generates a fresh one.
 * Format: 00-{traceId:32hex}-{spanId:16hex}-01
 *
 * Sets req.traceContext = { traceId, spanId, parentSpanId, traceparent, traceFlags }
 * Echoes traceparent on the response so clients can correlate logs.
 */
function tracing(req, res, next) {
  // Multiple middleware layers (pino-http, compression, firestoreTracker, controllerSpan)
  // each legitimately attach finish/close listeners. Raise the limit to silence the
  // false-positive MaxListenersExceededWarning without masking real leaks elsewhere.
  res.setMaxListeners(20);
  let traceId;
  let parentSpanId = null;
  let traceFlags = '01';
  const incoming = req.headers['traceparent'];
  const incomingClientTraceId = req.headers['x-trace-id'];

  if (incoming) {
    // Parse existing traceparent: version-traceId-parentSpanId-flags
    const parts = incoming.split('-');
    if (
      parts.length === 4
      && parts[0] === '00'
      && parts[1].length === 32
      && parts[2].length === 16
      && parts[3].length === 2
    ) {
      traceId = parts[1];
      parentSpanId = parts[2];
      traceFlags = parts[3];
    }
  }

  if (!traceId) {
    traceId = randomBytes(16).toString('hex');
  }

  const spanId = randomBytes(8).toString('hex');
  const traceparent = `00-${traceId}-${spanId}-${traceFlags}`;
  const clientTraceId = typeof incomingClientTraceId === 'string' && incomingClientTraceId.trim()
    ? incomingClientTraceId.trim()
    : null;

  req.traceContext = {
    traceId,
    spanId,
    parentSpanId,
    traceparent,
    traceFlags,
    clientTraceId,
  };
  res.setHeader('traceparent', traceparent);
  if (clientTraceId) {
    res.setHeader('x-trace-id', clientTraceId);
  }
  next();
}

module.exports = tracing;
