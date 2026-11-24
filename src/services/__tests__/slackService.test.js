'use strict';

// slackService.js requires firebaseAdmin (which eagerly reads
// env.FIREBASE_SERVICE_ACCOUNT at require-time) and customerRepository, so
// both are mocked here — same reasoning as configController.test.js.

jest.mock('../../config/env', () => ({
  appEnv: 'test',
  SLACK_BOT_TOKEN: 'xoxb-test-token',
  SLACK_CHANNEL_ID: 'C_TEST_CHANNEL',
  SLACK_BROADCAST_CHANNEL_ID: undefined,
  SLACK_ATTENDANCE_CHANNEL_ID: 'C_ATTENDANCE',
}));
jest.mock('../../utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../../utils/firebaseAdmin', () => ({
  firestore: jest.fn(),
}));
jest.mock('../../repositories/customerRepository', () => ({
  getCustomer: jest.fn(),
}));

const { notifyPendingOrders, postNewQuoteRequest, updateQuoteStatus, postAttendanceIn, postAttendanceOut } = require('../slackService');
const logger = require('../../utils/logger');
const env = require('../../config/env');
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


// ── Attendance ─────────────────────────────────────────────────────────────

describe('attendance posts', () => {
  let fetchMock;
  const inRecord = (over = {}) => ({
    name: 'Ravi', inAt: '2026-11-24T03:32:00.000Z', inVerdict: 'inside', ...over,
  });

  beforeEach(() => {
    jest.clearAllMocks();
    env.SLACK_ATTENDANCE_CHANNEL_ID = 'C_ATTENDANCE';
    fetchMock = jest.fn().mockResolvedValue({ json: async () => ({ ok: true, ts: '555.666' }) });
    global.fetch = fetchMock;
  });
  afterEach(() => { delete global.fetch; });

  const body = call => JSON.parse(fetchMock.mock.calls[call][1].body);

  test('clock-in posts to the ATTENDANCE channel, not the order channel', async () => {
    const ts = await postAttendanceIn(inRecord());
    expect(ts).toBe('555.666');
    expect(body(0).channel).toBe('C_ATTENDANCE');
    expect(body(0).channel).not.toBe('C_TEST_CHANNEL');
    expect(body(0).blocks[0].text.text).toBe('🟢 *Ravi* — In at 9:02 AM');
  });

  test('a normal in-shop clock-in is just the time — no flag line', async () => {
    await postAttendanceIn(inRecord());
    expect(body(0).blocks[0].text.text).not.toContain('⚠️');
  });

  test('an outside clock-in carries the distance', async () => {
    await postAttendanceIn(inRecord({ inVerdict: 'outside', inDistanceM: 4200 }));
    expect(body(0).blocks[0].text.text).toContain('⚠️ Outside geofence — 4.2 km away');
  });

  test('an unverified one says why', async () => {
    await postAttendanceIn(inRecord({ inVerdict: 'unverified', inReason: 'no_location' }));
    expect(body(0).blocks[0].text.text).toContain('⚠️ Location unverified — location unavailable or permission denied');
  });

  test('clock-out is a THREADED reply under the clock-in', async () => {
    await postAttendanceOut(
      { name: 'Ravi', outAt: '2026-11-24T13:18:00.000Z', outSource: 'button', slackTs: '111.222' }, 586);
    expect(body(0).thread_ts).toBe('111.222');
    expect(body(0).blocks[0].text.text).toBe('🔴 Out at 6:48 PM · 9h 46m');
  });

  test('an auto clock-out is labelled, so a late-appearing reply still reads correctly', async () => {
    await postAttendanceOut(
      { name: 'Ravi', outAt: '2026-11-24T14:30:00.000Z', outSource: 'auto', slackTs: '111.222' }, 660);
    expect(body(0).blocks[0].text.text).toContain('_(auto)_');
  });

  test('with no thread to reply into it posts standalone and names the person', async () => {
    await postAttendanceOut({ name: 'Ravi', outAt: '2026-11-24T13:18:00.000Z', outSource: 'button', slackTs: null }, 586);
    expect(body(0).thread_ts).toBeUndefined();
    expect(body(0).blocks[0].text.text).toContain('*Ravi*');
  });

  test('does NOTHING without an attendance channel — it must not fall back to orders', async () => {
    env.SLACK_ATTENDANCE_CHANNEL_ID = undefined;
    expect(await postAttendanceIn(inRecord())).toBeNull();
    expect(await postAttendanceOut({ name: 'Ravi', outAt: '2026-11-24T13:18:00.000Z' }, 1)).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('slack failures are visible', () => {
  beforeEach(() => { jest.clearAllMocks(); env.SLACK_ATTENDANCE_CHANNEL_ID = 'C_ATTENDANCE'; });
  afterEach(() => { delete global.fetch; });

  test('a rejection from Slack is logged with its reason — not_in_channel is the likely one', async () => {
    // Slack answers 200 { ok:false } when the bot was never invited. Returning
    // null silently made that look identical to a working channel with nothing
    // to say.
    global.fetch = jest.fn().mockResolvedValue({ json: async () => ({ ok: false, error: 'not_in_channel' }) });
    const ts = await postAttendanceIn({ name: 'Ravi', inAt: '2026-11-24T03:32:00.000Z' });
    expect(ts).toBeNull();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ slackError: 'not_in_channel', channel: 'C_ATTENDANCE' }), 'slack.post_failed');
  });

  test('a network failure is logged and swallowed', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('ECONNRESET'));
    await expect(postAttendanceIn({ name: 'Ravi', inAt: '2026-11-24T03:32:00.000Z' })).resolves.toBeNull();
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ err: 'ECONNRESET' }), 'slack.post_threw');
  });
});
