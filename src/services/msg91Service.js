const axios = require('axios');
const { createSpan } = require('../utils/spanTracer');

const BASE = 'https://control.msg91.com/api/v5/otp';

function authHeaders() {
  return { authkey: process.env.MSG91_AUTH_KEY };
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
  const res = await axios.post(BASE, {}, {
    params: {
      template_id: process.env.MSG91_TEMPLATE_ID,
      mobile: normalizedPhone,
      authkey: process.env.MSG91_AUTH_KEY
    },
    timeout: 10000
  });
  assertSuccess(res.data, 'send');
  return res.data;
}

async function verifyOtp(normalizedPhone, otp, traceContext = null) {
  const span = createSpan(traceContext, 'msg91.api.verifyOtp', { endpoint: '/api/v5/otp/verify' });
  try {
    const res = await axios.get(`${BASE}/verify`, {
      params: { otp, mobile: normalizedPhone },
      headers: authHeaders(),
      timeout: 10000
    });
    span.end({ success: true, type: res.data?.type });
    return res.data;
  } catch (error) {
    span.end({ success: false, error: error.response?.data || error.message });
    throw error;
  }
}

async function resendOtp(normalizedPhone, traceContext = null) {
  const span = createSpan(traceContext, 'msg91.api.resendOtp', { endpoint: '/api/v5/otp/retry' });
  try {
    const res = await axios.get(`${BASE}/retry`, {
      params: { retrytype: 'text', mobile: normalizedPhone },
      headers: authHeaders(),
      timeout: 10000
    });
    span.end({ success: true });
    return res.data;
  } catch (error) {
    span.end({ success: false, error: error.response?.data || error.message });
    throw error;
  }
}

module.exports = { sendOtp, verifyOtp, resendOtp };
