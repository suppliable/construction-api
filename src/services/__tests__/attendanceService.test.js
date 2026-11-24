'use strict';

// What makes attendance safe to leave running: clock-in is idempotent per IST
// day (the portal logs in again on every new tab), a forgotten clock-out closes
// itself, Slack can fail without blocking anyone, and no coordinates are kept.

jest.mock('../../utils/firebaseAdmin', () => ({
  firestore: jest.fn(), auth: jest.fn(), database: jest.fn(),
}));
jest.mock('../../utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../../repositories/adminUserRepository', () => ({ getUser: jest.fn() }));
jest.mock('../../repositories/attendanceRepository', () => ({
  get: jest.fn(), createIfAbsent: jest.fn(), update: jest.fn(async () => {}),
  listOpen: jest.fn(async () => []), listRange: jest.fn(async () => []),
  docIdFor: (u, d) => `${String(u).toLowerCase()}_${d}`,
}));
jest.mock('../slackService', () => ({
  postAttendanceIn: jest.fn(async () => '111.222'),
  postAttendanceOut: jest.fn(async () => '333.444'),
}));
jest.mock('../auditService', () => ({
  record: jest.fn(async () => {}),
  ACTIONS: { ATTENDANCE_EDITED: 'attendance.edited' },
}));

const userRepo = require('../../repositories/adminUserRepository');
const repo = require('../../repositories/attendanceRepository');
const slack = require('../slackService');
const audit = require('../auditService');
const svc = require('../attendanceService');

const SHOP_READING = { lat: 12.863326, lng: 80.226196, accuracy: 25 };
const HOME_READING = { lat: 12.9500, lng: 80.2300, accuracy: 20 };   // ~9.6 km away
const NOW = new Date('2026-11-24T03:32:00Z');                          // 9:02 AM IST
const enabledUser = (over = {}) => ({
  userId: 'ravi@suppliable.in', name: 'Ravi', isActive: true, attendanceEnabled: true, ...over,
});

beforeEach(() => {
  jest.clearAllMocks();
  userRepo.getUser.mockResolvedValue(enabledUser());
  repo.listOpen.mockResolvedValue([]);
  repo.createIfAbsent.mockImplementation(async rec => ({ created: true, record: { ...rec } }));
});

describe('who may use it', () => {
  test('refuses a user without attendance switched on', async () => {
    userRepo.getUser.mockResolvedValue(enabledUser({ attendanceEnabled: false }));
    await expect(svc.clockIn('ravi@suppliable.in', SHOP_READING, null, NOW))
      .rejects.toMatchObject({ statusCode: 403, code: 'ATTENDANCE_NOT_ENABLED' });
    expect(repo.createIfAbsent).not.toHaveBeenCalled();
  });

  test('refuses an unknown user and the shared-token identity (no record, so no attendance)', async () => {
    userRepo.getUser.mockResolvedValue(null);
    await expect(svc.clockIn('legacy-shared-token', SHOP_READING, null, NOW))
      .rejects.toMatchObject({ code: 'ATTENDANCE_NOT_ENABLED' });
  });

  test('refuses a deactivated user even if the flag is still on', async () => {
    userRepo.getUser.mockResolvedValue(enabledUser({ isActive: false }));
    await expect(svc.clockIn('ravi@suppliable.in', SHOP_READING, null, NOW)).rejects.toMatchObject({ statusCode: 403 });
  });

  test('status reports disabled rather than erroring, so the portal can stay quiet', async () => {
    userRepo.getUser.mockResolvedValue(enabledUser({ attendanceEnabled: false }));
    await expect(svc.status('ravi@suppliable.in', null, NOW)).resolves.toEqual({ enabled: false, record: null });
  });
});

