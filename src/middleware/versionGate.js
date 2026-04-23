'use strict';

const remoteConfig = require('../services/remoteConfigService');
const logger = require('../utils/logger');
const { compareVersions } = require('../utils/semver');

/**
 * Version gate middleware.
 * Reads min_app_version from Firebase Remote Config (cached 5 min).
 * Clients sending X-App-Version below the minimum receive 426 Upgrade Required.
 * Clients not sending X-App-Version (web, admin) are allowed through.
 */
async function versionGate(req, res, next) {
  const appVersion = req.headers['x-app-version'];

  // Non-Flutter clients (web, admin portal) don't send this header — pass through
  if (!appVersion) return next();

  const log = req.log || logger;

  const [minAppVersion, latestAppVersion] = await Promise.all([
    remoteConfig.getString('min_app_version', '0.0.0'),
    remoteConfig.getString('latest_app_version', '0.0.0'),
  ]);

  if (compareVersions(appVersion, minAppVersion) < 0) {
    log.info({ appVersion, minAppVersion }, 'Rejected request from outdated app version');
    return res.status(426).json({
      success: false,
      code: 'FORCE_UPGRADE',
      message: 'This version of the app is no longer supported. Please update to continue.',
      minVersion: minAppVersion,
      latestVersion: latestAppVersion,
    });
  }

  next();
}

module.exports = versionGate;
