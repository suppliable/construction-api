'use strict';

const axios = require('axios');
const admin = require('../utils/firebaseAdmin');
const { getTrackedDb } = require('../middleware/firestoreTracker');
const { dbOp } = require('../utils/dbOp');
const { getCustomerByPhone, saveCustomer, getCustomer } = require('../repositories/customerRepository');
const { getAddresses, addAddress, getAddressById } = require('../repositories/addressRepository');
const { saveOrder } = require('../repositories/orderRepository');
const { getSettings } = require('../repositories/configRepository');
const { getProductById } = require('./productService');
const { getPaintPricing, VALID_SIZES } = require('../repositories/paintRepository');
const { calculateDelivery } = require('./deliveryService');
const { geocodeAddress, reverseGeocode } = require('./googleMapsService');
const { zohoPost } = require('./zohoHttp');
const { createZohoContact, searchZohoContactByPhone, updateZohoContact, getAccessToken, getZohoProductById } = require('./zohoService');
const { uploadToPath } = require('./storageService');
const { updateCustomerGST } = require('./customerService');

const db = getTrackedDb();

// ---- Customer search ----

async function searchCustomers(q, traceContext = null) {
  const normalized = (q || '').trim();
  if (normalized.length < 2) return [];

  const seen = new Set();
  const results = [];

  // Exact phone match first
  const digitsOnly = normalized.replace(/\D/g, '');
  if (digitsOnly.length >= 6) {
    const byPhone = await getCustomerByPhone(digitsOnly, traceContext).catch(() => null);
    if (byPhone?.userId) {
      seen.add(byPhone.userId);
      results.push(byPhone);
    }
  }

  // Bulk fetch + in-memory filter for name/partial-phone contains.
  // No orderBy('name'): it dropped docs missing a `name` field and, combined
  // with the limit, alphabetically truncated the candidate set so names later in
  // the alphabet were silently unsearchable.
  const snap = await dbOp('pos.searchCustomers', () =>
    db.collection('customers').limit(2000).get(),
    traceContext
  );

  const lowerQ = normalized.toLowerCase();
  // Token match so word order/casing don't matter ("kumar raj" → "Raj Kumar").
  const tokens = lowerQ.split(/\s+/).filter(Boolean);
  snap.docs.forEach(doc => {
    const c = doc.data();
    if (!c.userId || seen.has(c.userId)) return;
    const nameLower = (c.name || '').toLowerCase();
    const phoneDigits = (c.phone || '').replace(/\D/g, '');
    const nameMatch = tokens.length > 0 && tokens.every(t => nameLower.includes(t));
    // Guard the phone-contains: an empty digitsOnly (pure name query) would make
    // includes('') true for every customer, returning wrong results.
    const phoneMatch = digitsOnly.length >= 3 && phoneDigits.includes(digitsOnly);
    if (nameMatch || phoneMatch) {
      seen.add(c.userId);
      results.push(c);
    }
  });

  // Fetch addresses for each matched customer
  const limited = results.slice(0, 10);
  const withAddresses = await Promise.all(limited.map(async c => {
    const addresses = await getAddresses(c.userId, traceContext).catch(() => []);
    return {
      userId: c.userId,
      name: c.name || '',
      phone: c.phone || '',
      email: c.email || null,
      gstin: c.gstin || null,
      businessName: c.business_name || null,
      registeredAddress: c.registered_address || null,
      addresses,
    };
  }));

  return withAddresses;
}

// ---- Customer creation ----

async function createCustomer({ name, phone, email }, traceContext = null) {
  if (!name || !name.trim()) throw Object.assign(new Error('name is required'), { code: 'MISSING_PARAM' });
  if (!phone || !phone.trim()) throw Object.assign(new Error('phone is required'), { code: 'MISSING_PARAM' });

  const digits = phone.trim().replace(/\D/g, '');
  const normalizedPhone = digits.length === 10 && /^[6-9]/.test(digits) ? '+91' + digits
    : digits.length === 12 && digits.startsWith('91') && /^[6-9]/.test(digits[2]) ? '+91' + digits.slice(2)
    : digits;
  const existing = await getCustomerByPhone(normalizedPhone, traceContext).catch(() => null);
  if (existing) throw Object.assign(new Error('A customer with this phone number already exists'), { code: 'DUPLICATE_PHONE' });

  const userId = 'USR' + Date.now();
  const customer = {
    userId,
    name: name.trim(),
    phone: normalizedPhone,
    email: email ? email.trim() : null,
    createdAt: new Date().toISOString(),
    createdBy: 'pos',
  };

  await saveCustomer(customer, traceContext);

  // Create Zoho contact immediately so the customer is visible in Zoho Books
  try {
    const zohoContact = await createZohoContact({
      name: customer.name,
      phone: customer.phone,
    }, traceContext);
    if (zohoContact?.contact_id) {
      customer.zoho_contact_id = zohoContact.contact_id;
      await saveCustomer(customer, traceContext);
    }
  } catch (zohoErr) {
    // non-fatal — customer is saved in Firestore; Zoho contact will be created on first order
  }

  return customer;
}

