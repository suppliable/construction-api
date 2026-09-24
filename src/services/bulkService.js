'use strict';

// Bulk Orders & Quotes.
//
// A bulk product is an ordinary Zoho item with the `cf_bulk` checkbox ticked,
// so rate, GST, HSN and unit come from the catalogue finance already maintains.
// Firestore only holds what Zoho has no concept of: a category's minimum order
// value, and the quotes themselves.
//
// Lifecycle: requested → quoted → ordered, with edit_requested / declined /
// expired as side exits. Totals are zero until a human prices the quote.

const crypto = require('crypto');
const bulkRepo = require('../repositories/bulkRepository');
const remoteConfig = require('./remoteConfigService');
const { getAllProducts, getProductById } = require('./productService');
const { getSignedUploadUrl, getSignedReadUrl } = require('./storageService');
const { ValidationError, NotFoundError, ConflictError } = require('../utils/errors');
const {
  BULK_QUOTE_VALIDITY_DAYS,
  BULK_MAX_QUOTE_PHOTOS,
  BULK_MAX_PHOTO_BYTES,
  BULK_ALLOWED_PHOTO_TYPES,
  BULK_PHOTO_UPLOAD_URL_TTL_MIN,
  BULK_PHOTO_READ_URL_TTL_MIN,
  BULK_QUOTES_PAGE_SIZE,
  DEFAULT_PINCODES,
} = require('../constants');

const PINCODE_RE = /^\d{6}$/;

/** Stable id for a Zoho category name, used to key the Firestore overlay. */
function categorySlug(name) {
  return String(name || '').toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40) || 'uncategorised';
}

// ---- availability ----

/**
 * Instant vs bulk for a pincode.
 *
 * `instant` reuses the same Remote Config list deliveryService checks, so the
 * two can never disagree about whether quick delivery reaches an address.
 * `bulkAvailable` is true everywhere by default — serving out-of-zone customers
 * is the entire point of bulk — but stays configurable. `*` means everywhere.
 */
async function getAvailability(pincode, traceContext = null) {
  if (!pincode || !PINCODE_RE.test(String(pincode))) {
    throw new ValidationError('Enter a valid 6-digit pincode', 'VALIDATION_ERROR');
  }
  const [instantStr, bulkStr] = await Promise.all([
    remoteConfig.getString('serviceable_pincodes', DEFAULT_PINCODES),
    remoteConfig.getString('bulk_serviceable_pincodes', '*'),
  ]);

  const instantList = String(instantStr).split(',').map(p => p.trim()).filter(Boolean);
  const instant = instantList.includes(String(pincode));

  const bulkRaw = String(bulkStr).trim();
  const bulkAvailable = bulkRaw === '*'
    || bulkRaw.split(',').map(p => p.trim()).filter(Boolean).includes(String(pincode));

  return { pincode: String(pincode), instant, bulkAvailable };
}

// ---- catalogue (sourced from Zoho) ----

/**
 * Every Zoho item flagged for bulk.
 *
 * includeHidden is deliberate: cf_walkin governs the instant storefront and
 * cf_bulk governs this one, so an item can be bulk-only without appearing in
 * the app's normal catalogue.
 */
async function getBulkProducts(traceContext = null) {
  const all = await getAllProducts(null, traceContext, { includeHidden: true });
  return all.filter(p => p.bulkVisible);
}

function toProductDTO(p) {
  const unit = p.unit || 'unit';
  return {
    id: p.id,
    name: p.name || '',
    brand: p.brand || '',
    categoryId: categorySlug(p.category),
    // Zoho's unit doubles as the pack label ("50kg bag", "Nos").
    packLabel: unit,
    unit: { singular: unit, plural: unit },
    // Indicative only. The priced quote carries the real number; the client
    // labels this "indicative" everywhere it is shown.
    price: Number(p.price ?? 0),
    imageUrl: p.imageUrl || null,
    description: p.description || null,
    available: p.hasVariants
      ? (p.variants || []).some(v => (v.available_stock ?? 0) > 0)
      : true,
  };
}

