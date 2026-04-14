const { syncCustomer } = require('../services/customerService');

async function syncAuth(req, res) {
  const { firebaseUid, phone } = req.body;

  if (!firebaseUid || !phone) {
    return res.status(400).json({ success: false, message: 'firebaseUid and phone are required' });
  }

  try {
    const customer = await syncCustomer(firebaseUid, phone, req.body.name);
    res.json({ success: true, user: customer });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
}

module.exports = { syncAuth };
