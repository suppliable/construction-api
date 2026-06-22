const axios = require('axios');
const logger = require('../utils/logger');
const { createSpan } = require('../utils/spanTracer');
const { withRetry, DEFAULT_TIMEOUT_MS } = require('../utils/httpClient');
const { zohoPost, zohoPut } = require('./zohoHttp');

let accessToken = null;
let tokenExpiry = null;

async function getAccessToken() {
  if (accessToken && tokenExpiry && Date.now() < tokenExpiry) {
    return accessToken;
  }
  const response = await axios.post('https://accounts.zoho.in/oauth/v2/token', null, {
    params: {
      grant_type: 'refresh_token',
      client_id: process.env.ZOHO_CLIENT_ID,
      client_secret: process.env.ZOHO_CLIENT_SECRET,
      refresh_token: process.env.ZOHO_REFRESH_TOKEN,
    },
    timeout: DEFAULT_TIMEOUT_MS,
  });
  accessToken = response.data.access_token;
  tokenExpiry = Date.now() + (55 * 60 * 1000);
  return accessToken;
}

async function getZohoProducts(traceContext = null) {
  const span = createSpan(traceContext, 'zoho.api.getProducts', { 'peer.service': 'zoho', endpoint: '/inventory/v1/items' });
  const token = await getAccessToken();
  const allItems = [];
  let page = 1;
  try {
    while (true) {
      const response = await withRetry('zoho.api.getProducts', () =>
        axios.get(`${process.env.ZOHO_API_DOMAIN}/inventory/v1/items`, {
          headers: { Authorization: `Zoho-oauthtoken ${token}` },
          params: { organization_id: process.env.ZOHO_ORG_ID, per_page: 200, page },
          timeout: DEFAULT_TIMEOUT_MS,
        })
      );
      const items = (response.data.items || []).filter(i => i.status !== 'inactive');
      allItems.push(...items);
      if (!response.data.page_context?.has_more_page) break;
      page++;
    }
    span.end({ success: true, item_count: allItems.length, pages: page });
    return allItems;
  } catch (error) {
    span.end({ success: false, error: error.message });
    throw error;
  }
}

async function getZohoCategories(traceContext = null) {
  const span = createSpan(traceContext, 'zoho.api.getCategories', { 'peer.service': 'zoho', endpoint: '/inventory/v1/categories' });
  try {
    const token = await getAccessToken();
    const response = await withRetry('zoho.api.getCategories', () =>
      axios.get(`${process.env.ZOHO_API_DOMAIN}/inventory/v1/categories`, {
        headers: { Authorization: `Zoho-oauthtoken ${token}` },
        params: { organization_id: process.env.ZOHO_ORG_ID },
        timeout: DEFAULT_TIMEOUT_MS,
      })
    );
    const categories = (response.data.categories || []).filter(c => c.category_id !== '-1');
    span.end({ success: true, category_count: categories.length });
    return categories;
  } catch (error) {
    span.end({ success: false, error: error.message });
    throw error;
  }
}

async function getZohoProductById(itemId, traceContext = null) {
  const span = createSpan(traceContext, 'zoho.api.getProductById', { 'peer.service': 'zoho', endpoint: '/inventory/v1/items/:id', itemId });
  try {
    const token = await getAccessToken();
    const response = await withRetry('zoho.api.getProductById', () =>
      axios.get(`${process.env.ZOHO_API_DOMAIN}/inventory/v1/items/${itemId}`, {
        headers: { Authorization: `Zoho-oauthtoken ${token}` },
        params: { organization_id: process.env.ZOHO_ORG_ID },
        timeout: DEFAULT_TIMEOUT_MS,
      })
    );
    span.end({ success: true, item_id: response.data.item?.item_id });
    return response.data.item;
  } catch (error) {
    span.end({ success: false, error: error.message });
    throw error;
  }
}

async function getZohoItemGroups(traceContext = null) {
  const span = createSpan(traceContext, 'zoho.api.getItemGroups', { 'peer.service': 'zoho', endpoint: '/inventory/v1/itemgroups' });
  const token = await getAccessToken();
  const allGroups = [];
  let page = 1;
  try {
    while (true) {
      const response = await withRetry('zoho.api.getItemGroups', () =>
        axios.get(`${process.env.ZOHO_API_DOMAIN}/inventory/v1/itemgroups`, {
          headers: { Authorization: `Zoho-oauthtoken ${token}` },
          params: { organization_id: process.env.ZOHO_ORG_ID, per_page: 200, page },
          timeout: DEFAULT_TIMEOUT_MS,
        })
      );
      const groups = (response.data.itemgroups || []).filter(g => g.status !== 'inactive');
      allGroups.push(...groups);
      if (!response.data.page_context?.has_more_page) break;
      page++;
    }
    span.end({ success: true, group_count: allGroups.length, pages: page });
    return allGroups;
  } catch (error) {
    span.end({ success: false, error: error.message });
    throw error;
  }
}

