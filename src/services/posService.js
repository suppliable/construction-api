'use strict';

const { getTrackedDb } = require('../middleware/firestoreTracker');
const { dbOp } = require('../utils/dbOp');
const { getCustomerByPhone, saveCustomer, getCustomer } = require('../repositories/customerRepository');
const { getAddresses, addAddress, getAddressById } = require('../repositories/addressRepository');
const { saveOrder } = require('../repositories/orderRepository');
const { getSettings } = require('../repositories/configRepository');
const { getProductById } = require('./productService');
const { calculateDelivery } = require('./deliveryService');
const { geocodeAddress, reverseGeocode } = require('./googleMapsService');
const { zohoPost } = require('./zohoHttp');
const { createZohoContact, searchZohoContactByPhone } = require('./zohoService');

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

  // Bulk fetch + in-memory filter for name/partial-phone contains
  const snap = await dbOp('pos.searchCustomers', () =>
    db.collection('customers').orderBy('name').limit(500).get(),
    traceContext
  );

  const lowerQ = normalized.toLowerCase();
  snap.docs.forEach(doc => {
    const c = doc.data();
    if (!c.userId || seen.has(c.userId)) return;
    if (
      c.name?.toLowerCase().includes(lowerQ) ||
      (c.phone || '').replace(/\D/g, '').includes(digitsOnly)
    ) {
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
      addresses,
    };
  }));

  return withAddresses;
}

// ---- Customer creation ----

async function createCustomer({ name, phone, email }, traceContext = null) {
  if (!name || !name.trim()) throw Object.assign(new Error('name is required'), { code: 'MISSING_PARAM' });
  if (!phone || !phone.trim()) throw Object.assign(new Error('phone is required'), { code: 'MISSING_PARAM' });

  const normalizedPhone = phone.trim().replace(/\D/g, '');
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
  return customer;
}

// ---- Address ----

async function getCustomerAddresses(userId, traceContext = null) {
  return getAddresses(userId, traceContext);
}

async function addCustomerAddress(userId, { fullAddress, lat, lng, label }, traceContext = null) {
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

  // Try to extract 6-digit Indian pincode from fullAddress
  const pincodeMatch = fullAddress.match(/\b(\d{6})\b/);
  if (pincodeMatch) {
    pincode = pincodeMatch[1];
  } else if (latitude && longitude && process.env.GOOGLE_MAPS_API_KEY) {
    // Fallback: reverse geocode to get pincode
    const geo = await reverseGeocode(latitude, longitude, traceContext).catch(() => null);
    if (geo?.postalCode) pincode = geo.postalCode;
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

    if (item.variantId && product.variants) {
      const variant = product.variants.find(v => v.name === item.variantId || v.id === item.variantId);
      if (variant) {
        zohoItemId = variant.id;
        resolvedVariantId = variant.name;
        unitPrice = variant.price ?? unitPrice;
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

    lineItems.push(lineItem);
  }

  return lineItems;
}

async function calcTotalsAndDelivery(lineItems, addressId, traceContext = null) {
  const subtotal = Math.round(lineItems.reduce((s, i) => s + i.totalWithoutGST, 0) * 100) / 100;
  const gstTotal = Math.round(lineItems.reduce((s, i) => s + i.gstAmount, 0) * 100) / 100;

  let deliveryCharge = 0;
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
        deliveryCharge = deliveryResult.delivery_charge || 0;
      }
    }
  }

  const grandTotal = Math.round((subtotal + gstTotal + deliveryCharge) * 100) / 100;
  return { subtotal, gstTotal, deliveryCharge, grandTotal, deliveryResult };
}

// ---- Draft CRUD ----

async function savePOSDraft({ customerId, addressId, items, gstNumber }, traceContext = null) {
  const lineItems = await buildDraftLineItems(items, traceContext);
  const totals = await calcTotalsAndDelivery(lineItems, addressId, traceContext);

  const now = new Date();
  const expiresAt = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString();
  const draftId = 'DRAFT' + Date.now();

  const draft = {
    draftId,
    customerId: customerId || null,
    addressId: addressId || null,
    gstNumber: gstNumber || null,
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

async function updatePOSDraft(draftId, { customerId, addressId, items, gstNumber }, traceContext = null) {
  const existing = await getPOSDraft(draftId, traceContext);
  if (!existing) return null;

  const lineItems = await buildDraftLineItems(items, traceContext);
  const resolvedAddressId = addressId !== undefined ? addressId : existing.addressId;
  const totals = await calcTotalsAndDelivery(lineItems, resolvedAddressId, traceContext);

  const now = new Date();
  const expiresAt = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString();

  const updates = {
    customerId: customerId !== undefined ? (customerId || null) : existing.customerId,
    addressId: resolvedAddressId || null,
    gstNumber: gstNumber !== undefined ? (gstNumber || null) : existing.gstNumber,
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
  } else {
    const walkin = await createZohoContact({ name: 'Walk-in Customer', phone: '0000000000' }, traceContext);
    zohoContactId = walkin.contact_id;
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
  if (draft.gstNumber) body.gst_no = draft.gstNumber;

  const response = await zohoPost(
    `${process.env.ZOHO_API_DOMAIN}/books/v3/estimates`,
    body
  );

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
};
