'use strict';

const crypto = require('crypto');
const admin = require('../utils/firebaseAdmin');

const COLLECTION = 'idempotency_keys';
const KEY_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;

// Replay window. Firestore TTL policy on `expiresAt` should be configured in the
// console to actually delete docs; this field also lets the middleware ignore
// stale entries even before the TTL sweeper runs.
const TTL_HOURS = 24;

/**
 * Idempotency middleware. Opt-in: only activates when the client sends an
 * `X-Idempotency-Key` header. Without the header, the request flows through
 * untouched — preserving existing client behavior.
 *
 * Guarantees:
 *  - Same key + same body + same user → cached response replayed.
 *  - Same key + different body → 422 (client bug).
 *  - Same key + different user → 409 (key reuse across accounts).
 *  - Concurrent first-writes serialized via Firestore transaction; the loser
 *    sees the in-progress doc and returns 409 IDEMPOTENCY_IN_PROGRESS.
 *  - Only 2xx/4xx responses are cached. 5xx releases the key so retries work.
 */
function idempotency() {
  const db = admin.firestore();

  return async function idempotencyMiddleware(req, res, next) {
    const key = req.headers['x-idempotency-key'];
    if (!key) return next();

    if (!KEY_PATTERN.test(key)) {
      return res.status(400).json({
        success: false,
        error: 'INVALID_IDEMPOTENCY_KEY',
        message: 'X-Idempotency-Key must be 8–128 chars [A-Za-z0-9_-]',
      });
    }

    const userId = req.user && req.user.uid ? req.user.uid : 'anon';
    const bodyHash = crypto
      .createHash('sha256')
      .update(JSON.stringify(req.body || {}))
      .digest('hex');

    const ref = db.collection(COLLECTION).doc(key);
    const now = Date.now();
    const expiresAt = new Date(now + TTL_HOURS * 3600 * 1000);

    let cached = null;
    try {
      await db.runTransaction(async tx => {
        const snap = await tx.get(ref);
        if (snap.exists) {
          const data = snap.data();
          // Treat expired entries as missing — overwrite with a fresh claim.
          if (data.expiresAt && data.expiresAt.toMillis() < now) {
            tx.set(ref, {
              userId,
              bodyHash,
              status: 'pending',
              createdAt: admin.firestore.FieldValue.serverTimestamp(),
              expiresAt: admin.firestore.Timestamp.fromDate(expiresAt),
            });
            return;
          }
          cached = data;
          return;
        }
        tx.set(ref, {
          userId,
          bodyHash,
          status: 'pending',
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
          expiresAt: admin.firestore.Timestamp.fromDate(expiresAt),
        });
      });
    } catch (err) {
      // Firestore unavailable — log and fall through. Idempotency is a safety
      // net; failing closed would break ordering for everyone, so we fail open.
      req.log && req.log.warn({ err: err.message }, 'idempotency.tx_failed');
      return next();
    }

    if (cached) {
      if (cached.userId !== userId) {
        return res.status(409).json({
          success: false,
          error: 'IDEMPOTENCY_KEY_CONFLICT',
          message: 'Idempotency key already used by another account',
        });
      }
      if (cached.bodyHash !== bodyHash) {
        return res.status(422).json({
          success: false,
          error: 'IDEMPOTENCY_BODY_MISMATCH',
          message: 'Idempotency key reused with a different request body',
        });
      }
      if (cached.status === 'pending') {
        return res.status(409).json({
          success: false,
          error: 'IDEMPOTENCY_IN_PROGRESS',
          message: 'A request with this key is already in progress',
        });
      }
      return res.status(cached.statusCode || 200).json(cached.body);
    }

    // We claimed the key. Wrap res.json so we capture the response on completion.
    const origJson = res.json.bind(res);
    res.json = payload => {
      const statusCode = res.statusCode || 200;
      if (statusCode < 500) {
        ref
          .set(
            {
              status: 'completed',
              statusCode,
              body: payload,
              completedAt: admin.firestore.FieldValue.serverTimestamp(),
            },
            { merge: true }
          )
          .catch(err => {
            req.log && req.log.warn({ err: err.message }, 'idempotency.cache_write_failed');
          });
      } else {
        // 5xx → release the key so the client can retry.
        ref.delete().catch(() => {});
      }
      return origJson(payload);
    };
    next();
  };
}

module.exports = { idempotency };
