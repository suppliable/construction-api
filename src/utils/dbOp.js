'use strict';

const { withSpan } = require('./spanTracer');

async function dbOp(name, fn, traceContext = null, extraAttrs = {}) {
  return withSpan(traceContext, `db ${name}`, {
    'db.system': 'google_cloud_firestore',
    'peer.service': 'firestore',
    ...extraAttrs,
  }, fn);
}

module.exports = { dbOp };
