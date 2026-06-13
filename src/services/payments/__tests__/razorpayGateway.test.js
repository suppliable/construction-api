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

describe('razorpayGateway.fetchStatus — abandonment detection', () => {
  beforeEach(() => jest.clearAllMocks());

  // The bug: closing an unpaid Razorpay link still placed the order, because
  // a `created` link reports PENDING and the client proceeded-as-pending.
  // fetchStatus must report attempted=false for a link nobody paid, so
  // /verify can refuse to proceed.
  test('created link with no payments → PENDING and attempted=false', async () => {
    axios.get.mockResolvedValue({
      data: {
        id: 'plink_abandon',
        status: 'created',
        amount: 150000,
        amount_paid: 0,
        payments: null, // Razorpay returns null/absent when nothing attempted
      },
    });

    const res = await gateway.fetchStatus({ providerOrderId: 'plink_abandon' });

    expect(res.status).toBe('PENDING');
    expect(res.attempted).toBe(false);
    expect(res.amountPaidInPaise).toBe(0);
  });

  test('created link with an in-flight payment entity → attempted=true', async () => {
    axios.get.mockResolvedValue({
      data: {
        id: 'plink_inflight',
        status: 'created',
        amount: 150000,
        amount_paid: 0,
        payments: [{ payment_id: 'pay_1', status: 'created' }],
      },
    });

    const res = await gateway.fetchStatus({ providerOrderId: 'plink_inflight' });

    expect(res.status).toBe('PENDING');
    expect(res.attempted).toBe(true);
  });

  test('paid link → PAID and attempted=true', async () => {
    axios.get.mockResolvedValue({
      data: {
        id: 'plink_paid',
        status: 'paid',
        amount: 150000,
        amount_paid: 150000,
        payments: [{ payment_id: 'pay_2', status: 'captured' }],
      },
    });

    const res = await gateway.fetchStatus({ providerOrderId: 'plink_paid' });

    expect(res.status).toBe('PAID');
    expect(res.attempted).toBe(true);
    expect(res.amountPaidInPaise).toBe(150000);
  });

  test('expired link → FAILED', async () => {
    axios.get.mockResolvedValue({
      data: { id: 'plink_exp', status: 'expired', amount: 150000, amount_paid: 0 },
    });

    const res = await gateway.fetchStatus({ providerOrderId: 'plink_exp' });
    expect(res.status).toBe('FAILED');
  });
});

describe('razorpayGateway.createCheckout — customer.contact from request', () => {
  beforeEach(() => jest.clearAllMocks());

  test('normalizes a phone passed from the client into E.164 contact', async () => {
    let sentBody;
    axios.post.mockImplementation((_url, body) => {
      sentBody = body;
      return Promise.resolve({ data: { id: 'plink_x', short_url: 'https://rzp.io/x' } });
    });

    await gateway.createCheckout({
      orderId: 'ord_1',
      amountInPaise: 150000,
      currency: 'INR',
      customer: { customerPhone: '9876543210', customerName: 'Murali' },
      returnUrl: 'https://api.example.com/api/v1/payments/return?orderId=ord_1',
    });

    expect(sentBody.customer.contact).toBe('+919876543210');
    expect(sentBody.customer.name).toBe('Murali');
    // notify must be off — fulfilment is webhook-driven.
    expect(sentBody.notify).toEqual({ sms: false, email: false });
  });

  test('omits contact entirely when phone is missing (Razorpay rejects empty)', async () => {
    let sentBody;
    axios.post.mockImplementation((_url, body) => {
      sentBody = body;
      return Promise.resolve({ data: { id: 'plink_y', short_url: 'https://rzp.io/y' } });
    });

    await gateway.createCheckout({
      orderId: 'ord_2',
      amountInPaise: 150000,
      currency: 'INR',
      customer: { customerPhone: '' },
      returnUrl: 'https://api.example.com/return',
    });

    expect(sentBody.customer.contact).toBeUndefined();
  });
});
