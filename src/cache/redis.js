'use strict';

// Upstash Redis — Data Browser (dev):
// https://console.upstash.com/redis/ea66ca5c-d438-4b2d-974a-498cf236b537/data-browser?teamid=0

const { Redis } = require('@upstash/redis');
const env = require('../config/env');

let client;

if (env.UPSTASH_REDIS_REST_URL && env.UPSTASH_REDIS_REST_TOKEN) {
  client = new Redis({
    url: env.UPSTASH_REDIS_REST_URL,
    token: env.UPSTASH_REDIS_REST_TOKEN,
  });
} else {
  client = {
    get: async () => null,
    set: async () => null,
    del: async () => null,
    scan: async () => [0, []],
  };
}

module.exports = client;
