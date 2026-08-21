'use strict';

// ── Pagination ────────────────────────────────────────────────────────────────
const DEFAULT_USER_ORDER_LIMIT = 50;
const DEFAULT_ADMIN_LIST_LIMIT = 50;
const DEFAULT_DRIVER_HISTORY_LIMIT = 30;
const DEFAULT_ORDER_QUERY_LIMIT = 30;
const DEFAULT_HANDOVER_QUERY_LIMIT = 30;

// ── Rate limiting ─────────────────────────────────────────────────────────────
const OTP_SEND_MAX = 3;
const OTP_SEND_WINDOW_MS = 15 * 60 * 1000;   // 15 min per phone
const IP_MAX = 10;
const IP_WINDOW_MS = 60 * 60 * 1000;          // 1 hour per IP
const RESEND_COOLDOWN_MS = 30 * 1000;          // 30 sec per phone
const VERIFY_MAX_ATTEMPTS = 5;
const VERIFY_LOCKOUT_MS = 15 * 60 * 1000;     // 15 min lockout
// Guest (unauthenticated) FCM token registration — generous enough for many
// devices behind one NAT/CGNAT IP registering on launch + token refresh, but
// caps abuse of the open endpoint.
const GUEST_FCM_MAX = 40;
const GUEST_FCM_WINDOW_MS = 60 * 60 * 1000;   // 1 hour per IP

// ── Cache ─────────────────────────────────────────────────────────────────────
const CACHE_TTL_MS = 5 * 60 * 1000;           // 5 min remote config cache (ms)

// Redis TTLs (seconds) — used with cacheFor()
const CACHE_TTL_CATALOGUE_S      = 600;   // 10 min — products, categories, home, search
const CACHE_TTL_CONFIG_S         = 300;   //  5 min — cod-threshold, warehouse-status, delivery config
const CACHE_TTL_ORDER_S          = 300;   //  5 min — order detail
const CACHE_TTL_INVOICE_S        = 3600;  // 60 min — invoice PDF URL (rarely changes)
const CACHE_TTL_DRIVER_PROFILE_S = 600;   // 10 min — driver profile
const CACHE_TTL_DRIVER_ORDERS_S  = 60;    //  1 min — today's orders (short for freshness)

// ── Business rules ────────────────────────────────────────────────────────────
const MAX_ACTIVE_ORDERS_PER_ASSIGNMENT = 2;    // max concurrent orders per driver/vehicle
const NEW_ORDER_THRESHOLD_MS = 5 * 60 * 1000; // window for "new" order alert count

// ── Order statuses ────────────────────────────────────────────────────────────
const ACTIVE_DRIVER_ORDER_STATUSES = [
  'accepted', 'ready_for_dispatch', 'loading', 'out_for_delivery', 'arrived',
];

// liveOrders (RTDB) membership. NON_TERMINAL statuses are pushed to the admin
// live view via RTDB; TERMINAL statuses are removed. Pre-warehouse_review
// statuses (pending_payment/pending_proceeding) never enter liveOrders.
const NON_TERMINAL_ORDER_STATUSES = [
  'warehouse_review', 'accepted', 'packing', 'ready_for_dispatch',
  'loading', 'out_for_delivery', 'arrived',
];
const TERMINAL_ORDER_STATUSES = [
  'delivered', 'declined', 'cancelled', 'failed', 'converted_to_cod',
  'pending_payment', 'pending_proceeding',
];

// Slim projection written to liveOrders/{orderId} — enough to render the admin
// live table without per-order Firestore enrichment.
const LIVE_ORDER_PROJECTION_FIELDS = [
  'status', 'customerName', 'customerPhone', 'grand_total', 'paymentType',
  'createdAt', 'acceptedAt', 'driverId', 'dailyOrderNo',
];

// Customer-facing labels (used in orderDTO)
const ORDER_STATUS_LABELS = {
  pending_payment:   'Awaiting Payment',
  payment_confirmed: 'Payment Confirmed',
  warehouse_review:  'Order Placed',
  accepted:          'Order Accepted',
  packing:           'Order Accepted',
  ready_for_dispatch: 'Ready for Pickup',
  loading:           'Loading into Vehicle',
  out_for_delivery:  'Out for Delivery',
  arrived:           'Driver has Arrived',
  delivered:         'Delivered',
  declined:          'Order Cancelled',
};

// Driver-facing labels
const DRIVER_STATUS_LABELS = {
  accepted:           'Order Accepted',
  ready_for_dispatch: 'Ready for Dispatch',
  loading:            'Loading',
  out_for_delivery:   'Out for Delivery',
  arrived:            'Arrived',
  delivered:          'Delivered',
  declined:           'Declined',
};

// ── Delivery ──────────────────────────────────────────────────────────────────
const DEFAULT_PINCODES = '600119,600130,603103,600097,600100,600126,600115';

// ── External services ─────────────────────────────────────────────────────────
const MSG91_BASE_URL = 'https://control.msg91.com/api/v5/otp';
// MSG91 defaults to a 4-digit OTP and a 15-minute expiry. Both must be sent
// explicitly: the app's OTP field requires exactly 6 digits (app_constants.dart
// otpLength), and the DLT-approved template text promises 10 minutes.
const MSG91_OTP_LENGTH = 6;
const MSG91_OTP_EXPIRY_MINUTES = 10;
// Must be a RASTER format. placehold.co returns SVG when no extension is given,
// and Flutter's codecs (JPEG/PNG/GIF/WebP/BMP/WBMP) cannot decode SVG — the
// `?text=No+Image` form this used to be rendered as the error widget, not as a
// placeholder. Single source of truth: productService.buildImage() uses this too,
// so the two cannot drift apart again.
const PLACEHOLDER_IMAGE = 'https://placehold.co/400x300/png';

module.exports = {
  DEFAULT_USER_ORDER_LIMIT,
  DEFAULT_ADMIN_LIST_LIMIT,
  DEFAULT_DRIVER_HISTORY_LIMIT,
  DEFAULT_ORDER_QUERY_LIMIT,
  DEFAULT_HANDOVER_QUERY_LIMIT,
  OTP_SEND_MAX,
  OTP_SEND_WINDOW_MS,
  IP_MAX,
  IP_WINDOW_MS,
  RESEND_COOLDOWN_MS,
  VERIFY_MAX_ATTEMPTS,
  VERIFY_LOCKOUT_MS,
  GUEST_FCM_MAX,
  GUEST_FCM_WINDOW_MS,
  CACHE_TTL_MS,
  CACHE_TTL_CATALOGUE_S,
  CACHE_TTL_CONFIG_S,
  CACHE_TTL_ORDER_S,
  CACHE_TTL_INVOICE_S,
  CACHE_TTL_DRIVER_PROFILE_S,
  CACHE_TTL_DRIVER_ORDERS_S,
  MAX_ACTIVE_ORDERS_PER_ASSIGNMENT,
  NEW_ORDER_THRESHOLD_MS,
  ACTIVE_DRIVER_ORDER_STATUSES,
  NON_TERMINAL_ORDER_STATUSES,
  TERMINAL_ORDER_STATUSES,
  LIVE_ORDER_PROJECTION_FIELDS,
  ORDER_STATUS_LABELS,
  DRIVER_STATUS_LABELS,
  DEFAULT_PINCODES,
  MSG91_BASE_URL,
  MSG91_OTP_LENGTH,
  MSG91_OTP_EXPIRY_MINUTES,
  PLACEHOLDER_IMAGE,
};
