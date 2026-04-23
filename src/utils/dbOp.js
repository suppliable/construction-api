'use strict';

const { withSpan } = require('./spanTracer');

async function dbOp(name, fn, traceContext = null) {
  return withSpan(traceContext, `db.${name}`, {}, fn);
}

module.exports = { dbOp };
