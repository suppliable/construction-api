'use strict';

// Load and validate environment variables first — before any import that reads process.env
const env = require('./src/config/env');

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const dotenv = require('dotenv');
const compression = require('compression');
const path = require('path');
const pinoHttp = require('pino-http');
const logger = require('./src/utils/logger');

const tracing = require('./src/middleware/tracing');
const versionGate = require('./src/middleware/versionGate');
const maintenanceMode = require('./src/middleware/maintenanceMode');

// v1 versioned router
const v1Router = require('./src/routes/v1');

const app = express();

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
  customProps: req => ({
    clientTraceId: req.traceContext?.clientTraceId || undefined,
    traceparent: req.traceContext?.traceparent || undefined,
  }),
}));
app.use(compression()); // Enable gzip compression for all responses
app.use(cors());
app.use(express.json());

// Health check — unversioned, no middleware chain
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'construction-api', version: 'v1' });
});

// v1 routes — versioned, full middleware stack (versionGate → maintenanceMode → routes)
app.use('/api/v1', versionGate, maintenanceMode, v1Router);

// Global error handler
app.use((err, req, res, next) => {
  const log = req.log || logger;
  const statusCode = err.statusCode || 500;
  if (statusCode >= 500) {
    log.error({ err }, 'Unhandled error');
  } else {
    log.warn({ code: err.code, message: err.message, path: req.path }, 'Client error');
  }
  res.status(statusCode).json({ success: false, code: err.code || 'SERVER_ERROR', message: err.message });
});

app.listen(env.PORT, '0.0.0.0', () => {
  logger.info({ port: env.PORT, env: env.NODE_ENV }, 'Server started');
});