describe('clockIn', () => {
  test('records the IST day, the verdict, and posts to Slack with the ts kept for the reply', async () => {
    const { record, created } = await svc.clockIn('ravi@suppliable.in', SHOP_READING, null, NOW);

    expect(created).toBe(true);
    expect(record).toMatchObject({
      id: 'ravi@suppliable.in_2026-11-24', date: '2026-11-24',
      inVerdict: 'inside', inSource: 'login', outAt: null,
    });
    expect(slack.postAttendanceIn).toHaveBeenCalledTimes(1);
    expect(repo.update).toHaveBeenCalledWith('ravi@suppliable.in_2026-11-24', { slackTs: '111.222' }, null);
  });

  test('is IDEMPOTENT — a second login the same day neither duplicates nor re-posts', async () => {
    const existing = { id: 'ravi@suppliable.in_2026-11-24', date: '2026-11-24', inAt: '2026-11-24T03:32:00.000Z', outAt: null, inVerdict: 'inside' };
    repo.createIfAbsent.mockResolvedValue({ created: false, record: existing });

    const out = await svc.clockIn('ravi@suppliable.in', SHOP_READING, null, new Date('2026-11-24T08:00:00Z'));
    expect(out.created).toBe(false);
    expect(out.record.inAt).toBe('2026-11-24T03:32:00.000Z');   // the FIRST login stands
    expect(slack.postAttendanceIn).not.toHaveBeenCalled();
  });

  test('a clock-in from home is recorded and flagged, never blocked', async () => {
    const { record } = await svc.clockIn('ravi@suppliable.in', HOME_READING, null, NOW);
    expect(record.inVerdict).toBe('outside');
    expect(record.inDistanceM).toBeGreaterThan(9000);
    expect(record.inNote).toMatch(/Outside geofence/);
  });

  test('a denied location permission is recorded as unverified, not an error', async () => {
    const { record } = await svc.clockIn('ravi@suppliable.in', {}, null, NOW);
    expect(record.inVerdict).toBe('unverified');
    expect(record.inReason).toBe('no_location');
  });

  test('stores no coordinates — only distance, accuracy and verdict', async () => {
    await svc.clockIn('ravi@suppliable.in', HOME_READING, null, NOW);
    const stored = JSON.stringify(repo.createIfAbsent.mock.calls[0][0]);
    expect(stored).not.toContain('12.95');
    expect(stored).not.toContain('80.23');
    expect(repo.createIfAbsent.mock.calls[0][0]).not.toHaveProperty('lat');
    expect(repo.createIfAbsent.mock.calls[0][0]).not.toHaveProperty('lng');
  });

  test('a Slack failure never blocks the clock-in', async () => {
    slack.postAttendanceIn.mockRejectedValue(new Error('slack down'));
    await expect(svc.clockIn('ravi@suppliable.in', SHOP_READING, null, NOW)).resolves.toMatchObject({ created: true });
  });

  test('Slack returning no ts (bot not in channel) still leaves a valid record', async () => {
    slack.postAttendanceIn.mockResolvedValue(null);
    await svc.clockIn('ravi@suppliable.in', SHOP_READING, null, NOW);
    expect(repo.update).not.toHaveBeenCalledWith(expect.anything(), { slackTs: expect.anything() }, null);
  });
});

describe('forgotten clock-outs close themselves', () => {
  const yesterday = {
    id: 'ravi@suppliable.in_2026-11-23', userId: 'ravi@suppliable.in', name: 'Ravi',
    date: '2026-11-23', inAt: '2026-11-23T03:30:00.000Z', outAt: null, slackTs: '9.9',
  };

  test('yesterday\'s open record is closed at 20:00 IST and flagged auto', async () => {
    repo.listOpen.mockResolvedValue([yesterday]);
    await svc.clockIn('ravi@suppliable.in', SHOP_READING, null, NOW);

    const [id, patch] = repo.update.mock.calls.find(c => c[1].outSource === 'auto');
    expect(id).toBe('ravi@suppliable.in_2026-11-23');
    expect(patch.outAt).toBe('2026-11-23T14:30:00.000Z');
    expect(patch.outSource).toBe('auto');
    expect(slack.postAttendanceOut).toHaveBeenCalledWith(
      expect.objectContaining({ outSource: 'auto', slackTs: '9.9' }), 660);
  });

  test('today\'s record is left alone before the cut-off', async () => {
    repo.listOpen.mockResolvedValue([{ ...yesterday, id: 'x', date: '2026-11-24', inAt: '2026-11-24T03:30:00.000Z' }]);
    await svc.clockIn('ravi@suppliable.in', SHOP_READING, null, NOW);
    expect(repo.update.mock.calls.some(c => c[1].outSource === 'auto')).toBe(false);
  });
});

