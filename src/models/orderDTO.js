'use strict';

const { formatTimestamps } = require('../utils/formatDoc');

const { ORDER_STATUS_LABELS: STATUS_LABELS } = require('../constants');

function normalizeAddress(addr) {
  if (!addr) return null;
  const lat = addr.lat ?? addr.latitude ?? addr.coordinates?.lat ?? addr.coordinates?.latitude ?? null;
  const lng = addr.lng ?? addr.longitude ?? addr.coordinates?.lng ?? addr.coordinates?.longitude ?? null;
  const fullAddress = addr.fullAddress || addr.address || addr.street ||
    [addr.line1, addr.line2, addr.city, addr.state, addr.pincode].filter(Boolean).join(', ') || null;
  return { ...addr, lat, lng, fullAddress };
}

/**
 * Maps a raw Firestore order document to a typed customer-facing shape.
 * Normalises snake_case DB fields to camelCase.
 * deliveryOtp is only included when status === 'arrived'.
 */
function toOrderDTO(doc) {
  if (!doc) return null;
  const o = formatTimestamps(doc);
  return {
    orderId: o.orderId || null,
    zohoSoNumber: o.zoho_so_number || null,
    zohoInvoiceNumber: o.zoho_invoice_number || null,
    status: o.status || null,
    statusLabel: STATUS_LABELS[o.status] || o.status || null,
    paymentType: o.paymentType || null,
    // 'pending' | 'pending_proceeding' | 'confirmed' | 'failed'.
    // `pending_proceeding` = order moved past pending_payment while the online
    // payment is still settling. See orderService helpers
    // proceedAsPendingPayment / convertPendingToCod / confirmOnlinePayment.
    paymentStatus: o.paymentStatus || null,
    // ISO timestamp set when an originally-ONLINE order was auto-converted to
    // COD at `arrived` because the payment never confirmed. Surfaced to the
    // driver so they know to expect a "this was originally online" context.
    convertedFromOnlineAt: o.convertedFromOnlineAt || null,
    payment: o.payment
      ? {
          gateway: o.payment.gateway || null,
          providerOrderId: o.payment.providerOrderId || null,
          attempts: Array.isArray(o.payment.attempts) ? o.payment.attempts : [],
        }
      : null,
    items: o.items || [],
    subtotal: Number(o.subtotal ?? 0),
    gstTotal: Number(o.gst_total ?? 0),
    deliveryCharge: Number(o.delivery_charge ?? o.deliveryCharge ?? 0),
    grandTotal: Number(o.grand_total ?? o.grandTotal ?? 0),
    deliveryAddress: normalizeAddress(o.deliveryAddress),
    driverName: o.driverName || o.vehicle?.driverName || null,
    driverPhone: o.driverPhone || o.vehicle?.driverPhone || null,
    deliveryOtp: o.status === 'arrived' ? o.deliveryOtp : undefined,
    estimatedDelivery: o.estimatedDelivery || null,
    createdAt: o.createdAt || null,
    acceptedAt: o.acceptedAt || null,
    declinedAt: o.declinedAt || null,
    deliveredAt: o.deliveredAt || null,
  };
}

module.exports = { toOrderDTO, STATUS_LABELS };
