const { syncCustomer } = require('../services/customerService');

async function syncAuth(req, res) {
  const { firebaseUid, phone, name, is_business, business_name, gstin, registered_address } = req.body;

  if (!firebaseUid || !phone) {
    return res.status(400).json({ success: false, message: 'firebaseUid and phone are required' });
  }

  try {
    const customer = await syncCustomer(firebaseUid, phone, name, is_business, business_name, gstin, registered_address);
    res.json({
      success: true,
      data: { customer },   // new shape
      customer,             // backward compat
      user: customer        // backward compat
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
}

module.exports = { syncAuth };
