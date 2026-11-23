'use strict';

// A Zoho access token can be rejected BEFORE its 55-minute cache window ends:
// Zoho caps how many are live per refresh token and drops the oldest, so
// anything else minting against the same refresh token kills this process's
// copy. The cache was trusted until expiry, so one rejected token took the
// whole catalogue down for up to 55 minutes — products, categories, bulk,
// margins and low stock all 401'd at once, with no path back but a restart.

let rejectedHandler = null;
const mockAxios = jest.fn();

jest.mock('axios', () => {
  const fn = (...args) => mockAxios(...args);
  fn.post = jest.fn();
  fn.get = jest.fn();
  fn.put = jest.fn();
  fn.delete = jest.fn();
  fn.interceptors = {
    response: { use: (_ok, rejected) => { rejectedHandler = rejected; } },
    request: { use: jest.fn() },
  };
  return fn;
});
jest.mock('../../utils/firebaseAdmin', () => ({
  firestore: jest.fn(), auth: jest.fn(), database: jest.fn(),
}));
jest.mock('../../utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const axios = require('axios');
const { clearAccessToken } = require('../zohoService');   // installs the interceptor

const zohoErr = (status, config) => ({ response: { status }, config });

beforeEach(() => {
  jest.clearAllMocks();
  clearAccessToken();
  axios.post.mockResolvedValue({ data: { access_token: 'FRESH' } });
  mockAxios.mockResolvedValue({ data: { ok: true } });
});

describe('Zoho 401 retry', () => {
  test('mints a fresh token and replays the request once', async () => {
    const config = {
      url: 'https://www.zohoapis.in/books/v3/bills',
      headers: { Authorization: 'Zoho-oauthtoken STALE' },
    };
    await expect(rejectedHandler(zohoErr(401, config))).resolves.toEqual({ data: { ok: true } });

    expect(axios.post).toHaveBeenCalledTimes(1);                       // refreshed
    expect(config.headers.Authorization).toBe('Zoho-oauthtoken FRESH'); // header swapped
    expect(mockAxios).toHaveBeenCalledWith(config);                     // replayed
  });

  test('the replay is marked, so a genuine 401 still surfaces', async () => {
    const config = { url: 'https://www.zohoapis.in/inventory/v1/items', headers: {} };
    await rejectedHandler(zohoErr(401, config));
    expect(config.__zohoAuthRetried).toBe(true);

    await expect(rejectedHandler(zohoErr(401, config))).rejects.toBeDefined();
    expect(axios.post).toHaveBeenCalledTimes(1);   // not refreshed a second time
  });

  test('a non-401 is passed straight through', async () => {
    const config = { url: 'https://www.zohoapis.in/books/v3/bills' };
    await expect(rejectedHandler(zohoErr(500, config))).rejects.toBeDefined();
    expect(axios.post).not.toHaveBeenCalled();
    expect(config.__zohoAuthRetried).toBeUndefined();
  });

  test('ignores 401s that are not from a Zoho API host', async () => {
    // accounts.zoho.in is the token endpoint itself — matching it would make
    // the interceptor recurse while refreshing.
    for (const url of ['https://accounts.zoho.in/oauth/v2/token', 'https://control.msg91.com/api/v5/otp']) {
      const config = { url };
      await expect(rejectedHandler(zohoErr(401, config))).rejects.toBeDefined();
      expect(config.__zohoAuthRetried).toBeUndefined();
    }
    expect(axios.post).not.toHaveBeenCalled();
  });

  test('a request with no config is passed through rather than crashing the handler', async () => {
    await expect(rejectedHandler({ response: { status: 401 } })).rejects.toBeDefined();
  });
});
