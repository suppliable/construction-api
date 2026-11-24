'use strict';

// Per-user admin authentication.
//
// Replaces a single shared password that returned a single static token. That
// arrangement meant no action could be attributed to a person, nobody could be
// removed without rotating the credential for everyone, and the token never
// expired. The symptom was already in the code: markPaymentReceived records
// `actor: req.user?.uid`, which was always null on admin routes because nothing
// ever set a user.
//
// Modelled on the driver login, which already does this properly: a record per
// person, a bcrypt-hashed secret, and a token minted at login.

const bcrypt = require('bcrypt');
const crypto = require('crypto');
const repo = require('../repositories/adminUserRepository');
const logger = require('../utils/logger');
const { ValidationError, UnauthorizedError, ConflictError, NotFoundError } = require('../utils/errors');

const BCRYPT_ROUNDS = 10;              // matches setDriverPin
const SESSION_HOURS = 12;              // a working day, not a standing grant
const MIN_PASSWORD = 8;

const ROLES = ['admin', 'staff'];

// What each role may do. Everything not listed is allowed to both — the point
// is to fence off the few actions that move money or change what customers pay,
// not to build a permission matrix nobody maintains.
const ADMIN_ONLY = Object.freeze([
  'manage_users',      // create, deactivate, reset another person's password
  'change_prices',     // selling price on the margin report
  'settings',          // warehouse config, delivery pricing
  'view_attendance',   // the attendance report — everyone's hours
  'edit_attendance',   // correcting a punch
]);

const str = v => (typeof v === 'string' ? v.trim() : '');
const normEmail = v => str(v).toLowerCase();

function can(role, capability) {
  if (role === 'admin') return true;
  return !ADMIN_ONLY.includes(capability);
}

function newToken() {
  return crypto.randomBytes(32).toString('hex');
}

function assertPassword(password) {
  if (str(password).length < MIN_PASSWORD) {
    throw new ValidationError(`Password must be at least ${MIN_PASSWORD} characters`, 'WEAK_PASSWORD');
  }
}

/** Public shape — never carries passwordHash. */
function toUserDTO(u) {
  if (!u) return null;
  return {
    userId: u.userId,
    name: u.name || null,
    email: u.email || u.userId,
    role: u.role || 'staff',
    isActive: u.isActive !== false,
    // Opt-in per person. Read by the portal to decide whether to ask for a
    // location; the server re-checks it on every attendance call.
    attendanceEnabled: u.attendanceEnabled === true,
    lastLoginAt: u.lastLoginAt || null,
    createdAt: u.createdAt || null,
    createdBy: u.createdBy || null,
  };
}

// ── login ───────────────────────────────────────────────────────────────────

/**
 * Verify a password and mint a session.
 *
 * Deliberately gives one message for "no such user" and "wrong password": a
 * distinct "no such user" tells an attacker which addresses are worth guessing
 * against. The bcrypt comparison runs even when the user is missing, so the
 * response time does not leak the same thing.
 */
async function login({ email, password, ip = null }, traceContext = null) {
  const id = normEmail(email);
  if (!id || !str(password)) {
    throw new ValidationError('Email and password are required', 'MISSING_PARAM');
  }

  const user = await repo.getUserByEmail(id, traceContext);
  const hash = user?.passwordHash
    // A real-looking hash so a missing user costs the same time as a wrong password.
    || '$2b$10$0000000000000000000000000000000000000000000000000000';
  const ok = await bcrypt.compare(String(password), hash);

  if (!user || !ok) {
    logger.warn({ email: id, reason: user ? 'bad_password' : 'no_such_user' }, 'admin.login.failed');
    throw new UnauthorizedError('Incorrect email or password', 'INVALID_CREDENTIALS');
  }
  if (user.isActive === false) {
    logger.warn({ email: id }, 'admin.login.inactive');
    throw new UnauthorizedError('This account has been deactivated', 'ACCOUNT_INACTIVE');
  }

  const token = newToken();
  const now = new Date();
  await repo.createSession(token, {
    userId: user.userId,
    name: user.name || user.userId,
    role: user.role || 'staff',
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + SESSION_HOURS * 3600 * 1000).toISOString(),
    ip,
  }, traceContext);

  await repo.saveUser({ userId: user.userId, lastLoginAt: now.toISOString() }, traceContext);
  logger.info({ userId: user.userId, role: user.role }, 'admin.login.ok');

  return { token, user: toUserDTO(user) };
}

