'use strict';

// configController.js pulls in firestoreService/remoteConfigService/
// warehouseStatus/slackService/orderRepository at require-time, so all of
// them are mocked here even though pendingOrdersTick only touches
// orderRepository and slackService — otherwise requiring the real modules
// would hit live Firestore/env validation, same reasoning as
// schedulerAuth.test.js mocking ../../config/env directly rather than
// loading it for real.

jest.mock('../../config/env', () => ({
  appEnv: 'test',
  SLACK_BOT_TOKEN: undefined,
  SLACK_CHANNEL_ID: undefined,
}));
jest.mock('../../repositories/orderRepository', () => ({
  findOrders: jest.fn(),
}));
jest.mock('../../services/slackService', () => ({
  notifyWarehouseTransition: jest.fn(),
  notifyPendingOrders: jest.fn(),
}));
jest.mock('../../services/firestoreService', () => ({
  getSettings: jest.fn(),
  updateSettings: jest.fn(),
}));
jest.mock('../../services/remoteConfigService', () => ({
  getString: jest.fn(),
  getNumber: jest.fn(),
}));
jest.mock('../../utils/warehouseStatus', () => ({
  computeWarehouseStatus: jest.fn(),
  resolveClosedUntil: jest.fn(),
  resolveForceOpenUntil: jest.fn(),
}));

const { findOrders } = require('../../repositories/orderRepository');
const { notifyPendingOrders } = require('../../services/slackService');
const { pendingOrdersTick } = require('../configController');

function mockReq() {
  return { traceContext: null };
}
function mockRes() {
  const res = { statusCode: null, body: null };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (payload) => { res.body = payload; return res; };
  return res;
}

describe('pendingOrdersTick', () => {
  beforeEach(() => jest.clearAllMocks());

  test('zero pending orders: sends no Slack message, reports sent:false', async () => {
    findOrders.mockResolvedValue([]);
    const res = mockRes();

    await pendingOrdersTick(mockReq(), res);

    expect(notifyPendingOrders).not.toHaveBeenCalled();
    expect(res.body).toEqual({ success: true, data: { sent: false, pendingCount: 0 } });
  });

  test('non-zero pending orders: posts exactly once, reports sent:true + count, oldest-first', async () => {
    const orders = [
      { orderId: 'ORD2', createdAt: '2026-08-16T06:00:00.000Z', grand_total: 200 }, // newer
      { orderId: 'ORD1', createdAt: '2026-08-16T05:00:00.000Z', grand_total: 100 }, // older
    ];
    findOrders.mockResolvedValue([...orders]); // as returned: desc (newest first)
    notifyPendingOrders.mockResolvedValue('1699999999.000100');
    const res = mockRes();

    await pendingOrdersTick(mockReq(), res);

    expect(notifyPendingOrders).toHaveBeenCalledTimes(1);
    expect(notifyPendingOrders).toHaveBeenCalledWith([orders[1], orders[0]]); // reversed: oldest-first
    expect(res.body).toEqual({ success: true, data: { sent: true, pendingCount: 2 } });
  });

  test('Slack posting failure does not crash the endpoint (postMessage is best-effort)', async () => {
    findOrders.mockResolvedValue([{ orderId: 'ORD1', createdAt: '2026-08-16T05:00:00.000Z', grand_total: 100 }]);
    notifyPendingOrders.mockResolvedValue(null); // best-effort null-on-failure
    const res = mockRes();

    await pendingOrdersTick(mockReq(), res);

    expect(res.statusCode).toBeNull(); // default 200
    expect(res.body).toEqual({ success: true, data: { sent: true, pendingCount: 1 } });
  });

  test('a thrown error from findOrders is caught and returns 500', async () => {
    findOrders.mockRejectedValue(new Error('firestore unavailable'));
    const res = mockRes();

    await pendingOrdersTick(mockReq(), res);

    expect(res.statusCode).toBe(500);
    expect(res.body.success).toBe(false);
  });
});
