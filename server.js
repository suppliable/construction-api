'use strict';

// Load and validate environment variables first — before any import that reads process.env
const env = require('./src/config/env');

const { startTelemetry, shutdownTelemetry } = require('./src/observability/otel');
const logger = require('./src/utils/logger');

// Allowlist of headers worth logging in DEBUG_PAYLOADS mode. Everything
// else (helmet boilerplate, accept-encoding, host, user-agent, etc.) is
// dropped to keep log lines scannable. Tokens are redacted, not logged.
const REQUEST_HEADER_ALLOW = new Set([
  'traceparent',
  'x-trace-id',
  'authorization',
  'content-type',
  'x-idempotency-key',
  'x-user-id',
  'x-app-version',
]);

const RESPONSE_HEADER_ALLOW = new Set([
  'traceparent',
  'x-trace-id',
  'content-type',
  'access-control-allow-origin',
  'x-firestore-reads',
  'x-firestore-writes',
]);

const REDACTED_HEADERS = new Set([
  'authorization',
  'cookie',
  'set-cookie',
  'x-firebase-appcheck',
  'x-recaptcha-token',
  'x-api-key',
]);

function pickHeaders(headers, allowlist) {
  if (!headers) return undefined;
  const out = {};
  for (const [k, v] of Object.entries(headers)) {
    const key = k.toLowerCase();
    if (!allowlist.has(key)) continue;
    out[k] = REDACTED_HEADERS.has(key) ? '***REDACTED***' : v;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

// Loki rejects streams with structured metadata > 64KB. Cap each payload field
// well below that so headers + multiple fields still fit in one log line.
const PAYLOAD_MAX_BYTES = 16 * 1024;

function truncatePayload(value) {
  if (value === undefined || value === null) return value;
  const str = typeof value === 'string' ? value : JSON.stringify(value);
  if (str === undefined) return value;
  const size = Buffer.byteLength(str, 'utf8');
  if (size <= PAYLOAD_MAX_BYTES) return value;
  return `${str.slice(0, PAYLOAD_MAX_BYTES)}…[truncated ${size - PAYLOAD_MAX_BYTES}B of ${size}B]`;
}

function createApp() {
  // Require instrumented modules only after telemetry has started.
  const express = require('express');
  const cors = require('cors');
  const helmet = require('helmet');
  const compression = require('compression');
  const path = require('path');
  const pinoHttp = require('pino-http');

  const tracing = require('./src/middleware/tracing');
  const controllerSpan = require('./src/middleware/controllerSpan');
  const versionGate = require('./src/middleware/versionGate');
  const maintenanceMode = require('./src/middleware/maintenanceMode');
  const { requestMiddleware: firestoreTracking } = require('./src/middleware/firestoreTracker');
  const v1Router = require('./src/routes/v1');

  const app = express();

  // Trust proxy headers (like X-Forwarded-For) since we're behind a proxy in production
  app.set('trust proxy', true);

  // Static files
  app.use(express.static('public'));
  app.use('/admin', express.static(path.join(__dirname, 'admin-portal')));

  // Middleware
  app.use(helmet({ contentSecurityPolicy: false }));
  // Core middleware — order matters
  app.use(tracing); // W3C traceparent — must run before pino-http so genReqId can read traceId
  const debugPayloads = process.env.DEBUG_PAYLOADS === 'true';

  app.use(pinoHttp({
    logger,
    // Use the W3C traceId as the pino-http request ID so every req.log.* call carries it
    genReqId: req => req.traceContext?.traceId,
    customProps: (req, res) => {
      const props = {
        clientTraceId: req.traceContext?.clientTraceId || undefined,
        traceparent: req.traceContext?.traceparent || undefined,
      };
      // req.otelSpan is set synchronously by controllerSpan before next() is called,
      // so it's always available here even though the OTEL async context isn't.
      const spanCtx = req.otelSpan?.spanContext();
      if (spanCtx) {
        props.trace_id = spanCtx.traceId;
        props.span_id = spanCtx.spanId;
      }
      if (debugPayloads) {
        if (req.body && Object.keys(req.body).length > 0) props.reqBody = truncatePayload(req.body);
        if (res._debugPayload !== undefined) props.resBody = truncatePayload(res._debugPayload);
        props.reqHeaders = pickHeaders(req.headers, REQUEST_HEADER_ALLOW);
        props.resHeaders = pickHeaders(res.getHeaders(), RESPONSE_HEADER_ALLOW);
      }
      return props;
    },
    // Bake method + route + status into the message so Grafana Loki's line view is useful
    customSuccessMessage: (req, res, responseTime) =>
      `${req.method} ${req.url} ${res.statusCode} ${responseTime}ms`,
    customErrorMessage: (req, res, err) =>
      `${req.method} ${req.url} ${res.statusCode} ${err.message}`,
  }));
  app.use(compression()); // Enable gzip compression for all responses
  app.use(cors());
  app.use(express.json({
    // Preserve raw body for routes that need signature verification (Cashfree webhook).
    // No effect on other routes — they read req.body as before.
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  }));
  // When DEBUG_PAYLOADS=true, intercept res.json() to capture the response body for logging
  if (debugPayloads) {
    app.use((req, res, next) => {
      const orig = res.json.bind(res);
      res.json = (body) => { res._debugPayload = body; return orig(body); };
      next();
    });
  }
  app.use(firestoreTracking);

  // Health check — unversioned, no middleware chain
  app.get('/', (req, res) => {
    res.json({ status: 'ok', service: 'construction-api', version: 'v1' });
  });

  // v1 routes — versioned, full middleware stack (versionGate → maintenanceMode → routes)
  app.use('/api/v1', versionGate, maintenanceMode, controllerSpan, v1Router);

  // Global error handler
  app.use((err, req, res, next) => {
    const log = req.log || logger;
    const statusCode = err.statusCode || 500;
    if (statusCode >= 500) {
      log.error({ err }, 'Unhandled error');
    } else {
      log.warn({ code: err.code, message: err.message, path: req.path }, 'Client error');
    }
    const body = { success: false, error: err.code || 'SERVER_ERROR', message: err.message };
    if (err.issues) body.issues = err.issues;
    if (err.canAddToCart) body.canAddToCart = true;
    res.status(statusCode).json(body);
  });

  return app;
}

async function startServer() {
  await startTelemetry();
  const app = createApp();
  const server = app.listen(env.PORT, '0.0.0.0', () => {
    logger.info({ port: env.PORT, env: env.NODE_ENV }, 'Server started');
    // Keep connections alive for 65 s — longer than typical mobile client idle gaps.
    // Node default is 5 s, which causes "Connection closed before full header" on
    // persistent HTTP clients (Flutter, curl --keepalive) when the client reuses a
    // connection the server has already decided to close.
    server.keepAliveTimeout = 65_000;
    // headersTimeout must be > keepAliveTimeout to avoid a race during the handshake.
    server.headersTimeout = 66_000;
    // Google Maps cost reminder — Directions API calls from driver location updates
    // 9 calls/order (every 5 min, ~45 min delivery) × 30 orders/day = 270 calls/day
    // 270 × $0.005 = $1.35/day ≈ ₹3,400/month at current usage
    if (process.env.GOOGLE_MAPS_API_KEY) {
      logger.info('Google Maps Directions API active — est. cost: 270 calls/day × $0.005 = ~$1.35/day (~₹3,400/mo) at 30 orders/day');
    } else {
      logger.warn('GOOGLE_MAPS_API_KEY not set — dynamic ETA will be skipped');
    }
  });

  const gracefulShutdown = async signal => {
    logger.info({ signal }, 'Shutting down server');
    setTimeout(() => {
      logger.error({ signal }, 'Graceful shutdown timed out, forcing exit');
      process.exit(1);
    }, 10_000).unref();
    server.close(async () => {
      await shutdownTelemetry();
      process.exit(0);
    });
  };

  process.on('SIGINT', () => {
    void gracefulShutdown('SIGINT');
  });

  process.on('SIGTERM', () => {
    void gracefulShutdown('SIGTERM');
  });

  process.on('unhandledRejection', reason => {
    const err = reason instanceof Error
      ? { message: reason.message, stack: reason.stack }
      : { value: reason };
    logger.fatal({ err }, 'Unhandled promise rejection');
    void gracefulShutdown('unhandledRejection');
  });

  process.on('uncaughtException', err => {
    logger.fatal({ err: { message: err.message, stack: err.stack } }, 'Uncaught exception');
    void gracefulShutdown('uncaughtException');
  });
}

startServer().catch(err => {
  logger.error({ err }, 'Failed to start server');
  process.exit(1);
});
