const { getSettings, updateSettings } = require('../services/firestoreService');
const remoteConfig = require('../services/remoteConfigService');
const { computeWarehouseStatus, resolveOverrideExpiry, loadSchedule } = require('../utils/warehouseStatus');
const { notifyWarehouseTransition, notifyPendingOrders } = require('../services/slackService');
const { findOrders } = require('../repositories/orderRepository');

const getCodThreshold = async (req, res) => {
  try {
    const settings = await getSettings(req.traceContext);
    const cod_threshold = await remoteConfig.getNumber('cod_threshold', settings.cod_threshold ?? 7500);
    res.json({ success: true, data: { cod_threshold } });
  } catch (err) {
    res.status(500).json({ success: false, error: 'SERVER_ERROR', message: err.message });
  }
};

const updateCodThreshold = async (req, res) => {
  try {
    const { value } = req.body;
    if (value === undefined || value === null) {
      return res.status(400).json({ success: false, error: 'MISSING_PARAM', message: 'value is required' });
    }
    if (isNaN(value) || value < 0) {
      return res.status(400).json({ success: false, error: 'INVALID_PARAM', message: 'value must be a non-negative number' });
    }
    await updateSettings({ cod_threshold: parseFloat(value) }, req.traceContext);
    res.json({ success: true, data: { cod_threshold: parseFloat(value) } });
  } catch (err) {
    res.status(500).json({ success: false, error: 'SERVER_ERROR', message: err.message });
  }
};

const getWarehouseStatus = async (req, res) => {
  try {
    const settings = await getSettings(req.traceContext);
    res.json({ success: true, data: await computeWarehouseStatus(settings) });
  } catch (err) {
    res.status(500).json({ success: false, error: 'SERVER_ERROR', message: err.message });
  }
};

/**
 * Admin open/close. Writes a TODAY-ONLY override that expires by itself, so the
 * schedule always resumes without anyone remembering to undo this.
 *
 * `force` and the old duration params (closedForMinutes / closedUntil /
 * forceOpenForMinutes / forceOpenUntil) are gone: opening outside hours IS the
 * override, and every override is time-bound by construction. A closure spanning
 * more than today belongs in the schedule's `holidays` list, not here.
 */
const updateWarehouseStatus = async (req, res) => {
  try {
    const { isOpen, closedMessage } = req.body;
    if (isOpen === undefined || isOpen === null) {
      return res.status(400).json({ success: false, error: 'MISSING_PARAM', message: 'isOpen is required' });
    }

    const now = new Date();
    const state = isOpen ? 'open' : 'closed';
    // The schedule is needed to place the expiry for an 'open' override, which
    // hands back at the next boundary rather than running to midnight.
    const schedule = await loadSchedule();
    const until = resolveOverrideExpiry(state, now, schedule);

    const update = { override: state, overrideUntil: until.toISOString() };
    if (closedMessage !== undefined) update.warehouseClosedMessage = closedMessage;

    // Clear the previous model's fields so a stale indefinite close can't be
    // resurrected by anything still reading them.
    update.warehouseOpen = null;
    update.warehouseClosedUntil = null;
    update.warehouseForceOpen = null;
    update.warehouseForceOpenUntil = null;

    await updateSettings(update, req.traceContext);
    const settings = await getSettings(req.traceContext);
    const status = await computeWarehouseStatus(settings, now, schedule);

    // Announce the admin action to the broadcast channel. Fire-and-forget: a
    // Slack outage must not fail the admin's request.
    notifyWarehouseTransition({
      kind: 'manual',
      isOpen: status.isOpen,
      until: status.overrideUntil,
      message: status.closedMessage,
    });

    res.json({ success: true, data: status });
  } catch (err) {
    res.status(500).json({ success: false, error: 'SERVER_ERROR', message: err.message });
  }
};

