'use strict';

// The middleware is what actually gates every admin route, so its failure modes
// matter more than the service's: a bug here either locks everyone out or lets
// everyone in.

// requireActual below pulls the real service in, which reaches firebaseAdmin
// at require-time and needs a real RSA key. Nothing here touches Firestore.
jest.mock('../../utils/firebaseAdmin', () => ({
  firestore: jest.fn(), auth: jest.fn(), database: jest.fn(),
}));
jest.mock('../../services/adminAuthService', () => ({
  resolveSession: jest.fn(),
  can: jest.requireActual('../../services/adminAuthService').can,
}));
jest.mock('../../utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const { resolveSession } = require('../../services/adminAuthService');
const { adminAuth, requireCapability } = require('../adminAuth');

function mkReq(token) {
  const log = { warn: jest.fn(), error: jest.fn(), info: jest.fn() };
  log.child = jest.fn(() => log);
  return { headers: token ? { authorization: 'Bearer ' + token } : {}, path: '/orders', log };
}
function mkRes() {
  const res = { statusCode: 200 };
  res.status = jest.fn(c => { res.statusCode = c; return res; });
  res.json = jest.fn(b => { res.body = b; return res; });
  return res;
}

beforeEach(() => {
  jest.clearAllMocks();
  process.env.ADMIN_TOKEN = 'shared-legacy-token-0123456789';
  delete process.env.ADMIN_LEGACY_TOKEN;
});

describe('adminAuth', () => {
  test('a live session identifies the person and tags the logger', async () => {
    resolveSession.mockResolvedValue({ userId: 'ravi@suppliable.in', name: 'Ravi', role: 'staff' });
    const req = mkReq('good'), res = mkRes(), next = jest.fn();
    await adminAuth(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(req.adminUser).toMatchObject({ userId: 'ravi@suppliable.in', role: 'staff', isLegacy: false });
    // This is what makes every later log line attributable.
    expect(req.log.child).toHaveBeenCalledWith({ adminUserId: 'ravi@suppliable.in' });
  });

  test('no token is a 401 before anything is looked up', async () => {
    const req = mkReq(null), res = mkRes(), next = jest.fn();
    await adminAuth(req, res, next);
    expect(res.statusCode).toBe(401);
    expect(next).not.toHaveBeenCalled();
    expect(resolveSession).not.toHaveBeenCalled();
  });

  test('an unknown token is refused with a message that says what to do', async () => {
    resolveSession.mockResolvedValue(null);
    const req = mkReq('stale'), res = mkRes(), next = jest.fn();
    await adminAuth(req, res, next);
    expect(res.statusCode).toBe(401);
    expect(res.body.message).toMatch(/sign in again/i);
  });

  test('the shared token still works during migration, but is logged as legacy', async () => {
    resolveSession.mockResolvedValue(null);
    const req = mkReq('shared-legacy-token-0123456789'), res = mkRes(), next = jest.fn();
    await adminAuth(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(req.adminUser.isLegacy).toBe(true);
    // Warn, not info: it should stay visible until it stops appearing.
    expect(req.log.warn).toHaveBeenCalledWith(expect.anything(), 'admin.auth.legacy_shared_token');
  });

  test('ADMIN_LEGACY_TOKEN=off closes the bridge', async () => {
    process.env.ADMIN_LEGACY_TOKEN = 'off';
    resolveSession.mockResolvedValue(null);
    const req = mkReq('shared-legacy-token-0123456789'), res = mkRes(), next = jest.fn();
    await adminAuth(req, res, next);
    expect(res.statusCode).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });

  test('a real session wins over the legacy branch', async () => {
    resolveSession.mockResolvedValue({ userId: 'ravi@suppliable.in', name: 'Ravi', role: 'admin' });
    const req = mkReq('shared-legacy-token-0123456789'), res = mkRes(), next = jest.fn();
    await adminAuth(req, res, next);
    expect(req.adminUser.isLegacy).toBe(false);
  });

  test('a lookup failure is a 401, never an accidental pass', async () => {
    resolveSession.mockRejectedValue(new Error('firestore down'));
    const req = mkReq('good'), res = mkRes(), next = jest.fn();
    await adminAuth(req, res, next);
    expect(res.statusCode).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });
});

describe('requireCapability', () => {
  test('lets an admin through', () => {
    const req = { adminUser: { role: 'admin' }, log: { warn: jest.fn() } };
    const res = mkRes(), next = jest.fn();
    requireCapability('manage_users')(req, res, next);
    expect(next).toHaveBeenCalled();
  });

  test('stops staff with 403 and names the action', () => {
    const req = { adminUser: { role: 'staff' }, log: { warn: jest.fn() } };
    const res = mkRes(), next = jest.fn();
    requireCapability('change_prices')(req, res, next);
    expect(res.statusCode).toBe(403);
    expect(res.body.message).toMatch(/change prices/);
    expect(next).not.toHaveBeenCalled();
  });

  test('401s when no user was established — never 403, which would imply a valid session', () => {
    const res = mkRes(), next = jest.fn();
    requireCapability('settings')({}, res, next);
    expect(res.statusCode).toBe(401);
  });
});