/**
 * Resolve a bearer token to the person holding it.
 * Returns null for anything unusable, so callers answer 401 uniformly.
 */
async function resolveSession(token, traceContext = null) {
  if (!str(token)) return null;
  const session = await repo.getSession(token, traceContext);
  if (!session) return null;
  if (session.expiresAt && Date.parse(session.expiresAt) <= Date.now()) {
    // Expired sessions are left to the TTL sweeper; refusing is enough.
    return null;
  }
  return session;
}

async function logout(token, traceContext = null) {
  if (str(token)) await repo.deleteSession(token, traceContext).catch(() => {});
}

// ── user management ─────────────────────────────────────────────────────────

async function createUser({ email, name, password, role = 'staff' }, actor = null, traceContext = null) {
  const id = normEmail(email);
  if (!id || !id.includes('@')) throw new ValidationError('A valid email is required', 'INVALID_PARAM');
  if (!str(name)) throw new ValidationError('Name is required', 'MISSING_PARAM');
  if (!ROLES.includes(role)) {
    throw new ValidationError(`role must be one of: ${ROLES.join(', ')}`, 'INVALID_PARAM');
  }
  assertPassword(password);

  if (await repo.getUserByEmail(id, traceContext)) {
    throw new ConflictError(`${id} already has an account`, 'USER_EXISTS');
  }

  const user = {
    userId: id,
    email: id,
    name: str(name),
    role,
    isActive: true,
    passwordHash: await bcrypt.hash(String(password), BCRYPT_ROUNDS),
    createdAt: new Date().toISOString(),
    createdBy: actor || null,
  };
  await repo.saveUser(user, traceContext);
  logger.info({ userId: id, role, createdBy: actor }, 'admin.user.created');
  return toUserDTO(user);
}

async function setActive(userId, isActive, actor = null, traceContext = null) {
  const user = await repo.getUser(normEmail(userId), traceContext);
  if (!user) throw new NotFoundError('No such admin user', 'USER_NOT_FOUND');

  await repo.saveUser({ userId: user.userId, isActive: !!isActive }, traceContext);
  // Deactivation has to bite immediately — a live session would otherwise
  // outlive it by up to the session lifetime.
  if (!isActive) await repo.deleteSessionsForUser(user.userId, traceContext);

  logger.info({ userId: user.userId, isActive: !!isActive, actor }, 'admin.user.active_changed');
  return toUserDTO({ ...user, isActive: !!isActive });
}

/**
 * Change a password. Sessions are dropped either way: after a reset the old
 * ones should not keep working, and that is the whole point of a reset.
 */
async function setPassword(userId, password, actor = null, traceContext = null) {
  const user = await repo.getUser(normEmail(userId), traceContext);
  if (!user) throw new NotFoundError('No such admin user', 'USER_NOT_FOUND');
  assertPassword(password);

  await repo.saveUser({
    userId: user.userId,
    passwordHash: await bcrypt.hash(String(password), BCRYPT_ROUNDS),
    passwordChangedAt: new Date().toISOString(),
  }, traceContext);
  await repo.deleteSessionsForUser(user.userId, traceContext);

  logger.info({ userId: user.userId, actor }, 'admin.user.password_changed');
  return toUserDTO(user);
}

/** Switch attendance on or off for one person. Takes effect on their next
 *  attendance call (the server checks the flag every time); the portal's cached
 *  copy refreshes at their next login. */
async function setAttendance(userId, enabled, actor = null, traceContext = null) {
  const user = await repo.getUser(normEmail(userId), traceContext);
  if (!user) throw new NotFoundError('No such admin user', 'USER_NOT_FOUND');
  await repo.saveUser({ userId: user.userId, attendanceEnabled: !!enabled }, traceContext);
  logger.info({ userId: user.userId, enabled: !!enabled, actor }, 'admin.user.attendance_changed');
  return toUserDTO({ ...user, attendanceEnabled: !!enabled });
}

async function listUsers(traceContext = null) {
  const users = await repo.listUsers(traceContext);
  return users.map(toUserDTO).sort((a, b) => String(a.name).localeCompare(String(b.name)));
}

module.exports = {
  login, resolveSession, logout,
  createUser, setActive, setPassword, setAttendance, listUsers,
  can, toUserDTO, ROLES, ADMIN_ONLY, SESSION_HOURS, MIN_PASSWORD,
};
