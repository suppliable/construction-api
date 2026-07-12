'use strict';

/**
 * backfill-live-orders.js
 *
 * One-time backfill of the RTDB `liveOrders` node from Firestore so the admin
 * live view isn't empty on first deploy of the RTDB-push change. Writes the slim
 * projection for every non-terminal order; optionally prunes terminal orders
 * that are still lingering in the node.
 *
 * Reuses the app's config + service modules so the projection/membership logic
 * stays single-sourced with the runtime sync (realtimeDBService.syncLiveOrder).
 *
 * Usage:
 *   node scripts/backfill-live-orders.js [--dry-run] [--prune]
 *
 *   --dry-run  log what would be written/removed without touching RTDB
 *   --prune    also remove liveOrders entries whose order is now terminal/missing
 */

require('dotenv').config();

const DRY_RUN = process.argv.includes('--dry-run');
const PRUNE = process.argv.includes('--prune');

// Initialises the Admin SDK (auth/firestore/database) from env.
const admin = require('../src/utils/firebaseAdmin');
const { NON_TERMINAL_ORDER_STATUSES, LIVE_ORDER_PROJECTION_FIELDS } = require('../src/constants');

function projectionOf(order) {
  const p = {};
  for (const field of LIVE_ORDER_PROJECTION_FIELDS) {
    p[field] = order[field] != null ? order[field] : null;
  }
  p.updatedAt = new Date().toISOString();
  return p;
}

async function main() {
  const db = admin.firestore();
  const rtdb = admin.database();

  // 1. Active orders from Firestore → upsert projection.
  // 'in' supports ≤ 10 values; NON_TERMINAL has 7, so a single query is fine.
  const snap = await db.collection('orders')
    .where('status', 'in', NON_TERMINAL_ORDER_STATUSES)
    .get();

  console.log(`Found ${snap.size} non-terminal order(s) to backfill${DRY_RUN ? ' (dry-run)' : ''}.`);

  let written = 0;
  for (const doc of snap.docs) {
    const order = doc.data();
    const orderId = order.orderId || doc.id;
    const projection = projectionOf(order);
    if (DRY_RUN) {
      console.log(`  would upsert liveOrders/${orderId} status=${order.status}`);
    } else {
      await rtdb.ref(`liveOrders/${orderId}`).update(projection);
    }
    written++;
  }
  console.log(`${DRY_RUN ? 'Would write' : 'Wrote'} ${written} live order(s).`);

  // 2. Optional prune: remove stale liveOrders entries (terminal or deleted).
  if (PRUNE) {
    const liveSnap = await rtdb.ref('liveOrders').once('value');
    const live = liveSnap.val() || {};
    const activeIds = new Set(snap.docs.map(d => d.data().orderId || d.id));
    let removed = 0;
    for (const orderId of Object.keys(live)) {
      if (activeIds.has(orderId)) continue;
      if (DRY_RUN) {
        console.log(`  would remove stale liveOrders/${orderId} status=${live[orderId]?.status}`);
      } else {
        await rtdb.ref(`liveOrders/${orderId}`).remove();
      }
      removed++;
    }
    console.log(`${DRY_RUN ? 'Would remove' : 'Removed'} ${removed} stale live order(s).`);
  }

  process.exit(0);
}

main().catch((err) => {
  console.error('backfill-live-orders failed:', err);
  process.exit(1);
});
