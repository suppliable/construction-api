'use strict';

// The rule that makes clock-in impossible to skip: with attendance on, the admin
// API refuses everything until the person has clocked in today.

jest.mock('../../utils/firebaseAdmin', () => ({ firestore: jest.fn(), auth: jest.fn(), database: jest.fn() }));
jest.mock('../../utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../../services/attendanceService', () => ({ mustClockIn: jest.fn() }));

const attendance = require('../../services/attendanceService');
const { requireClockIn } = require('../requireClockIn');

function run(adminUser) {
  const req = { adminUser, traceContext: null, log: { error: jest.fn() } };
  const res = { status: jest.fn(function s() { return this; }), json: jest.fn() };
  const next = jest.fn();
  return requireClockIn(req, res, next).then(() => ({ req, res, next }));
}
const person = { userId: 'ravi@suppliable.in', isLegacy: false };

beforeEach(() => jest.clearAllMocks());

test('blocks with 403 ATTENDANCE_REQUIRED when attendance is on and they have not clocked in', async () => {
  attendance.mustClockIn.mockResolvedValue(true);
  const { res, next } = await run(person);
  expect(res.status).toHaveBeenCalledWith(403);
  expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: false, error: 'ATTENDANCE_REQUIRED' }));
  expect(next).not.toHaveBeenCalled();
});

test('lets them through once clocked in, or when attendance is off for them', async () => {
  attendance.mustClockIn.mockResolvedValue(false);
  const { res, next } = await run(person);
  expect(next).toHaveBeenCalledTimes(1);
  expect(res.status).not.toHaveBeenCalled();
});

test('the shared legacy token has no identity and is not gated here', async () => {
  const { next } = await run({ userId: 'legacy-shared-token', isLegacy: true });
  expect(attendance.mustClockIn).not.toHaveBeenCalled();
  expect(next).toHaveBeenCalledTimes(1);
});

test('fails OPEN when the check itself errors, and says so loudly', async () => {
  attendance.mustClockIn.mockRejectedValue(new Error('firestore unavailable'));
  const { req, res, next } = await run(person);
  expect(next).toHaveBeenCalledTimes(1);
  expect(res.status).not.toHaveBeenCalled();
  expect(req.log.error).toHaveBeenCalledWith(expect.objectContaining({ err: 'firestore unavailable' }), 'attendance.gate_failed_open');
});
