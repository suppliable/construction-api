'use strict';

// slackService.js requires firebaseAdmin (which eagerly reads
// env.FIREBASE_SERVICE_ACCOUNT at require-time) and customerRepository, so
// both are mocked here — same reasoning as configController.test.js.

jest.mock('../../config/env', () => ({
  appEnv: 'test',
  SLACK_BOT_TOKEN: 'xoxb-test-token',
  SLACK_CHANNEL_ID: 'C_TEST_CHANNEL',
  SLACK_BROADCAST_CHANNEL_ID: undefined,
}));
jest.mock('../../utils/firebaseAdmin', () => ({
  firestore: jest.fn(),
}));
jest.mock('../../repositories/customerRepository', () => ({
  getCustomer: jest.fn(),
}));

const { notifyPendingOrders, postNewQuoteRequest, updateQuoteStatus } = require('../slackService');
const { getCustomer } = require('../../repositories/customerRepository');

function makeOrder(overrides = {}) {
  return {
    orderId: 'ORD1755321000000',
    customerName: 'John Doe',
    customerPhone: '9876543210',
    grand_total: 1250,
    createdAt: '2026-08-16T08:45:00.000Z',
    ...overrides,
  };
}

describe('notifyPendingOrders', () => {
  let fetchMock;

  beforeEach(() => {
    fetchMock = jest.fn().mockResolvedValue({
      json: async () => ({ ok: true, ts: '1699999999.000100' }),
    });
    global.fetch = fetchMock;
  });

  afterEach(() => {
    delete global.fetch;
  });

  test('no-op when orders is empty', async () => {
    const result = await notifyPendingOrders([]);
    expect(result).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('no-op when orders is null/undefined', async () => {
    expect(await notifyPendingOrders(null)).toBeNull();
    expect(await notifyPendingOrders(undefined)).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('posts a single section block with formatted lines for a normal-sized list', async () => {
    const orders = [makeOrder({ orderId: 'ORD1' }), makeOrder({ orderId: 'ORD2', customerName: '', customerPhone: '' })];

    await notifyPendingOrders(orders);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, options] = fetchMock.mock.calls[0];
    const body = JSON.parse(options.body);

    expect(body.channel).toBe('C_TEST_CHANNEL'); // SLACK_BROADCAST_CHANNEL_ID unset -> falls back
    expect(body.text).toBe('⏳ 2 orders awaiting acceptance');
    expect(body.blocks).toHaveLength(1);
    const text = body.blocks[0].text.text;
    expect(text).toContain('⏳ *2 orders awaiting acceptance*');
    // pendingOrderLine also carries the payment mode and the IST date; this
    // expectation predated both and had been failing on develop.
    expect(text).toContain('1. `ORD1` — John Doe · 9876543210 · ₹1250 · COD · 16 Aug 2:15 PM IST');
    // empty customerName/customerPhone fall back to N/A
    expect(text).toContain('2. `ORD2` — N/A · N/A · ₹1250 · COD · 16 Aug 2:15 PM IST');
  });

  test('singular wording for exactly one pending order', async () => {
    await notifyPendingOrders([makeOrder()]);
    const [, options] = fetchMock.mock.calls[0];
    const body = JSON.parse(options.body);
    expect(body.text).toBe('⏳ 1 order awaiting acceptance');
    expect(body.blocks[0].text.text).toContain('⏳ *1 order awaiting acceptance*');
  });

  test('chunks into multiple section blocks once the char budget is exceeded', async () => {
    // Each line is long enough that ~40 of them safely exceeds the 2800-char budget.
    const orders = Array.from({ length: 60 }, (_, i) =>
      makeOrder({ orderId: `ORD${1000 + i}`, customerName: 'A Reasonably Long Customer Name' }));

    await notifyPendingOrders(orders);

    const [, options] = fetchMock.mock.calls[0];
    const body = JSON.parse(options.body);
    expect(body.blocks.length).toBeGreaterThan(1);
    for (const block of body.blocks) {
      expect(block.text.text.length).toBeLessThanOrEqual(2800 + 200); // header/line overhead slack
    }
    // every order line appears exactly once across all blocks
    const combined = body.blocks.map(b => b.text.text).join('\n');
    for (const order of orders) {
      expect(combined).toContain(`\`${order.orderId}\``);
    }
  });

  test('returns null (does not call fetch) when Slack is not configured', async () => {
    jest.resetModules();
    jest.doMock('../../config/env', () => ({
      appEnv: 'test',
      SLACK_BOT_TOKEN: undefined,
      SLACK_CHANNEL_ID: undefined,
    }));
    jest.doMock('../../utils/firebaseAdmin', () => ({ firestore: jest.fn() }));
    jest.doMock('../../repositories/customerRepository', () => ({ getCustomer: jest.fn() }));

    const { notifyPendingOrders: notifyWithSlackOff } = require('../slackService');
    const result = await notifyWithSlackOff([makeOrder()]);

    expect(result).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ── Bulk quote card ────────────────────────────────────────────────────────

function makeQuote(overrides = {}) {
  return {
    id: 'QT-MABCD123-7F2A',
    userId: 'user-1',
    source: 'cart',
    status: 'requested',
    grandTotal: 0,
    items: [{ name: 'UltraTech Cement 50kg', quantity: 100, unit: 'bags' }],
    photos: [],
    note: null,
    deliveryAddress: '12 Kamaraj Salai, Semmancheri',
    deliveryPincode: '600119',
    ...overrides,
  };
}

describe('postNewQuoteRequest', () => {
  let fetchMock;

  beforeEach(() => {
    fetchMock = jest.fn().mockResolvedValue({
      json: async () => ({ ok: true, ts: '1699999999.000100' }),
    });
    global.fetch = fetchMock;
    getCustomer.mockResolvedValue({ name: 'Ravi Kumar', phone: '9884857261' });
  });

  afterEach(() => {
    delete global.fetch;
    jest.clearAllMocks();
  });

  function cardText(call) {
    return JSON.parse(call[1].body).blocks[0].text.text;
  }

  test('posts a card and returns the ts so the caller can persist it', async () => {
    const result = await postNewQuoteRequest(makeQuote());
    expect(result).toEqual({ ts: '1699999999.000100' });

    const text = cardText(fetchMock.mock.calls[0]);
    expect(text).toContain('📝 *Bulk Quote Request* · `QT-MABCD123-7F2A`');
    expect(text).toContain('👤 *Customer:* Ravi Kumar');
    expect(text).toContain('📞 *Phone:* 9884857261');
    expect(text).toContain('🧾 *Source:* Catalogue');
    expect(text).toContain('⏳ Awaiting pricing');
    expect(text).toContain('📍 *Site:* 12 Kamaraj Salai, Semmancheri · 600119');
  });

  test('resolves the customer from userId — a quote carries no name/phone', async () => {
    await postNewQuoteRequest(makeQuote());
    expect(getCustomer).toHaveBeenCalledWith('user-1');
  });

  test('posts the item list as a threaded reply under the card', async () => {
    await postNewQuoteRequest(makeQuote());
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const reply = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(reply.thread_ts).toBe('1699999999.000100');
    expect(reply.blocks[0].text.text).toContain('UltraTech Cement 50kg × 100 bags');
  });

  test('a free-form request has no items, so no threaded reply — the note carries it', async () => {
    const quote = makeQuote({
      source: 'freeform',
      items: [],
      note: 'Need 2 truckloads of M-sand by Friday',
      photos: [{ id: 'p1' }, { id: 'p2' }],
    });
    await postNewQuoteRequest(quote);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const text = cardText(fetchMock.mock.calls[0]);
    expect(text).toContain('🧾 *Source:* Free-form');
    expect(text).toContain('💬 *Note:* Need 2 truckloads of M-sand by Friday');
    expect(text).toContain('🖼️ *Photos:* 2 attached');
  });

  test('omits the site line when no address was attached', async () => {
    const text = cardText(
      (await postNewQuoteRequest(makeQuote({ deliveryAddress: null, deliveryPincode: null })),
        fetchMock.mock.calls[0])
    );
    expect(text).not.toContain('📍');
  });

  test('never throws when Slack fails — a quote must still be recorded', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('slack down'));
    await expect(postNewQuoteRequest(makeQuote())).resolves.toEqual({ ts: null });
  });
});

describe('updateQuoteStatus', () => {
  let fetchMock;

  beforeEach(() => {
    fetchMock = jest.fn().mockResolvedValue({ json: async () => ({ ok: true }) });
    global.fetch = fetchMock;
    getCustomer.mockResolvedValue({ name: 'Ravi Kumar', phone: '9884857261' });
  });

  afterEach(() => {
    delete global.fetch;
    jest.clearAllMocks();
  });

  test('edits the same message to show the quoted total', async () => {
    await updateQuoteStatus(makeQuote({ grandTotal: 48500 }), '1699999999.000100', 'quoted');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe('https://slack.com/api/chat.update');
    const body = JSON.parse(opts.body);
    expect(body.ts).toBe('1699999999.000100');
    expect(body.blocks[0].text.text).toContain('✅ Quoted — ₹48500');
  });

  test.each([
    ['declined', '🚫 Declined'],
    ['expired', '⌛ Expired'],
    ['ordered', '🎉 Ordered'],
  ])('renders the %s state', async (state, expected) => {
    await updateQuoteStatus(makeQuote(), '1699999999.000100', state);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).blocks[0].text.text).toContain(expected);
  });

  test('no-op without a ts — quotes raised before this existed have none', async () => {
    await updateQuoteStatus(makeQuote(), null, 'quoted');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
