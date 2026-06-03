'use strict';

const { AsyncLocalStorage } = require('async_hooks');

// Request-scoped store for the OTEL context of the active controllerSpan.
// `controllerSpan` middleware seeds this with the OTEL ctx for the request.
// `spanTracer.resolveParentCtx` reads it as a reliable fallback when callers
// don't pass an explicit parent.
//
// This exists because Express's middleware trampoline + some auto-instrumentations
// occasionally overwrite OTEL's global active context between middleware
// boundaries, causing manual createSpan/withSpan calls to start as new trace
// roots instead of children of the request's controllerSpan. Our own ALS
// is not touched by anything else, so it survives those boundaries.
const reqCtxStore = new AsyncLocalStorage();

function runWithRequestCtx(otelCtx, fn) {
  return reqCtxStore.run(otelCtx, fn);
}

function getRequestCtx() {
  return reqCtxStore.getStore() || null;
}

module.exports = { runWithRequestCtx, getRequestCtx };
