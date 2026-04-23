const { getSettings, updateSettings } = require('../services/firestoreService');

const getCodThreshold = async (req, res) => {
  try {
    const settings = await getSettings(req.traceContext);
    res.json({ success: true, data: { cod_threshold: settings.cod_threshold ?? 7500 } });
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
    res.json({
      success: true,
      data: {
        isOpen: settings.warehouseOpen !== false,
        closedMessage: settings.warehouseClosedMessage || 'We are currently closed. You can add items to cart and place your order when we reopen.'
      }
    });
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
    await updateSettings(update, req.traceContext);
    const settings = await getSettings(req.traceContext);
    res.json({
      success: true,
      data: {
        isOpen: settings.warehouseOpen !== false,
        closedMessage: settings.warehouseClosedMessage || ''
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: 'SERVER_ERROR', message: err.message });
  }
};

module.exports = { getCodThreshold, updateCodThreshold, getWarehouseStatus, updateWarehouseStatus };
