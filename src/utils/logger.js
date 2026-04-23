'use strict';

const pino = require('pino');
const env = require('../config/env');

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

let transport;
if (isSimple) {
  // Inline pretty-printer (main thread) — supports messageFormat as a function
  const pretty = require('pino-pretty');
  transport = pretty({
    colorize: true,
    translateTime: 'SYS:HH:MM:ss',
    ignore: [COMMON_FIELDS, SPAN_FIELDS, HTTP_FIELDS].join(','),
    messageFormat: simpleFormat,
  });
} else if (env.NODE_ENV !== 'production') {
  // Developer requested OTEL/JSON format explicitly — pretty-print the raw JSON
  transport = pino.transport({
    target: 'pino-pretty',
    options: { colorize: true, translateTime: 'SYS:HH:MM:ss', ignore: 'pid,hostname' },
  });
}
// production: no transport → raw JSON to stdout

const logger = pino(
  {
    level: env.NODE_ENV === 'production' ? 'info' : 'debug',
    base: { service: 'construction-api' },
    timestamp: pino.stdTimeFunctions.isoTime,
  },
  transport,
);

module.exports = logger;