async function listCategories(traceContext = null) {
  const [products, overlays] = await Promise.all([
    getBulkProducts(traceContext),
    bulkRepo.listCategoryOverlays(traceContext),
  ]);
  const overlayById = new Map(overlays.map(o => [o.id, o]));

  const byId = new Map();
  for (const p of products) {
    const id = categorySlug(p.category);
    if (!byId.has(id)) byId.set(id, { id, name: p.category || 'Uncategorised', productCount: 0 });
    byId.get(id).productCount++;
  }

  return [...byId.values()]
    .map(c => {
      const o = overlayById.get(c.id) || {};
      return {
        id: c.id,
        name: o.name || c.name,
        iconKey: o.iconKey || null,
        minOrderValue: Number(o.minOrderValue ?? 0),
        sortOrder: o.sortOrder ?? 999,
        productCount: c.productCount,
        active: o.active !== false,
      };
    })
    .filter(c => c.active)
    .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name))
    .map(({ sortOrder, active, ...rest }) => rest);
}

async function listCategoryProducts(categoryId, search, traceContext = null) {
  const products = await getBulkProducts(traceContext);
  let rows = products.filter(p => categorySlug(p.category) === categoryId);

  if (!rows.length) throw new NotFoundError('Category not found', 'NOT_FOUND');

  const term = (search || '').trim().toLowerCase();
  if (term) {
    rows = rows.filter(r =>
      `${r.name || ''} ${r.brand || ''} ${r.unit || ''}`.toLowerCase().includes(term)
    );
  }
  return rows.map(toProductDTO);
}

// ---- photo upload slots ----

/**
 * Mints a pre-signed PUT so the app uploads straight to storage instead of
 * streaming bytes through this API. The returned photoId is what the client
 * later attaches to a quote request.
 */
async function createPhotoSlot({ userId, fileName, contentType, sizeBytes }, traceContext = null) {
  const type = String(contentType || '').toLowerCase();
  if (!BULK_ALLOWED_PHOTO_TYPES.includes(type)) {
    throw new ValidationError('Photos must be JPEG or PNG', 'VALIDATION_ERROR');
  }
  const bytes = Number(sizeBytes);
  if (!Number.isFinite(bytes) || bytes <= 0) {
    throw new ValidationError('sizeBytes is required', 'VALIDATION_ERROR');
  }
  if (bytes > BULK_MAX_PHOTO_BYTES) {
    const mb = Math.floor(BULK_MAX_PHOTO_BYTES / (1024 * 1024));
    throw new ValidationError(`Each photo must be under ${mb}MB`, 'VALIDATION_ERROR');
  }

  const photoId = 'BPH' + crypto.randomUUID().replace(/-/g, '').slice(0, 20);
  const ext = type === 'image/png' ? 'png' : 'jpg';
  const path = `bulk-quotes/${userId}/${photoId}.${ext}`;

  const uploadUrl = await getSignedUploadUrl(path, type, BULK_PHOTO_UPLOAD_URL_TTL_MIN);

  await bulkRepo.savePhotoSlot({
    photoId,
    userId,
    path,
    contentType: type,
    fileName: String(fileName || '').slice(0, 200),
    sizeBytes: bytes,
    createdAt: new Date().toISOString(),
  }, traceContext);

  return { photoId, uploadUrl, expiresInMinutes: BULK_PHOTO_UPLOAD_URL_TTL_MIN };
}

// ---- quote requests ----

/**
 * Per-category minimum spend, re-validated server-side.
 *
 * The app blocks a short cart already, but the server owns the rule — the
 * message here is shown to the customer verbatim, so it names the category and
 * the shortfall rather than reading like a log line.
 */
function assertCategoryMinimums(lineItems, categoriesById) {
  const spendByCategory = new Map();
  for (const li of lineItems) {
    const prev = spendByCategory.get(li.categoryId) || 0;
    spendByCategory.set(li.categoryId, prev + li.unitPrice * li.quantity);
  }
  for (const [categoryId, spend] of spendByCategory) {
    const category = categoriesById.get(categoryId);
    const min = Number(category?.minOrderValue ?? 0);
    if (min > 0 && spend < min) {
      const short = Math.ceil(min - spend);
      throw new ValidationError(
        `${category.name} orders start at ₹${min.toLocaleString('en-IN')}. `
        + `Add ₹${short.toLocaleString('en-IN')} more of ${category.name} to request a quote.`,
        'BELOW_MINIMUM_ORDER_VALUE'
      );
    }
  }
}

