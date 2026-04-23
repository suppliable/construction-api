'use strict';

const logger = require('../utils/logger');
const remoteConfig = require('../services/remoteConfigService');

async function maintenanceMode(req, res, next) {
  // Admin routes bypass maintenance mode
  if (req.path.startsWith('/admin')) return next();

  const log = req.log || logger;

  const enabled = await remoteConfig.getBoolean('maintenance_mode', false);

  if (enabled) {
    log.info({ path: req.originalUrl }, 'Request blocked — maintenance mode active');
    return res.status(503).json({
      success: false,
      code: 'MAINTENANCE',
      message: 'The service is temporarily unavailable for maintenance. Please try again shortly.',
    });
  }

  next();
}

module.exports = maintenanceMode;
