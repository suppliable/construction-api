'use strict';

// Pins the MSG91 request/response contract, in particular the one that matters
// to callers: MSG91's v5 API returns HTTP 200 with type:"error" for a rejected
// send, so a 200 from axios must NOT be read as success. logger is mocked
// because it requires config/env, which exits the process when a full .env is
// absent (same reasoning as configController.test.js).

jest.mock('axios', () => ({ post: jest.fn(), get: jest.fn() }));
jest.mock('../../utils/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));
jest.mock('../../utils/spanTracer', () => ({
  createSpan: () => ({ end: jest.fn() }),
}));
jest.mock('../../utils/httpClient', () => ({
  withRetry: (_name, fn) => fn(),
  DEFAULT_TIMEOUT_MS: 1000,
}));

const axios = require('axios');
const { sendOtp, resendOtp, isNoActiveOtpError } = require('../msg91Service');

const log = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };

beforeEach(() => {
  jest.clearAllMocks();
  process.env.MSG91_AUTH_KEY = 'test-key';
  process.env.MSG91_TEMPLATE_ID = 'a'.repeat(24);
});

describe('sendOtp — can a provider failure look like success?', () => {
  test('resolves only when MSG91 says type:success', async () => {
    axios.post.mockResolvedValue({ status: 200, data: { type: 'success', request_id: 'r1' } });
    await expect(sendOtp('+919876543210', null, log)).resolves.toMatchObject({ type: 'success' });
  });

  test('HTTP 200 with type:error REJECTS — the caller can never see it as success', async () => {
    axios.post.mockResolvedValue({
      status: 200,
      data: { type: 'error', message: 'template not found', code: '204' },
    });
    await expect(sendOtp('+919876543210', null, log)).rejects.toThrow('template not found');
  });

  test('HTTP 200 with no type field REJECTS', async () => {
    axios.post.mockResolvedValue({ status: 200, data: { request_id: 'r1' } });
    await expect(sendOtp('+919876543210', null, log)).rejects.toThrow();
  });

  test('a transport error REJECTS', async () => {
    axios.post.mockRejectedValue(Object.assign(new Error('boom'), {
      response: { status: 503, data: { message: 'upstream down' } },
    }));
    await expect(sendOtp('+919876543210', null, log)).rejects.toThrow();
  });

  test('sends the mobile without a leading +', async () => {
    axios.post.mockResolvedValue({ status: 200, data: { type: 'success' } });
    await sendOtp('+919876543210', null, log);
    expect(axios.post.mock.calls[0][2].params).toMatchObject({ mobile: '919876543210' });
  });

  test('carries the MSG91 body on the thrown error for classification', async () => {
    axios.post.mockResolvedValue({ status: 200, data: { type: 'error', message: 'nope', code: '304' } });
    await expect(sendOtp('+919876543210', null, log)).rejects.toMatchObject({
      msg91Code: '304', msg91Type: 'error',
    });
  });
});

describe('resendOtp', () => {
  test('rejects on type:error so the controller can classify it', async () => {
    axios.get.mockResolvedValue({ status: 200, data: { type: 'error', message: 'No OTP sent to this number' } });
    await expect(resendOtp('+919876543210', null, log)).rejects.toThrow();
  });

  test('strips the + from the retry mobile too', async () => {
    axios.get.mockResolvedValue({ status: 200, data: { type: 'success' } });
    await resendOtp('+919876543210', null, log);
    expect(axios.get.mock.calls[0][1].params).toMatchObject({ mobile: '919876543210', retrytype: 'text' });
  });
});

describe('isNoActiveOtpError', () => {
  test('matches a "no OTP" rejection', () => {
    expect(isNoActiveOtpError({ msg91Body: { message: 'No OTP sent to this number' } })).toBe(true);
  });

  test('matches an expiry rejection', () => {
    expect(isNoActiveOtpError({ msg91Body: { message: 'OTP expired' } })).toBe(true);
  });

  test('reads an axios-shaped error body too', () => {
    expect(isNoActiveOtpError({ response: { data: { message: 'otp not found' } } })).toBe(true);
  });

  test('does NOT classify an unrelated provider failure', () => {
    expect(isNoActiveOtpError({ msg91Body: { message: 'insufficient balance' } })).toBe(false);
  });

  test('does not classify an error with no body', () => {
    expect(isNoActiveOtpError(new Error('socket hang up'))).toBe(false);
  });
});
