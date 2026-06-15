'use strict';

// Mock env before requiring the gateway (it reads creds at module load via env).
jest.mock('../../../config/env', () => ({
  RAZORPAY_KEY_ID: 'rzp_test_key',
  RAZORPAY_KEY_SECRET: 'secret',
  RAZORPAY_WEBHOOK_SECRET: 'whsec',
}));

// Mock axios so fetchStatus/createCheckout don't hit the network.
jest.mock('axios');
const axios = require('axios');

const gateway = require('../razorpayGateway');

describe('razorpayGateway.fetchStatus — Orders API', () => {
  beforeEach(() => jest.clearAllMocks());

  test('paid order → PAID and attempted=true', async () => {
    axios.get.mockResolvedValueOnce({
      data: { id: 'order_paid', status: 'paid', amount: 150000, amount_paid: 150000 },
    });

    const res = await gateway.fetchStatus({ providerOrderId: 'order_paid' });

    expect(res.status).toBe('PAID');
    expect(res.attempted).toBe(true);
    expect(res.amountPaidInPaise).toBe(150000);
    // Should not call /payments when order is already paid
    expect(axios.get).toHaveBeenCalledTimes(1);
  });

  test('created order with no payments → PENDING and attempted=false', async () => {
    axios.get
      .mockResolvedValueOnce({ data: { id: 'order_new', status: 'created', amount: 150000, amount_paid: 0 } })
      .mockResolvedValueOnce({ data: { items: [] } });

    const res = await gateway.fetchStatus({ providerOrderId: 'order_new' });

    expect(res.status).toBe('PENDING');
    expect(res.attempted).toBe(false);
  });

  test('attempted order with in-flight payment → PENDING and attempted=true', async () => {
    axios.get
      .mockResolvedValueOnce({ data: { id: 'order_inflight', status: 'attempted', amount: 150000, amount_paid: 0 } })
      .mockResolvedValueOnce({ data: { items: [{ status: 'created' }] } });

    const res = await gateway.fetchStatus({ providerOrderId: 'order_inflight' });

    expect(res.status).toBe('PENDING');
    expect(res.attempted).toBe(true);
  });

  test('all payments failed → FAILED', async () => {
    axios.get
      .mockResolvedValueOnce({ data: { id: 'order_fail', status: 'attempted', amount: 150000, amount_paid: 0 } })
      .mockResolvedValueOnce({ data: { items: [{ status: 'failed' }, { status: 'failed' }] } });

    const res = await gateway.fetchStatus({ providerOrderId: 'order_fail' });

    expect(res.status).toBe('FAILED');
    expect(res.attempted).toBe(true);
  });

  test('payments list has a captured payment → PAID', async () => {
    axios.get
      .mockResolvedValueOnce({ data: { id: 'order_cap', status: 'attempted', amount: 150000, amount_paid: 0 } })
      .mockResolvedValueOnce({ data: { items: [{ status: 'captured' }] } });

    const res = await gateway.fetchStatus({ providerOrderId: 'order_cap' });

    expect(res.status).toBe('PAID');
    expect(res.attempted).toBe(true);
  });
});

