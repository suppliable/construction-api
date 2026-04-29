'use strict';

const os = require('os');
const { diag, DiagConsoleLogger, DiagLogLevel } = require('@opentelemetry/api');
diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.WARN);

const { NodeSDK } = require('@opentelemetry/sdk-node');
const { OTLPTraceExporter } = require('@opentelemetry/exporter-trace-otlp-http');
const { OTLPMetricExporter } = require('@opentelemetry/exporter-metrics-otlp-http');
const { OTLPLogExporter } = require('@opentelemetry/exporter-logs-otlp-http');
const { PeriodicExportingMetricReader } = require('@opentelemetry/sdk-metrics');
const { BatchLogRecordProcessor } = require('@opentelemetry/sdk-logs');
const { getNodeAutoInstrumentations } = require('@opentelemetry/auto-instrumentations-node');
const { resourceFromAttributes } = require('@opentelemetry/resources');
const { SemanticResourceAttributes } = require('@opentelemetry/semantic-conventions');
const { W3CBaggagePropagator } = require('@opentelemetry/core');
const { W3CTraceContextPropagator } = require('@opentelemetry/core');
const { CompositePropagator } = require('@opentelemetry/core');

const baseUrl =
  process.env.OTLP_ENDPOINT ||
  process.env.OTEL_EXPORTER_OTLP_ENDPOINT ||
  'http://localhost:4318';

// Basic auth for Grafana Cloud — omitted when credentials are not configured
const headers = (process.env.GRAFANA_USER && process.env.GRAFANA_API_KEY)
  ? { Authorization: 'Basic ' + Buffer.from(`${process.env.GRAFANA_USER}:${process.env.GRAFANA_API_KEY}`).toString('base64') }
  : {};

const serviceName = process.env.OTEL_SERVICE_NAME || 'construction-api';
const deployEnv = process.env.NODE_ENV || 'development';

const sdk = new NodeSDK({
  textMapPropagator: new CompositePropagator({
    propagators: [new W3CTraceContextPropagator(), new W3CBaggagePropagator()],
  }),
  resource: resourceFromAttributes({
    [SemanticResourceAttributes.SERVICE_NAME]: serviceName,
    [SemanticResourceAttributes.SERVICE_NAMESPACE]: process.env.OTEL_SERVICE_NAMESPACE || 'suppliable',
    [SemanticResourceAttributes.SERVICE_VERSION]: process.env.npm_package_version || '0.0.0',
    [SemanticResourceAttributes.SERVICE_INSTANCE_ID]: `${os.hostname()}-${process.pid}`,
    [SemanticResourceAttributes.DEPLOYMENT_ENVIRONMENT]: deployEnv,
  }),
  traceExporter: new OTLPTraceExporter({ url: `${baseUrl}/v1/traces`, headers }),
  metricReaders: [
    new PeriodicExportingMetricReader({
      exporter: new OTLPMetricExporter({ url: `${baseUrl}/v1/metrics`, headers }),
      exportIntervalMillis: 60_000,
    }),
  ],
  logRecordProcessors: [
    new BatchLogRecordProcessor(
      new OTLPLogExporter({ url: `${baseUrl}/v1/logs`, headers }),
    ),
  ],
  instrumentations: [getNodeAutoInstrumentations({
    '@opentelemetry/instrumentation-fs': { enabled: false },
    '@opentelemetry/instrumentation-runtime-node': { enabled: false },
    '@opentelemetry/instrumentation-net': { enabled: false },
    '@opentelemetry/instrumentation-dns': { enabled: false },
    '@opentelemetry/instrumentation-grpc': { enabled: false },
    // controllerSpan is the trace root — HTTP and Express auto-spans are redundant noise.
    '@opentelemetry/instrumentation-express': { enabled: false },
    '@opentelemetry/instrumentation-http': { enabled: false },
  })],
});

let started = false;

async function startTelemetry() {
  if (started) return;
  started = true;
  await sdk.start();
}

async function shutdownTelemetry() {
  try {
    await sdk.shutdown();
  } catch (_) {
    // Keep shutdown best-effort to avoid blocking process exit.
  }
}

module.exports = { startTelemetry, shutdownTelemetry };