/**
 * Creates a quote request. It starts at `requested` with zero totals — the real
 * numbers arrive when a human prices it. Item unitPrice is the indicative price
 * the customer was shown, and gstRate is carried from Zoho so pricing later
 * does not have to guess the tax band.
 */
async function createQuoteRequest({ userId, source, items, note, addressId, photoIds, address }, traceContext = null) {
  if (!['cart', 'freeform'].includes(source)) {
    throw new ValidationError('source must be cart or freeform', 'VALIDATION_ERROR');
  }

  const requestedItems = Array.isArray(items) ? items : [];
  if (source === 'cart' && !requestedItems.length) {
    throw new ValidationError('Add at least one item to request a quote', 'VALIDATION_ERROR');
  }
  if (source === 'freeform' && !String(note || '').trim() && !(photoIds || []).length) {
    throw new ValidationError('Describe what you need, or attach a photo', 'VALIDATION_ERROR');
  }
  if ((photoIds || []).length > BULK_MAX_QUOTE_PHOTOS) {
    throw new ValidationError(`Attach up to ${BULK_MAX_QUOTE_PHOTOS} photos`, 'VALIDATION_ERROR');
  }

  // Priced from Zoho rather than from client-sent numbers.
  let lineItems = [];
  if (requestedItems.length) {
    const resolved = await Promise.all(
      requestedItems.map(i => getProductById(i.productId, traceContext).catch(() => null))
    );

    lineItems = requestedItems.map((i, idx) => {
      const p = resolved[idx];
      if (!p) throw new NotFoundError(`Product not found: ${i.productId}`, 'NOT_FOUND');
      if (!p.bulkVisible) {
        throw new ValidationError(`${p.name} is not available for bulk orders`, 'VALIDATION_ERROR');
      }
      const quantity = Number(i.quantity);
      if (!Number.isFinite(quantity) || quantity <= 0) {
        throw new ValidationError(`Enter a quantity for ${p.name}`, 'VALIDATION_ERROR');
      }
      const unit = p.unit || 'unit';
      return {
        productId: p.id,
        zohoItemId: p.id,
        categoryId: categorySlug(p.category),
        name: p.name,
        packLabel: unit,
        quantity,
        unit,
        unitPrice: Number(p.price ?? 0),
        gstRate: Number(p.gst_percentage ?? 0),
      };
    });

    const categories = await listCategories(traceContext);
    assertCategoryMinimums(lineItems, new Map(categories.map(c => [c.id, c])));
  }

  // Photos: only the requester's own slots resolve, so a photoId from someone
  // else's upload cannot be attached here.
  let photos = [];
  if ((photoIds || []).length) {
    const slots = await bulkRepo.getPhotoSlots(photoIds, traceContext);
    const mine = slots.filter(s => s.userId === userId);
    if (mine.length !== photoIds.length) {
      throw new ValidationError('One of those photos is no longer available', 'VALIDATION_ERROR');
    }
    photos = mine.map(s => ({ id: s.photoId, path: s.path, url: null }));
  }

  const now = new Date();
  const quote = {
    id: 'QT-' + now.getTime().toString(36).toUpperCase() + crypto.randomBytes(2).toString('hex').toUpperCase(),
    userId,
    status: 'requested',
    source,
    createdAt: now.toISOString(),
    items: lineItems,
    // Totals stay zero until a human prices this.
    subtotal: 0,
    deliveryCharge: 0,
    gstAmount: 0,
    grandTotal: 0,
    note: String(note || '').trim() || null,
    photos,
    addressId: addressId || null,
    deliveryAddress: address?.fullAddress || address?.address || null,
    deliveryPincode: address?.pincode || null,
    validUntil: null,
    deliveryDate: null,
    teamNote: null,
    orderId: null,
    updatedAt: now.toISOString(),
  };

  await bulkRepo.saveQuote(quote, traceContext);
  return toQuoteDTO(await hydratePhotos(quote));
}

