'use strict';

// Proof-photo fields, derived for read paths.
//
// Delivery completion and photo upload are separate steps (drivers in low-signal
// areas close the order on OTP alone), so a delivered order can legitimately sit
// without a photo for a while. These helpers present that state consistently
// wherever an order is serialized.
//
// Orders delivered before this split have no proofPhoto* fields at all. Rather
// than backfilling them, we derive the status on read: an old order that already
// has a deliveryPhotoUrl is treated as 'uploaded', so history doesn't light up
// with false "photo pending" warnings.

const PENDING_PHOTO_ALERT_AFTER_MS = 6 * 60 * 60 * 1000; // 6 hours

function resolveProofPhotoStatus(order) {
  if (order.proofPhotoStatus) return order.proofPhotoStatus;
  // Legacy order: a stored photo means it was captured at completion time.
  if (order.deliveryPhotoUrl) return 'uploaded';
  // Anything not yet delivered has no proof obligation.
  return order.status === 'delivered' ? 'pending' : null;
}

/**
 * Returns the proof-photo fields for an order, with legacy orders normalized.
 * `pendingPhotoAlert` marks a delivered order whose photo is still missing more
 * than six hours later — the point at which it stops looking like a slow upload
 * and starts looking like it is never coming.
 */
function proofPhotoFields(order) {
  if (!order) return {};
  const proofPhotoStatus = resolveProofPhotoStatus(order);
  const proofPhotoUrl = order.proofPhotoUrl ?? order.deliveryPhotoUrl ?? null;

  let pendingPhotoAlert = false;
  if (order.status === 'delivered' && proofPhotoStatus === 'pending' && order.deliveredAt) {
    const deliveredMs = new Date(order.deliveredAt).getTime();
    if (Number.isFinite(deliveredMs)) {
      pendingPhotoAlert = Date.now() - deliveredMs > PENDING_PHOTO_ALERT_AFTER_MS;
    }
  }

  return {
    proofPhotoStatus,
    proofPhotoUrl,
    proofPhotoUploadId: order.proofPhotoUploadId ?? null,
    proofPhotoUploadedAt: order.proofPhotoUploadedAt ?? null,
    pendingPhotoAlert,
  };
}

module.exports = { proofPhotoFields, resolveProofPhotoStatus, PENDING_PHOTO_ALERT_AFTER_MS };