/**
 * Cloud Scheduler tick: announce a schedule-driven open/close transition.
 *
 * Prod only in practice — Cloud Scheduler is scoped to the suppliable-app GCP
 * project, while dev/qa run on Render. Those envs still honour the schedule
 * (the gate is clock-computed per request); they just don't announce it.
 *
 * This endpoint deliberately writes NO warehouse state — the open/closed gate is
 * computed from the clock on every request, so the store is already correct at
 * the boundary whether or not this fires. All the tick does is notice that the
 * computed state differs from the last-announced one and post to Slack.
 *
 * That makes it idempotent by construction: a retried or duplicated firing sees
 * no change and posts nothing, and a missed firing costs one notification rather
 * than leaving the warehouse stuck.
 *
 * A manual admin close in effect at a schedule boundary simply keeps isOpen
 * false, so nothing is announced and the schedule resumes on its own when
 * warehouseClosedUntil expires.
 */
const warehouseScheduleTick = async (req, res) => {
  try {
    const settings = await getSettings(req.traceContext);
    const status = await computeWarehouseStatus(settings);

    const lastAnnounced = settings.lastAnnouncedOpen;
    if (lastAnnounced === status.isOpen) {
      return res.json({ success: true, data: { changed: false, isOpen: status.isOpen } });
    }

    await updateSettings({ lastAnnouncedOpen: status.isOpen }, req.traceContext);
    await notifyWarehouseTransition({
      kind: 'scheduled',
      isOpen: status.isOpen,
      until: status.overrideUntil,
      message: status.closedMessage,
    });

    res.json({ success: true, data: { changed: true, isOpen: status.isOpen } });
  } catch (err) {
    res.status(500).json({ success: false, error: 'SERVER_ERROR', message: err.message });
  }
};

/**
 * Cloud Scheduler / GitHub Actions tick: post a Slack digest of ALL orders
 * currently awaiting admin acceptance (status === 'warehouse_review').
 *
 * Runs every 15 minutes, all days — unlike warehouseScheduleTick this isn't
 * gated by business hours, since "not yet accepted" is itself the alert
 * condition regardless of schedule.
 *
 * Pure read + conditional Slack post, no Firestore writes — idempotent by
 * construction. A duplicate or missed firing just double-posts or skips one
 * cycle; there's no state to corrupt. Sends nothing when zero orders are
 * pending — silence is the expected/successful case, not a "0 pending" ping.
 */
const pendingOrdersTick = async (req, res) => {
  try {
    const orders = await findOrders({ status: 'warehouse_review', limit: 0 }, req.traceContext);
    orders.reverse(); // findOrders returns createdAt desc; oldest-pending-first is more actionable

    if (orders.length === 0) {
      return res.json({ success: true, data: { sent: false, pendingCount: 0 } });
    }

    await notifyPendingOrders(orders);
    res.json({ success: true, data: { sent: true, pendingCount: orders.length } });
  } catch (err) {
    res.status(500).json({ success: false, error: 'SERVER_ERROR', message: err.message });
  }
};

/**
 * Cloud Scheduler tick: flip lapsed bulk quotes to `expired`.
 *
 * The server owns expiry — approve also re-checks validUntil, because a quote
 * can lapse between firings and must not be approvable in that window.
 *
 * Pure read + conditional writes, idempotent: a quote already past its date is
 * flipped once and then no longer matches the `quoted` filter.
 */
const bulkQuoteExpiryTick = async (req, res) => {
  try {
    const result = await require('../services/bulkService')
      .expireLapsedQuotes(req.traceContext);
    if (result.expired) {
      req.log.info({ expired: result.expired, quoteIds: result.quoteIds }, 'bulk quotes expired');
    }
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(500).json({ success: false, error: 'SERVER_ERROR', message: err.message });
  }
};

module.exports = {
  bulkQuoteExpiryTick,
  getCodThreshold,
  updateCodThreshold,
  getWarehouseStatus,
  updateWarehouseStatus,
  pendingOrdersTick,
  warehouseScheduleTick,
};
