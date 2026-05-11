'use strict';

const { trace, context, propagation, SpanKind, SpanStatusCode } = require('@opentelemetry/api');
const logger = require('./logger');

const tracer = trace.getTracer('construction-api.services');

/**
 * Creates a child OTEL span under the current active context.
 *
 * The `traceContext` parameter is accepted for backward compatibility but
 * is unused — OTEL's context propagation (set by controllerSpan middleware)
 * automatically provides the correct parent span via context.active().
 *
 * Returns an object with a `.end({ success, error })` method that mirrors
 * the original API so all callers remain unchanged.
 */
function createSpan(traceContext, name, attributes = {}) {
  const bag = propagation.getBaggage(context.active());
  const baggageAttrs = {};
  if (bag) {
    const userId = bag.getEntry('enduser.id')?.value;
    const phone = bag.getEntry('app.user.phone')?.value;
    if (userId) baggageAttrs['enduser.id'] = userId;
    if (phone) baggageAttrs['app.user.phone'] = phone;
  }

  const span = tracer.startSpan(name, {
    kind: SpanKind.CLIENT,
    attributes: { ...baggageAttrs, ...attributes },
  });

  const startTime = Date.now();
  let ended = false;

  return {
    // Keep traceId/spanId/traceparent for callers that forward them as headers
    get traceId() {
      return span.spanContext().traceId;
    },
    get spanId() {
      return span.spanContext().spanId;
    },
    get traceparent() {
      const ctx = span.spanContext();
      return `00-${ctx.traceId}-${ctx.spanId}-01`;
    },

    setAttribute(key, value) {
      span.setAttribute(key, value);
    },

    end(result = {}) {
      if (ended) return 0;
      ended = true;
      const durationMs = Date.now() - startTime;
      const isError = result.error != null || result.success === false;

      if (isError) {
        const err = result.error instanceof Error ? result.error : new Error(result.error || 'span failed');
        span.recordException(err);
        span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
      } else {
        span.setStatus({ code: SpanStatusCode.OK });
      }

      // Preserve existing pino log so log correlation continues to work
      logger[isError ? 'warn' : 'info']({
        trace_id: span.spanContext().traceId,
        span_id: span.spanContext().spanId,
        parent_span_id: traceContext?.spanId || null,
        span_name: name,
        kind: 'CLIENT',
        duration_ms: durationMs,
        timestamp: new Date(startTime).toISOString(),
        attributes,
        ...result,
      }, `span:${name}`);

      span.end();
      return durationMs;
    },
  };
}

/**
 * Convenience wrapper — creates a span, activates it as the current context
 * (so nested withSpan / dbOp calls are correctly parented), runs asyncFn,
 * then ends the span.
 */
async function withSpan(traceContext, name, attributes, asyncFn) {
  return tracer.startActiveSpan(name, { kind: SpanKind.CLIENT, attributes }, async (rawSpan) => {
    // Merge baggage attributes just like createSpan does
    const bag = propagation.getBaggage(context.active());
    if (bag) {
      const userId = bag.getEntry('enduser.id')?.value;
      const phone = bag.getEntry('app.user.phone')?.value;
      if (userId) rawSpan.setAttribute('enduser.id', userId);
      if (phone) rawSpan.setAttribute('app.user.phone', phone);
    }

    const startTime = Date.now();
    let ended = false;

    // Thin facade that mirrors the createSpan public API so all callers are unchanged
    const spanObj = {
      get traceId() { return rawSpan.spanContext().traceId; },
      get spanId() { return rawSpan.spanContext().spanId; },
      get traceparent() {
        const ctx = rawSpan.spanContext();
        return `00-${ctx.traceId}-${ctx.spanId}-01`;
      },
      setAttribute(key, value) { rawSpan.setAttribute(key, value); },
      end(result = {}) {
        if (ended) return 0;
        ended = true;
        const durationMs = Date.now() - startTime;
        const isError = result.error != null || result.success === false;

        if (isError) {
          const err = result.error instanceof Error ? result.error : new Error(result.error || 'span failed');
          rawSpan.recordException(err);
          rawSpan.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
        } else {
          rawSpan.setStatus({ code: SpanStatusCode.OK });
        }

        logger[isError ? 'warn' : 'info']({
          trace_id: rawSpan.spanContext().traceId,
          span_id: rawSpan.spanContext().spanId,
          parent_span_id: traceContext?.spanId || null,
          span_name: name,
          kind: 'CLIENT',
          duration_ms: durationMs,
          timestamp: new Date(startTime).toISOString(),
          attributes,
          ...result,
        }, `span:${name}`);

        rawSpan.end();
        return durationMs;
      },
    };

    try {
      const result = await asyncFn(spanObj);
      spanObj.end({ success: true });
      return result;
    } catch (error) {
      spanObj.end({ success: false, error: error.message });
      throw error;
    }
  });
}

module.exports = { createSpan, withSpan };
