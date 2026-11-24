'use strict';

// Records an admin action against the thing it changed.
//
// Every call is BEST-EFFORT and never throws. An audit row failing to write
// must not undo a bill that Zoho already accepted or a price Zoho already
// holds — the log line is the fallback, and losing the row is better than
// losing the operation or telling the user it failed when it did not.

const repo = require('../repositories/auditRepository');
const logger = require('../utils/logger');

// Named so a reader of the Activity page knows what happened without decoding
// an endpoint path.
const ACTIONS = Object.freeze({
  SELLING_PRICE_CHANGED: 'selling_price.changed',
  BILL_CREATED: 'bill.created',
  ORDER_ACCEPTED: 'order.accepted',
  ORDER_DECLINED: 'order.declined',
  ORDER_CANCELLED: 'order.cancelled',
  ORDER_FORCE_COMPLETED: 'order.force_completed',
  PAYMENT_MARKED_RECEIVED: 'order.payment_marked_received',
  COD_RECONCILED: 'cod.reconciled',
  ADMIN_USER_CREATED: 'admin_user.created',
  ADMIN_USER_ACTIVE_CHANGED: 'admin_user.active_changed',
  ADMIN_USER_PASSWORD_RESET: 'admin_user.password_reset',
  ADMIN_USER_ATTENDANCE_CHANGED: 'admin_user.attendance_changed',
  ATTENDANCE_EDITED: 'attendance.edited',
});

const LABELS = Object.freeze({
  'selling_price.changed': 'Changed selling price',
  'bill.created': 'Entered a vendor bill',
  'order.accepted': 'Accepted an order',
  'order.declined': 'Declined an order',
  'order.cancelled': 'Cancelled an order',
  'order.force_completed': 'Force-completed an order',
  'order.payment_marked_received': 'Marked payment received',
  'cod.reconciled': 'Reconciled COD',
  'admin_user.created': 'Created an admin user',
  'admin_user.active_changed': 'Activated / deactivated a user',
  'admin_user.password_reset': 'Reset a password',
  'admin_user.attendance_changed': 'Turned attendance on / off for a user',
  'attendance.edited': 'Corrected an attendance punch',
});

/**
 * @param {Object} req        the request, for the actor and trace id
 * @param {string} action     one of ACTIONS
 * @param {Object} target     { type, id, name }
 * @param {Object} [change]   { before, after } — only for value changes
 * @param {Object} [meta]     anything else worth keeping, e.g. an amount
 */
async function record(req, action, target, change = null, meta = null) {
  try {
    const actor = req?.adminUser || {};
    await repo.append({
      at: new Date().toISOString(),
      action,
      label: LABELS[action] || action,
      actorId: actor.userId || 'unknown',
      actorName: actor.name || actor.userId || 'unknown',
      // Flags an action taken while the shared credential was still in use, so
      // "unknown" in the Activity page is explicable rather than suspicious.
      actorIsLegacy: actor.isLegacy === true,
      targetType: target?.type || null,
      targetId: target?.id ? String(target.id) : null,
      targetName: target?.name || null,
      before: change && 'before' in change ? change.before : null,
      after: change && 'after' in change ? change.after : null,
      meta: meta || null,
      traceId: req?.traceContext?.traceId || null,
    }, req?.traceContext);
  } catch (err) {
    (req?.log || logger).warn({ err: err.message, action }, 'audit.write_failed');
  }
}

async function list(filters, traceContext = null) {
  const rows = await repo.list({ limit: filters?.limit }, traceContext);
  const { actorId, action, from, to } = filters || {};
  return rows.filter(r =>
    (!actorId || r.actorId === actorId) &&
    (!action || r.action === action) &&
    (!from || String(r.at) >= String(from)) &&
    (!to || String(r.at) <= `${to}T23:59:59.999Z`));
}

module.exports = { record, list, ACTIONS, LABELS };
