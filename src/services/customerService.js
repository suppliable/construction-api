const { getCustomer, saveCustomer, getCustomerByPhone } = require('./firestoreService');
const { deleteCustomer } = require('../repositories/customerRepository');
const { getOrdersByUser } = require('../repositories/orderRepository');
const { deleteAllAddresses } = require('../repositories/addressRepository');
const { deleteCart } = require('../repositories/cartRepository');
const { deleteUserTokens } = require('./fcmService');
const admin = require('../utils/firebaseAdmin');
const { NON_TERMINAL_ORDER_STATUSES } = require('../constants');
const { createZohoContact, updateZohoContact } = require('./zohoService');
const logger = require('../utils/logger');
const { normalizePhone } = require('../utils/phone');

async function syncCustomer(userId, phone, name, is_business, business_name, gstin, registered_address, traceContext = null) {
  const normalizedPhone = normalizePhone(phone) || phone;
  logger.debug({ userId, name, is_business }, 'syncCustomer called');
  let existing = await getCustomer(userId, traceContext);

  // If no customer found by Firebase UID, check if a POS-created customer exists
  // for the same phone. If so, adopt it — this links the app login to the POS account.
  if (!existing) {
    const byPhone = await getCustomerByPhone(normalizedPhone, traceContext).catch(() => null);
    if (byPhone && byPhone.userId !== userId) {
      existing = { ...byPhone, userId };
      await saveCustomer(existing, traceContext);
      logger.info({ oldUserId: byPhone.userId, newUserId: userId }, 'adopted POS customer for app login');
    }
  }

  if (existing) {
    let hasChanges = false;

    if (name && name.trim() !== '' && existing.name !== name) {
      existing.name = name;
      hasChanges = true;
    }
    if (is_business !== undefined && existing.is_business !== is_business) {
      existing.is_business = is_business;
      hasChanges = true;
    }
    if (business_name && existing.business_name !== business_name) {
      existing.business_name = business_name;
      hasChanges = true;
    }
    if (gstin && existing.gstin !== gstin) {
      existing.gstin = gstin;
      hasChanges = true;
    }
    if (registered_address) {
      existing.registered_address = registered_address;
      hasChanges = true;
    }

    if (hasChanges) {
      if (!existing.zoho_contact_id && existing.name) {
        try {
          const zohoContact = await createZohoContact({
            phone: existing.phone,
            name: existing.name,
            is_business: existing.is_business,
            business_name: existing.business_name,
            gstin: existing.gstin,
            registered_address: existing.registered_address
          }, traceContext);
          existing.zoho_contact_id = zohoContact.contact_id;
        } catch (zohoErr) {
          logger.warn({ err: zohoErr.message }, 'zoho contact create failed — customer saved locally');
        }
      } else if (existing.zoho_contact_id) {
        try {
          await updateZohoContact(existing.zoho_contact_id, {
            name,
            phone: existing.phone,
            business_name,
            gstin,
            registered_address
          }, traceContext);
        } catch (zohoErr) {
          logger.warn({ err: zohoErr.message, zohoContactId: existing.zoho_contact_id }, 'zoho contact update failed — customer saved locally');
        }
      }
      await saveCustomer(existing, traceContext);
    }

    return existing;
  }

  let zohoContactId = null;
  if (name && name.trim()) {
    try {
      const zohoContact = await createZohoContact({ phone: normalizedPhone, name, is_business, business_name, gstin, registered_address }, traceContext);
      zohoContactId = zohoContact.contact_id;
    } catch (zohoErr) {
      logger.warn({ err: zohoErr.message }, 'zoho contact create failed — customer saved locally');
    }
  }

  return await saveCustomer({
    userId,
    phone: normalizedPhone,
    name: name || '',
    is_business: is_business || false,
    business_name: business_name || '',
    gstin: gstin || '',
    zoho_contact_id: zohoContactId,
    delivery_address: null,
    registered_address: registered_address || null
  }, traceContext);
}

