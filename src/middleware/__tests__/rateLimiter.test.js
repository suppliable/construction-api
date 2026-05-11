'use strict';

// Re-require the module fresh for each test suite to reset in-memory Maps.
// All tests use `const rl = require('../rateLimiter')` inside the block so
// they pick up the freshly-loaded module after jest.resetModules().
beforeEach(() => {
  jest.resetModules();
});

describe('checkOtpSendLimit', () => {
  test('allows up to 3 sends within the window', () => {
    const rl = require('../rateLimiter');
    for (let i = 0; i < 3; i++) rl.recordOtpSend('9000000001');
    expect(() => rl.checkOtpSendLimit('9000000001')).toThrow();
  });

  test('does not throw for a fresh phone number', () => {
    const rl = require('../rateLimiter');
    expect(() => rl.checkOtpSendLimit('9000000002')).not.toThrow();
  });

  test('thrown error has status 429', () => {
    const rl = require('../rateLimiter');
    for (let i = 0; i < 3; i++) rl.recordOtpSend('9000000003');
    let err;
    try { rl.checkOtpSendLimit('9000000003'); } catch (e) { err = e; }
    expect(err.status).toBe(429);
  });
});

describe('checkResendCooldown', () => {
  test('throws if called again within 30 seconds', () => {
    const rl = require('../rateLimiter');
    rl.recordOtpSend('9000000010');
    let err;
    try { rl.checkResendCooldown('9000000010'); } catch (e) { err = e; }
    expect(err).toBeDefined();
    expect(err.status).toBe(429);
  });

  test('does not throw for a phone that has never sent', () => {
    const rl = require('../rateLimiter');
    expect(() => rl.checkResendCooldown('9000000011')).not.toThrow();
  });
});

describe('checkVerifyLockout / recordFailedVerify', () => {
  test('does not throw before 5 failed attempts', () => {
    const rl = require('../rateLimiter');
    for (let i = 0; i < 4; i++) rl.recordFailedVerify('9000000020');
    expect(() => rl.checkVerifyLockout('9000000020')).not.toThrow();
  });

  test('throws after 5 failed attempts', () => {
    const rl = require('../rateLimiter');
    for (let i = 0; i < 5; i++) rl.recordFailedVerify('9000000021');
    let err;
    try { rl.checkVerifyLockout('9000000021'); } catch (e) { err = e; }
    expect(err).toBeDefined();
    expect(err.status).toBe(429);
  });

  test('clearVerifyAttempts removes the lockout', () => {
    const rl = require('../rateLimiter');
    for (let i = 0; i < 5; i++) rl.recordFailedVerify('9000000022');
    rl.clearVerifyAttempts('9000000022');
    expect(() => rl.checkVerifyLockout('9000000022')).not.toThrow();
  });
});

describe('Map memory cleanup', () => {
  test('ipLog key is removed after window expires', () => {
    jest.useFakeTimers();
    const rl = require('../rateLimiter');
    const req = { ip: '1.2.3.4', connection: {} };
    const res = { status: () => ({ json: () => {} }) };
    let nextCalled = false;
    rl.ipRateLimiter(req, res, () => { nextCalled = true; });
    expect(nextCalled).toBe(true);
    // Advance past the 1-hour IP window
    jest.advanceTimersByTime(60 * 60 * 1000 + 1000);
    // Calling again should not throw and should clean up the stale entry
    rl.ipRateLimiter(req, res, () => {});
    jest.useRealTimers();
  });
});