// ---- reading quotes ----

/**
 * Photo URLs are short-lived signed reads, so a URL stored at request time is
 * stale by the time anyone opens the quote. Re-mint on every read rather than
 * persisting a long-lived link.
 */
async function hydratePhotos(quote) {
  if (!quote.photos?.length) return quote;
  const photos = await Promise.all(quote.photos.map(async p => ({
    ...p,
    url: p.path
      ? await getSignedReadUrl(p.path, BULK_PHOTO_READ_URL_TTL_MIN).catch(() => p.url ?? null)
      : (p.url ?? null),
  })));
  return { ...quote, photos };
}

async function listQuotes(userId, { limit, cursor } = {}, traceContext = null) {
  const requested = Number(limit);
  const pageSize = Number.isFinite(requested) && requested > 0
    ? Math.min(requested, BULK_QUOTES_PAGE_SIZE)
    : BULK_QUOTES_PAGE_SIZE;

  const page = await bulkRepo.listQuotesByUser(userId, pageSize, cursor || null, traceContext);
  const hydrated = await Promise.all(page.quotes.map(hydratePhotos));

  return {
    quotes: hydrated.map(toQuoteDTO),
    hasMore: page.hasMore,
    nextCursor: page.nextCursor,
  };
}

/** Loads a quote and checks it belongs to this customer. */
async function loadOwnedQuote(userId, quoteId, traceContext = null) {
  const quote = await bulkRepo.getQuote(quoteId, traceContext);
  // Someone else's quote is reported as missing rather than forbidden, so the
  // endpoint cannot be used to probe which quote ids exist.
  if (!quote || quote.userId !== userId) {
    throw new NotFoundError('Quote not found', 'NOT_FOUND');
  }
  return quote;
}

async function getQuote(userId, quoteId, traceContext = null) {
  const quote = await loadOwnedQuote(userId, quoteId, traceContext);
  return toQuoteDTO(await hydratePhotos(quote));
}

// ---- customer actions on a quote ----

async function requestEdit(userId, quoteId, message, traceContext = null) {
  const text = String(message || '').trim();
  if (!text) throw new ValidationError('Tell us what needs changing', 'VALIDATION_ERROR');

  const quote = await loadOwnedQuote(userId, quoteId, traceContext);
  if (!['quoted', 'edit_requested'].includes(quote.status)) {
    throw new ConflictError(`This quote can no longer be changed (${quote.status})`, 'INVALID_STATUS');
  }

  const updated = await bulkRepo.updateQuote(quoteId, {
    status: 'edit_requested',
    editRequest: { message: text, at: new Date().toISOString() },
    updatedAt: new Date().toISOString(),
  }, traceContext);
  return toQuoteDTO(await hydratePhotos(updated));
}

async function declineQuote(userId, quoteId, reason, traceContext = null) {
  const quote = await loadOwnedQuote(userId, quoteId, traceContext);
  if (['ordered', 'declined'].includes(quote.status)) {
    throw new ConflictError(`This quote is already ${quote.status}`, 'INVALID_STATUS');
  }

  const updated = await bulkRepo.updateQuote(quoteId, {
    status: 'declined',
    declineReason: String(reason || '').trim() || null,
    declinedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }, traceContext);
  return toQuoteDTO(await hydratePhotos(updated));
}

// ---- ops: pricing a quote ----

/**
 * Publishes a priced quote: requested/edit_requested → quoted.
 *
 * GST is computed per line from the Zoho tax band rather than typed, so a mixed
 * quote (cement at 28%, steel at 18%) is right without anyone doing sums.
 * Delivery is whatever ops enters — bulk freight is truck-loads to out-of-zone
 * sites, which the instant per-km rate card does not describe.
 */
