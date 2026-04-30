'use strict';

const logger = require('./logger');

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_ATTEMPTS = 3;
const DEFAULT_BASE_MS = 200;
const RETRYABLE_CODES = new Set([
  'ECONNABORTED', // axios timeout
  'ECONNRESET',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ECONNREFUSED',
]);

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Full jitter — picks a random value in [0, base]. Better than fixed exponential
// when many clients fail simultaneously: it spreads retries across the window
// instead of synchronizing them.
function jitter(baseMs) {
  return Math.floor(Math.random() * baseMs);
}

function parseRetryAfter(header) {
  if (!header) return null;
  // Numeric form: "120" → 120 seconds.
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  // HTTP-date form: "Wed, 21 Oct 2026 07:28:00 GMT".
  const ts = Date.parse(header);
  if (!Number.isNaN(ts)) return Math.max(0, ts - Date.now());
  return null;
}

function isRetryable(err) {
  if (err && RETRYABLE_CODES.has(err.code)) return true;
  const status = err && err.response && err.response.status;
  return status === 429 || (status >= 500 && status < 600);
}

/**
 * Wrap an HTTP call with bounded retries + exponential backoff with jitter.
 *
 * Only retries transient failures (timeouts, ECONNRESET, 5xx, 429). Non-retryable
 * errors (4xx other than 429, application-level errors) throw immediately.
 *
 * Honors `Retry-After` from 429/503 responses; otherwise sleeps `jitter(baseMs * 2^attempt)`.
 *
 * @param {string} label  Identifier for logs (e.g. 'zoho.api.getProducts').
 * @param {() => Promise<any>} fn  Thunk performing the HTTP call.
 * @param {object} [opts]
 * @param {number} [opts.attempts]  Total attempts including the first (default 3).
 * @param {number} [opts.baseMs]    Backoff base in ms (default 200).
 * @param {object} [opts.log]       Pino logger; defaults to module logger. Pass req.log
 *                                  in request-scoped paths so retries inherit trace IDs.
 */
async function withRetry(label, fn, opts = {}) {
  const {
    attempts = DEFAULT_ATTEMPTS,
    baseMs = DEFAULT_BASE_MS,
    log = logger,
  } = opts;

  let lastErr;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const result = await fn();
      if (attempt > 1) {
        log.info({ label, attempt }, 'http.retry.succeeded');
      }
      return result;
    } catch (err) {
      lastErr = err;
      const retryable = isRetryable(err);
      const status = err.response && err.response.status;
      const isLast = attempt === attempts;

      if (!retryable || isLast) {
        log.warn(
          {
            label,
            attempt,
            attempts,
            retryable,
            status,
            code: err.code,
            err: err.message,
          },
          'http.failed'
        );
        throw err;
      }

      const retryAfter = parseRetryAfter(err.response && err.response.headers && err.response.headers['retry-after']);
      const delay = retryAfter !== null ? retryAfter : jitter(baseMs * Math.pow(2, attempt - 1));
      log.info(
        { label, attempt, attempts, status, code: err.code, delayMs: delay },
        'http.retry'
      );
      await sleep(delay);
    }
  }
  throw lastErr;
}

module.exports = {
  withRetry,
  isRetryable,
  parseRetryAfter,
  DEFAULT_TIMEOUT_MS,
};
