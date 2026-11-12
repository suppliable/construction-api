'use strict';

module.exports = {
  testEnvironment: 'node',
  testMatch: ['**/__tests__/**/*.test.js'],
  // Supplies the env vars config/env.js validates at require-time. Without it a
  // developer whose .env is incomplete gets process.exit(1) and the entire run
  // dies with no summary. See the file.
  setupFiles: ['<rootDir>/test/setupEnv.js'],
};
