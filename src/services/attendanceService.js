'use strict';

// Staff attendance: clock in at first portal login of the IST day, clock out
// with a button or automatically at the cut-off.
//
// Why "first login of the day" and not "every login": the portal keeps its token
// in sessionStorage, which is per browser TAB. A new tab, a restarted browser or
// a closed tab means signing in again, so someone legitimately logs in four or
// five times a day without arriving or leaving. Making clock-in idempotent per
// day absorbs all of that. Clock-out cannot be inferred from sessions for the
// same reason, so it is deliberate (button) with an automatic fallback.
//
// Auto clock-out is LAZY, not a cron: stale records are closed the next time
// someone logs in or an admin opens the report. The scheduled workflows are
// best-effort and can run late; a read-time check cannot be missed.
//
// Slack is best-effort throughout. A Slack outage must never block a clock-in.

const attendanceRepo = require('../repositories/attendanceRepository');
const userRepo = require('../repositories/adminUserRepository');
const slack = require('./slackService');
const audit = require('./auditService');
const rules = require('../utils/attendanceRules');
const { istDateKey } = require('../utils/istDate');
const logger = require('../utils/logger');
const { AppError, ValidationError, NotFoundError } = require('../utils/errors');

const normId = v => String(v || '').trim().toLowerCase();

/** Attendance is opt-in per person, and checked on the server every call: the
 *  portal's cached copy of the flag is a convenience, never the gate. */
async function requireEnabled(userId, traceContext) {
  const user = await userRepo.getUser(normId(userId), traceContext);
  if (!user || user.isActive === false || user.attendanceEnabled !== true) {
    throw new AppError('Attendance is not enabled for your account.', 403, 'ATTENDANCE_NOT_ENABLED');
  }
  return user;
}

function withDerived(record) {
  if (!record) return null;
  return {
    ...record,
    minutes: rules.minutesBetween(record.inAt, record.outAt),
    duration: rules.formatDuration(rules.minutesBetween(record.inAt, record.outAt)),
    inNote: rules.describeVerdict({
      verdict: record.inVerdict, reason: record.inReason,
      distanceM: record.inDistanceM, accuracyM: record.inAccuracyM,
    }),
  };
}

// ── lazy auto clock-out ─────────────────────────────────────────────────────

async function autoClose(record, traceContext) {
  const outAt = rules.autoOutAt(record);
  const patch = {
    outAt,
    outSource: 'auto',
    outVerdict: null, outDistanceM: null, outAccuracyM: null,
    autoClosedAt: new Date().toISOString(),
  };
  await attendanceRepo.update(record.id, patch, traceContext);
  const closed = { ...record, ...patch };

  // The reply carries "(auto)" and the cut-off time, so a message appearing days
  // late (closed when someone finally opened the report) still reads correctly.
  slack.postAttendanceOut(closed, rules.minutesBetween(closed.inAt, closed.outAt)).catch(() => {});
  logger.info({ id: record.id, outAt }, 'attendance.auto_closed');
  return closed;
}

/** Close whatever is stale. Per person when given a userId, otherwise everyone. */
async function closeStale({ userId = null } = {}, traceContext = null, now = new Date()) {
  const open = await attendanceRepo.listOpen({ userId }, traceContext);
  const closed = [];
  for (const rec of open) {
    // Sequential on purpose: each close posts to Slack, and a handful at most.
    if (rules.isStale(rec, now)) closed.push(await autoClose(rec, traceContext));
  }
  return closed;
}

// ── clock in / out ──────────────────────────────────────────────────────────

/**
 * Clock in for today. Idempotent: a second call returns the existing record and
 * posts nothing, which is what makes "first login of the day" safe across tabs.
 */
async function clockIn(userId, reading, traceContext = null, now = new Date()) {
  const user = await requireEnabled(userId, traceContext);
  await closeStale({ userId: normId(userId) }, traceContext, now);

  const date = istDateKey(now);
  const id = attendanceRepo.docIdFor(user.userId, date);
  const loc = rules.evaluateLocation(reading);

  const { created, record } = await attendanceRepo.createIfAbsent({
    id,
    userId: user.userId,
    name: user.name || user.userId,
    date,
    inAt: now.toISOString(),
    inSource: 'login',
    inVerdict: loc.verdict,
    inReason: loc.reason,
    inDistanceM: loc.distanceM,
    inAccuracyM: loc.accuracyM,
    outAt: null,
    outSource: null,
    outVerdict: null, outDistanceM: null, outAccuracyM: null,
    slackTs: null,
    createdAt: now.toISOString(),
  }, traceContext);

  if (!created) return { record: withDerived(record), created: false };

  const ts = await slack.postAttendanceIn(record).catch(() => null);
  if (ts) {
    await attendanceRepo.update(id, { slackTs: ts }, traceContext);
    record.slackTs = ts;
  }
  logger.info({ id, verdict: loc.verdict, distanceM: loc.distanceM }, 'attendance.clocked_in');
  return { record: withDerived(record), created: true };
}

/**
 * Clock out. Location is recorded but never required: people leave the shop
 * before they clock out, so demanding presence would only push everyone to
 * clock out late.
 */
