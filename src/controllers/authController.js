const jwt = require('jsonwebtoken');
const { syncCustomer } = require('../services/customerService');
const { getCustomerByPhone } = require('../services/firestoreService');
const msg91 = require('../services/msg91Service');
const { normalizePhone, isValidIndianMobile } = require('../utils/phone');
const {
  checkOtpSendLimit,
  recordOtpSend,
  checkResendCooldown,
  checkVerifyLockout,
  recordFailedVerify,
  clearVerifyAttempts
} = require('../middleware/rateLimiter');

// ── EXISTING — kept for backward compat (legacy Firebase flow) ─
async function syncAuth(req, res) {
  // Accept both old firebaseUid and new userId field names
  const { firebaseUid, userId: bodyUserId, phone, name, is_business, business_name, gstin, registered_address } = req.body;
  const userId = bodyUserId || firebaseUid;
  if (!userId || !phone) {
    return res.status(400).json({ success: false, message: 'userId and phone are required' });
  }
  try {
    const customer = await syncCustomer(userId, phone, name, is_business, business_name, gstin, registered_address, req.traceContext);
    res.json({ success: true, data: { customer }, customer, user: customer });
  } catch (err) {
    req.log.error({ err: err.message }, 'syncAuth failed');
    res.status(500).json({ success: false, message: err.message });
  }
}

// ── HELPERS ────────────────────────────────────────────────
function signToken(payload, expiresIn = '7d') {
  return jwt.sign(payload, process.env.JWT_SECRET, { expiresIn });
}

function friendlyMsg91Error(err) {
  // Timeout / network
  if (err.code === 'ECONNABORTED' || err.code === 'ETIMEDOUT') return 'OTP service timed out. Please try again.';
  if (err.code === 'ENOTFOUND' || err.code === 'ECONNREFUSED') return 'OTP service unreachable. Please try again.';
  // MSG91 body errors (assertSuccess threw these)
  const code = err.msg91Code;
  const raw = (err.message || '').toLowerCase();
  if (code === 418) return 'OTP template misconfigured. Please contact support.';
  if (code === 401 || raw.includes('authkey') || raw.includes('authentication')) return 'OTP service authentication error. Please contact support.';
  if (raw.includes('mobile') || raw.includes('number')) return 'Phone number not accepted by OTP service.';
  if (raw.includes('balance') || raw.includes('credit')) return 'OTP service quota exhausted. Please contact support.';
  // HTTP-level errors from axios
  const httpStatus = err.response?.status;
  if (httpStatus === 401 || httpStatus === 403) return 'OTP service authentication error. Please contact support.';
  if (httpStatus === 429) return 'OTP service rate limit reached. Please wait and try again.';
  if (httpStatus >= 500) return 'OTP service is temporarily unavailable. Please try again.';
  return 'Unable to send OTP. Please try again.';
}

function logMsg91Failure(context, err, maskedPhone) {
  const httpStatus = err.response?.status ?? 200;
  const body = err.msg91Body ?? err.response?.data ?? err.message;
  // Never log authkey — scrub it from any stringified output
  const safeBody = JSON.stringify(body).replace(new RegExp(process.env.MSG91_AUTH_KEY || '__none__', 'g'), '***');
  console.error(`[AUTH] msg91 failure (${context}): httpStatus=${httpStatus} body=${safeBody} phone=${maskedPhone}`);
}

