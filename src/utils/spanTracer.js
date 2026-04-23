'use strict';

const { randomBytes } = require('crypto');
const logger = require('./logger');

/**
 * Creates a child span under the given W3C trace context.
 *
 * The span carries a `traceparent` string built with its own spanId —
 * forward that header on outgoing HTTP calls so downstream services see
 * this span as their parent (W3C Trace Context Level 1, OTel-compatible).
 *
 * Log fields match OTel semantic conventions so a future migration to
 * an OTLP exporter is a drop-in: trace_id, span_id, parent_span_id,
 * span_name, kind, duration_ms.
 *
 * @param {object|null} traceContext  req.traceContext (or the traceContext
 *   param threaded through service layers). Pass null to start a root span.
 * @param {string}      name          Dot-namespaced span name, e.g. 'zoho.api.getProducts'
 * @param {object}      [attributes]  Static key/value metadata for the span
 *
 * @example
 *   const span = createSpan(traceContext, 'msg91.api.sendOtp', { phone: masked });
 *   try {
 *     const res = await axios.post(url, body, { headers: { traceparent: span.traceparent } });
 *     span.end({ success: true });
 *   } catch (err) {
 *     span.end({ success: false, error: err.message });
 *     throw err;
 *   }
 */
function createSpan(traceContext, name, attributes = {}) {
  const ctx = traceContext || {};
  const traceId = ctx.traceId || randomBytes(16).toString('hex');
  const parentSpanId = ctx.spanId || null;
  const spanId = randomBytes(8).toString('hex');
  const startTime = Date.now();

  // W3C traceparent using *this* span's ID as the parent for downstream calls
  const traceparent = `00-${traceId}-${spanId}-01`;

  return {
    traceId,
    spanId,
    parentSpanId,
    name,
    traceparent,

    end(result = {}) {
      const durationMs = Date.now() - startTime;
      const isError = result.error != null || result.success === false;
      logger[isError ? 'warn' : 'info']({
        trace_id: traceId,
        span_id: spanId,
        parent_span_id: parentSpanId,
        span_name: name,
        kind: 'CLIENT',
        duration_ms: durationMs,
        timestamp: new Date(startTime).toISOString(),
        attributes,
        ...result,
      }, `span:${name}`);
      return durationMs;
    },
  };
}

/**
 * Convenience wrapper — creates a span, runs asyncFn, ends the span.
 * Use when you don't need to enrich the result beyond success/failure.
 * The span is passed to asyncFn in case you need span.traceparent for
 * outgoing headers.
 *
 * @param {object|null} traceContext
 * @param {string}      name
 * @param {object}      attributes
 * @param {function}    asyncFn  (span) => Promise<any>
 */
async function withSpan(traceContext, name, attributes, asyncFn) {
  const span = createSpan(traceContext, name, attributes);
  try {
    const result = await asyncFn(span);
    span.end({ success: true });
    return result;
  } catch (error) {
    span.end({ success: false, error: error.message });
    throw error;
  }
}

module.exports = { createSpan, withSpan };
