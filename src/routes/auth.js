const express = require('express');
const router = express.Router();
const { syncAuth } = require('../controllers/authController');

router.post('/', syncAuth);

module.exports = router;