async function getZohoItemGroupById(groupId, traceContext = null) {
  const span = createSpan(traceContext, 'zoho.api.getItemGroupById', { 'peer.service': 'zoho', endpoint: '/inventory/v1/itemgroups/:id', groupId });
  try {
    const token = await getAccessToken();
    const response = await withRetry('zoho.api.getItemGroupById', () =>
      axios.get(`${process.env.ZOHO_API_DOMAIN}/inventory/v1/itemgroups/${groupId}`, {
        headers: { Authorization: `Zoho-oauthtoken ${token}` },
        params: { organization_id: process.env.ZOHO_ORG_ID },
        timeout: DEFAULT_TIMEOUT_MS,
      })
    );
    span.end({ success: true, group_id: response.data.item_group?.group_id });
    return response.data.item_group;
  } catch (error) {
    span.end({ success: false, error: error.message });
    throw error;
  }
}

async function createZohoContact(contactData, traceContext = null) {
  const span = createSpan(traceContext, 'zoho.api.createContact', { 'peer.service': 'zoho', phone: contactData.phone, endpoint: '/books/v3/contacts' });
  const contactBody = {
    contact_name: contactData.business_name || contactData.name || contactData.phone,
    company_name: contactData.business_name || contactData.name || contactData.phone,
    contact_type: 'customer',
    gst_treatment: contactData.is_business ? 'business_gst' : 'consumer',
    gst_no: contactData.gstin || '',
    place_of_contact: contactData.registered_address?.state_code || 'TN',
    contact_persons: [
      {
        first_name: contactData.name || contactData.phone,
        last_name: '',
        mobile: contactData.phone,
        is_primary_contact: true
      }
    ],
    billing_address: contactData.registered_address ? {
      attention: contactData.business_name || contactData.name || '',
      address: contactData.registered_address.address_line1 || '',
      street2: contactData.registered_address.address_line2 || '',
      city: contactData.registered_address.city || '',
      state: contactData.registered_address.state || '',
      zip: contactData.registered_address.pincode || '',
      country: 'India'
    } : {}
  };
  logger.debug({ body: contactBody }, 'Creating Zoho contact');
  try {
    const response = await zohoPost('https://www.zohoapis.in/books/v3/contacts', contactBody);
    logger.debug({ contactId: response.data.contact?.contact_id }, 'Zoho contact created');
    span.end({ success: true, contact_id: response.data.contact?.contact_id });
    return response.data.contact;
  } catch (error) {
    const errorData = error.response?.data;
    if (errorData?.code === 3062) {
      logger.info({ phone: contactData.phone }, 'Contact already exists in Zoho; searching by phone');
      const existing = await searchZohoContactByPhone(contactData.phone, traceContext);
      if (existing) {
        logger.debug({ contactId: existing.contact_id }, 'Found existing Zoho contact');
        span.end({ success: true, contact_id: existing.contact_id, existing: true });
        return existing;
      }
    }
    logger.error({ err: JSON.stringify(errorData || error.message) }, 'createZohoContact failed');
    span.end({ success: false, error: errorData?.message || error.message });
    throw new Error(JSON.stringify(errorData || error.message));
  }
}

async function searchZohoContactByName(name, traceContext = null) {
  try {
    const token = await getAccessToken();
    const response = await withRetry('zoho.api.searchContactByName', () =>
      axios.get(`${process.env.ZOHO_API_DOMAIN}/books/v3/contacts`, {
        headers: { Authorization: `Zoho-oauthtoken ${token}` },
        params: { organization_id: process.env.ZOHO_ORG_ID, search_text: name, contact_type: 'customer' },
        timeout: DEFAULT_TIMEOUT_MS,
      })
    );
    const contacts = response.data.contacts || [];
    // Prefer exact case match, fall back to case-insensitive
    return contacts.find(c => c.contact_name === name) ||
           contacts.find(c => c.contact_name?.toLowerCase() === name.toLowerCase()) ||
           null;
  } catch (error) {
    return null;
  }
}