// ---- Address ----

async function getCustomerAddresses(userId, traceContext = null) {
  return getAddresses(userId, traceContext);
}

async function addCustomerAddress(userId, { fullAddress, lat, lng, label, address_components }, traceContext = null) {
  if (!fullAddress || !fullAddress.trim()) throw Object.assign(new Error('fullAddress is required'), { code: 'MISSING_PARAM' });

  let latitude = lat ? parseFloat(lat) : null;
  let longitude = lng ? parseFloat(lng) : null;
  let pincode = null;

  // Geocode if coordinates not provided
  if ((!latitude || !longitude) && process.env.GOOGLE_MAPS_API_KEY) {
    const coords = await geocodeAddress(fullAddress.trim(), traceContext);
    latitude = coords.latitude;
    longitude = coords.longitude;
  }

  // 1. Most reliable: postal_code component from Google Places address_components
  if (address_components && Array.isArray(address_components)) {
    const postalComp = address_components.find(c => c.types && c.types.includes('postal_code'));
    if (postalComp?.long_name) pincode = postalComp.long_name;
  }

  // 2. Fallback: regex on the address string
  if (!pincode) {
    const pincodeMatch = fullAddress.match(/\b(\d{6})\b/);
    if (pincodeMatch) pincode = pincodeMatch[1];
  }

  // 3. Fallback: reverse geocode using coordinates
  if (!pincode && latitude && longitude && process.env.GOOGLE_MAPS_API_KEY) {
    const geo = await reverseGeocode(latitude, longitude, traceContext).catch(() => null);
    if (geo?.postalCode) pincode = geo.postalCode;
  }

  if (!pincode) {
    console.warn('addCustomerAddress: pincode could not be resolved for address:', fullAddress);
  }

  return addAddress(userId, {
    streetAddress: fullAddress.trim(),
    latitude,
    longitude,
    pincode: pincode || null,
    label: label ? label.trim() : 'POS Address',
    source: 'pos',
  }, traceContext);
}

// ---- Draft line item calculation ----

// ---- POS live stock (session-cached on the client) ----
// Fetches authoritative stock + cost straight from Zoho Inventory for a set of
// item ids. Used by the POS grid so operators see live stock while searching,
// and so the cart can soft-warn when an overridden price falls below cost.
// Per-id failures resolve to null so the client can fall back to the cached
// catalogue figure rather than the whole request failing.
async function getLiveStock(ids, traceContext = null) {
  const uniqueIds = [...new Set((ids || []).filter(Boolean).map(String))];
  const result = {};
  const CONCURRENCY = 5;
  for (let i = 0; i < uniqueIds.length; i += CONCURRENCY) {
    const batch = uniqueIds.slice(i, i + CONCURRENCY);
    const settled = await Promise.allSettled(
      batch.map(id => getZohoProductById(id, traceContext))
    );
    settled.forEach((r, idx) => {
      const id = batch[idx];
      if (r.status === 'fulfilled' && r.value) {
        const item = r.value;
        const stock = item.available_stock ?? item.actual_available_stock ?? null;
        result[id] = {
          available_stock: stock === null || stock === undefined ? null : Number(stock),
          purchase_rate: item.purchase_rate != null ? Number(item.purchase_rate) : null,
        };
      } else {
        result[id] = null;
      }
    });
  }
  return result;
}

