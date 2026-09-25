'use strict';

// Covers only the demo-login bypass in send-otp / verify-otp / resend-otp.
// authController pulls in Firestore/Firebase/MSG91 at require-time, so those are
// mocked here rather than loaded for real (same reasoning as
// configController.test.js). The rate limiter is mocked too so each case can
// assert exactly which limits the demo path skips and which it still honours.

jest.mock('../../utils/firebaseAdmin', () => ({
  auth: () => ({ createCustomToken: jest.fn().mockResolvedValue('fb-custom-token') }),
}));
jest.mock('../../services/customerService', () => ({ syncCustomer: jest.fn() }));
jest.mock('../../services/firestoreService', () => ({ getCustomerByPhone: jest.fn() }));
jest.mock('../../services/msg91Service', () => ({
  sendOtp: jest.fn(),
  verifyOtp: jest.fn(),
  resendOtp: jest.fn(),
}));
jest.mock('../../middleware/rateLimiter', () => ({
  checkOtpSendLimit: jest.fn(),
  recordOtpSend: jest.fn(),
  checkResendCooldown: jest.fn(),
  checkVerifyLockout: jest.fn(),
  recordFailedVerify: jest.fn(),
  clearVerifyAttempts: jest.fn(),
}));

const jwt = require('jsonwebtoken');
const msg91 = require('../../services/msg91Service');
const { getCustomerByPhone } = require('../../services/firestoreService');
const {
  checkOtpSendLimit, checkResendCooldown, checkVerifyLockout, recordFailedVerify,
} = require('../../middleware/rateLimiter');
const { sendOtp, verifyOtp, resendOtp } = require('../authController');

const DEMO_PHONE = '9999999999';
const DEMO_OTP = '123456';
const REAL_PHONE = '9876543210';

function mockReq(body) {
  return { body, traceContext: null, log: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } };
}
function mockRes() {
  const res = { statusCode: 200, body: null };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (payload) => { res.body = payload; return res; };
  return res;
}

beforeEach(() => {
  // resetAllMocks, not clearAllMocks: the lockout case installs a throwing
  // implementation that would otherwise leak into later cases.
  jest.resetAllMocks();
  process.env.DEMO_PHONE = DEMO_PHONE;
  process.env.DEMO_OTP = DEMO_OTP;
  process.env.JWT_SECRET = 'test-secret';
});
afterEach(() => {
  delete process.env.DEMO_PHONE;
  delete process.env.DEMO_OTP;
});

describe('send-otp', () => {
  test('demo phone: reports success without calling MSG91 or the send limits', async () => {
    const res = mockRes();
    await sendOtp(mockReq({ phone: DEMO_PHONE }), res);

    expect(msg91.sendOtp).not.toHaveBeenCalled();
    expect(checkOtpSendLimit).not.toHaveBeenCalled();
    expect(checkResendCooldown).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ success: true, message: 'OTP sent successfully' });
  });

  test('demo phone stays reachable after repeated sends (no cooldown)', async () => {
    for (let i = 0; i < 5; i++) {
      const res = mockRes();
      await sendOtp(mockReq({ phone: DEMO_PHONE }), res);
      expect(res.body.success).toBe(true);
    }
    expect(msg91.sendOtp).not.toHaveBeenCalled();
  });

  test('ordinary phone still goes to MSG91', async () => {
    msg91.sendOtp.mockResolvedValue({ type: 'success' });
    const res = mockRes();
    await sendOtp(mockReq({ phone: REAL_PHONE }), res);

    expect(msg91.sendOtp).toHaveBeenCalledWith('+919876543210', null, expect.anything());
    expect(res.body.success).toBe(true);
  });

  test('with the bypass off, the demo number is just an ordinary number', async () => {
    delete process.env.DEMO_PHONE;
    delete process.env.DEMO_OTP;
    msg91.sendOtp.mockResolvedValue({ type: 'success' });
    const res = mockRes();
    await sendOtp(mockReq({ phone: DEMO_PHONE }), res);

    expect(msg91.sendOtp).toHaveBeenCalledWith('+919999999999', null, expect.anything());
  });
});

describe('resend-otp', () => {
  test('demo phone: reports success without calling MSG91', async () => {
    const res = mockRes();
    await resendOtp(mockReq({ phone: DEMO_PHONE }), res);

    expect(msg91.resendOtp).not.toHaveBeenCalled();
    expect(res.body).toEqual({ success: true, message: 'OTP resent successfully' });
  });
});

describe('verify-otp', () => {
  test('demo phone + fixed OTP: issues a session for the existing customer, no MSG91 call', async () => {
    const customer = { userId: 'usr_demo', phone: '+919999999999', name: 'Demo' };
    getCustomerByPhone.mockResolvedValue(customer);

    const res = mockRes();
    await verifyOtp(mockReq({ phone: DEMO_PHONE, otp: DEMO_OTP }), res);

    expect(msg91.verifyOtp).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.isNewUser).toBe(false);
    expect(jwt.verify(res.body.token, 'test-secret')).toMatchObject({
      userId: 'usr_demo', phone: '+919999999999',
    });
  });

  test('demo phone with no customer record falls through to the signup flow', async () => {
    getCustomerByPhone.mockResolvedValue(null);

    const res = mockRes();
    await verifyOtp(mockReq({ phone: DEMO_PHONE, otp: DEMO_OTP }), res);

    expect(res.body.isNewUser).toBe(true);
    expect(res.body.signupToken).toBeTruthy();
  });

  test('demo phone + wrong OTP: rejected, and the attempt counts toward lockout', async () => {
    const res = mockRes();
    await verifyOtp(mockReq({ phone: DEMO_PHONE, otp: '654321' }), res);

    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ success: false, message: 'Invalid or expired OTP' });
    expect(recordFailedVerify).toHaveBeenCalledWith('+919999999999');
    expect(msg91.verifyOtp).not.toHaveBeenCalled();
  });

  test('demo phone still honours an active lockout', async () => {
    checkVerifyLockout.mockImplementation(() => {
      const err = new Error('Too many attempts'); err.status = 429; throw err;
    });

    const res = mockRes();
    await verifyOtp(mockReq({ phone: DEMO_PHONE, otp: DEMO_OTP }), res);

    expect(res.statusCode).toBe(429);
    expect(getCustomerByPhone).not.toHaveBeenCalled();
  });

  test('the fixed OTP does not open any other number', async () => {
    msg91.verifyOtp.mockResolvedValue({ type: 'error' });

    const res = mockRes();
    await verifyOtp(mockReq({ phone: REAL_PHONE, otp: DEMO_OTP }), res);

    expect(msg91.verifyOtp).toHaveBeenCalled();
    expect(res.statusCode).toBe(400);
  });
});