async function clockOut(userId, reading, traceContext = null, now = new Date()) {
  const user = await requireEnabled(userId, traceContext);
  await closeStale({ userId: normId(userId) }, traceContext, now);

  const id = attendanceRepo.docIdFor(user.userId, istDateKey(now));
  const record = await attendanceRepo.get(id, traceContext);
  if (!record) {
    throw new AppError('You have not clocked in today.', 409, 'NOT_CLOCKED_IN');
  }
  if (record.outAt) return { record: withDerived(record), created: false };

  const loc = rules.evaluateLocation(reading);
  const patch = {
    outAt: now.toISOString(),
    outSource: 'button',
    outVerdict: loc.verdict,
    outDistanceM: loc.distanceM,
    outAccuracyM: loc.accuracyM,
  };
  await attendanceRepo.update(id, patch, traceContext);
  const done = { ...record, ...patch };

  slack.postAttendanceOut(done, rules.minutesBetween(done.inAt, done.outAt)).catch(() => {});
  logger.info({ id }, 'attendance.clocked_out');
  return { record: withDerived(done), created: true };
}

/** Today's state, for the portal indicator. */
async function status(userId, traceContext = null, now = new Date()) {
  const user = await userRepo.getUser(normId(userId), traceContext);
  if (!user || user.isActive === false || user.attendanceEnabled !== true) {
    return { enabled: false, record: null };
  }
  await closeStale({ userId: normId(userId) }, traceContext, now);
  const record = await attendanceRepo.get(
    attendanceRepo.docIdFor(user.userId, istDateKey(now)), traceContext
  );
  return { enabled: true, record: withDerived(record) };
}

// ── report + corrections (admin) ────────────────────────────────────────────

async function report({ from, to, userId = null } = {}, traceContext = null) {
  // Everything that has gone stale is closed before it is read, so the report
  // never shows a day as "still open" that the cut-off already ended.
  await closeStale({}, traceContext);

  const rows = (await attendanceRepo.listRange({ from, to }, traceContext))
    .filter(r => !userId || r.userId === normId(userId))
    .map(withDerived);

  const totals = new Map();
  for (const r of rows) {
    const t = totals.get(r.userId) || { userId: r.userId, name: r.name, days: 0, minutes: 0, flagged: 0 };
    t.days += 1;
    t.minutes += r.minutes || 0;
    if (r.inVerdict && r.inVerdict !== 'inside') t.flagged += 1;
    totals.set(r.userId, t);
  }
  return {
    rows,
    totals: [...totals.values()]
      .map(t => ({ ...t, duration: rules.formatDuration(t.minutes) }))
      .sort((a, b) => String(a.name).localeCompare(String(b.name))),
  };
}

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

/**
 * An admin correcting a punch. The change goes into the audit log with before
 * and after, so a correction is itself visible — the log is what stops this
 * from being a quiet way to rewrite someone's hours.
 */
async function editPunch(id, { inAt, outAt }, req, traceContext = null) {
  const record = await attendanceRepo.get(id, traceContext);
  if (!record) throw new NotFoundError('No such attendance record', 'NOT_FOUND');

  const patch = {};
  if (inAt !== undefined) {
    if (!ISO.test(String(inAt)) || Number.isNaN(Date.parse(inAt))) {
      throw new ValidationError('inAt must be a valid date-time', 'INVALID_PARAM');
    }
    patch.inAt = new Date(inAt).toISOString();
  }
  if (outAt !== undefined && outAt !== null) {
    if (!ISO.test(String(outAt)) || Number.isNaN(Date.parse(outAt))) {
      throw new ValidationError('outAt must be a valid date-time', 'INVALID_PARAM');
    }
    patch.outAt = new Date(outAt).toISOString();
    patch.outSource = 'edited';
  }
  if (!Object.keys(patch).length) {
    throw new ValidationError('Nothing to change', 'MISSING_PARAM');
  }

  const nextIn = patch.inAt || record.inAt;
  const nextOut = patch.outAt || record.outAt;
  if (nextOut && Date.parse(nextOut) < Date.parse(nextIn)) {
    throw new ValidationError('Clock-out cannot be before clock-in', 'INVALID_PARAM');
  }
  // The record's date is the IST day it was created for; moving the punch to a
  // different day would orphan it from its own document id.
  if (istDateKey(new Date(nextIn)) !== record.date) {
    throw new ValidationError(`Clock-in must stay on ${record.date}`, 'INVALID_PARAM');
  }

  patch.editedBy = req?.adminUser?.userId || null;
  patch.editedAt = new Date().toISOString();
  await attendanceRepo.update(id, patch, traceContext);

  await audit.record(req, audit.ACTIONS.ATTENDANCE_EDITED,
    { type: 'attendance', id, name: `${record.name} · ${record.date}` },
    { before: { inAt: record.inAt, outAt: record.outAt }, after: { inAt: nextIn, outAt: nextOut || null } });

  return withDerived({ ...record, ...patch });
}

module.exports = {
  clockIn, clockOut, status, report, editPunch, closeStale, requireEnabled,
};