function generateUserId() {
  return 'usr_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

async function lookupCustomer(normalizedPhone, traceContext) {
  let customer = await getCustomerByPhone(normalizedPhone, traceContext);
  if (!customer) customer = await getCustomerByPhone('+' + normalizedPhone, traceContext);
  return customer || null;
}

// ── POST /api/auth/send-otp ────────────────────────────────
async function sendOtp(req, res) {
  const { phone } = req.body;

  if (!phone || !isValidIndianMobile(phone)) {
    return res.status(400).json({ success: false, message: 'Valid Indian mobile number required' });
  }

  const normalized = normalizePhone(phone);

  try {
    checkOtpSendLimit(normalized);
    checkResendCooldown(normalized);
  } catch (err) {
    return res.status(err.status || 429).json({ success: false, message: err.message });
  }

  req.log.info({ phone: `***${normalized.slice(-4)}` }, 'send otp request');

  try {
    await msg91.sendOtp(normalized, req.traceContext);
    recordOtpSend(normalized);
    req.log.info({ phone: `***${normalized.slice(-4)}` }, 'otp sent');
    return res.json({ success: true, message: 'OTP sent successfully' });
  } catch (err) {
    req.log.error({ err: err.response?.data || err.message }, 'msg91 send failure');
    return res.status(500).json({ success: false, message: 'Unable to send OTP' });
  }
}

// ── POST /api/auth/verify-otp ──────────────────────────────
async function verifyOtp(req, res) {
  const { phone, otp } = req.body;

  if (!phone || !isValidIndianMobile(phone)) {
    return res.status(400).json({ success: false, message: 'Valid Indian mobile number required' });
  }
  if (!otp || !/^\d{4,8}$/.test(String(otp))) {
    return res.status(400).json({ success: false, message: 'OTP must be 4–8 digits' });
  }

  const normalized = normalizePhone(phone);

  try {
    checkVerifyLockout(normalized);
  } catch (err) {
    return res.status(err.status || 429).json({ success: false, message: err.message });
  }

  let msg91Res;
  try {
    msg91Res = await msg91.verifyOtp(normalized, otp, req.traceContext);
  } catch (err) {
    const data = err.response?.data;
    req.log.error({ err: data || err.message }, 'msg91 verify failure');
    // MSG91 returns 4xx for wrong OTP
    if (err.response?.status === 400 || data?.type === 'error') {
      recordFailedVerify(normalized);
      return res.status(400).json({ success: false, message: 'Invalid or expired OTP' });
    }
    return res.status(500).json({ success: false, message: 'OTP verification failed. Please try again.' });
  }

  // MSG91 returns { type: 'success' } on valid OTP
  if (!msg91Res || msg91Res.type !== 'success') {
    recordFailedVerify(normalized);
    return res.status(400).json({ success: false, message: 'Invalid or expired OTP' });
  }

  clearVerifyAttempts(normalized);
  req.log.info({ phone: `***${normalized.slice(-4)}` }, 'otp verify success');

  const customer = await lookupCustomer(normalized, req.traceContext);

  if (customer) {
    req.log.info({ userId: customer.userId }, 'existing customer login');
    const token = signToken({ userId: customer.userId, phone: normalized });
    return res.json({ success: true, isNewUser: false, token, customer });
  }

  req.log.info({ phone: `***${normalized.slice(-4)}` }, 'new customer signup required');
  const tempUserId = generateUserId();
  const token = signToken({ userId: tempUserId, phone: normalized, type: 'signup' }, '1h');
  return res.json({ success: true, isNewUser: true, signupToken: token, phone: normalized, tempUserId });
}

// ── POST /api/auth/resend-otp ──────────────────────────────
async function resendOtp(req, res) {
  const { phone } = req.body;

  if (!phone || !isValidIndianMobile(phone)) {
    return res.status(400).json({ success: false, message: 'Valid Indian mobile number required' });
  }

  const normalized = normalizePhone(phone);

  req.log.info({ phone: `***${normalized.slice(-4)}` }, 'resend otp request');

  try {
    await msg91.resendOtp(normalized, req.traceContext);
    recordOtpSend(normalized);
    return res.json({ success: true, message: 'OTP resent successfully' });
  } catch (err) {
    req.log.error({ err: err.response?.data || err.message }, 'msg91 resend failure');
    return res.status(500).json({ success: false, message: 'Unable to resend OTP' });
  }
}

// ── POST /api/auth/complete-signup ────────────────────────
async function completeSignup(req, res) {
  const { token, name, is_business, business_name, gstin, registered_address } = req.body;

  if (!token) {
    return res.status(400).json({ success: false, message: 'signupToken is required' });
  }
  if (!name || !name.trim()) {
    return res.status(400).json({ success: false, message: 'name is required' });
  }

  let payload;
  try {
    payload = jwt.verify(token, process.env.JWT_SECRET);
  } catch {
    return res.status(401).json({ success: false, message: 'Invalid or expired signup token' });
  }

  if (payload.type !== 'signup') {
    return res.status(401).json({ success: false, message: 'Invalid token type' });
  }

  const { userId, phone } = payload;

  try {
    const customer = await syncCustomer(userId, phone, name.trim(), is_business, business_name, gstin, registered_address, req.traceContext);
    req.log.info({ userId }, 'new customer signup complete');
    const authToken = signToken({ userId, phone });
    return res.json({ success: true, token: authToken, customer });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
}

module.exports = { syncAuth, sendOtp, verifyOtp, resendOtp, completeSignup };
