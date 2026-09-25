'use strict';

// Demo login bypass — lets a fixed phone number sign in without an MSG91 SMS.
// Needed because MSG91 is live: App Store / Play reviewers, sales demos and QA
// on a handset without the real SIM have no other way in.
//
// Off unless BOTH DEMO_PHONE and DEMO_OTP are set (see config/env.js), so a
// deploy that forgets them fails closed rather than opening a fixed-OTP account.
// Deliberately active in production too — store reviewers test the live build.

const crypto = require('crypto');
const { normalizePhone } = require('./phone');

// Read at call time, not module load: env is loaded by config/env.js and tests
// mutate process.env between cases.
function demoPhones() {
  return String(process.env.DEMO_PHONE || '')
    .split(',')
    .map(p => normalizePhone(p.trim()))
    .filter(Boolean);
}

function demoOtp() {
  return String(process.env.DEMO_OTP || '');
}

function isDemoLoginEnabled() {
  return demoPhones().length > 0 && demoOtp().length > 0;
}

// `normalized` must already be through normalizePhone (E.164 +91…).
function isDemoPhone(normalized) {
  if (!isDemoLoginEnabled()) return false;
  return demoPhones().includes(normalized);
}

// Constant-time so the fixed OTP can't be recovered digit-by-digit. The verify
// lockout still applies to the demo phone, so this is defence in depth.
function matchesDemoOtp(otp) {
  const expected = demoOtp();
  if (!expected) return false;
  const a = Buffer.from(String(otp));
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

module.exports = { isDemoLoginEnabled, isDemoPhone, matchesDemoOtp };
