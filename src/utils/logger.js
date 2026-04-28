'use strict';

const { Writable } = require('stream');
const pino = require('pino');
const { trace } = require('@opentelemetry/api');
const { logs, SeverityNumber } = require('@opentelemetry/api-logs');
const env = require('../config/env');

// Maps pino numeric level → OTel SeverityNumber
const pinoLevelToSeverity = {
  10: SeverityNumber.TRACE,
  20: SeverityNumber.DEBUG,
  30: SeverityNumber.INFO,
  40: SeverityNumber.WARN,
  50: SeverityNumber.ERROR,
  60: SeverityNumber.FATAL,
};

const pinoLevelToText = {
  10: 'TRACE', 20: 'DEBUG', 30: 'INFO', 40: 'WARN', 50: 'ERROR', 60: 'FATAL',
};

// Pino destination that emits each log line as an OTel LogRecord → Grafana Loki
const otelDest = new Writable({
  write(chunk, _enc, cb) {
    try {
      const rec = JSON.parse(chunk.toString());
      const { level, time: _time, pid: _pid, hostname: _hostname, msg, trace_id, span_id, ...attrs } = rec;
      const otelLogger = logs.getLogger('pino');
      const logRecord = {
        severityNumber: pinoLevelToSeverity[level] ?? SeverityNumber.INFO,
        severityText: pinoLevelToText[level] ?? 'INFO',
        body: msg,
        attributes: attrs,
      };
      if (trace_id && span_id) {
        logRecord.spanContext = { traceId: trace_id, spanId: span_id, traceFlags: 1 };
      }
      otelLogger.emit(logRecord);
    } catch (_) {}
    cb();
  },
});

// LOG_FORMAT=otel  → structured JSON (OTEL-compatible, matches production)
// LOG_FORMAT=json  → alias for otel
// default (dev)    → simple human-readable single-line output
const isSimple =
  env.NODE_ENV !== 'production' &&
  process.env.LOG_FORMAT !== 'otel' &&
  process.env.LOG_FORMAT !== 'json';

// traceparent: "00-<traceId>-<spanId>-01"
function parseTraceparent(tp) {
  const p = String(tp || '').split('-');
  return p.length >= 3 ? { traceId: p[1], spanId: p[2] } : {};
}

function simpleFormat(log, messageKey) {
  // Span log (from spanTracer.js)
  if (log.span_name) {
    const traceShort = (log.trace_id || '').slice(0, 8);
    const tag = traceShort ? `[${traceShort}] ` : '';
    const endpoint = log.attributes?.endpoint || '';
    const duration = log.duration_ms != null ? `${log.duration_ms}ms` : '';
    const rows = log.rows != null ? `rows:${log.rows}` : '';
    const status = log.error ? `✗ ${log.error}` : '✓';
    return [tag + `SPAN ${log.span_name}`, log.kind, duration, endpoint, rows, status]
      .filter(Boolean)
      .join('  |  ');
  }

  // HTTP request log (from pino-http)
  // traceparent is injected by customProps in server.js — parse it for both IDs
  if (log.req) {
    const { traceId, spanId } = parseTraceparent(log.traceparent);
    const traceShort = (traceId || String(log.reqId || '')).slice(0, 8);
    const tag = traceShort ? `[${traceShort}] ` : '';
    const method = log.req.method || '';
    const url = log.req.url || '';
    const httpStatus = log.res?.statusCode ?? '';
    const duration = log.responseTime != null ? `${log.responseTime}ms` : '';
    // span ID = parent for all child spans spawned during this request
    const spanTag = spanId ? `span:${spanId.slice(0, 8)}` : '';
    return [tag + `${method} ${url}`, spanTag, httpStatus, duration]
      .filter(s => s !== '')
      .join('  |  ');
  }

  const traceShort = (log.trace_id || String(log.reqId || '')).slice(0, 8);
  const tag = traceShort ? `[${traceShort}] ` : '';
  return tag + (log[messageKey] || '');
}

// Fields to suppress when using simple format (shown inline via simpleFormat instead)
const SPAN_FIELDS = 'trace_id,span_id,parent_span_id,span_name,kind,duration_ms,timestamp,attributes,success,error,rows';
const HTTP_FIELDS = 'req,res,responseTime,reqId,clientTraceId,traceparent';
const COMMON_FIELDS = 'pid,hostname,service';

// Build the human-readable dev stream (runs inline so messageFormat can be a function).
// Always pair it with otelDest so logs are bridged to Loki even in dev.
let devStream;
if (env.NODE_ENV !== 'production') {
  const pretty = require('pino-pretty');
  devStream = isSimple
    ? pretty({
        colorize: true,
        translateTime: 'SYS:HH:MM:ss',
        ignore: [COMMON_FIELDS, SPAN_FIELDS, HTTP_FIELDS].join(','),
        messageFormat: simpleFormat,
      })
    : pretty({ colorize: true, translateTime: 'SYS:HH:MM:ss', ignore: 'pid,hostname' });
}

const streams = devStream
  ? pino.multistream([{ stream: devStream }, { stream: otelDest }])
  : pino.multistream([{ stream: process.stdout }, { stream: otelDest }]);

const logger = pino(
  {
    level: env.NODE_ENV === 'production' ? 'info' : 'debug',
    base: { service: 'construction-api' },
    timestamp: pino.stdTimeFunctions.isoTime,
    mixin() {
      const span = trace.getActiveSpan();
      if (span?.isRecording()) {
        const ctx = span.spanContext();
        return { trace_id: ctx.traceId, span_id: ctx.spanId };
      }
      return {};
    },
  },
  streams,
);

module.exports = logger;