describe('clockOut', () => {
  const today = {
    id: 'ravi@suppliable.in_2026-11-24', userId: 'ravi@suppliable.in', name: 'Ravi',
    date: '2026-11-24', inAt: '2026-11-24T03:32:00.000Z', outAt: null, slackTs: '111.222',
  };
  const LATER = new Date('2026-11-24T13:18:00Z');   // 6:48 PM IST

  test('stamps the time and replies in the clock-in thread with the duration', async () => {
    repo.get.mockResolvedValue(today);
    const { record } = await svc.clockOut('ravi@suppliable.in', SHOP_READING, null, LATER);

    expect(record).toMatchObject({ outSource: 'button', duration: '9h 46m' });
    expect(slack.postAttendanceOut).toHaveBeenCalledWith(
      expect.objectContaining({ slackTs: '111.222', outSource: 'button' }), 586);
  });

  test('does not require being at the shop — people leave before they clock out', async () => {
    repo.get.mockResolvedValue(today);
    const { record } = await svc.clockOut('ravi@suppliable.in', HOME_READING, null, LATER);
    expect(record.outAt).toBeTruthy();
    expect(record.outVerdict).toBe('outside');   // recorded, not enforced
  });

  test('works with no location at all', async () => {
    repo.get.mockResolvedValue(today);
    await expect(svc.clockOut('ravi@suppliable.in', {}, null, LATER)).resolves.toBeTruthy();
  });

  test('is idempotent — clocking out twice keeps the first time and posts once', async () => {
    repo.get.mockResolvedValue({ ...today, outAt: '2026-11-24T12:00:00.000Z' });
    const out = await svc.clockOut('ravi@suppliable.in', SHOP_READING, null, LATER);
    expect(out.created).toBe(false);
    expect(out.record.outAt).toBe('2026-11-24T12:00:00.000Z');
    expect(slack.postAttendanceOut).not.toHaveBeenCalled();
  });

  test('says so when there is nothing to clock out of', async () => {
    repo.get.mockResolvedValue(null);
    await expect(svc.clockOut('ravi@suppliable.in', SHOP_READING, null, LATER))
      .rejects.toMatchObject({ statusCode: 409, code: 'NOT_CLOCKED_IN' });
  });
});

describe('report', () => {
  const rows = [
    { id: 'a', userId: 'ravi@s.in', name: 'Ravi', date: '2026-11-23', inAt: '2026-11-23T03:30:00.000Z', outAt: '2026-11-23T13:30:00.000Z', inVerdict: 'inside' },
    { id: 'b', userId: 'ravi@s.in', name: 'Ravi', date: '2026-11-24', inAt: '2026-11-24T03:30:00.000Z', outAt: '2026-11-24T11:30:00.000Z', inVerdict: 'outside' },
    { id: 'c', userId: 'nila@s.in', name: 'Nila', date: '2026-11-24', inAt: '2026-11-24T04:00:00.000Z', outAt: '2026-11-24T12:00:00.000Z', inVerdict: 'inside' },
  ];
  beforeEach(() => repo.listRange.mockResolvedValue(rows));

  test('totals hours per person and counts flagged days', async () => {
    const { totals } = await svc.report({ from: '2026-11-23', to: '2026-11-24' });
    const ravi = totals.find(t => t.userId === 'ravi@s.in');
    expect(ravi).toMatchObject({ days: 2, minutes: 600 + 480, flagged: 1, duration: '18h 00m' });
    expect(totals.find(t => t.userId === 'nila@s.in')).toMatchObject({ days: 1, flagged: 0 });
  });

  test('filters to one person', async () => {
    const { rows: out } = await svc.report({ userId: 'nila@s.in' });
    expect(out).toHaveLength(1);
  });

  test('closes stale records BEFORE reading, so a day is never shown open past the cut-off', async () => {
    await svc.report({});
    expect(repo.listOpen.mock.invocationCallOrder[0]).toBeLessThan(repo.listRange.mock.invocationCallOrder[0]);
  });
});

