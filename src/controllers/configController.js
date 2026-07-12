const { getSettings, updateSettings } = require('../services/firestoreService');
const remoteConfig = require('../services/remoteConfigService');
const { computeWarehouseStatus, resolveClosedUntil } = require('../utils/warehouseStatus');

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
    res.json({ success: true, data: computeWarehouseStatus(settings) });
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
    res.json({ success: true, data: computeWarehouseStatus(settings) });
  } catch (err) {
    res.status(500).json({ success: false, error: 'SERVER_ERROR', message: err.message });
  }
};

module.exports = { getCodThreshold, updateCodThreshold, getWarehouseStatus, updateWarehouseStatus };