async function buildDraftLineItems(items, traceContext = null) {
  const lineItems = [];

  for (const item of (items || [])) {
    if (!item.productId) throw Object.assign(new Error('Each item requires productId'), { code: 'MISSING_PARAM' });
    if (!item.quantity || item.quantity <= 0) throw Object.assign(new Error(`Invalid quantity for productId ${item.productId}`), { code: 'INVALID_PARAM' });

    const product = await getProductById(item.productId, traceContext);
    if (!product) throw Object.assign(new Error(`Product not found: ${item.productId}`), { code: 'PRODUCT_NOT_FOUND' });

    // Resolve variant
    let zohoItemId = item.productId;
    let resolvedVariantId = item.variantId || null;
    let unitPrice = product.price || 0;
    let resolvedVariant = null;

    if (item.variantId && product.variants) {
      resolvedVariant = product.variants.find(v => v.name === item.variantId || v.id === item.variantId);
      if (resolvedVariant) {
        zohoItemId = resolvedVariant.id;
        resolvedVariantId = resolvedVariant.name;
        unitPrice = resolvedVariant.price ?? unitPrice;
      }
    }

    // Stock check — variant-level first, then product-level
    const availableStock = resolvedVariant?.available_stock ?? product.available_stock ?? null;
    if (availableStock !== null) {
      const label = `${product.name}${resolvedVariantId ? ` (${resolvedVariantId})` : ''}`;
      if (availableStock <= 0) {
        throw Object.assign(new Error(`${label} is out of stock`), { code: 'OUT_OF_STOCK' });
      }
      if (item.quantity > availableStock) {
        throw Object.assign(new Error(`Only ${availableStock} units available for ${label}`), { code: 'INSUFFICIENT_STOCK' });
      }
    }

    // Shade pricing — look up tier-adjusted price if shade is tinted
    if (item.shadeCode && item.shadeTier && product.shadeBrand) {
      const pricing = await getPaintPricing(item.productId, traceContext).catch(() => null);
      if (pricing?.tiers?.[item.shadeTier]) {
        const sizeKey = VALID_SIZES.includes(resolvedVariantId) ? resolvedVariantId
          : VALID_SIZES.includes(product.unit) ? product.unit : null;
        if (sizeKey !== null && pricing.tiers[item.shadeTier][sizeKey] !== undefined) {
          unitPrice = pricing.tiers[item.shadeTier][sizeKey];
        }
      }
    }

    // Manual selling-price override (POS only) — temporary for this draft alone.
    // Applied AFTER variant/shade pricing so it wins. The override is treated as
    // the GST-inclusive selling price, matching how unitPrice is used everywhere
    // downstream (GST split, totals, quotation rate, sales-order rate). It never
    // writes back to Zoho's master price and a fresh draft re-derives from list.
    let priceOverridden = false;
    let originalUnitPrice = null;
    if (item.priceOverride !== undefined && item.priceOverride !== null && item.priceOverride !== '') {
      const override = Number(item.priceOverride);
      if (!Number.isFinite(override) || override <= 0) {
        throw Object.assign(new Error('Invalid price override'), { code: 'INVALID_PARAM' });
      }
      if (override !== unitPrice) {
        originalUnitPrice = unitPrice;
        unitPrice = Math.round(override * 100) / 100;
        priceOverridden = true;
      }
    }

    const gstRate = product.gst_percentage || 18;
    const qty = item.quantity;
    const divisor = 1 + (gstRate / 100);
    const basePrice = Math.round((unitPrice / divisor) * 100) / 100;
    const totalWithoutGST = Math.round(basePrice * qty * 100) / 100;
    const gstAmount = Math.round((unitPrice * qty - totalWithoutGST) * 100) / 100;
    const grandTotal = Math.round(unitPrice * qty * 100) / 100;

    const variantRack = zohoItemId && product.variants
      ? product.variants.find(v => v.id === zohoItemId)?.rackNumber
      : null;
    const rackNumber = variantRack || product.rackNumber || null;

    const lineItem = {
      productId: item.productId,
      zohoItemId,
      variantId: resolvedVariantId,
      name: product.name,
      unit: product.unit || '',
      quantity: qty,
      unitPrice,
      basePrice,
      totalWithoutGST,
      gstRate,
      gstAmount,
      grandTotal,
      rackNumber: rackNumber || null,
    };

    if (item.shadeCode) lineItem.shadeCode = item.shadeCode;
    if (item.shadeTier) lineItem.shadeTier = item.shadeTier;
    if (priceOverridden) {
      lineItem.priceOverridden = true;
      lineItem.originalUnitPrice = originalUnitPrice;
    }

    lineItems.push(lineItem);
  }

  return lineItems;
}

