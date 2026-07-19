'use strict';

// The middleware reads config at call time and verifies tokens via
// google-auth-library, so both are mocked: these tests cover the authorization
// decisions, not Google's signature checking.

const mockVerifyIdToken = jest.fn();

jest.mock('google-auth-library', () => ({
  OAuth2Client: jest.fn().mockImplementation(() => ({ verifyIdToken: mockVerifyIdToken })),
}));

jest.mock('../../config/env', () => ({
  SCHEDULER_SERVICE_ACCOUNT_EMAIL: undefined,
  SCHEDULER_OIDC_AUDIENCE: undefined,
}));

jest.mock('../../utils/logger', () => ({ warn: jest.fn(), error: jest.fn(), info: jest.fn() }));

const env = require('../../config/env');
const { requireScheduler } = require('../schedulerAuth');

const EXPECTED_SA = 'warehouse-scheduler@suppliable-app.iam.gserviceaccount.com';

function mockReq(headers = {}) {
  const lower = {};
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v;
  return {
    headers: lower,
    get: (name) => lower[name.toLowerCase()],
  };
}

function mockRes() {
  const res = { statusCode: null, body: null };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (payload) => { res.body = payload; return res; };
  return res;
}

const authedReq = (token = 'a.b.c') =>
  mockReq({ authorization: `Bearer ${token}`, host: 'construction-api-xyz.a.run.app' });

beforeEach(() => {
  jest.clearAllMocks();
  env.SCHEDULER_SERVICE_ACCOUNT_EMAIL = EXPECTED_SA;
  env.SCHEDULER_OIDC_AUDIENCE = undefined;
});

describe('requireScheduler — configuration', () => {
  test('refuses with 503 when the expected service account is unset', async () => {
    env.SCHEDULER_SERVICE_ACCOUNT_EMAIL = undefined;
    const res = mockRes();
    const next = jest.fn();

    await requireScheduler(authedReq(), res, next);

    // Closed, not open: a misconfigured deploy must not expose the endpoint.
    expect(res.statusCode).toBe(503);
    expect(next).not.toHaveBeenCalled();
    expect(mockVerifyIdToken).not.toHaveBeenCalled();
  });
});

describe('requireScheduler — token presence', () => {
  test.each([
    ['no authorization header', {}],
    ['non-bearer scheme', { authorization: 'Basic abc123' }],
    ['bearer with empty token', { authorization: 'Bearer ' }],
  ])('rejects %s with 401', async (_label, headers) => {
    const res = mockRes();
    const next = jest.fn();

    await requireScheduler(mockReq({ host: 'x.a.run.app', ...headers }), res, next);

    expect(res.statusCode).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });
});

describe('requireScheduler — audience pinning', () => {
  test('verifies against the request host when no override is set', async () => {
    mockVerifyIdToken.mockResolvedValue({
      getPayload: () => ({ email: EXPECTED_SA, email_verified: true }),
    });
    const next = jest.fn();

    await requireScheduler(authedReq(), mockRes(), next);

    expect(mockVerifyIdToken).toHaveBeenCalledWith(
      expect.objectContaining({ audience: 'https://construction-api-xyz.a.run.app' })
    );
    expect(next).toHaveBeenCalled();
  });

  test('SCHEDULER_OIDC_AUDIENCE overrides the derived host', async () => {
    env.SCHEDULER_OIDC_AUDIENCE = 'https://api.suppliable.com';
    mockVerifyIdToken.mockResolvedValue({
      getPayload: () => ({ email: EXPECTED_SA, email_verified: true }),
    });

    await requireScheduler(authedReq(), mockRes(), jest.fn());

    expect(mockVerifyIdToken).toHaveBeenCalledWith(
      expect.objectContaining({ audience: 'https://api.suppliable.com' })
    );
  });

  test('refuses when the audience cannot be determined', async () => {
    const res = mockRes();
    const next = jest.fn();

    // No Host header and no override — never verify against an unknown audience.
    await requireScheduler(mockReq({ authorization: 'Bearer a.b.c' }), res, next);

    expect(res.statusCode).toBe(401);
    expect(mockVerifyIdToken).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
  });
});

describe('requireScheduler — caller identity', () => {
  test('accepts the expected service account', async () => {
    mockVerifyIdToken.mockResolvedValue({
      getPayload: () => ({ email: EXPECTED_SA, email_verified: true }),
    });
    const res = mockRes();
    const next = jest.fn();

    await requireScheduler(authedReq(), res, next);

    expect(next).toHaveBeenCalled();
    expect(res.statusCode).toBeNull();
  });

  test('rejects a valid Google token from a different service account with 403', async () => {
    // The signature is fine — this is some other identity in the project.
    mockVerifyIdToken.mockResolvedValue({
      getPayload: () => ({ email: 'someone-else@suppliable-app.iam.gserviceaccount.com', email_verified: true }),
    });
    const res = mockRes();
    const next = jest.fn();

    await requireScheduler(authedReq(), res, next);

    expect(res.statusCode).toBe(403);
    expect(next).not.toHaveBeenCalled();
  });

  test('rejects an unverified email even when it matches', async () => {
    mockVerifyIdToken.mockResolvedValue({
      getPayload: () => ({ email: EXPECTED_SA, email_verified: false }),
    });
    const res = mockRes();
    const next = jest.fn();

    await requireScheduler(authedReq(), res, next);

    expect(res.statusCode).toBe(403);
    expect(next).not.toHaveBeenCalled();
  });

  test('rejects an empty payload', async () => {
    mockVerifyIdToken.mockResolvedValue({ getPayload: () => null });
    const res = mockRes();
    const next = jest.fn();

    await requireScheduler(authedReq(), res, next);

    expect(res.statusCode).toBe(403);
    expect(next).not.toHaveBeenCalled();
  });

  test('rejects a token that fails signature verification with 401', async () => {
    mockVerifyIdToken.mockRejectedValue(new Error('Invalid token signature'));
    const res = mockRes();
    const next = jest.fn();

    await requireScheduler(authedReq('forged.token.here'), res, next);

    expect(res.statusCode).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });
});
