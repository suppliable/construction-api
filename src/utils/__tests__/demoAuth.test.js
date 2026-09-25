'use strict';

const { isDemoLoginEnabled, isDemoPhone, matchesDemoOtp } = require('../demoAuth');

const ORIGINAL = { DEMO_PHONE: process.env.DEMO_PHONE, DEMO_OTP: process.env.DEMO_OTP };

function setDemoEnv(phone, otp) {
  if (phone === undefined) delete process.env.DEMO_PHONE; else process.env.DEMO_PHONE = phone;
  if (otp === undefined) delete process.env.DEMO_OTP; else process.env.DEMO_OTP = otp;
}

afterEach(() => setDemoEnv(ORIGINAL.DEMO_PHONE, ORIGINAL.DEMO_OTP));

describe('isDemoLoginEnabled', () => {
  test('off when neither var is set', () => {
    setDemoEnv(undefined, undefined);
    expect(isDemoLoginEnabled()).toBe(false);
  });

  test('off when only the phone is set', () => {
    setDemoEnv('9999999999', undefined);
    expect(isDemoLoginEnabled()).toBe(false);
  });

  test('off when only the OTP is set', () => {
    setDemoEnv(undefined, '123456');
    expect(isDemoLoginEnabled()).toBe(false);
  });

  test('on when both are set', () => {
    setDemoEnv('9999999999', '123456');
    expect(isDemoLoginEnabled()).toBe(true);
  });
});

describe('isDemoPhone', () => {
  test('matches the configured number in E.164 form', () => {
    setDemoEnv('9999999999', '123456');
    expect(isDemoPhone('+919999999999')).toBe(true);
  });

  test('accepts the env value in any of the formats normalizePhone handles', () => {
    setDemoEnv('+91 99999 99999', '123456');
    expect(isDemoPhone('+919999999999')).toBe(true);
  });

  test('matches any entry in a comma-separated list', () => {
    setDemoEnv('9999999999, 9888888888', '123456');
    expect(isDemoPhone('+919888888888')).toBe(true);
  });

  test('does not match an ordinary customer number', () => {
    setDemoEnv('9999999999', '123456');
    expect(isDemoPhone('+919876543210')).toBe(false);
  });

  test('matches nothing while the bypass is off', () => {
    setDemoEnv(undefined, undefined);
    expect(isDemoPhone('+919999999999')).toBe(false);
  });

  test('ignores an unparseable entry rather than matching it', () => {
    setDemoEnv('not-a-number', '123456');
    expect(isDemoLoginEnabled()).toBe(false);
    expect(isDemoPhone('not-a-number')).toBe(false);
  });
});

describe('matchesDemoOtp', () => {
  beforeEach(() => setDemoEnv('9999999999', '123456'));

  test('accepts the configured OTP', () => {
    expect(matchesDemoOtp('123456')).toBe(true);
  });

  test('accepts a numeric OTP as sent by a JSON client', () => {
    expect(matchesDemoOtp(123456)).toBe(true);
  });

  test('rejects a wrong OTP of the same length', () => {
    expect(matchesDemoOtp('654321')).toBe(false);
  });

  test('rejects a differing-length OTP without throwing', () => {
    expect(matchesDemoOtp('1234')).toBe(false);
    expect(matchesDemoOtp('12345678')).toBe(false);
  });

  test('rejects everything when no demo OTP is configured', () => {
    setDemoEnv(undefined, undefined);
    expect(matchesDemoOtp('')).toBe(false);
    expect(matchesDemoOtp('123456')).toBe(false);
  });
});
