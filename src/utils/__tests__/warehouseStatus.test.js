'use strict';

const { computeWarehouseStatus, resolveClosedUntil } = require('../warehouseStatus');

// Mon 10:00 IST — inside business hours, so the schedule alone would be open.
// This isolates the manual-close behaviour.
const DURING_HOURS = new Date('2026-06-29T04:30:00Z');

describe('computeWarehouseStatus — manual close', () => {
  test('open during hours with no manual close', () => {
    expect(computeWarehouseStatus({}, DURING_HOURS)).toEqual({ isOpen: true, closedMessage: '' });
  });

  test('indefinite manual close stays closed', () => {
    const res = computeWarehouseStatus({ warehouseOpen: false }, DURING_HOURS);
    expect(res.isOpen).toBe(false);
    expect(res.closedUntil).toBeUndefined();
  });

  test('timed close in the future stays closed and reports closedUntil', () => {
    const until = '2026-06-29T05:30:00Z'; // 1h later
    const res = computeWarehouseStatus({ warehouseOpen: false, warehouseClosedUntil: until }, DURING_HOURS);
    expect(res.isOpen).toBe(false);
    expect(res.closedUntil).toBe(until);
    expect(res.closedMessage).toMatch(/maintenance/i);
  });

  test('timed close in the past has expired — schedule resumes, store reopens', () => {
    const until = '2026-06-29T03:00:00Z'; // already passed
    const res = computeWarehouseStatus({ warehouseOpen: false, warehouseClosedUntil: until }, DURING_HOURS);
    expect(res.isOpen).toBe(true);
  });

  test('malformed closedUntil fails safe (stays closed)', () => {
    const res = computeWarehouseStatus({ warehouseOpen: false, warehouseClosedUntil: 'not-a-date' }, DURING_HOURS);
    expect(res.isOpen).toBe(false);
  });

  test('custom closedMessage overrides the default maintenance text', () => {
    const res = computeWarehouseStatus(
      { warehouseOpen: false, warehouseClosedUntil: '2026-06-29T05:30:00Z', warehouseClosedMessage: 'Back after lunch' },
      DURING_HOURS
    );
    expect(res.closedMessage).toBe('Back after lunch');
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
