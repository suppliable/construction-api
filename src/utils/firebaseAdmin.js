'use strict';

const admin = require('firebase-admin');
const env = require('../config/env');

if (!admin.apps.length) {
  let serviceAccount;
  const val = env.FIREBASE_SERVICE_ACCOUNT.trim();

  if (val.startsWith('/') || val.startsWith('.')) {
    // Absolute or relative file path
    serviceAccount = require(val);
  } else {
    // JSON string (used in Docker / Render)
    serviceAccount = JSON.parse(val);
    // Fix double-escaped newlines in private_key that occur when the JSON
    // is stored as an env var string (\\n → \n)
    if (serviceAccount.private_key) {
      serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, '\n');
    }
  }
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });

}
module.exports = admin