async function calcTotalsAndDelivery(lineItems, addressId, traceContext = null, deliveryChargeOverride = null) {
  const subtotal = Math.round(lineItems.reduce((s, i) => s + i.totalWithoutGST, 0) * 100) / 100;
  const gstTotal = Math.round(lineItems.reduce((s, i) => s + i.gstAmount, 0) * 100) / 100;

  // Auto-calculated charge — always computed via our delivery logic first.
  let autoDeliveryCharge = 0;
  let deliveryResult = null;

  if (addressId) {
    const address = await getAddressById(addressId, traceContext).catch(() => null);
    if (address?.pincode) {
      deliveryResult = await calculateDelivery(
        address.pincode,
        parseFloat(address.latitude || 0),
        parseFloat(address.longitude || 0),
        subtotal + gstTotal,
        address.streetAddress || '',
        traceContext
      ).catch(() => null);
      if (deliveryResult?.serviceable) {
        autoDeliveryCharge = deliveryResult.delivery_charge || 0;
      }
    } else {
      console.warn('Delivery skipped — no pincode for address:', addressId);
    }
  }

  // Manual per-order override (POS only). The auto-calc above is untouched and
  // preserved as autoDeliveryCharge; the override only changes the effective
  // charge and grand total. Serviceability (deliveryResult) is unaffected.
  let deliveryCharge = autoDeliveryCharge;
  let deliveryOverridden = false;
  if (deliveryChargeOverride !== null && deliveryChargeOverride !== undefined && deliveryChargeOverride !== '') {
    const override = Number(deliveryChargeOverride);
    if (Number.isFinite(override) && override >= 0) {
      deliveryCharge = Math.round(override * 100) / 100;
      deliveryOverridden = deliveryCharge !== autoDeliveryCharge;
    }
  }

  const grandTotal = Math.round((subtotal + gstTotal + deliveryCharge) * 100) / 100;
  return { subtotal, gstTotal, deliveryCharge, autoDeliveryCharge, deliveryOverridden, grandTotal, deliveryResult };
}

// ---- Draft CRUD ----

async function savePOSDraft({ customerId, addressId, items, gstNumber, gstName, gstAddress, deliveryChargeOverride = null }, traceContext = null) {
  const lineItems = await buildDraftLineItems(items, traceContext);
  const totals = await calcTotalsAndDelivery(lineItems, addressId, traceContext, deliveryChargeOverride);

  const now = new Date();
  const expiresAt = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString();
  const draftId = 'DRAFT' + Date.now();

  const draft = {
    draftId,
    customerId: customerId || null,
    addressId: addressId || null,
    gstNumber: gstNumber || null,
    gstName: gstName || null,
    gstAddress: gstAddress || null,
    items: lineItems,
    ...totals,
    status: 'draft',
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    expiresAt,
  };

  await dbOp('pos.saveDraft', () =>
    db.collection('posDrafts').doc(draftId).set(draft),
    traceContext
  );

  return draft;
}

async function getPOSDraft(draftId, traceContext = null) {
  return dbOp('pos.getDraft', async () => {
    const doc = await db.collection('posDrafts').doc(draftId).get();
    if (!doc.exists) return null;
    return doc.data();
  }, traceContext);
}

async function updatePOSDraft(draftId, { customerId, addressId, items, gstNumber, gstName, gstAddress, deliveryChargeOverride }, traceContext = null) {
  const existing = await getPOSDraft(draftId, traceContext);
  if (!existing) return null;

  const lineItems = await buildDraftLineItems(items, traceContext);
  const resolvedAddressId = addressId !== undefined ? addressId : existing.addressId;
  // Preserve an existing override when the client doesn't send the field.
  const resolvedOverride = deliveryChargeOverride !== undefined
    ? deliveryChargeOverride
    : (existing.deliveryOverridden ? existing.deliveryCharge : null);
  const totals = await calcTotalsAndDelivery(lineItems, resolvedAddressId, traceContext, resolvedOverride);

  const now = new Date();
  const expiresAt = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString();

  const updates = {
    customerId: customerId !== undefined ? (customerId || null) : existing.customerId,
    addressId: resolvedAddressId || null,
    gstNumber: gstNumber !== undefined ? (gstNumber || null) : existing.gstNumber,
    gstName: gstName !== undefined ? (gstName || null) : existing.gstName,
    gstAddress: gstAddress !== undefined ? (gstAddress || null) : existing.gstAddress,
    items: lineItems,
    ...totals,
    updatedAt: now.toISOString(),
    expiresAt,
  };

  await dbOp('pos.updateDraft', () =>
    db.collection('posDrafts').doc(draftId).update(updates),
    traceContext
  );

  return { ...existing, ...updates };
}

