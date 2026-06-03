'use strict';

const {
  context,
  propagation,
  trace,
  SpanKind,
  SpanStatusCode,
} = require('@opentelemetry/api');

const { runWithRequestCtx } = require('../observability/requestContext');

const tracer = trace.getTracer('construction-api.controllers');

function controllerSpan(req, res, next) {
  // Multiple middleware (pino-http, compression, firestoreTracker, controllerSpan) each add
  // finish/close listeners — raise the limit so Node doesn't warn on normal traffic.
  res.setMaxListeners(20);

  // Use the raw path at span start — route pattern not yet known.
  const rawPath = `${req.baseUrl || ''}${req.path || ''}`;
  const spanName = `${req.method} ${rawPath}`;

  // Extract incoming W3C traceparent so this span is correctly parented
  // even when the OTEL HTTP auto-instrumentation doesn't fire first.
  const parentCtx = propagation.extract(context.active(), req.headers);

  const span = tracer.startSpan(spanName, {
    kind: SpanKind.SERVER,
    attributes: {
      'http.request.method': req.method,
      'http.route': rawPath,
      'url.scheme': req.protocol || 'http',
      'network.protocol.version': req.httpVersion,
      'app.trace_id': req.traceContext?.traceId || '',
      'app.client_trace_id': req.traceContext?.clientTraceId || '',
      'app.parent_span_id': req.traceContext?.parentSpanId || '',
    },
  }, parentCtx);

  // Store on req so pino-http's finish handler can read it outside the OTEL async context.
  req.otelSpan = span;

  let ended = false;
  const doEnd = () => {
    if (ended) return;
    ended = true;

    // By the time the response finishes, Express has set req.route.path to the
    // matched parameterized pattern (e.g. "/:orderId") and updated req.baseUrl
    // to the sub-router's mount prefix (e.g. "/api/v1/orders").
    // Combining them gives a stable, low-cardinality span name suitable for metrics.
    const routePattern = req.route?.path
      ? `${req.baseUrl || ''}${req.route.path}`
      : rawPath;
    span.updateName(`${req.method} ${routePattern}`);
    span.setAttribute('http.route', routePattern);

    span.setAttribute('http.response.status_code', res.statusCode);
    if (req.user?.uid) span.setAttribute('enduser.id', req.user.uid);
    if (req.user?.phone) span.setAttribute('app.user.phone', req.user.phone);
    if (res.statusCode >= 500) {
      span.setStatus({ code: SpanStatusCode.ERROR, message: `HTTP ${res.statusCode}` });
    }

    span.end();
  };
  const onFinish = () => { res.off('close', onClose); doEnd(); };
  const onClose = () => { res.off('finish', onFinish); doEnd(); };

  res.on('finish', onFinish);
  res.on('close', onClose);

  // Activate this span on the OTEL context for the rest of the request.
  // `context.with(ctx, next)` only covers next()'s synchronous execution; if
  // Express schedules downstream middleware via setImmediate/queueMicrotask,
  // the AsyncLocalStorage scope unwinds and child spans become new trace roots.
  // `context.bind(ctx, next)` returns a wrapped next() that re-enters ctx every
  // time it's invoked, including from queued callbacks.
  const ctx = trace.setSpan(parentCtx, span);
  // Stash OTEL ctx on req AND in our request-scoped ALS so child spans can
  // discover it without every caller threading req through their signatures.
  // OTEL's global active context is unreliable across Express's trampoline +
  // some auto-instrumentations; our own ALS is untouched by them.
  req.otelCtx = ctx;
  const boundNext = context.bind(ctx, next);
  return runWithRequestCtx(ctx, () => context.with(ctx, boundNext));
}

module.exports = controllerSpan;
