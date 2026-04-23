'use strict';

const { createSpan } = require('./spanTracer');

function countRows(result) {
  if (result == null) return undefined;
  if (Array.isArray(result)) return result.length;
  if (typeof result === 'object') return Object.keys(result).length;
  return undefined;
}

async function dbOp(name, fn, traceContext = null) {
  const span = createSpan(traceContext, `db.${name}`, {});
  try {
    const result = await fn(span);
    const rows = countRows(result);
    span.end({ success: true, ...(rows != null && { rows }) });
    return result;
  } catch (error) {
    span.end({ success: false, error: error.message });
    throw error;
  }
}

module.exports = { dbOp };
