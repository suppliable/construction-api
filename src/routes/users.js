'use strict';

const express = require('express');
const router = express.Router();
const admin = require('../utils/firebaseAdmin');
const authenticate = require('../middleware/auth');
const { buildRuntimeDiagnostics, ensureAllowlistedAdminPhone } = require('../services/diagnosticsService');

// POST /api/v1/users/fcm-token
router.post('/fcm-token', authenticate, async (req, res) => {
  try {
    const userId = req.user.uid;
    const { token } = req.body;

    if (!token || typeof token !== 'string' || !token.trim()) {
      return res.status(400).json({ success: false, error: 'MISSING_PARAM', message: 'token is required' });
    }

    await admin.firestore()
      .collection('fcmTokens')
      .doc(userId)
      .set(
        {
          tokens: admin.firestore.FieldValue.arrayUnion(token.trim()),
          updatedAt: new Date().toISOString()
        },
        { merge: true }
      );

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: 'SERVER_ERROR', message: err.message });
  }
});

router.get('/environment-info', authenticate, async (req, res, next) => {
  try {
    await ensureAllowlistedAdminPhone(req.user.phone);
    return res.json({
      success: true,
      data: buildRuntimeDiagnostics(),
    });
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