async function publishQuote(quoteId, { items, deliveryCharge, validityDays, deliveryDate, teamNote }, traceContext = null) {
  const quote = await bulkRepo.getQuote(quoteId, traceContext);
  if (!quote) throw new NotFoundError('Quote not found', 'NOT_FOUND');
  if (quote.status === 'ordered') {
    throw new ConflictError('This quote has already been ordered', 'INVALID_STATUS');
  }

  const rows = Array.isArray(items) ? items : [];
  if (!rows.length) throw new ValidationError('Add at least one line item', 'VALIDATION_ERROR');

  const lineItems = rows.map((r, idx) => {
    const quantity = Number(r.quantity);
    const unitPrice = Number(r.unitPrice);
    if (!Number.isFinite(quantity) || quantity <= 0) {
      throw new ValidationError(`Line ${idx + 1}: enter a quantity`, 'VALIDATION_ERROR');
    }
    if (!Number.isFinite(unitPrice) || unitPrice < 0) {
      throw new ValidationError(`Line ${idx + 1}: enter a price`, 'VALIDATION_ERROR');
    }
    const name = String(r.name || '').trim();
    if (!name) throw new ValidationError(`Line ${idx + 1}: enter a description`, 'VALIDATION_ERROR');

    return {
      productId: r.productId || null,
      zohoItemId: r.zohoItemId || r.productId || null,
      categoryId: r.categoryId || null,
      name,
      packLabel: String(r.packLabel || '').trim(),
      quantity,
      unit: String(r.unit || '').trim() || 'unit',
      unitPrice: Math.round(unitPrice * 100) / 100,
      gstRate: Number(r.gstRate ?? 0),
    };
  });

  const round2 = n => Math.round(n * 100) / 100;
  const subtotal = round2(lineItems.reduce((s, i) => s + i.unitPrice * i.quantity, 0));
  const gstAmount = round2(lineItems.reduce((s, i) => s + (i.unitPrice * i.quantity * (i.gstRate || 0)) / 100, 0));
  const freight = Math.max(0, Number(deliveryCharge) || 0);
  const grandTotal = round2(subtotal + gstAmount + freight);

  const days = Number.isFinite(Number(validityDays)) && Number(validityDays) > 0
    ? Number(validityDays)
    : BULK_QUOTE_VALIDITY_DAYS;
  const validUntil = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();

  const updated = await bulkRepo.updateQuote(quoteId, {
    status: 'quoted',
    items: lineItems,
    subtotal,
    gstAmount,
    deliveryCharge: round2(freight),
    grandTotal,
    validUntil,
    deliveryDate: deliveryDate || null,
    teamNote: String(teamNote || '').trim() || null,
    quotedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }, traceContext);

  return updated;
}

// ---- approve & pay ----

/**
 * Approving mints a payment session and nothing else.
 *
 * No order is written here. The order is created atomically when payment
 * confirms — by /payments/verify or the webhook, through the same
 * confirmOnlinePayment transaction that backs instant checkout. So a customer
 * who abandons the gateway leaves nothing to clean up: the quote stays
 * `quoted` and can be approved again, and a double-tap cannot mint two orders.
 *
 * The session is written in the cartData shape _orderFromSession already
 * understands, which is why that shared transaction needed almost no change.
 */