async function searchZohoContactByPhone(phone, traceContext = null) {
  const span = createSpan(traceContext, 'zoho.api.searchContactByPhone', { 'peer.service': 'zoho', phone, endpoint: '/books/v3/contacts' });
  try {
    const token = await getAccessToken();
    const response = await withRetry('zoho.api.searchContactByPhone', () =>
      axios.get(`${process.env.ZOHO_API_DOMAIN}/books/v3/contacts`, {
        headers: { Authorization: `Zoho-oauthtoken ${token}` },
        params: {
          organization_id: process.env.ZOHO_ORG_ID,
          search_text: phone,
          contact_type: 'customer',
        },
        timeout: DEFAULT_TIMEOUT_MS,
      })
    );
    const contacts = response.data.contacts || [];
    const normalizedPhone = phone.replace(/\D/g, '');
    // Verify exact match — search_text is fuzzy, so confirm the contact actually owns this phone.
    // The list API returns top-level `mobile`/`phone` fields but NOT contact_persons —
    // check both to handle both list and single-contact response shapes.
    const match = contacts.find(c => {
      const topMobile = (c.mobile || '').replace(/\D/g, '');
      const topPhone = (c.phone || '').replace(/\D/g, '');
      if ((topMobile && topMobile === normalizedPhone) || (topPhone && topPhone === normalizedPhone)) return true;
      return (c.contact_persons || []).some(p => {
        const m = (p.mobile || '').replace(/\D/g, '');
        const ph = (p.phone || '').replace(/\D/g, '');
        return (m && m === normalizedPhone) || (ph && ph === normalizedPhone);
      });
    });
    span.end({ success: true, found: !!match, contactCount: contacts.length });
    return match || null;
  } catch (error) {
    span.end({ success: false, error: error.message });
    throw error;
  }
}

async function updateZohoItemImage(itemId, imageUrl, traceContext = null) {
  const span = createSpan(traceContext, 'zoho.api.updateItemImage', { 'peer.service': 'zoho', itemId, endpoint: '/inventory/v1/items/:id' });
  try {
    const response = await zohoPut(`${process.env.ZOHO_API_DOMAIN}/inventory/v1/items/${itemId}`, {
      custom_fields: [{ label: 'Image URL', value: imageUrl }]
    });
    span.end({ success: true, item_id: response.data.item?.item_id });
    return response.data.item;
  } catch (error) {
    span.end({ success: false, error: error.message });
    throw error;
  }
}

async function updateZohoItemFeatured(itemId, featured, traceContext = null) {
  const span = createSpan(traceContext, 'zoho.api.updateItemFeatured', { 'peer.service': 'zoho', itemId, endpoint: '/inventory/v1/items/:id' });
  try {
    const response = await zohoPut(`${process.env.ZOHO_API_DOMAIN}/inventory/v1/items/${itemId}`, {
      custom_fields: [{ label: 'Featured', value: featured }]
    });
    span.end({ success: true, item_id: response.data.item?.item_id });
    return response.data.item;
  } catch (error) {
    span.end({ success: false, error: error.message });
    throw error;
  }
}

async function updateZohoContact(zohoContactId, contactData, traceContext = null) {
  const span = createSpan(traceContext, 'zoho.api.updateContact', {
    'peer.service': 'zoho',
    contactId: zohoContactId,
    endpoint: '/books/v3/contacts/:id'
  });
  logger.debug({ zohoContactId }, 'updateZohoContact called');
  const updateBody = {};

  if (contactData.name || contactData.business_name) {
    updateBody.contact_name = contactData.business_name || contactData.name;
    updateBody.company_name = contactData.business_name || contactData.name;
  }
  if (contactData.name) {
    updateBody.contact_persons = [{
      first_name: contactData.name,
      last_name: '',
      mobile: contactData.phone,
      is_primary_contact: true
    }];
  }
  if (contactData.gstin) {
    updateBody.gst_no = contactData.gstin;
    updateBody.gst_treatment = 'business_gst';
  } else if (contactData.gstin === null) {
    updateBody.gst_no = '';
    updateBody.gst_treatment = 'consumer';
  }
  if (contactData.registered_address) {
    updateBody.place_of_contact = contactData.registered_address.state_code || 'TN';
    updateBody.billing_address = {
      attention: contactData.business_name || contactData.name || '',
      address: contactData.registered_address.address_line1 || '',
      street2: contactData.registered_address.address_line2 || '',
      city: contactData.registered_address.city || '',
      state: contactData.registered_address.state || '',
      zip: contactData.registered_address.pincode || '',
      country: 'India'
    };
  }

  logger.debug({ body: updateBody }, 'Sending updateZohoContact request');
  const url = `https://www.zohoapis.in/books/v3/contacts/${zohoContactId}`;
  try {
    const response = await zohoPut(url, updateBody);
    logger.debug({ contactId: response.data.contact?.contact_id }, 'updateZohoContact succeeded');
    span.end({ success: true, contact_id: response.data.contact?.contact_id });
    return response.data.contact;
  } catch (error) {
    const errorData = error.response?.data;
    // 3062 = contact name already exists — find the conflicting contact and signal caller to redirect
    if (errorData?.code === 3062 && updateBody.contact_name) {
      logger.warn({ zohoContactId, contact_name: updateBody.contact_name }, 'contact_name conflict; searching for existing contact');
      const existing = await searchZohoContactByName(updateBody.contact_name, traceContext);
      if (existing?.contact_id) {
        logger.info({ zohoContactId, existingContactId: existing.contact_id, name: updateBody.contact_name }, 'Redirecting to existing Zoho contact');
        span.end({ success: false, contact_name_conflict: true, existing_id: existing.contact_id });
        throw Object.assign(new Error('contact_name_conflict'), {
          code: 'CONTACT_NAME_CONFLICT',
          existingContactId: existing.contact_id,
        });
      }
      // No existing contact found — retry without renaming as last resort
      const retryBody = { ...updateBody };
      delete retryBody.contact_name;
      try {
        const retryResponse = await zohoPut(url, retryBody);
        span.end({ success: true, contact_id: retryResponse.data.contact?.contact_id, name_conflict: true });
        return retryResponse.data.contact;
      } catch (retryError) {
        const retryErrorData = retryError.response?.data;
        span.end({ success: false, error: retryErrorData?.message || retryError.message });
        throw new Error(JSON.stringify(retryErrorData || retryError.message));
      }
    }
    span.end({ success: false, error: errorData?.message || error.message });
    throw new Error(JSON.stringify(errorData || error.message));
  }
}

