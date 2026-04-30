'use strict';

// Load and validate environment variables first — before any import that reads process.env
const env = require('./src/config/env');

const { startTelemetry, shutdownTelemetry } = require('./src/observability/otel');
const logger = require('./src/utils/logger');

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
  app.use(pinoHttp({
    logger,
    // Use the W3C traceId as the pino-http request ID so every req.log.* call carries it
    genReqId: req => req.traceContext?.traceId,
    customProps: req => {
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
  app.use(express.json());
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
