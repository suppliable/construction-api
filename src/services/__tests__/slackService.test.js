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

const { notifyPendingOrders } = require('../slackService');

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
    expect(text).toContain('1. `ORD1` — John Doe · 9876543210 · ₹1250 · 2:15 PM IST');
    // empty customerName/customerPhone fall back to N/A
    expect(text).toContain('2. `ORD2` — N/A · N/A · ₹1250 · 2:15 PM IST');
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
