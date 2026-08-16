'use strict';

const { computeWarehouseStatus, resolveClosedUntil, resolveForceOpenUntil } = require('../warehouseStatus');
const { parseSchedule, FALLBACK_SCHEDULE } = require('../storeSchedule');

// Mon 10:00 IST — inside business hours, so the schedule alone would be open.
// This isolates the manual-close behaviour.
const DURING_HOURS = new Date('2026-06-29T04:30:00Z');
// Mon 07:00 IST — before the 08:45 open.
const BEFORE_OPEN = new Date('2026-06-29T01:30:00Z');
// Mon 21:00 IST — after the 19:30 close.
const AFTER_CLOSE = new Date('2026-06-29T15:30:00Z');
// Sun 10:00 IST — a closed day under the default schedule.
const SUNDAY = new Date('2026-06-28T04:30:00Z');

// Pass the schedule explicitly so these never touch Remote Config.
const SCHEDULE = FALLBACK_SCHEDULE;

describe('computeWarehouseStatus — manual close', () => {
  test('open during hours with no manual close', async () => {
    await expect(computeWarehouseStatus({}, DURING_HOURS, SCHEDULE))
      .resolves.toEqual({ isOpen: true, closedMessage: '' });
  });

  test('indefinite manual close stays closed', async () => {
    const res = await computeWarehouseStatus({ warehouseOpen: false }, DURING_HOURS, SCHEDULE);
    expect(res.isOpen).toBe(false);
    expect(res.closedUntil).toBeUndefined();
  });

  test('timed close in the future stays closed and reports closedUntil', async () => {
    const until = '2026-06-29T05:30:00Z'; // 1h later
    const res = await computeWarehouseStatus(
      { warehouseOpen: false, warehouseClosedUntil: until }, DURING_HOURS, SCHEDULE);
    expect(res.isOpen).toBe(false);
    expect(res.closedUntil).toBe(until);
    expect(res.closedMessage).toMatch(/maintenance/i);
  });

  test('timed close in the past has expired — schedule resumes, store reopens', async () => {
    const until = '2026-06-29T03:00:00Z'; // already passed
    const res = await computeWarehouseStatus(
      { warehouseOpen: false, warehouseClosedUntil: until }, DURING_HOURS, SCHEDULE);
    expect(res.isOpen).toBe(true);
  });

  test('malformed closedUntil fails safe (stays closed)', async () => {
    const res = await computeWarehouseStatus(
      { warehouseOpen: false, warehouseClosedUntil: 'not-a-date' }, DURING_HOURS, SCHEDULE);
    expect(res.isOpen).toBe(false);
  });

  test('custom closedMessage overrides the default maintenance text', async () => {
    const res = await computeWarehouseStatus(
      { warehouseOpen: false, warehouseClosedUntil: '2026-06-29T05:30:00Z', warehouseClosedMessage: 'Back after lunch' },
      DURING_HOURS,
      SCHEDULE
    );
    expect(res.closedMessage).toBe('Back after lunch');
  });

  test('manual close wins over an open schedule', async () => {
    const res = await computeWarehouseStatus({ warehouseOpen: false }, DURING_HOURS, SCHEDULE);
    expect(res.isOpen).toBe(false);
  });
});

describe('computeWarehouseStatus — force-open', () => {
  test('indefinite force-open opens the store on a closed day', async () => {
    const res = await computeWarehouseStatus({ warehouseForceOpen: true }, SUNDAY, SCHEDULE);
    expect(res.isOpen).toBe(true);
    expect(res.forcedOpen).toBe(true);
  });

  test('force-open does not add forcedOpen when the schedule was already open', async () => {
    const res = await computeWarehouseStatus({ warehouseForceOpen: true }, DURING_HOURS, SCHEDULE);
    expect(res.isOpen).toBe(true);
    expect(res.forcedOpen).toBeUndefined();
  });

  test('timed force-open in the future opens the store', async () => {
    const until = '2026-06-28T05:30:00Z'; // 1h after SUNDAY
    const res = await computeWarehouseStatus(
      { warehouseForceOpen: true, warehouseForceOpenUntil: until }, SUNDAY, SCHEDULE);
    expect(res.isOpen).toBe(true);
  });

  test('timed force-open in the past has expired — schedule resumes, store stays closed', async () => {
    const until = '2026-06-28T03:00:00Z'; // already passed
    const res = await computeWarehouseStatus(
      { warehouseForceOpen: true, warehouseForceOpenUntil: until }, SUNDAY, SCHEDULE);
    expect(res.isOpen).toBe(false);
  });

  test('malformed warehouseForceOpenUntil fails safe (NOT forced open)', async () => {
    const res = await computeWarehouseStatus(
      { warehouseForceOpen: true, warehouseForceOpenUntil: 'not-a-date' }, SUNDAY, SCHEDULE);
    expect(res.isOpen).toBe(false);
  });

  test('a manual close always wins over a force-open', async () => {
    const res = await computeWarehouseStatus(
      { warehouseOpen: false, warehouseForceOpen: true }, SUNDAY, SCHEDULE);
    expect(res.isOpen).toBe(false);
    expect(res.closedReason).toBe('manual');
  });

  test('closedReason is "schedule" when closed with no overrides active', async () => {
    const res = await computeWarehouseStatus({}, SUNDAY, SCHEDULE);
    expect(res.closedReason).toBe('schedule');
  });
});