describe('editPunch', () => {
  const rec = {
    id: 'ravi@suppliable.in_2026-11-24', name: 'Ravi', date: '2026-11-24',
    inAt: '2026-11-24T03:32:00.000Z', outAt: '2026-11-24T13:18:00.000Z',
  };
  const req = { adminUser: { userId: 'boss@suppliable.in', name: 'Boss' } };
  beforeEach(() => repo.get.mockResolvedValue(rec));

  test('corrects a time, marks it edited and writes before/after to the audit log', async () => {
    await svc.editPunch(rec.id, { outAt: '2026-11-24T12:30:00+05:30' }, req);

    const [, patch] = repo.update.mock.calls[0];
    expect(patch).toMatchObject({ outAt: '2026-11-24T07:00:00.000Z', outSource: 'edited', editedBy: 'boss@suppliable.in' });
    expect(audit.record).toHaveBeenCalledWith(
      req, 'attendance.edited',
      expect.objectContaining({ id: rec.id }),
      { before: { inAt: rec.inAt, outAt: rec.outAt }, after: { inAt: rec.inAt, outAt: '2026-11-24T07:00:00.000Z' } });
  });

  test('refuses a clock-out before the clock-in', async () => {
    await expect(svc.editPunch(rec.id, { outAt: '2026-11-24T01:00:00.000Z' }, req)).rejects.toThrow(/before clock-in/);
    expect(repo.update).not.toHaveBeenCalled();
  });

  test('refuses moving the clock-in to another day — it would orphan its own document', async () => {
    await expect(svc.editPunch(rec.id, { inAt: '2026-11-23T03:00:00.000Z' }, req)).rejects.toThrow(/must stay on 2026-11-24/);
  });

  test('refuses nonsense and empty edits', async () => {
    await expect(svc.editPunch(rec.id, { inAt: 'tuesday' }, req)).rejects.toThrow(/valid date-time/);
    await expect(svc.editPunch(rec.id, {}, req)).rejects.toThrow(/Nothing to change/);
  });

  test('404s a record that does not exist', async () => {
    repo.get.mockResolvedValue(null);
    await expect(svc.editPunch('nope', { outAt: '2026-11-24T12:00:00Z' }, req)).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe('the clock-in gate (mustClockIn)', () => {
  const ID = 'gate@suppliable.in';
  beforeEach(() => svc.forget(ID));

  test('true when attendance is on and there is no record today', async () => {
    userRepo.getUser.mockResolvedValue(enabledUser({ userId: ID }));
    repo.get.mockResolvedValue(null);
    expect(await svc.mustClockIn(ID, null, NOW)).toBe(true);
  });

  test('false once a record exists, and then not re-read for the rest of the day', async () => {
    userRepo.getUser.mockResolvedValue(enabledUser({ userId: ID }));
    repo.get.mockResolvedValue({ id: `${ID}_2026-11-24`, inAt: NOW.toISOString() });
    expect(await svc.mustClockIn(ID, null, NOW)).toBe(false);
    repo.get.mockClear(); userRepo.getUser.mockClear();
    expect(await svc.mustClockIn(ID, null, new Date('2026-11-24T10:00:00Z'))).toBe(false);
    expect(repo.get).not.toHaveBeenCalled();
    expect(userRepo.getUser).not.toHaveBeenCalled();
  });

  test('a new IST day needs a new clock-in', async () => {
    userRepo.getUser.mockResolvedValue(enabledUser({ userId: ID }));
    repo.get.mockResolvedValueOnce({ id: 'today' });
    expect(await svc.mustClockIn(ID, null, NOW)).toBe(false);
    repo.get.mockResolvedValue(null);
    expect(await svc.mustClockIn(ID, null, new Date('2026-11-25T04:00:00Z'))).toBe(true);
  });

  test('"not clocked in yet" is never cached: the request after clock-in passes at once', async () => {
    userRepo.getUser.mockResolvedValue(enabledUser({ userId: ID }));
    repo.get.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: 'now-exists' });
    expect(await svc.mustClockIn(ID, null, NOW)).toBe(true);
    expect(await svc.mustClockIn(ID, null, new Date(NOW.getTime() + 5000))).toBe(false);
  });

  test('false for someone without attendance, or a deactivated account, with no record read', async () => {
    userRepo.getUser.mockResolvedValue(enabledUser({ userId: ID, attendanceEnabled: false }));
    expect(await svc.mustClockIn(ID, null, NOW)).toBe(false);
    expect(repo.get).not.toHaveBeenCalled();
    svc.forget(ID);
    userRepo.getUser.mockResolvedValue(enabledUser({ userId: ID, isActive: false }));
    expect(await svc.mustClockIn(ID, null, NOW)).toBe(false);
  });

  test('the enabled flag is cached briefly, and forget() applies a toggle immediately', async () => {
    userRepo.getUser.mockResolvedValue(enabledUser({ userId: ID, attendanceEnabled: false }));
    await svc.mustClockIn(ID, null, NOW);
    userRepo.getUser.mockClear();
    await svc.mustClockIn(ID, null, new Date(NOW.getTime() + 5000));
    expect(userRepo.getUser).not.toHaveBeenCalled();           // within the TTL

    userRepo.getUser.mockResolvedValue(enabledUser({ userId: ID }));
    repo.get.mockResolvedValue(null);
    svc.forget(ID);                                             // admin switched it on
    expect(await svc.mustClockIn(ID, null, new Date(NOW.getTime() + 6000))).toBe(true);
  });
});
