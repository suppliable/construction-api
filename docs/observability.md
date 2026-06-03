# Observability — Tracing Architecture

This document explains how distributed tracing is wired across `construction-api` and the Flutter clients, so future contributors (humans or LLMs) don't break propagation when changing the middleware stack, span helpers, or auto-instrumentation config.

## TL;DR

- One **trace per request**, root span created by `controllerSpan` middleware.
- W3C `traceparent` header is the wire format. The Flutter `ApiClient` sends one derived from a Sentry transaction; backend extracts it and uses it as the parent of the controllerSpan.
- All Firestore / Zoho / cache / business-logic spans must be **children of controllerSpan**, sharing its `trace_id`.
- Parent discovery for child spans goes through a project-local AsyncLocalStorage (`src/observability/requestContext.js`), **not** OTEL's `context.active()`. This is deliberate — see "Why a custom ALS" below.
- Auto-instrumentations that overwrite the active OTEL context are disabled in `src/observability/otel.js`. **Do not re-enable** `instrumentation-http`, `instrumentation-express`, `instrumentation-redis`, `instrumentation-ioredis`, or `instrumentation-undici` without re-validating the trace tree.

## End-to-end flow

```
Flutter (Sentry transaction)
  │  trace_id=T, span_id=S1
  │  HTTP request with header:
  │    traceparent: 00-<T>-<S1>-01
  │
  ▼
Backend: tracing middleware            (parses traceparent into req.traceContext)
Backend: pino-http                     (uses T as request id, logs with trace_id)
Backend: controllerSpan middleware
  ├─ propagation.extract() → parentCtx with parent span S1
  ├─ tracer.startSpan(SERVER, parent=parentCtx) → root span Sroot, trace_id=T
  ├─ req.otelCtx = ctx-with-Sroot
  ├─ runWithRequestCtx(ctx-with-Sroot, () => context.with(ctx-with-Sroot, next))
  │
  ▼
Route handler / cacheFor / repositories
  └─ createSpan(null, 'cache.get', ...) / withSpan(null, 'db getCart', ...)
       └─ resolveParentCtx(null) → reads ALS → returns ctx-with-Sroot
            └─ tracer.startSpan(name, opts, parentCtx=ctx-with-Sroot)
                 → child span, trace_id=T, parent=Sroot ✓

Flutter (Sentry) and Backend (Tempo) both store spans tagged with trace_id=T,
so a single Tempo lookup by T shows backend spans, and Sentry's "Trace
Navigator" links to the corresponding Tempo trace.
```

## Why a custom AsyncLocalStorage

OTEL's standard pattern is `context.with(ctx, fn)` to activate a context, and `tracer.startSpan(name)` to inherit it via `context.active()`. **In this codebase that does not work reliably.**

Observed symptoms (May 2026): `controllerSpan` correctly extracts the incoming `traceparent` and activates its span on the OTEL global context, but by the time downstream Express middleware (`cacheFor`) and route handlers run, `context.active()` returns a different — and often unrelated — span. The result: orphan spans starting fresh trace roots, breaking propagation.

Reproduced even after disabling all suspicious auto-instrumentations (`http`, `express`, `redis`, `ioredis`, `undici`). The bleed is in some interaction between Express's middleware trampoline, AsyncLocalStorage context boundaries, and (likely) other instrumentations bundled in `@opentelemetry/auto-instrumentations-node`.

**Mitigation:** maintain our own `AsyncLocalStorage` (`src/observability/requestContext.js`) that nothing else touches. `controllerSpan` seeds it; `spanTracer` reads it. This is robust because:

1. It's *our* ALS — no third-party code knows about it, so no one can overwrite it.
2. It's request-scoped — propagates through every async boundary inside one HTTP request.
3. Existing call sites (76+) continue to pass `null` / `req.traceContext` as their first arg and still get correct parents.

If OTEL fixes the underlying issue (or we drop offending instrumentations) we can simplify by deleting the ALS — but until then, treat it as load-bearing.

## Files & contracts