describe('razorpayGateway.createCheckout — Orders API', () => {
  beforeEach(() => jest.clearAllMocks());

  test('calls /v1/orders and returns client object with keyId/amount/currency/prefill/notes', async () => {
    let capturedUrl, capturedBody;
    axios.post.mockImplementation((url, body) => {
      capturedUrl = url;
      capturedBody = body;
      return Promise.resolve({ data: { id: 'order_abc', receipt: 'ord_1' } });
    });

    const result = await gateway.createCheckout({
      orderId: 'ord_1',
      amountInPaise: 150000,
      currency: 'INR',
      customer: { customerPhone: '9876543210', customerName: 'Murali', customerEmail: '' },
      returnUrl: 'https://api.example.com/return',
    });

    expect(capturedUrl).toMatch(/\/v1\/orders$/);
    expect(capturedBody.amount).toBe(150000);
    expect(capturedBody.receipt).toBe('ord_1');
    expect(capturedBody.notes.internalOrderId).toBe('ord_1');

    expect(result.providerOrderId).toBe('order_abc');
    expect(result.paymentUrl).toBe('');
    expect(result.client.keyId).toBe('rzp_test_key');
    expect(result.client.amount).toBe(150000);
    expect(result.client.currency).toBe('INR');
    expect(result.client.prefill.contact).toBe('+919876543210');
    expect(result.client.prefill.name).toBe('Murali');
    expect(result.client.prefill.email).toBeUndefined(); // empty email omitted
    expect(result.client.notes.internalOrderId).toBe('ord_1');
  });

  test('omits prefill entirely when customer has no data', async () => {
    axios.post.mockResolvedValue({ data: { id: 'order_xyz', receipt: 'ord_2' } });

    const result = await gateway.createCheckout({
      orderId: 'ord_2',
      amountInPaise: 50000,
      currency: 'INR',
      customer: { customerPhone: '', customerName: '', customerEmail: '' },
    });

    expect(result.client.prefill).toBeUndefined();
  });

  test('normalizes phone to E.164 in prefill.contact', async () => {
    let capturedBody;
    axios.post.mockImplementation((_url, body) => {
      capturedBody = body;
      return Promise.resolve({ data: { id: 'order_ph', receipt: 'ord_3' } });
    });

    await gateway.createCheckout({
      orderId: 'ord_3',
      amountInPaise: 100000,
      currency: 'INR',
      customer: { customerPhone: '9884857261' },
    });

    // Phone is in prefill (client), not in the Orders API body
    expect(capturedBody.customer).toBeUndefined();
    const res = await gateway.createCheckout({
      orderId: 'ord_3',
      amountInPaise: 100000,
      currency: 'INR',
      customer: { customerPhone: '9884857261' },
    });
    expect(res.client.prefill.contact).toBe('+919884857261');
  });
});

describe('razorpayGateway.verifyWebhook — Orders API events', () => {
  const crypto = require('crypto');

  function makeSignature(body) {
    return crypto.createHmac('sha256', 'whsec').update(body).digest('hex');
  }

  test('payment.captured event → PAYMENT_SUCCESS with providerOrderId and internalOrderId', () => {
    const payload = {
      event: 'payment.captured',
      payload: {
        payment: {
          entity: {
            id: 'pay_123',
            order_id: 'order_abc',
            amount: 150000,
            status: 'captured',
            notes: { internalOrderId: 'ORD-001' },
          },
        },
      },
    };
    const body = JSON.stringify(payload);
    const sig = makeSignature(body);

    const result = gateway.verifyWebhook({ rawBody: body, headers: { 'x-razorpay-signature': sig } });

    expect(result.isValid).toBe(true);
    expect(result.event).toBe('PAYMENT_SUCCESS');
    expect(result.providerOrderId).toBe('order_abc');
    expect(result.internalOrderId).toBe('ORD-001');
    expect(result.amountInPaise).toBe(150000);
  });

  test('payment.failed event → PAYMENT_FAILED', () => {
    const payload = {
      event: 'payment.failed',
      payload: {
        payment: {
          entity: { id: 'pay_456', order_id: 'order_def', amount: 50000, status: 'failed', notes: { internalOrderId: 'ORD-002' } },
        },
      },
    };
    const body = JSON.stringify(payload);
    const sig = makeSignature(body);

    const result = gateway.verifyWebhook({ rawBody: body, headers: { 'x-razorpay-signature': sig } });

    expect(result.isValid).toBe(true);
    expect(result.event).toBe('PAYMENT_FAILED');
    expect(result.providerOrderId).toBe('order_def');
    expect(result.internalOrderId).toBe('ORD-002');
  });

  test('order.paid event → PAYMENT_SUCCESS with order entity', () => {
    const payload = {
      event: 'order.paid',
      payload: {
        order: {
          entity: { id: 'order_ghi', amount_paid: 200000, status: 'paid', notes: { internalOrderId: 'ORD-003' } },
        },
      },
    };
    const body = JSON.stringify(payload);
    const sig = makeSignature(body);

    const result = gateway.verifyWebhook({ rawBody: body, headers: { 'x-razorpay-signature': sig } });

    expect(result.isValid).toBe(true);
    expect(result.event).toBe('PAYMENT_SUCCESS');
    expect(result.providerOrderId).toBe('order_ghi');
    expect(result.internalOrderId).toBe('ORD-003');
    expect(result.amountInPaise).toBe(200000);
  });

  test('invalid signature → isValid=false', () => {
    const body = JSON.stringify({ event: 'payment.captured' });
    const result = gateway.verifyWebhook({ rawBody: body, headers: { 'x-razorpay-signature': 'badsig' } });
    expect(result.isValid).toBe(false);
  });
});
