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
      // If the customer doesn't have a Zoho contact yet and now has a name,
      // create one with complete data instead of updating a non-existent record.
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

  // Only create a Zoho contact when we have a name — identity pings (no name)
  // save to Firestore only and get a Zoho contact on the next call with a name.
  let zohoContactId = null;
  if (name && name.trim()) {
    try {
      const zohoContact = await createZohoContact({ phone, name, is_business, business_name, gstin, registered_address }, traceContext);
      zohoContactId = zohoContact.contact_id;
    } catch (zohoErr) {
      logger.warn({ err: zohoErr.message }, 'zoho contact create failed — customer saved locally');
    }
  }

  return await saveCustomer({
    userId,
    phone,
    name: name || '',
    is_business: is_business || false,
    business_name: business_name || '',
    gstin: gstin || '',
    zoho_contact_id: zohoContactId,
    delivery_address: null,
    registered_address: registered_address || null
  }, traceContext);
}

module.exports = { syncCustomer };
