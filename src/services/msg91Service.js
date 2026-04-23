const axios = require('axios');
const { createSpan } = require('../utils/spanTracer');

const BASE = 'https://control.msg91.com/api/v5/otp';

const AUTHKEY = () => process.env.MSG91_AUTH_KEY;
const MASKED_KEY = () => {
  const k = AUTHKEY();
  return k ? k.slice(0, 4) + '***' + k.slice(-4) : '(not set)';
};

function authHeaders() {
  return { authkey: AUTHKEY() };
}

function logRequest(context, method, url, params, headers, body) {
  const safeParams = { ...params };
  if (safeParams.authkey) safeParams.authkey = MASKED_KEY();
  const safeHeaders = { ...headers };
  if (safeHeaders.authkey) safeHeaders.authkey = MASKED_KEY();
  console.log(`[MSG91:${context}] >>> ${method} ${url}`);
  console.log(`[MSG91:${context}] params:`, JSON.stringify(safeParams));
  console.log(`[MSG91:${context}] headers:`, JSON.stringify(safeHeaders));
  console.log(`[MSG91:${context}] body:`, JSON.stringify(body));
}

function logResponse(context, httpStatus, data) {
  console.log(`[MSG91:${context}] <<< httpStatus=${httpStatus}`);
  console.log(`[MSG91:${context}] response:`, JSON.stringify(data));
}

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

async function sendOtp(normalizedPhone) {
  const method = 'POST';
  const params = {
    template_id: process.env.MSG91_TEMPLATE_ID,
    mobile: normalizedPhone,
  };
  const headers = authHeaders();
  const body = null;

  logRequest('send', method, BASE, params, headers, body);

  let res;
  try {
    res = await axios.post(BASE, body, { params, headers, timeout: 10000 });
  } catch (err) {
    const httpStatus = err.response?.status ?? 'network-error';
    logResponse('send', httpStatus, err.response?.data ?? err.message);
    throw err;
  }

  logResponse('send', res.status, res.data);
  assertSuccess(res.data, 'send');
  return res.data;
}

async function verifyOtp(normalizedPhone, otp, traceContext = null) {
  const span = createSpan(traceContext, 'msg91.api.verifyOtp', { endpoint: '/api/v5/otp/verify' });
  const url = `${BASE}/verify`;
  const params = { otp, mobile: normalizedPhone };
  const headers = authHeaders();

  logRequest('verify', 'GET', url, params, headers, null);

  try {
    const res = await axios.get(url, { params, headers, timeout: 10000 });
    logResponse('verify', res.status, res.data);
    span.end({ success: true, type: res.data?.type });
    return res.data;
  } catch (error) {
    const httpStatus = error.response?.status ?? 'network-error';
    logResponse('verify', httpStatus, error.response?.data ?? error.message);
    span.end({ success: false, error: error.response?.data || error.message });
    throw error;
  }
}

async function resendOtp(normalizedPhone, traceContext = null) {
  const span = createSpan(traceContext, 'msg91.api.resendOtp', { endpoint: '/api/v5/otp/retry' });
  const url = `${BASE}/retry`;
  const params = { retrytype: 'text', mobile: normalizedPhone };
  const headers = authHeaders();

  logRequest('resend', 'GET', url, params, headers, null);

  try {
    const res = await axios.get(url, { params, headers, timeout: 10000 });
    logResponse('resend', res.status, res.data);
    span.end({ success: true });
    assertSuccess(res.data, 'resend');
    return res.data;
  } catch (error) {
    const httpStatus = error.response?.status ?? 'network-error';
    logResponse('resend', httpStatus, error.response?.data ?? error.message);
    span.end({ success: false, error: error.response?.data || error.message });
    throw error;
  }
}

module.exports = { sendOtp, verifyOtp, resendOtp };
