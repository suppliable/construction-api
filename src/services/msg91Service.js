const axios = require('axios');
const { createSpan } = require('../utils/spanTracer');
const logger = require('../utils/logger');
const { withRetry, DEFAULT_TIMEOUT_MS } = require('../utils/httpClient');

const {
  MSG91_BASE_URL: BASE,
  MSG91_OTP_LENGTH,
  MSG91_OTP_EXPIRY_MINUTES,
} = require('../constants');

const AUTHKEY = () => process.env.MSG91_AUTH_KEY;
const MASKED_KEY = () => {
  const k = AUTHKEY();
  return k ? k.slice(0, 4) + '***' + k.slice(-4) : '(not set)';
};

function authHeaders() {
  return { authkey: AUTHKEY() };
}

// Use the pino logger, not console.log — only pino writes are bridged to OTel
// and reach Loki/Grafana. `log` is req.log where available so lines inherit trace IDs.
function logRequest(log, context, method, url, params, headers, body) {
  const safeParams = { ...params };
  if (safeParams.authkey) safeParams.authkey = MASKED_KEY();
  const safeHeaders = { ...headers };
  if (safeHeaders.authkey) safeHeaders.authkey = MASKED_KEY();
  log.info(
    { context, method, url, params: safeParams, headers: safeHeaders, body },
    `msg91 ${context} request`,
  );
}

function logResponse(log, context, httpStatus, data, ok = true) {
  const fields = { context, httpStatus, response: data };
  if (ok) log.info(fields, `msg91 ${context} response`);
  else log.error(fields, `msg91 ${context} failure`);
}

// MSG91 expects phone without '+' (e.g. "919876543210"), not E.164 ("+91...").
function toMsg91Mobile(e164) { return e164.replace(/^\+/, ''); }

// MSG91 returns HTTP 200 even on failure — always check res.data.type.
function assertSuccess(data, context) {
  if (!data || data.type !== 'success') {
    const err = new Error(data?.message || `MSG91 ${context} failed`);
    err.msg91Code = data?.code;
    err.msg91Type = data?.type;
    err.msg91Body = data;
    throw err;
  }
}

async function sendOtp(normalizedPhone, traceContext = null, log = logger) {
  const span = createSpan(traceContext, 'msg91.api.sendOtp', { 'peer.service': 'msg91', endpoint: '/api/v5/otp' });
  const params = {
    template_id: process.env.MSG91_TEMPLATE_ID,
    mobile: toMsg91Mobile(normalizedPhone),
    otp_length: MSG91_OTP_LENGTH,
    otp_expiry: MSG91_OTP_EXPIRY_MINUTES,
  };
  const headers = authHeaders();
  const body = null;

  logRequest(log, 'send', 'POST', BASE, params, headers, body);

  let res;
  try {
    res = await withRetry('msg91.api.sendOtp', () =>
      axios.post(BASE, body, { params, headers, timeout: DEFAULT_TIMEOUT_MS })
    );
  } catch (err) {
    const httpStatus = err.response?.status ?? 'network-error';
    logResponse(log, 'send', httpStatus, err.response?.data ?? err.message, false);
    span.end({ success: false, error: err.response?.data || err.message });
    throw err;
  }

  logResponse(log, 'send', res.status, res.data);

  try {
    assertSuccess(res.data, 'send');
  } catch (err) {
    span.end({ success: false, error: err.msg91Body || err.message });
    throw err;
  }

  span.end({ success: true, type: res.data?.type });
  return res.data;
}

async function verifyOtp(normalizedPhone, otp, traceContext = null, log = logger) {
  const span = createSpan(traceContext, 'msg91.api.verifyOtp', { 'peer.service': 'msg91', endpoint: '/api/v5/otp/verify' });
  const url = `${BASE}/verify`;
  const params = { otp, mobile: toMsg91Mobile(normalizedPhone) };
  const headers = authHeaders();

  logRequest(log, 'verify', 'GET', url, params, headers, null);

  try {
    const res = await withRetry('msg91.api.verifyOtp', () =>
      axios.get(url, { params, headers, timeout: DEFAULT_TIMEOUT_MS })
    );
    logResponse(log, 'verify', res.status, res.data);
    span.end({ success: true, type: res.data?.type });
    return res.data;
  } catch (error) {
    const httpStatus = error.response?.status ?? 'network-error';
    logResponse(log, 'verify', httpStatus, error.response?.data ?? error.message, false);
    span.end({ success: false, error: error.response?.data || error.message });
    throw error;
  }
}

async function resendOtp(normalizedPhone, traceContext = null, log = logger) {
  const span = createSpan(traceContext, 'msg91.api.resendOtp', { 'peer.service': 'msg91', endpoint: '/api/v5/otp/retry' });
  const url = `${BASE}/retry`;
  const params = { retrytype: 'text', mobile: toMsg91Mobile(normalizedPhone) };
  const headers = authHeaders();

  logRequest(log, 'resend', 'GET', url, params, headers, null);

  try {
    const res = await withRetry('msg91.api.resendOtp', () =>
      axios.get(url, { params, headers, timeout: DEFAULT_TIMEOUT_MS })
    );
    logResponse(log, 'resend', res.status, res.data);
    assertSuccess(res.data, 'resend');
    span.end({ success: true });
    return res.data;
  } catch (error) {
    const httpStatus = error.response?.status ?? 'network-error';
    logResponse(log, 'resend', httpStatus, error.response?.data ?? error.message, false);
    span.end({ success: false, error: error.response?.data || error.message });
    throw error;
  }
}

module.exports = { sendOtp, verifyOtp, resendOtp };
