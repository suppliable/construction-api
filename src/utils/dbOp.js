'use strict';

const logger = require('./logger');

async function dbOp(name, fn) {
  try {
    return await fn();
  } catch (err) {
    logger.error({ err: err.message, operation: name }, 'Firestore operation failed');
    throw err;
  }
}

module.exports = { dbOp };