// ---- Phase 3: Zoho Books quotation ----

async function createPOSQuotation(draftId, traceContext = null) {
  const draft = await getPOSDraft(draftId, traceContext);
  if (!draft) throw Object.assign(new Error('Draft not found'), { code: 'DRAFT_NOT_FOUND' });

  // Find or create Zoho Books contact for this customer
  const customer = draft.customerId
    ? await getCustomer(draft.customerId, traceContext).catch(() => null)
    : null;

  let zohoContactId;
  if (customer?.phone) {
    if (customer.zoho_contact_id) {
      // Use the already-linked Zoho contact — avoid fuzzy search returning a wrong contact
      zohoContactId = customer.zoho_contact_id;
    } else {
      const existing = await searchZohoContactByPhone(customer.phone, traceContext).catch(() => null);
      if (existing?.contact_id) {
        zohoContactId = existing.contact_id;
      } else {
        const created = await createZohoContact({
          name: customer.name || customer.phone,
          phone: customer.phone,
        }, traceContext);
        zohoContactId = created.contact_id;
      }
    }
  } else {
    const walkin = await createZohoContact({ name: 'Walk-in Customer', phone: '0000000000' }, traceContext);
    zohoContactId = walkin.contact_id;
  }

  // Sync GST details using the same flow as the app's customer GST update —
  // this handles contact_name rename and CONTACT_NAME_CONFLICT redirect transparently
  if ((draft.gstName || draft.gstNumber) && draft.customerId) {
    try {
      const updatedCustomer = await updateCustomerGST(draft.customerId, {
        gstin: draft.gstNumber || null,
        business_name: draft.gstName || null,
        registered_address: draft.gstAddress || null,
      }, traceContext);
      // Use the (possibly redirected) zoho_contact_id
      if (updatedCustomer?.zoho_contact_id) zohoContactId = updatedCustomer.zoho_contact_id;
    } catch (err) {
      // non-fatal — estimate will still be created
    }
  }

  // Build estimate line items — same base-rate extraction as createZohoSalesOrder
  const zohoLineItems = (draft.items || []).map(item => {
    const gstRate = item.gstRate || 18;
    const baseRate = Math.round((item.unitPrice / (1 + gstRate / 100)) * 100) / 100;
    return {
      item_id: item.zohoItemId || item.productId,
      name: [item.name, item.variantId || null, item.shadeCode ? `(${item.shadeCode})` : null]
        .filter(Boolean).join(' '),
      quantity: item.quantity,
      rate: baseRate,
      unit: item.unit || '',
    };
  });

  const body = {
    customer_id: zohoContactId,
    date: new Date().toISOString().split('T')[0],
    line_items: zohoLineItems,
    shipping_charge: draft.deliveryCharge || 0,
    notes: `POS Quotation — Suppliable${customer?.phone ? ` | Phone: ${customer.phone}` : ''}`,
  };
  if (draft.gstNumber) {
    body.gst_no = draft.gstNumber;
    body.gst_treatment = 'business_gst';
  }
  if (draft.gstName || draft.gstAddress) {
    const a = draft.gstAddress || {};
    const trunc = (s, n = 100) => (s || '').substring(0, n);
    body.billing_address = {
      attention: trunc(draft.gstName || customer?.name || ''),
      address: trunc(a.address_line1),
      street2: trunc(a.address_line2),
      city: trunc(a.city),
      state: trunc(a.state),
      zip: a.pincode || '',
      country: 'India',
    };
  }

  let response;
  try {
    response = await zohoPost(
      `${process.env.ZOHO_API_DOMAIN}/books/v3/estimates`,
      body
    );
  } catch (err) {
    const zohoError = err.response?.data;
    const detail = zohoError ? JSON.stringify(zohoError) : err.message;
    throw Object.assign(
      new Error(`Zoho estimate creation failed: ${detail}`),
      { code: 'ZOHO_ESTIMATE_FAILED', zohoError }
    );
  }

  const estimate = response.data.estimate;
  if (!estimate?.estimate_id) {
    throw new Error(`Zoho estimate creation failed: ${JSON.stringify(response.data)}`);
  }

  const zohoQuotationId = estimate.estimate_id;
  const zohoQuotationNumber = estimate.estimate_number;
  const zohoQuotationUrl = `https://books.zoho.in/app/${process.env.ZOHO_ORG_ID}#/estimates/${zohoQuotationId}`;

  await dbOp('pos.quoteDraft', () =>
    db.collection('posDrafts').doc(draftId).update({
      zohoQuotationId,
      zohoQuotationNumber,
      zohoQuotationUrl,
      status: 'quoted',
      quotedAt: new Date().toISOString(),
    }),
    traceContext
  );

  return { zohoQuotationId, zohoQuotationNumber, zohoQuotationUrl };
}