async function recordPaymentInZohoBooks({ invoiceId, customerId, amount, paymentMethod, date, notes }) {
  const token = await getAccessToken();
  const orgId = process.env.ZOHO_ORG_ID;
  const authConfig = {
    headers: { Authorization: `Zoho-oauthtoken ${token}`, 'Content-Type': 'application/json' },
    params: { organization_id: orgId },
    timeout: DEFAULT_TIMEOUT_MS
  };

  // The app's order total and Zoho's invoice total can differ by a few paise
  // because Zoho recomputes GST per line with its own rounding. Applying the
  // app total verbatim makes Zoho reject the payment ("amount entered is more
  // than the balance due"). So we read the invoice's actual balance_due and
  // apply at most that — settling the invoice in full while absorbing the
  // sub-rupee rounding difference.
  const invoiceRes = await axios.get(
    `https://www.zohoapis.in/books/v3/invoices/${invoiceId}`,
    authConfig
  );
  if (invoiceRes.data.code !== 0) throw new Error(`Zoho invoice lookup failed: ${invoiceRes.data.message}`);
  const balanceDue = Number(invoiceRes.data.invoice?.balance_due ?? 0);
  if (balanceDue <= 0) {
    throw new Error('Zoho invoice already fully paid (balance due is 0)');
  }
  // Apply the lesser of what was collected and what the invoice still owes.
  const amountApplied = Math.round(Math.min(Number(amount), balanceDue) * 100) / 100;

  const modeMap = {
    cash: { payment_mode: 'cash', account_id: process.env.ZOHO_CASH_ACCOUNT_ID },
    upi:  { payment_mode: 'bank_transfer', account_id: process.env.ZOHO_BANK_ACCOUNT_ID }
  };
  const modeConfig = modeMap[paymentMethod] || modeMap.cash;

  const payload = {
    customer_id: customerId,
    payment_mode: modeConfig.payment_mode,
    amount: amountApplied,
    date: date || new Date().toISOString().split('T')[0],
    description: notes || `COD payment via ${(paymentMethod || 'cash').toUpperCase()} — Suppliable`,
    invoices: [{ invoice_id: invoiceId, amount_applied: amountApplied }]
  };
  if (modeConfig.account_id) payload.account_id = modeConfig.account_id;

  const res = await axios.post(
    'https://www.zohoapis.in/books/v3/customerpayments',
    payload,
    authConfig
  );

  if (res.data.code !== 0) throw new Error(`Zoho payment failed: ${res.data.message}`);

  return {
    zohoPaymentId: res.data.payment.payment_id,
    zohoPaymentNumber: res.data.payment.payment_number,
    amountApplied
  };
}

module.exports = {
  getAccessToken,
  getZohoProducts,
  getZohoProductById,
  getZohoCategories,
  getZohoItemGroups,
  getZohoItemGroupById,
  createZohoContact,
  updateZohoContact,
  updateZohoItemImage,
  updateZohoItemFeatured,
  searchZohoContactByPhone,
  searchZohoContactByName,
  recordPaymentInZohoBooks
};
