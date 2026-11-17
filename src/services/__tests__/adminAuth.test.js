'use strict';

// Admin auth replaced one shared password returning one static token. These
// tests pin the properties that made that worth changing: a person behind every
// request, immediate revocation, and no credential recoverable from the data.

jest.mock('../../utils/firebaseAdmin', () => ({
  firestore: jest.fn(), auth: jest.fn(), database: jest.fn(),
}));
jest.mock('../../repositories/adminUserRepository', () => {
  const crypto = require('crypto');
  return {
    getUser: jest.fn(), getUserByEmail: jest.fn(), listUsers: jest.fn(),
    saveUser: jest.fn(async u => u), countUsers: jest.fn(),
    createSession: jest.fn(), getSession: jest.fn(),
    deleteSession: jest.fn(), deleteSessionsForUser: jest.fn(async () => 1),
    hashToken: t => crypto.createHash('sha256').update(String(t)).digest('hex'),
  };
});
jest.mock('../../utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const bcrypt = require('bcrypt');
const repo = require('../../repositories/adminUserRepository');
const svc = require('../adminAuthService');

const PASSWORD = 'correct-horse';
let HASH;
beforeAll(async () => { HASH = await bcrypt.hash(PASSWORD, 10); });
beforeEach(() => jest.clearAllMocks());

const user = (over = {}) => ({
  userId: 'ravi@suppliable.in', email: 'ravi@suppliable.in', name: 'Ravi',
  role: 'staff', isActive: true, passwordHash: HASH, ...over,
});

describe('login', () => {
  test('mints a session carrying who it is, and returns the token once', async () => {
    repo.getUserByEmail.mockResolvedValue(user());
    const out = await svc.login({ email: 'Ravi@Suppliable.in ', password: PASSWORD });

    expect(out.token).toHaveLength(64);
    expect(out.user).toMatchObject({ userId: 'ravi@suppliable.in', name: 'Ravi', role: 'staff' });
    // The DTO must never leak the hash.
    expect(out.user.passwordHash).toBeUndefined();

    const [tokenArg, session] = repo.createSession.mock.calls[0];
    expect(tokenArg).toBe(out.token);
    expect(session).toMatchObject({ userId: 'ravi@suppliable.in', role: 'staff' });
    expect(Date.parse(session.expiresAt)).toBeGreaterThan(Date.now());
  });

  test('the raw token is never stored — only its hash keys the session', async () => {
    repo.getUserByEmail.mockResolvedValue(user());
    const { token } = await svc.login({ email: 'ravi@suppliable.in', password: PASSWORD });
    const stored = JSON.stringify(repo.createSession.mock.calls[0][1]);
    expect(stored).not.toContain(token);
  });

  test('a wrong password and an unknown user give the SAME message', async () => {
    repo.getUserByEmail.mockResolvedValue(user());
    const wrong = await svc.login({ email: 'ravi@suppliable.in', password: 'nope' }).catch(e => e);
    repo.getUserByEmail.mockResolvedValue(null);
    const missing = await svc.login({ email: 'ghost@suppliable.in', password: 'nope' }).catch(e => e);
    // Distinguishing them tells an attacker which addresses are worth guessing.
    expect(wrong.message).toBe(missing.message);
    expect(wrong.code).toBe('INVALID_CREDENTIALS');
  });

  test('a deactivated account cannot sign in even with the right password', async () => {
    repo.getUserByEmail.mockResolvedValue(user({ isActive: false }));
    await expect(svc.login({ email: 'ravi@suppliable.in', password: PASSWORD }))
      .rejects.toThrow(/deactivated/);
    expect(repo.createSession).not.toHaveBeenCalled();
  });

  test('requires both fields', async () => {
    await expect(svc.login({ email: '', password: PASSWORD })).rejects.toThrow(/required/);
    await expect(svc.login({ email: 'a@b.c', password: '' })).rejects.toThrow(/required/);
  });
});

describe('resolveSession', () => {
  test('returns the session for a live token', async () => {
    repo.getSession.mockResolvedValue({ userId: 'ravi@suppliable.in', role: 'staff',
      expiresAt: new Date(Date.now() + 3600e3).toISOString() });
    await expect(svc.resolveSession('tok')).resolves.toMatchObject({ userId: 'ravi@suppliable.in' });
  });

  test('refuses an expired one', async () => {
    repo.getSession.mockResolvedValue({ userId: 'x', expiresAt: new Date(Date.now() - 1000).toISOString() });
    await expect(svc.resolveSession('tok')).resolves.toBeNull();
  });

  test('refuses an unknown or empty token', async () => {
    repo.getSession.mockResolvedValue(null);
    await expect(svc.resolveSession('tok')).resolves.toBeNull();
    await expect(svc.resolveSession('')).resolves.toBeNull();
  });
});

describe('user management', () => {
  test('creates a user with a hashed password and no plaintext anywhere', async () => {
    repo.getUserByEmail.mockResolvedValue(null);
    const out = await svc.createUser(
      { email: 'New@Suppliable.in', name: 'Nila', password: 'another-good-one', role: 'admin' },
      'ravi@suppliable.in'
    );
    expect(out.userId).toBe('new@suppliable.in');
    expect(out.passwordHash).toBeUndefined();

    const [saved] = repo.saveUser.mock.calls[0];
    expect(saved.passwordHash).not.toBe('another-good-one');
    expect(await bcrypt.compare('another-good-one', saved.passwordHash)).toBe(true);
    expect(saved.createdBy).toBe('ravi@suppliable.in');
  });

  test('refuses a weak password, a bad role and a duplicate', async () => {
    repo.getUserByEmail.mockResolvedValue(null);
    await expect(svc.createUser({ email: 'a@b.c', name: 'A', password: 'short' })).rejects.toThrow(/at least 8/);
    await expect(svc.createUser({ email: 'a@b.c', name: 'A', password: 'long-enough', role: 'owner' })).rejects.toThrow(/role must be/);
    repo.getUserByEmail.mockResolvedValue(user());
    await expect(svc.createUser({ email: 'ravi@suppliable.in', name: 'R', password: 'long-enough' }))
      .rejects.toThrow(/already has an account/);
  });

  test('deactivating drops live sessions — not "once the token expires"', async () => {
    repo.getUser.mockResolvedValue(user());
    await svc.setActive('ravi@suppliable.in', false, 'boss@suppliable.in');
    expect(repo.deleteSessionsForUser).toHaveBeenCalledWith('ravi@suppliable.in', null);
  });

  test('reactivating does NOT drop sessions — there are none to drop', async () => {
    repo.getUser.mockResolvedValue(user({ isActive: false }));
    await svc.setActive('ravi@suppliable.in', true, 'boss@suppliable.in');
    expect(repo.deleteSessionsForUser).not.toHaveBeenCalled();
  });

  test('a password change invalidates existing sessions', async () => {
    repo.getUser.mockResolvedValue(user());
    await svc.setPassword('ravi@suppliable.in', 'brand-new-password', 'boss@suppliable.in');
    expect(repo.deleteSessionsForUser).toHaveBeenCalled();
  });
});

describe('capabilities', () => {
  test('admin may do everything', () => {
    for (const c of svc.ADMIN_ONLY) expect(svc.can('admin', c)).toBe(true);
  });

  test('staff is fenced off from users, prices and settings', () => {
    expect(svc.can('staff', 'manage_users')).toBe(false);
    expect(svc.can('staff', 'change_prices')).toBe(false);
    expect(svc.can('staff', 'settings')).toBe(false);
  });

  test('anything unlisted is open to staff — this fences off money, not everything', () => {
    expect(svc.can('staff', 'view_orders')).toBe(true);
    expect(svc.can('staff', 'enter_bill')).toBe(true);
  });
});
