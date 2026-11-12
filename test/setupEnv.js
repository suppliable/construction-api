'use strict';

// Minimum viable environment for the test process.
//
// Several suites pull in the real src/config/env.js (warehouseStatus →
// remoteConfigService → firebaseAdmin). That module validates env at
// require-time and calls process.exit(1) when anything required is missing —
// which does not just fail that suite, it kills the whole jest run, so no
// summary is printed and every other suite is skipped. A developer whose .env
// lacks, say, MSG91_AUTH_KEY therefore cannot run the tests at all.
//
// Values here are obviously fake. Suites that exercise a vendor call mock it.

process.env.NODE_ENV ??= 'test';

process.env.ZOHO_CLIENT_ID ??= 'test-zoho-client-id';
process.env.ZOHO_CLIENT_SECRET ??= 'test-zoho-client-secret';
process.env.ZOHO_REFRESH_TOKEN ??= 'test-zoho-refresh-token';
process.env.ZOHO_API_DOMAIN ??= 'https://www.zohoapis.test';
process.env.ZOHO_ORG_ID ??= '00000000000';

// Forced, not ??=, unlike everything else here. config/env.js loads .env and
// .env.local, so a developer running `npm test` on a machine configured for a
// real environment would otherwise hand the suites a working credential — and
// any repository call a test forgot to mock would quietly succeed against a
// live Firestore instead of failing. Tests must never be able to reach a real
// project. EXPECTED_PROJECT_ID is cleared with it, or the boot guard would
// reject this fake one; the RTDB URL and bucket are reached by name rather
// than by the credential, so they go too.
process.env.FIREBASE_SERVICE_ACCOUNT = JSON.stringify({
  project_id: 'construction-api-test',
  client_email: 'test@construction-api-test.iam.gserviceaccount.com',
  private_key: '-----BEGIN PRIVATE KEY-----\ntest\n-----END PRIVATE KEY-----\n',
});
delete process.env.EXPECTED_PROJECT_ID;
delete process.env.FIREBASE_DATABASE_URL;
delete process.env.FIREBASE_STORAGE_BUCKET;

process.env.ADMIN_PASSWORD ??= 'test-admin-password';
process.env.ADMIN_TOKEN ??= 'test-admin-token-0123456789';
process.env.JWT_SECRET ??= 'test-jwt-secret';

process.env.MSG91_AUTH_KEY ??= 'test-msg91-auth-key';
// Must be exactly 24 hex characters to satisfy the schema.
process.env.MSG91_TEMPLATE_ID ??= '0123456789abcdef01234567';