// ---- Phase 4: Convert draft to order ----

async function convertPOSDraftToOrder(draftId, { paymentMethod } = {}, traceContext = null) {
  const draft = await getPOSDraft(draftId, traceContext);
  if (!draft) throw Object.assign(new Error('Draft not found'), { code: 'DRAFT_NOT_FOUND' });
  if (draft.status !== 'quoted') {
    throw Object.assign(
      new Error('Draft must have status "quoted" before converting to an order'),
      { code: 'INVALID_STATUS' }
    );
  }

  // Warehouse open check — same guard used in createOrder
  const settings = await getSettings(traceContext);
  if (settings.warehouseOpen === false) {
    throw Object.assign(
      new Error(settings.warehouseClosedMessage || 'We are currently closed.'),
      { code: 'WAREHOUSE_CLOSED' }
    );
  }

  const customer = draft.customerId
    ? await getCustomer(draft.customerId, traceContext).catch(() => null)
    : null;

  const orderId = 'ORD' + Date.now();
  const order = {
    orderId,
    userId: draft.customerId || null,
    addressId: draft.addressId || null,
    items: draft.items,
    subtotal: draft.subtotal,
    gst_total: draft.gstTotal,
    delivery_charge: draft.deliveryCharge,
    grand_total: draft.grandTotal,
    paymentType: 'COD',
    paymentStatus: 'confirmed',
    status: 'warehouse_review',
    customerName: customer?.name || '',
    customerPhone: customer?.phone || '',
    freeDeliveryApplied: false,
    orderSource: 'pos',
    posDraftId: draftId,
    ...(draft.gstNumber ? { gstNumber: draft.gstNumber } : {}),
    ...(draft.gstName ? { gstName: draft.gstName } : {}),
    ...(draft.gstAddress ? { gstAddress: draft.gstAddress } : {}),
    ...(draft.zohoQuotationId ? { zohoQuotationId: draft.zohoQuotationId } : {}),
    ...(draft.zohoQuotationNumber ? { zohoQuotationNumber: draft.zohoQuotationNumber } : {}),
    createdAt: new Date().toISOString(),
  };

  await saveOrder(order, traceContext);

  await dbOp('pos.convertDraft', () =>
    db.collection('posDrafts').doc(draftId).update({
      status: 'converted',
      orderId,
      convertedAt: new Date().toISOString(),
    }),
    traceContext
  );

  return order;
}

async function discardPOSDraft(draftId, traceContext = null) {
  const draft = await getPOSDraft(draftId, traceContext);
  if (!draft) throw Object.assign(new Error('Draft not found'), { code: 'DRAFT_NOT_FOUND' });
  if (draft.status === 'converted') throw Object.assign(new Error('Cannot discard a converted draft'), { code: 'ALREADY_CONVERTED' });
  await dbOp('pos.discardDraft', () =>
    db.collection('posDrafts').doc(draftId).update({
      status: 'discarded',
      discardedAt: new Date().toISOString(),
    }),
    traceContext
  );
}

