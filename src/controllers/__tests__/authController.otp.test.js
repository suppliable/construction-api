'use strict';

// The non-demo OTP contract: what send-otp does with an ordinary number, and how
// resend-otp classifies a MSG91 rejection. Demo-number behaviour lives in
// authController.demo.test.js. Firestore/Firebase/MSG91 and the rate limiter are
// mocked for the same reasons given there.

jest.mock('../../utils/firebaseAdmin', () => ({
  auth: () => ({ createCustomToken: jest.fn().mockResolvedValue('fb-token') }),
}));
jest.mock('../../services/customerService', () => ({ syncCustomer: jest.fn() }));
jest.mock('../../services/firestoreService', () => ({ getCustomerByPhone: jest.fn() }));
jest.mock('../../services/msg91Service', () => ({
  sendOtp: jest.fn(),
  verifyOtp: jest.fn(),
  resendOtp: jest.fn(),
  isNoActiveOtpError: jest.fn(),
}));
jest.mock('../../middleware/rateLimiter', () => ({
  checkOtpSendLimit: jest.fn(),
  recordOtpSend: jest.fn(),
  checkResendCooldown: jest.fn(),
  hasRecentOtpSend: jest.fn(),
  checkVerifyLockout: jest.fn(),
  recordFailedVerify: jest.fn(),
  clearVerifyAttempts: jest.fn(),
}));

const msg91 = require('../../services/msg91Service');
const { hasRecentOtpSend, recordOtpSend } = require('../../middleware/rateLimiter');
const { sendOtp, resendOtp } = require('../authController');

const REAL = '9876543210';
const REAL_E164 = '+919876543210';

function mockReq(body) {
  return { body, traceContext: null, log: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } };
}
function mockRes() {
  const res = { statusCode: 200, body: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (p) => { res.body = p; return res; };
  return res;
}

beforeEach(() => {
  jest.resetAllMocks();
  delete process.env.DEMO_PHONE;
  delete process.env.DEMO_OTP;
  process.env.JWT_SECRET = 'test-secret';
});

describe('send-otp with a non-demo number', () => {
  test('does reach MSG91, with the number normalised to E.164', async () => {
    msg91.sendOtp.mockResolvedValue({ type: 'success' });
    const res = mockRes();
    await sendOtp(mockReq({ phone: REAL }), res);

    expect(msg91.sendOtp).toHaveBeenCalledTimes(1);
    expect(msg91.sendOtp).toHaveBeenCalledWith(REAL_E164, null, expect.anything());
    expect(res.statusCode).toBe(200);
    expect(recordOtpSend).toHaveBeenCalledWith(REAL_E164);
  });

  test('a provider failure can NOT return 200 — it returns 500', async () => {
    msg91.sendOtp.mockRejectedValue(Object.assign(new Error('template not found'), {
      msg91Type: 'error', msg91Body: { type: 'error', message: 'template not found' },
    }));
    const res = mockRes();
    await sendOtp(mockReq({ phone: REAL }), res);

    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({ success: false, message: 'Unable to send OTP' });
    expect(recordOtpSend).not.toHaveBeenCalled();
  });

  test('a transport failure also returns 500, never 200', async () => {
    msg91.sendOtp.mockRejectedValue(Object.assign(new Error('timeout'), {
      response: { status: 503, data: { message: 'upstream down' } },
    }));
    const res = mockRes();
    await sendOtp(mockReq({ phone: REAL }), res);
    expect(res.statusCode).toBe(500);
  });

  test('a malformed number is rejected before MSG91 is called', async () => {
    const res = mockRes();
    await sendOtp(mockReq({ phone: '123' }), res);
    expect(res.statusCode).toBe(400);
    expect(msg91.sendOtp).not.toHaveBeenCalled();
  });

  test('a rate limit is 429 and never reaches MSG91', async () => {
    const { checkOtpSendLimit } = require('../../middleware/rateLimiter');
    checkOtpSendLimit.mockImplementation(() => {
      const e = new Error('Too many OTP requests. Try again in 60s'); e.status = 429; throw e;
    });
    const res = mockRes();
    await sendOtp(mockReq({ phone: REAL }), res);
    expect(res.statusCode).toBe(429);
    expect(msg91.sendOtp).not.toHaveBeenCalled();
  });
});

describe('resend-otp classification', () => {
  test('MSG91 rejects and we have no record of a send -> 409 NO_ACTIVE_OTP', async () => {
    hasRecentOtpSend.mockReturnValue(false);
    msg91.isNoActiveOtpError.mockReturnValue(false);
    msg91.resendOtp.mockRejectedValue(new Error('rejected'));

    const res = mockRes();
    await resendOtp(mockReq({ phone: REAL }), res);

    expect(res.statusCode).toBe(409);
    expect(res.body).toMatchObject({ success: false, error: 'NO_ACTIVE_OTP' });
    expect(res.body.message).toMatch(/Tap Send OTP/);
  });

  test('MSG91 says the OTP is gone -> 409 even though a send was recorded', async () => {
    hasRecentOtpSend.mockReturnValue(true);
    msg91.isNoActiveOtpError.mockReturnValue(true);
    msg91.resendOtp.mockRejectedValue(
      Object.assign(new Error('x'), { msg91Body: { message: 'OTP expired' } }),
    );

    const res = mockRes();
    await resendOtp(mockReq({ phone: REAL }), res);

    expect(res.statusCode).toBe(409);
    expect(res.body.error).toBe('NO_ACTIVE_OTP');
  });

  test('an unrelated provider failure -> 502 PROVIDER_ERROR, not 500', async () => {
    hasRecentOtpSend.mockReturnValue(true);
    msg91.isNoActiveOtpError.mockReturnValue(false);
    msg91.resendOtp.mockRejectedValue(
      Object.assign(new Error('x'), { msg91Body: { message: 'insufficient balance' } }),
    );

    const res = mockRes();
    await resendOtp(mockReq({ phone: REAL }), res);

    expect(res.statusCode).toBe(502);
    expect(res.body).toMatchObject({ success: false, error: 'PROVIDER_ERROR' });
  });

  test('a cross-instance resend still succeeds: MSG91 accepts it despite no local record', async () => {
    hasRecentOtpSend.mockReturnValue(false);
    msg91.resendOtp.mockResolvedValue({ type: 'success' });

    const res = mockRes();
    await resendOtp(mockReq({ phone: REAL }), res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ success: true, message: 'OTP resent successfully' });
    expect(msg91.resendOtp).toHaveBeenCalledWith(REAL_E164, null, expect.anything());
  });

  test('MSG91 is still consulted even when we have no local send record', async () => {
    hasRecentOtpSend.mockReturnValue(false);
    msg91.resendOtp.mockResolvedValue({ type: 'success' });

    await resendOtp(mockReq({ phone: REAL }), mockRes());
    expect(msg91.resendOtp).toHaveBeenCalledTimes(1);
  });
});
