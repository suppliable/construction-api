'use strict';

// An expired token left in a tab used to bounce it between the login page and
// Orders forever: pages send a 401 to login without clearing the token, and
// login forwarded on the token's mere presence. Runs the page's own script.

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const html = fs.readFileSync(path.join(__dirname, '../../../admin-portal/login.html'), 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];

async function open({ token, fetchImpl }) {
  const store = new Map(token ? [['adminToken', token], ['adminUser', '{}']] : []);
  const els = {};
  const el = id => els[id] || (els[id] = { value: '', textContent: '', shown: false,
    addEventListener() {}, classList: { add() { els[id].shown = true; }, remove() { els[id].shown = false; } } });
  const goneTo = [];
  const ctx = {
    window: { location: { origin: 'https://x', replace: u => goneTo.push(u), set href(u) { goneTo.push(u); } } },
    sessionStorage: { getItem: k => store.get(k) ?? null, setItem: (k, v) => store.set(k, v), removeItem: k => store.delete(k) },
    document: { getElementById: el },
    fetch: jest.fn(fetchImpl),
  };
  vm.createContext(ctx);
  vm.runInContext(script, ctx);
  await new Promise(resolve => setImmediate(resolve));
  return { store, els, goneTo, fetch: ctx.fetch };
}

test('a valid session goes on to Orders', async () => {
  const p = await open({ token: 't', fetchImpl: async () => ({ ok: true, status: 200 }) });
  expect(p.goneTo).toEqual(['orders.html']);
  expect(p.fetch).toHaveBeenCalledWith('https://x/api/v1/admin/me', { headers: { Authorization: 'Bearer t' } });
});

test('an expired session stays here, drops the token and says why', async () => {
  const p = await open({ token: 't', fetchImpl: async () => ({ ok: false, status: 401 }) });
  expect(p.goneTo).toEqual([]);
  expect(p.store.size).toBe(0);
  expect(p.els.errorMsg.textContent).toMatch(/session ended/i);
});

test.each([
  ['a server error', async () => ({ ok: false, status: 503 })],
  ['no connection', async () => { throw new Error('offline'); }],
])('%s keeps the token and does not redirect', async (_name, fetchImpl) => {
  const p = await open({ token: 't', fetchImpl });
  expect(p.goneTo).toEqual([]);
  expect(p.store.get('adminToken')).toBe('t');
});

test('no token: nothing is asked of the server', async () => {
  const p = await open({ fetchImpl: async () => ({ ok: true }) });
  expect(p.fetch).not.toHaveBeenCalled();
  expect(p.goneTo).toEqual([]);
});
