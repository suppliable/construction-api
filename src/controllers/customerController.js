const { getCustomer, saveCustomer, getCustomerByPhone } = require('../services/firestoreService');
const { toCustomerDTO } = require('../models/customerDTO');
const { updateCustomerGST, clearCustomerGST } = require('../services/customerService');

async function getCustomerHandler(req, res) {
  const customer = await getCustomer(req.params.userId, req.traceContext);
  if (!customer) {
    return res.status(404).json({ success: false, message: 'Customer not found' });
  }
  const dto = toCustomerDTO(customer);
  res.json({ success: true, data: { customer: dto }, customer: dto, user: dto });
}

async function updateDeliveryAddress(req, res) {
  const customer = await getCustomer(req.params.userId, req.traceContext);
  if (!customer) {
    return res.status(404).json({ success: false, message: 'Customer not found' });
  }

  const { lat, lng, address_line1, address_line2, city, state, pincode, label } = req.body;
  customer.delivery_address = { lat, lng, address_line1, address_line2, city, state, pincode, label };
  await saveCustomer(customer, req.traceContext);

  res.json({ success: true, user: customer });
}

async function updateRegisteredAddress(req, res) {
  const customer = await getCustomer(req.params.userId, req.traceContext);
  if (!customer) {
    return res.status(404).json({ success: false, message: 'Customer not found' });
  }

  if (!customer.is_business) {
    return res.status(400).json({ success: false, message: 'Only business customers can have a registered address' });
  }

  const { address_line1, address_line2, city, state, state_code, pincode } = req.body;
  customer.registered_address = { address_line1, address_line2, city, state, state_code, pincode };
  await saveCustomer(customer, req.traceContext);

  res.json({ success: true, user: customer });
}

async function listCustomers(req, res) {
  res.status(501).json({ success: false, message: 'List all customers not supported with Firestore yet' });
}

async function getCustomerByPhoneHandler(req, res) {
  const customer = await getCustomerByPhone(req.params.phone, req.traceContext);
  if (!customer) {
    return res.status(404).json({ success: false, message: 'Customer not found' });
  }
  res.json({ success: true, user: toCustomerDTO(customer) });
}

async function updateGSTDetails(req, res) {
  try {
    const { gstin, business_name, registered_address } = req.body;
    if (!gstin && !business_name) {
      return res.status(400).json({ success: false, message: 'gstin or business_name is required' });
    }
    const customer = await updateCustomerGST(req.params.userId, { gstin, business_name, registered_address }, req.traceContext);
    const dto = toCustomerDTO(customer);
    res.json({ success: true, data: { customer: dto }, user: dto });
  } catch (err) {
    const status = err.message === 'Customer not found' ? 404 : 500;
    res.status(status).json({ success: false, message: err.message });
  }
}

async function removeGSTDetails(req, res) {
  if (req.user?.uid !== req.params.userId) {
    return res.status(403).json({ success: false, error: 'FORBIDDEN', message: 'Access denied' });
  }
  try {
    const customer = await clearCustomerGST(req.params.userId, req.traceContext, { throwOnZohoError: true });
    const dto = { ...toCustomerDTO(customer), isBusiness: false };
    return res.json({ success: true, data: { customer: dto }, user: dto });
  } catch (err) {
    if (err.code === 'ZOHO_SYNC_FAILED') {
      const dto = { ...toCustomerDTO(err.customer), isBusiness: false };
      return res.status(502).json({ success: false, error: 'ZOHO_SYNC_FAILED', message: 'GST details cleared locally but Zoho sync failed', data: { customer: dto }, user: dto });
    }
    if (err.message === 'Customer not found') {
      return res.status(404).json({ success: false, error: 'USER_NOT_FOUND', message: 'Customer not found' });
    }
    return res.status(500).json({ success: false, message: err.message });
  }
}

module.exports = { getCustomer: getCustomerHandler, updateDeliveryAddress, updateRegisteredAddress, updateGSTDetails, removeGSTDetails, listCustomers, getCustomerByPhone: getCustomerByPhoneHandler };