| File | Role | Contract |
|---|---|---|
| `src/middleware/tracing.js` | Parses incoming W3C `traceparent`, sets `req.traceContext` ({traceId, spanId, traceparent, …}). Echoes `traceparent` and `x-trace-id` on the response. | Runs first in the middleware chain. **Does not create OTEL spans.** |
| `src/middleware/controllerSpan.js` | Creates the root SERVER span for `/api/v1/*` requests. Activates that span on OTEL global context AND seeds `requestContext` ALS. Sets `req.otelCtx` and `req.otelSpan`. | Must run after `tracing` and before any route or cache middleware. Mounted at `app.use('/api/v1', …, controllerSpan, v1Router)`. |
| `src/observability/requestContext.js` | Project-local AsyncLocalStorage holding the OTEL Context for the active request. | `runWithRequestCtx(ctx, fn)` is called once per request by `controllerSpan`. `getRequestCtx()` returns ctx or null. **Do not export the ALS instance directly** — keep the API minimal. |
| `src/utils/spanTracer.js` | `createSpan(parentRef, name, attrs)` and `withSpan(parentRef, name, attrs, fn)`. Resolution: explicit ctx > req.otelCtx > requestContext ALS > context.active(). | First arg accepts: an OTEL Context, a `req`, the legacy `traceContext` object, or null. Falls through `resolveParentCtx`. |
| `src/utils/dbOp.js` | Thin wrapper over `withSpan` for Firestore ops. | Adds `db.system=google_cloud_firestore` attribute. |
| `src/cache/middleware.js` | Route-level Redis cache via `cacheFor(ttl, keyFn)`. Creates `cache.get` / `cache.set` spans. | Manual spans because `instrumentation-redis` is disabled. |
| `src/observability/otel.js` | NodeSDK setup. Disables instrumentations that conflict with manual span creation. | Disabled list: `fs`, `runtime-node`, `net`, `dns`, `grpc`, `express`, `http`, `redis`, `ioredis`, `undici`. Adding more is fine; **removing** any of these requires re-validating end-to-end propagation against `/api/v1/home`. |

## When you add new spans

```js
// In a route, repository, or service:
const { createSpan, withSpan } = require('../utils/spanTracer');
const { dbOp } = require('../utils/dbOp');

// One-shot manual span:
const span = createSpan(null, 'zoho.api.getInvoices', { 'http.url': url });
try {
  const result = await fetch(...);
  span.end({ success: true });
} catch (e) {
  span.end({ success: false, error: e });
  throw e;
}

// Wrapped async block:
return withSpan(null, 'orders.compose', { 'order.id': orderId }, async () => {
  const items = await dbOp('cart.fetch', () => db.collection('cart')...);
  // ... business logic
  return composed;
});
```

The first arg can stay `null` — the ALS will supply the request's controllerSpan as the parent. Pass `req` (or an explicit ctx) only if you need spans rooted under a non-default context (rare).

**Avoid manual `tracer.startSpan(...)` outside `spanTracer.js`** — it bypasses parent-context resolution and produces orphan spans.

## When you change middleware order

The chain in `server.js` is:

```
tracing → pino-http → compression → cors → express.json → debugPayloads
  → firestoreTracking
  → /api/v1: versionGate → maintenanceMode → controllerSpan → v1Router
```

Rules:
1. `tracing` must come before `pino-http` (pino-http reads `req.traceContext`).
2. `controllerSpan` must come before any middleware that creates spans (cacheFor, route handlers).
3. `firestoreTracking` is its own AsyncLocalStorage for read/write counters — independent of OTEL.
4. Middleware mounted with `app.use('/api/v1', mw1, mw2, ...)` runs sequentially. Adding a new middleware **before** `controllerSpan` won't get span context. Adding **after** is fine.

## When you add a new auto-instrumentation

Pre-flight checklist:
1. Hit `GET /api/v1/home` with cache miss (delete `qa:home:data` from Redis first).
2. In stdout, confirm every `SPAN ...` line and the `GET ...` line share the same `[trace_prefix]`.
3. In Grafana Tempo, confirm Tempo's "Spans count" for that trace > 1 and the controllerSpan is the root.
4. Send a request from Flutter, copy the traceId from `flutter run` console (`[TRACE] traceparent=...`), and search Tempo by it. Mobile and backend trace IDs must match.

If any of those fail after enabling the new instrumentation, **revert** it in `otel.js` until the conflict is understood.

## What lives where

- **Sentry (UI half)**: Flutter app's HTTP spans, route navigation, key user actions (otp.send, cart.add, checkout.place_order). DSN configured in `suppliable-ui/lib/main.dart`.
- **Grafana Tempo (backend half)**: controllerSpan + manual child spans + Sentry-shared `trace_id` for cross-system lookup.
- **Grafana Loki**: pino logs with `trace_id`/`span_id` attached via `mixin()` in `logger.js`.
- **Grafana Mimir**: OTEL metrics from NodeSDK `PeriodicExportingMetricReader`.

Same trace_id ties all four together. To debug an issue end-to-end:
1. Find the `traceId` in Sentry (or in the Flutter request log line).
2. Open Tempo and search by trace ID.
3. From any span there, click "Logs for this span" → goes to Loki.

## Known issues / future work

- **76+ legacy callers pass `req.traceContext`** (a plain `{traceId, spanId}` object, not an OTEL Context). `resolveParentCtx` does not extract OTEL parent info from it; callers fall through to the ALS, which works but masks the legacy signature. Keep until a sweep replaces them with `null`.
- **No OTLP from Flutter app yet** — relying on Sentry as the UI tracing store. Migration to `opentelemetry-dart` deferred until that SDK reaches beta.
- **`cache.get` records `cache.result` only on miss** — successful hits log `cache.result: 'hit'`, but errors during Redis call set neither. Acceptable; revisit if hit/miss attribution matters.
