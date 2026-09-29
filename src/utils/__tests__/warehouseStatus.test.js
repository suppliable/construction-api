'use strict';

// warehouseStatus pulls in remoteConfigService -> firebaseAdmin -> config/env,
// which calls process.exit(1) without a full .env and took this whole suite down
// before it could run a single case. The schedule is injected explicitly below,
// so the real RC client is never needed.
jest.mock('../../services/remoteConfigService', () => ({
  getString: jest.fn().mockResolvedValue(''),
  getNumber: jest.fn(),
}));

const { computeWarehouseStatus, resolveOverrideExpiry, activeOverride } = require('../warehouseStatus');
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

describe('computeWarehouseStatus — override replaces the schedule while live', () => {
  const until = (d) => d.toISOString();

  test('no override: the schedule decides (open during hours)', async () => {
    const r = await computeWarehouseStatus({}, DURING_HOURS, SCHEDULE);
    expect(r.isOpen).toBe(true);
  });

  test("override 'closed' shuts an open store", async () => {
    const settings = { override: 'closed', overrideUntil: until(new Date('2026-06-29T18:30:00Z')) };
    const r = await computeWarehouseStatus(settings, DURING_HOURS, SCHEDULE);
    expect(r.isOpen).toBe(false);
    expect(r.closedReason).toBe('override');
    expect(r.overrideUntil).toBe(settings.overrideUntil);
  });

  test("override 'open' opens the store on a closed Sunday", async () => {
    const settings = { override: 'open', overrideUntil: until(new Date('2026-06-28T18:30:00Z')) };
    const r = await computeWarehouseStatus(settings, SUNDAY, SCHEDULE);
    expect(r.isOpen).toBe(true);
    expect(r.forcedOpen).toBe(true);
  });

  test("override 'open' adds no forcedOpen flag when the schedule already agrees", async () => {
    const settings = { override: 'open', overrideUntil: until(new Date('2026-06-29T18:30:00Z')) };
    const r = await computeWarehouseStatus(settings, DURING_HOURS, SCHEDULE);
    expect(r.isOpen).toBe(true);
    expect(r.forcedOpen).toBeUndefined();
  });

  test('an EXPIRED override is ignored and the schedule resumes', async () => {
    const settings = { override: 'closed', overrideUntil: until(new Date('2026-06-29T03:00:00Z')) };
    const r = await computeWarehouseStatus(settings, DURING_HOURS, SCHEDULE);
    expect(r.isOpen).toBe(true);
    expect(r.override).toBeUndefined();
  });

  test('an override with NO expiry is ignored — a stuck-closed store is unrepresentable', async () => {
    const r = await computeWarehouseStatus({ override: 'closed' }, DURING_HOURS, SCHEDULE);
    expect(r.isOpen).toBe(true);
  });

  test('an override with a malformed expiry is ignored, not honoured forever', async () => {
    const r = await computeWarehouseStatus(
      { override: 'closed', overrideUntil: 'not-a-date' }, DURING_HOURS, SCHEDULE);
    expect(r.isOpen).toBe(true);
  });

  test('the legacy warehouseOpen:false flag no longer closes the store', async () => {
    const r = await computeWarehouseStatus(
      { warehouseOpen: false, warehouseClosedUntil: null }, DURING_HOURS, SCHEDULE);
    expect(r.isOpen).toBe(true);
  });

  test('a custom closedMessage is used for an override close', async () => {
    const settings = {
      override: 'closed',
      overrideUntil: until(new Date('2026-06-29T18:30:00Z')),
      warehouseClosedMessage: 'Closed for stocktake.',
    };
    const r = await computeWarehouseStatus(settings, DURING_HOURS, SCHEDULE);
    expect(r.closedMessage).toBe('Closed for stocktake.');
  });

  test('closedReason is "schedule" when closed with no override', async () => {
    const r = await computeWarehouseStatus({}, AFTER_CLOSE, SCHEDULE);
    expect(r.closedReason).toBe('schedule');
  });
});

describe('activeOverride', () => {
  test('returns the state while the window is open', () => {
    expect(activeOverride(
      { override: 'closed', overrideUntil: '2026-06-29T18:30:00Z' }, DURING_HOURS)).toBe('closed');
  });

  test('returns null once the window has passed', () => {
    expect(activeOverride(
      { override: 'closed', overrideUntil: '2026-06-29T03:00:00Z' }, DURING_HOURS)).toBeNull();
  });

  test('returns null for an unrecognised state', () => {
    expect(activeOverride(
      { override: 'maybe', overrideUntil: '2026-06-29T18:30:00Z' }, DURING_HOURS)).toBeNull();
  });

  test('returns null for no override at all', () => {
    expect(activeOverride({}, DURING_HOURS)).toBeNull();
  });
});

describe('resolveOverrideExpiry — always today, never stuck', () => {
  // 'closed' always runs to the upcoming IST midnight, so "close" before opening
  // time means "not opening today" rather than being undone at 08:45.
  test('close during hours expires at the next IST midnight', () => {
    const d = resolveOverrideExpiry('closed', DURING_HOURS, SCHEDULE);
    expect(d.toISOString()).toBe('2026-06-29T18:30:00.000Z'); // Tue 00:00 IST
  });

  test('close BEFORE opening time still runs to midnight, so the store stays shut', () => {
    const d = resolveOverrideExpiry('closed', BEFORE_OPEN, SCHEDULE);
    expect(d.toISOString()).toBe('2026-06-29T18:30:00.000Z');
  });

  // 'open' hands back at the next boundary so normal closing time still applies.
  test('open before opening time expires at 08:45 IST, letting the schedule take over', () => {
    const d = resolveOverrideExpiry('open', BEFORE_OPEN, SCHEDULE);
    expect(d.toISOString()).toBe('2026-06-29T03:15:00.000Z'); // 08:45 IST
  });

  test('open during hours expires at 19:30 IST (normal close)', () => {
    const d = resolveOverrideExpiry('open', DURING_HOURS, SCHEDULE);
    expect(d.toISOString()).toBe('2026-06-29T14:00:00.000Z'); // 19:30 IST
  });

  test('open after closing time expires at midnight, not overnight', () => {
    const d = resolveOverrideExpiry('open', AFTER_CLOSE, SCHEDULE);
    expect(d.toISOString()).toBe('2026-06-29T18:30:00.000Z');
  });

  test('open on a closed Sunday expires at midnight', () => {
    const d = resolveOverrideExpiry('open', SUNDAY, SCHEDULE);
    expect(d.toISOString()).toBe('2026-06-28T18:30:00.000Z');
  });

  test('every expiry is in the future and within 24h', () => {
    for (const now of [DURING_HOURS, BEFORE_OPEN, AFTER_CLOSE, SUNDAY]) {
      for (const state of ['open', 'closed']) {
        const d = resolveOverrideExpiry(state, now, SCHEDULE);
        expect(d.getTime()).toBeGreaterThan(now.getTime());
        expect(d.getTime() - now.getTime()).toBeLessThanOrEqual(24 * 3600 * 1000);
      }
    }
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

