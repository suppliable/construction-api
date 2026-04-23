const { getCustomer, saveCustomer, getCustomerByPhone } = require('./firestoreService');
const { createZohoContact, updateZohoContact } = require('./zohoService');
const logger = require('../utils/logger');

async function syncCustomer(userId, phone, name, is_business, business_name, gstin, registered_address, traceContext = null) {
  logger.debug({ userId, name, is_business }, 'syncCustomer called');
  const existing = await getCustomer(userId, traceContext);
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
    if (registered_address && !existing.registered_address) {
      existing.registered_address = registered_address;
      hasChanges = true;
    }

    if (hasChanges) {
      await saveCustomer(existing, traceContext);
      if (existing.zoho_contact_id) {
        await updateZohoContact(existing.zoho_contact_id, {
          name,
          phone: existing.phone,
          business_name,
          gstin,
          registered_address
        }, traceContext);
      }
    }

    return existing;
  }

  const zohoContact = await createZohoContact({ phone, name, is_business, business_name, gstin, registered_address }, traceContext);

  return await saveCustomer({
    userId,
    phone,
    name: name || '',
    is_business: is_business || false,
    business_name: business_name || '',
    gstin: gstin || '',
    zoho_contact_id: zohoContact.contact_id,
    delivery_address: null,
    registered_address: registered_address || null
  }, traceContext);
}

module.exports = { syncCustomer };
