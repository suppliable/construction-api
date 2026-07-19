const { getSettings, updateSettings } = require('../services/firestoreService');
const remoteConfig = require('../services/remoteConfigService');
const { computeWarehouseStatus, resolveClosedUntil } = require('../utils/warehouseStatus');
const { notifyWarehouseTransition } = require('../services/slackService');

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

const updateWarehouseStatus = async (req, res) => {
  try {
    const { isOpen, closedMessage } = req.body;
    if (isOpen === undefined || isOpen === null) {
      return res.status(400).json({ success: false, error: 'MISSING_PARAM', message: 'isOpen is required' });
    }
    const update = { warehouseOpen: Boolean(isOpen) };
    if (closedMessage !== undefined) update.warehouseClosedMessage = closedMessage;

    if (isOpen) {
      // Reopening clears any pending timed maintenance close.
      update.warehouseClosedUntil = null;
    } else {
      const { until, error } = resolveClosedUntil(req.body, new Date());
      if (error) {
        return res.status(400).json({ success: false, error: 'INVALID_PARAM', message: error });
      }
      // A timed close sets an expiry; an indefinite close clears any stale one.
      update.warehouseClosedUntil = until || null;
    }

    await updateSettings(update, req.traceContext);
    const settings = await getSettings(req.traceContext);
    const status = await computeWarehouseStatus(settings);

    // Announce the admin action to the broadcast channel. Fire-and-forget: a
    // Slack outage must not fail the admin's request.
    notifyWarehouseTransition({
      kind: 'manual',
      isOpen: status.isOpen,
      until: status.closedUntil,
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
      until: status.closedUntil,
      message: status.closedMessage,
    });

    res.json({ success: true, data: { changed: true, isOpen: status.isOpen } });
  } catch (err) {
    res.status(500).json({ success: false, error: 'SERVER_ERROR', message: err.message });
  }
};

module.exports = {
  getCodThreshold,
  updateCodThreshold,
  getWarehouseStatus,
  updateWarehouseStatus,
  warehouseScheduleTick,
};