describe('computeWarehouseStatus — schedule boundaries', () => {
  test('closed before opening time', async () => {
    const res = await computeWarehouseStatus({}, BEFORE_OPEN, SCHEDULE);
    expect(res.isOpen).toBe(false);
    expect(res.closedMessage).toMatch(/we open at/i);
  });

  test('closed after closing time', async () => {
    const res = await computeWarehouseStatus({}, AFTER_CLOSE, SCHEDULE);
    expect(res.isOpen).toBe(false);
    expect(res.closedMessage).toMatch(/closed for the day/i);
  });

  test('closed all day Sunday', async () => {
    const res = await computeWarehouseStatus({}, SUNDAY, SCHEDULE);
    expect(res.isOpen).toBe(false);
    expect(res.closedMessage).toMatch(/closed today/i);
  });
});

describe('computeWarehouseStatus — RC-driven schedule', () => {
  test('custom per-day hours are honoured', async () => {
    // Monday opens late at 11:00 IST — 10:00 should now read closed.
    const schedule = parseSchedule(JSON.stringify({
      days: { mon: ['11:00', '19:30'] },
    }));
    const res = await computeWarehouseStatus({}, DURING_HOURS, schedule);
    expect(res.isOpen).toBe(false);
    expect(res.closedMessage).toMatch(/11:00 AM/);
  });

  test('a day set to null is closed all day', async () => {
    const schedule = parseSchedule(JSON.stringify({ days: { mon: null } }));
    const res = await computeWarehouseStatus({}, DURING_HOURS, schedule);
    expect(res.isOpen).toBe(false);
  });

  test('a holiday closes an otherwise-open day', async () => {
    const schedule = parseSchedule(JSON.stringify({
      days: { mon: ['08:45', '19:30'] },
      holidays: ['2026-06-29'],
    }));
    const res = await computeWarehouseStatus({}, DURING_HOURS, schedule);
    expect(res.isOpen).toBe(false);
    expect(res.closedMessage).toMatch(/holiday/i);
  });

  test('a non-matching holiday leaves the day open', async () => {
    const schedule = parseSchedule(JSON.stringify({
      days: { mon: ['08:45', '19:30'] },
      holidays: ['2026-08-15'],
    }));
    const res = await computeWarehouseStatus({}, DURING_HOURS, schedule);
    expect(res.isOpen).toBe(true);
  });

  test('extended hours open the store outside default business hours', async () => {
    const schedule = parseSchedule(JSON.stringify({
      days: { mon: ['06:00', '23:00'] },
    }));
    const res = await computeWarehouseStatus({}, BEFORE_OPEN, SCHEDULE);
    expect(res.isOpen).toBe(false); // default schedule: still closed at 07:00
    const extended = await computeWarehouseStatus({}, BEFORE_OPEN, schedule);
    expect(extended.isOpen).toBe(true); // extended schedule: open at 07:00
  });
});

