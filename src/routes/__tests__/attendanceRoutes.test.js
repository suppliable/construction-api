'use strict';

// Wiring, not logic: unit tests on the service cannot catch a route declared in
// the wrong order or a missing capability gate — both of which only show up as a
// 404 or, worse, an open endpoint in the running app.

jest.mock('../../utils/firebaseAdmin', () => {
  const doc = () => ({ get: jest.fn(), set: jest.fn(), update: jest.fn(), delete: jest.fn() });
  const col = () => ({ doc: jest.fn(doc), where: jest.fn(function w() { return this; }),
    orderBy: jest.fn(function o() { return this; }), limit: jest.fn(function l() { return this; }), get: jest.fn() });
  return {
    firestore: jest.fn(() => ({ collection: jest.fn(col), runTransaction: jest.fn(), batch: jest.fn() })),
    auth: jest.fn(() => ({ createCustomToken: jest.fn() })),
    database: jest.fn(() => ({ ref: jest.fn() })),
    credential: { cert: jest.fn() },
  };
});

const adminRouter = require('../admin');

function layerFor(method, path) {
  return adminRouter.stack.find(l => l.route && l.route.path === path && l.route.methods[method]);
}
const handlers = (method, path) => layerFor(method, path)?.route.stack.length;

describe('attendance routes', () => {
  test.each([
    ['get', '/attendance/me'],
    ['post', '/attendance/clock-in'],
    ['post', '/attendance/clock-out'],
    ['get', '/attendance'],
    ['put', '/attendance/:id'],
    ['post', '/users/:userId/attendance'],
  ])('%s %s is registered', (method, path) => {
    expect(layerFor(method, path)).toBeTruthy();
  });

  test('/attendance/me is declared before /attendance/:id so "me" is not read as an id', () => {
    const idx = path => adminRouter.stack.findIndex(l => l.route && l.route.path === path);
    expect(idx('/attendance/me')).toBeGreaterThanOrEqual(0);
    // :id is PUT-only, so a GET would not collide today — but the ordering is
    // what keeps it that way if a GET /:id is ever added.
    expect(idx('/attendance/me')).toBeLessThan(idx('/attendance/:id'));
  });

  test('the report and corrections carry a capability gate; clock-in/out and status do not', () => {
    // [capability middleware, handler] versus [handler]
    expect(handlers('get', '/attendance')).toBe(2);
    expect(handlers('put', '/attendance/:id')).toBe(2);
    expect(handlers('post', '/users/:userId/attendance')).toBe(2);

    expect(handlers('get', '/attendance/me')).toBe(1);
    expect(handlers('post', '/attendance/clock-in')).toBe(1);
    expect(handlers('post', '/attendance/clock-out')).toBe(1);
  });

  test('every attendance route sits BELOW the identity middleware', () => {
    // adminAuth is router.use(adminAuth); a route registered above it would be
    // reachable with no login at all.
    const authIdx = adminRouter.stack.findIndex(l => !l.route && l.name === 'adminAuth');
    expect(authIdx).toBeGreaterThanOrEqual(0);
    adminRouter.stack.forEach((l, i) => {
      if (l.route && l.route.path.startsWith('/attendance')) expect(i).toBeGreaterThan(authIdx);
    });
  });
});

describe('admin API caching', () => {
  test('every admin response is marked no-store, including login', () => {
    // The no-store middleware must be the FIRST layer so it also covers
    // POST /auth, which is declared before the auth gate.
    const first = adminRouter.stack[0];
    expect(first.route).toBeUndefined();
    const headers = {};
    const next = jest.fn();
    first.handle({}, { set: (k, v) => { headers[k] = v; } }, next);
    expect(headers['Cache-Control']).toBe('no-store');
    expect(next).toHaveBeenCalledTimes(1);
  });
});
