const { getDriverByToken } = require('../services/firestoreService');

async function driverAuth(req, res, next) {
  const auth = req.headers.authorization || '';
  const token = auth.replace('Bearer ', '').trim();
  if (!token) {
    return res.status(401).json({ success: false, error: 'UNAUTHORIZED', message: 'Invalid or expired token' });
  }

  const driver = await getDriverByToken(token).catch(() => null);
  if (!driver) {
    return res.status(401).json({ success: false, error: 'UNAUTHORIZED', message: 'Invalid or expired token' });
  }
  if (!driver.isActive) {
    return res.status(401).json({ success: false, error: 'DRIVER_INACTIVE', message: 'Your account is inactive. Contact admin.' });
  }

  req.driver = {
    driverId: driver.driverId,
    name: driver.name,
    phone: driver.phone,
    isActive: driver.isActive,
    isAvailable: driver.isAvailable
  };
  next();
}

module.exports = driverAuth;
