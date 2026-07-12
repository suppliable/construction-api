'use strict';

const { getScheduleStatus, scheduleClosedMessage } = require('../storeSchedule');

// Dates are UTC instants; comments show the equivalent IST wall-clock time.
describe('getScheduleStatus', () => {
  test('open during weekday business hours', () => {
    // Mon 10:00 IST
    expect(getScheduleStatus(new Date('2026-06-29T04:30:00Z'))).toEqual({ open: true, reason: null });
  });

  test('open exactly at 08:45 IST (inclusive)', () => {
    expect(getScheduleStatus(new Date('2026-06-29T03:15:00Z'))).toEqual({ open: true, reason: null });
  });

  test('open at 19:29 IST, one minute before close', () => {
    expect(getScheduleStatus(new Date('2026-06-29T13:59:00Z'))).toEqual({ open: true, reason: null });
  });

  test('closed exactly at 19:30 IST (exclusive)', () => {
    expect(getScheduleStatus(new Date('2026-06-29T14:00:00Z'))).toEqual({ open: false, reason: 'after-close' });
  });

  test('closed before opening', () => {
    // Mon 08:00 IST
    expect(getScheduleStatus(new Date('2026-06-29T02:30:00Z'))).toEqual({ open: false, reason: 'before-open' });
  });

  test('closed all day Sunday', () => {
    // Sun 11:30 IST — within weekday hours but still closed
    expect(getScheduleStatus(new Date('2026-06-28T06:00:00Z'))).toEqual({ open: false, reason: 'sunday' });
  });
});

describe('scheduleClosedMessage', () => {
  test('produces a distinct message per reason', () => {
    expect(scheduleClosedMessage('sunday')).toMatch(/Sundays/);
    expect(scheduleClosedMessage('before-open')).toMatch(/open at 8:45 AM/);
    expect(scheduleClosedMessage('after-close')).toMatch(/closed for the day/);
  });
});