describe('parseSchedule — fail-safe on bad input', () => {
  // A broken schedule must never widen the store's hours, so anything
  // untrustworthy falls back to the known-good business hours.
  const badInputs = {
    'malformed JSON': '{not json',
    'empty string': '',
    'missing days': JSON.stringify({ holidays: [] }),
    'non-object': JSON.stringify('nope'),
    'bad time string': JSON.stringify({ days: { mon: ['8.45', '19:30'] } }),
    'close before open': JSON.stringify({ days: { mon: ['19:30', '08:45'] } }),
    'close equal to open': JSON.stringify({ days: { mon: ['08:45', '08:45'] } }),
    'wrong tuple length': JSON.stringify({ days: { mon: ['08:45'] } }),
    'out-of-range hour': JSON.stringify({ days: { mon: ['25:00', '26:00'] } }),
  };

  for (const [label, raw] of Object.entries(badInputs)) {
    test(`${label} → fallback schedule`, () => {
      const parsed = parseSchedule(raw);
      expect(parsed.usedFallback).toBe(true);
      expect(parsed.days).toEqual(FALLBACK_SCHEDULE.days);
    });
  }

  test('a valid schedule is not flagged as fallback', () => {
    const parsed = parseSchedule(JSON.stringify({
      days: { mon: ['08:45', '19:30'], sun: null },
      holidays: ['2026-08-15'],
    }));
    expect(parsed.usedFallback).toBe(false);
    expect(parsed.days.mon).toEqual([525, 1170]);
    expect(parsed.holidays).toEqual(['2026-08-15']);
  });

  test('malformed holiday entries are dropped, not fatal', () => {
    const parsed = parseSchedule(JSON.stringify({
      days: { mon: ['08:45', '19:30'] },
      holidays: ['2026-08-15', 'garbage', 42, null],
    }));
    expect(parsed.usedFallback).toBe(false);
    expect(parsed.holidays).toEqual(['2026-08-15']);
  });
});

describe('resolveClosedUntil', () => {
  const now = new Date('2026-06-29T04:30:00Z');

  test('closedForMinutes computes a future expiry', () => {
    const { until, error } = resolveClosedUntil({ closedForMinutes: 120 }, now);
    expect(error).toBeUndefined();
    expect(Date.parse(until)).toBe(now.getTime() + 120 * 60_000);
  });

  test('rejects non-positive or non-numeric closedForMinutes', () => {
    expect(resolveClosedUntil({ closedForMinutes: -5 }, now).error).toBeTruthy();
    expect(resolveClosedUntil({ closedForMinutes: 'abc' }, now).error).toBeTruthy();
  });

  test('accepts a valid future closedUntil', () => {
    const { until } = resolveClosedUntil({ closedUntil: '2026-06-29T06:00:00Z' }, now);
    expect(until).toBe('2026-06-29T06:00:00.000Z');
  });

  test('rejects past or malformed closedUntil', () => {
    expect(resolveClosedUntil({ closedUntil: '2026-06-29T04:00:00Z' }, now).error).toBeTruthy();
    expect(resolveClosedUntil({ closedUntil: 'garbage' }, now).error).toBeTruthy();
  });

  test('returns empty when no expiry provided (indefinite close)', () => {
    expect(resolveClosedUntil({}, now)).toEqual({});
  });
});

describe('resolveForceOpenUntil', () => {
  const now = new Date('2026-06-29T04:30:00Z');

  test('forceOpenForMinutes computes a future expiry', () => {
    const { until, error } = resolveForceOpenUntil({ forceOpenForMinutes: 90 }, now);
    expect(error).toBeUndefined();
    expect(Date.parse(until)).toBe(now.getTime() + 90 * 60_000);
  });

  test('rejects non-positive or non-numeric forceOpenForMinutes', () => {
    expect(resolveForceOpenUntil({ forceOpenForMinutes: -5 }, now).error).toBeTruthy();
    expect(resolveForceOpenUntil({ forceOpenForMinutes: 'abc' }, now).error).toBeTruthy();
  });

  test('accepts a valid future forceOpenUntil', () => {
    const { until } = resolveForceOpenUntil({ forceOpenUntil: '2026-06-29T06:00:00Z' }, now);
    expect(until).toBe('2026-06-29T06:00:00.000Z');
  });

  test('rejects past or malformed forceOpenUntil', () => {
    expect(resolveForceOpenUntil({ forceOpenUntil: '2026-06-29T04:00:00Z' }, now).error).toBeTruthy();
    expect(resolveForceOpenUntil({ forceOpenUntil: 'garbage' }, now).error).toBeTruthy();
  });

  test('returns empty when no expiry provided (indefinite force-open)', () => {
    expect(resolveForceOpenUntil({}, now)).toEqual({});
  });
});
