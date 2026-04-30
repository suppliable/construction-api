'use strict';

const { formatTimestamps } = require('../utils/formatDoc');

function normalizeAddress(addr) {
  if (!addr) return null;
  const lat = addr.lat ?? addr.latitude ?? addr.coordinates?.lat ?? addr.coordinates?.latitude ?? null;
  const lng = addr.lng ?? addr.longitude ?? addr.coordinates?.lng ?? addr.coordinates?.longitude ?? null;
  const fullAddress = addr.fullAddress || addr.address || addr.street ||
    [addr.line1, addr.line2, addr.city, addr.state, addr.pincode].filter(Boolean).join(', ') || null;
  return { ...addr, lat, lng, fullAddress };
}

const STATUS_LABELS = {
  pending_payment: 'Awaiting Payment',
  payment_confirmed: 'Payment Confirmed',
  warehouse_review: 'Order Placed',
  accepted: 'Order Accepted',
  packing: 'Order Accepted',
  ready_for_dispatch: 'Ready for Pickup',
  loading: 'Loading into Vehicle',
  out_for_delivery: 'Out for Delivery',
  arrived: 'Driver has Arrived',
  delivered: 'Delivered',
  declined: 'Order Cancelled',
};

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
    paymentStatus: o.paymentStatus || null,
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