async function listPOSDrafts(traceContext = null) {
  const now = new Date().toISOString();
  const snap = await dbOp('pos.listDrafts', () =>
    db.collection('posDrafts')
      .where('expiresAt', '>', now)
      .orderBy('expiresAt')
      .limit(100)
      .get(),
    traceContext
  );

  const drafts = snap.docs
    .map(d => d.data())
    .filter(d => d.status !== 'converted' && d.status !== 'discarded');

  // Sort newest first (Firestore ordered by expiresAt, not createdAt)
  drafts.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));

  const enriched = await Promise.all(drafts.map(async draft => {
    const [customer, address] = await Promise.all([
      draft.customerId ? getCustomer(draft.customerId, traceContext).catch(() => null) : null,
      draft.addressId ? getAddressById(draft.addressId, traceContext).catch(() => null) : null,
    ]);

    return {
      draftId: draft.draftId,
      customerId: draft.customerId || null,
      customer: customer
        ? { userId: customer.userId, name: customer.name, phone: customer.phone, email: customer.email || null }
        : null,
      address: address
        ? {
            addressId: address.addressId || address.id,
            streetAddress: address.streetAddress || address.fullAddress,
            label: address.label,
            pincode: address.pincode,
            lat: address.lat || address.latitude || null,
            lng: address.lng || address.longitude || null,
          }
        : null,
      items: draft.items || [],
      subtotal: draft.subtotal || 0,
      gstTotal: draft.gstTotal || 0,
      deliveryCharge: draft.deliveryCharge || 0,
      grandTotal: draft.grandTotal || 0,
      gstNumber: draft.gstNumber || null,
      gstName: draft.gstName || null,
      gstAddress: draft.gstAddress || null,
      status: draft.status,
      createdAt: draft.createdAt,
      updatedAt: draft.updatedAt,
      expiresAt: draft.expiresAt,
      zohoQuotationId: draft.zohoQuotationId || null,
      zohoQuotationNumber: draft.zohoQuotationNumber || null,
      zohoQuotationUrl: draft.zohoQuotationUrl || null,
      quotationPdfUrl: draft.quotationPdfUrl || null,
    };
  }));

  return enriched;
}

async function getPOSQuotationPDF(draftId, traceContext = null) {
  const draft = await getPOSDraft(draftId, traceContext);
  if (!draft) throw Object.assign(new Error('Draft not found'), { code: 'DRAFT_NOT_FOUND' });
  if (!draft.zohoQuotationId) throw Object.assign(new Error('No quotation on this draft'), { code: 'NO_QUOTATION' });

  // Return cached URL if already generated
  if (draft.quotationPdfUrl) return { pdfUrl: draft.quotationPdfUrl };

  // 1. Download PDF from Zoho Books
  // zohoGet's buildConfig doesn't forward responseType, so we use axios directly
  const token = await getAccessToken();
  const pdfRes = await axios.get(
    `${process.env.ZOHO_API_DOMAIN}/books/v3/estimates/${draft.zohoQuotationId}`,
    {
      params: { organization_id: process.env.ZOHO_ORG_ID },
      headers: { Authorization: `Zoho-oauthtoken ${token}`, Accept: 'application/pdf' },
      responseType: 'arraybuffer',
      timeout: 30000,
    }
  );
  const contentType = pdfRes.headers['content-type'] || '';
  if (!contentType.includes('pdf')) {
    throw new Error(`Zoho returned unexpected content-type: ${contentType} — PDF not available yet`);
  }
  const pdfBuffer = Buffer.from(pdfRes.data);

  // 2. Upload to Firebase Storage via storageService (uses correct OAuth endpoint)
  const filePath = `pos-quotations/${draftId}.pdf`;
  const pdfUrl = await uploadToPath(pdfBuffer, 'application/pdf', filePath);

  // 3. Persist URL on draft
  await dbOp('pos.savePdfUrl', () =>
    db.collection('posDrafts').doc(draftId).update({ quotationPdfUrl: pdfUrl }),
    traceContext
  );

  return { pdfUrl };
}

module.exports = {
  searchCustomers,
  createCustomer,
  getCustomerAddresses,
  addCustomerAddress,
  savePOSDraft,
  getPOSDraft,
  updatePOSDraft,
  createPOSQuotation,
  convertPOSDraftToOrder,
  listPOSDrafts,
  discardPOSDraft,
  getPOSQuotationPDF,
  getLiveStock,
};