async function updateCustomerGST(userId, { gstin, business_name, registered_address }, traceContext = null) {
  const customer = await getCustomer(userId, traceContext);
  if (!customer) throw new Error('Customer not found');

  customer.is_business = true;
  if (gstin) customer.gstin = gstin;
  if (business_name) customer.business_name = business_name;
  if (registered_address) customer.registered_address = registered_address;

  if (customer.zoho_contact_id) {
    try {
      await updateZohoContact(customer.zoho_contact_id, {
        business_name,
        gstin,
        registered_address
      }, traceContext);
    } catch (err) {
      if (err.code === 'CONTACT_NAME_CONFLICT' && err.existingContactId) {
        // Another Zoho contact already has this business name — redirect this customer to it
        logger.info({ userId, from: customer.zoho_contact_id, to: err.existingContactId, business_name }, 'Redirecting customer zoho_contact_id to existing company contact');
        customer.zoho_contact_id = err.existingContactId;
      } else {
        logger.warn({ err: err.message }, 'Zoho contact GST update failed — saved locally');
      }
    }
  }

  return saveCustomer(customer, traceContext);
}

async function clearCustomerGST(userId, traceContext = null, { throwOnZohoError = false } = {}) {
  const customer = await getCustomer(userId, traceContext);
  if (!customer) throw new Error('Customer not found');

  customer.gstin = null;
  customer.business_name = null;
  customer.registered_address = null;
  customer.is_business = false;

  let zohoFailed = false;
  if (customer.zoho_contact_id) {
    try {
      await updateZohoContact(customer.zoho_contact_id, {
        name: customer.name,
        phone: customer.phone,
        gstin: null,
        business_name: null,
        registered_address: null,
      }, traceContext);
    } catch (err) {
      zohoFailed = true;
      logger.warn({ err: err.message }, 'Zoho contact GST clear failed — saved locally');
    }
  }

  const saved = await saveCustomer(customer, traceContext);

  if (throwOnZohoError && zohoFailed) {
    throw Object.assign(new Error('Zoho sync failed'), { code: 'ZOHO_SYNC_FAILED', customer: saved });
  }

  return saved;
}

// Account deletion (Apple 5.1.1(v)). Invoices and orders are statutory records,
// so they are retained: the customer's own data is erased and the Zoho contact
// is anonymised. A GSTIN customer's Zoho contact is left intact because GST
// invoices must keep the recipient's name and GSTIN.
async function deleteCustomerAccount(userId, traceContext = null) {
  const customer = await getCustomer(userId, traceContext);
  if (!customer) throw Object.assign(new Error('Customer not found'), { code: 'USER_NOT_FOUND' });

  const orders = await getOrdersByUser(userId, 0, traceContext);
  const inFlight = orders.filter(o => NON_TERMINAL_ORDER_STATUSES.includes(o.status));
  if (inFlight.length) {
    throw Object.assign(new Error('Account has orders in progress'), {
      code: 'ACTIVE_ORDERS',
      orderIds: inFlight.map(o => o.orderId),
    });
  }

  let zohoAnonymised = false;
  if (customer.zoho_contact_id && !customer.gstin) {
    try {
      await updateZohoContact(customer.zoho_contact_id, {
        name: `Deleted Customer ${userId}`,
        phone: '',
      }, traceContext);
      zohoAnonymised = true;
    } catch (err) {
      logger.warn({ err: err.message, userId }, 'Zoho contact anonymise failed — continuing account deletion');
    }
  }

  await Promise.all([
    deleteAllAddresses(userId, traceContext),
    deleteCart(userId, traceContext),
    deleteUserTokens(userId).catch(err => logger.warn({ err: err.message, userId }, 'fcm token delete failed')),
  ]);
  await deleteCustomer(userId, traceContext);

  try {
    await admin.auth().deleteUser(userId);
  } catch (err) {
    if (err.code !== 'auth/user-not-found') {
      logger.warn({ err: err.message, userId }, 'firebase auth user delete failed');
    }
  }

  logger.info({ userId, zohoAnonymised, retainedOrders: orders.length }, 'customer account deleted');
  return { zohoAnonymised, retainedOrders: orders.length };
}

module.exports = { syncCustomer, updateCustomerGST, clearCustomerGST, deleteCustomerAccount };
