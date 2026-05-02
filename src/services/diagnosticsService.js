'use strict';

const env = require('../config/env');
const firebaseAdmin = require('../utils/firebaseAdmin');
const { isAllowlistedAdminPhone } = require('./remoteConfigService');

function buildRuntimeDiagnostics() {
  return {
    app_env: env.appEnv,
    firebase_project_id: env.firebaseProjectId,
    storage_bucket: env.FIREBASE_STORAGE_BUCKET || '(not set)',
    database_url: env.FIREBASE_DATABASE_URL || '(not set)',
    redis: env.UPSTASH_REDIS_REST_URL ? 'configured' : 'not set',
    zoho_domain: env.ZOHO_API_DOMAIN,
    node_env: env.NODE_ENV,
    port: env.PORT,
    firebase_apps_initialized: firebaseAdmin.apps.length,
  };
}

async function ensureAllowlistedAdminPhone(phone) {
  const allowed = await isAllowlistedAdminPhone(phone);
  if (!allowed) {
    const err = new Error('You are not authorized to view environment information');
    err.statusCode = 403;
    err.code = 'FORBIDDEN';
    throw err;
  }
}

module.exports = {
  buildRuntimeDiagnostics,
  ensureAllowlistedAdminPhone,
};