async function approveQuote(userId, quoteId, { customerName, customerPhone, customerEmail } = {}, traceContext = null) {
  const quote = await loadOwnedQuote(userId, quoteId, traceContext);

  if (quote.status === 'ordered') {
    throw new ConflictError('This quote has already been ordered', 'ALREADY_ORDERED');
  }
  if (quote.status !== 'quoted') {
    throw new ConflictError(`This quote cannot be approved (${quote.status})`, 'INVALID_STATUS');
  }
  // Checked here as well as by the expiry job: the job runs on a schedule, so a
  // quote can lapse between firings and must not be approvable in that window.
  if (quote.validUntil && new Date(quote.validUntil).getTime() <= Date.now()) {
    throw new ConflictError(
      'This quote has expired. Ask us for an updated quote.',
      'QUOTE_EXPIRED'
    );
  }
  if (!quote.grandTotal || quote.grandTotal <= 0) {
    throw new ValidationError('This quote has no amount to pay', 'VALIDATION_ERROR');
  }

  const { getGateway } = require('./payments');
  const { saveCheckoutSession } = require('../repositories/checkoutSessionRepository');
  const env = require('../config/env');

  const gateway = getGateway();
  // Distinct prefix so a bulk session is recognisable in logs and at the
  // gateway; /payments/verify treats it as an opaque id either way.
  const sessionId = 'BULKPAY-' + Date.now().toString(36).toUpperCase()
    + crypto.randomBytes(2).toString('hex').toUpperCase();

  const returnUrl = `${env.PAYMENT_RETURN_URL_BASE}/api/v1/payments/return?orderId=${encodeURIComponent(sessionId)}`;
  const notifyUrl = `${env.PAYMENT_RETURN_URL_BASE}/api/v1/payments/webhook/${gateway.name}`;

  const session = await gateway.createCheckout({
    orderId: sessionId,
    amountInPaise: Math.round(Number(quote.grandTotal) * 100),
    currency: 'INR',
    customer: { customerId: userId, customerPhone: customerPhone || '', customerName: customerName || '', customerEmail: customerEmail || '' },
    returnUrl,
    notifyUrl,
    attemptCount: 0,
  });

  await saveCheckoutSession({
    orderId: sessionId,
    userId,
    quoteId: quote.id,
    addressId: quote.addressId || null,
    // Shaped exactly like an instant checkout's cartData so the order can be
    // materialised by the existing transaction.
    cartData: {
      lineItems: quote.items || [],
      subtotal: quote.subtotal ?? 0,
      gst_total: quote.gstAmount ?? 0,
      deliveryCharge: quote.deliveryCharge ?? 0,
      grand_total: quote.grandTotal ?? 0,
      freeDeliveryApplied: false,
    },
    customerName: customerName || '',
    customerPhone: customerPhone || '',
    gateway: gateway.name,
    providerOrderId: session.providerOrderId,
    createdAt: new Date().toISOString(),
  }, traceContext);

  return {
    orderId: sessionId,
    gateway: gateway.name,
    paymentUrl: session.paymentUrl,
    providerOrderId: session.providerOrderId,
    ...(session.client || {}),
    notes: { quoteId: quote.id },
  };
}

// ---- expiry ----

/** Flips lapsed quotes to `expired`. An expired quote cannot be approved. */
async function expireLapsedQuotes(traceContext = null) {
  const nowISO = new Date().toISOString();
  const due = await bulkRepo.listExpirableQuotes(nowISO, traceContext);
  for (const q of due) {
    await bulkRepo.updateQuote(q.id, {
      status: 'expired',
      expiredAt: nowISO,
      updatedAt: nowISO,
    }, traceContext);
  }
  return { expired: due.length, quoteIds: due.map(q => q.id) };
}

// The wire shape the client maps. `path`, `gstRate` and `zohoItemId` are
// internal and never sent.
function toQuoteDTO(q) {
  return {
    id: q.id,
    status: q.status,
    source: q.source,
    createdAt: q.createdAt,
    items: (q.items || []).map(i => ({
      name: i.name,
      packLabel: i.packLabel,
      quantity: i.quantity,
      unit: i.unit,
      unitPrice: i.unitPrice,
    })),
    subtotal: q.subtotal ?? 0,
    deliveryCharge: q.deliveryCharge ?? 0,
    gstAmount: q.gstAmount ?? 0,
    grandTotal: q.grandTotal ?? 0,
    note: q.note ?? null,
    photos: (q.photos || []).map(p => ({ id: p.id, url: p.url })),
    deliveryAddress: q.deliveryAddress ?? null,
    deliveryPincode: q.deliveryPincode ?? null,
    validUntil: q.validUntil ?? null,
    deliveryDate: q.deliveryDate ?? null,
    teamNote: q.teamNote ?? null,
    orderId: q.orderId ?? null,
  };
}

module.exports = {
  categorySlug,
  getAvailability,
  getBulkProducts,
  listCategories,
  listCategoryProducts,
  createPhotoSlot,
  createQuoteRequest,
  listQuotes,
  getQuote,
  loadOwnedQuote,
  requestEdit,
  declineQuote,
  approveQuote,
  publishQuote,
  expireLapsedQuotes,
  hydratePhotos,
  toQuoteDTO,
};
