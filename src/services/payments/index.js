'use strict';

const env = require('../../config/env');

let cached;

function getGateway() {
  if (cached) return cached;
  switch (env.PAYMENT_GATEWAY) {
    case 'cashfree':
      cached = require('./cashfreeGateway');
      return cached;
    case 'razorpay':
      cached = require('./razorpayGateway');
      return cached;
    case 'none':
    default:
      throw new Error(
        `PAYMENT_GATEWAY=${env.PAYMENT_GATEWAY} — no active payment gateway is configured. ` +
          `Set PAYMENT_GATEWAY=cashfree or PAYMENT_GATEWAY=razorpay (and the corresponding creds) to enable online payments.`
      );
  }
}

module.exports = { getGateway };
