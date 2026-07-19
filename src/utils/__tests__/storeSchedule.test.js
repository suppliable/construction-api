'use strict';

const { getScheduleStatus, scheduleClosedMessage, parseSchedule, minutesLabel } = require('../storeSchedule');

// getScheduleStatus defaults to the hardcoded fallback schedule (Mon–Sat
// 08:45–19:30 IST, closed Sunday) when no schedule is passed.
// Dates are UTC instants; comments show the equivalent IST wall-clock time.
describe('getScheduleStatus — default (fallback) schedule', () => {
  test('open during weekday business hours', () => {
    // Mon 10:00 IST
    expect(getScheduleStatus(new Date('2026-06-29T04:30:00Z'))).toMatchObject({ open: true, reason: null });
  });

  test('open exactly at 08:45 IST (inclusive)', () => {
    expect(getScheduleStatus(new Date('2026-06-29T03:15:00Z'))).toMatchObject({ open: true, reason: null });
  });

  test('open at 19:29 IST, one minute before close', () => {
    expect(getScheduleStatus(new Date('2026-06-29T13:59:00Z'))).toMatchObject({ open: true, reason: null });
  });

  test('closed exactly at 19:30 IST (exclusive)', () => {
    expect(getScheduleStatus(new Date('2026-06-29T14:00:00Z'))).toMatchObject({ open: false, reason: 'after-close' });
  });

  test('closed before opening', () => {
    // Mon 08:00 IST
    expect(getScheduleStatus(new Date('2026-06-29T02:30:00Z'))).toMatchObject({ open: false, reason: 'before-open' });
  });

  test('closed all day Sunday', () => {
    // Sun 11:30 IST — within weekday hours but still closed
    expect(getScheduleStatus(new Date('2026-06-28T06:00:00Z'))).toMatchObject({ open: false, reason: 'closed-day' });
  });
});

describe('getScheduleStatus — RC-driven schedule', () => {
  test('per-day hours override the defaults', () => {
    const schedule = parseSchedule(JSON.stringify({ days: { mon: ['11:00', '15:00'] } }));
    // Mon 10:00 IST — open under the default schedule, closed under this one.
    expect(getScheduleStatus(new Date('2026-06-29T04:30:00Z'), schedule))
      .toMatchObject({ open: false, reason: 'before-open', opensAt: 660, closesAt: 900 });
  });

  test('a holiday closes an otherwise-open day', () => {
    const schedule = parseSchedule(JSON.stringify({
      days: { mon: ['08:45', '19:30'] },
      holidays: ['2026-06-29'],
    }));
    expect(getScheduleStatus(new Date('2026-06-29T04:30:00Z'), schedule))
      .toMatchObject({ open: false, reason: 'holiday' });
  });

  test('Sunday can be opened via RC', () => {
    const schedule = parseSchedule(JSON.stringify({ days: { sun: ['10:00', '14:00'] } }));
    // Sun 11:30 IST — closed by default, open under this schedule.
    expect(getScheduleStatus(new Date('2026-06-28T06:00:00Z'), schedule))
      .toMatchObject({ open: true, reason: null });
  });
});

describe('scheduleClosedMessage', () => {
  test('produces a distinct message per reason, using the live schedule hours', () => {
    const at = (now, schedule) => scheduleClosedMessage(getScheduleStatus(now, schedule));

    expect(at(new Date('2026-06-28T06:00:00Z'))).toMatch(/closed today/i);       // Sunday
    expect(at(new Date('2026-06-29T02:30:00Z'))).toMatch(/open at 8:45 AM/);     // before-open
    expect(at(new Date('2026-06-29T14:00:00Z'))).toMatch(/closed for the day/);  // after-close
  });

  test('reflects custom RC hours rather than the hardcoded defaults', () => {
    const schedule = parseSchedule(JSON.stringify({ days: { mon: ['11:00', '15:00'] } }));
    const msg = scheduleClosedMessage(getScheduleStatus(new Date('2026-06-29T04:30:00Z'), schedule));
    expect(msg).toMatch(/open at 11:00 AM/);
    expect(msg).not.toMatch(/8:45/);
  });

  test('holiday gets its own copy', () => {
    const schedule = parseSchedule(JSON.stringify({
      days: { mon: ['08:45', '19:30'] },
      holidays: ['2026-06-29'],
    }));
    expect(scheduleClosedMessage(getScheduleStatus(new Date('2026-06-29T04:30:00Z'), schedule)))
      .toMatch(/holiday/i);
  });
});

describe('minutesLabel', () => {
  test('formats 12-hour clock times with meridiem', () => {
    expect(minutesLabel(525)).toBe('8:45 AM');   // 08:45
    expect(minutesLabel(1170)).toBe('7:30 PM');  // 19:30
    expect(minutesLabel(0)).toBe('12:00 AM');    // midnight
    expect(minutesLabel(720)).toBe('12:00 PM');  // noon
  });
});
