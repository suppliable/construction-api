'use strict';

const { Router } = require('express');

const productRoutes = require('../products');
const cartRoutes = require('../cart');
const homeRoutes = require('../home');
const authRoutes = require('../auth');
const customerRoutes = require('../customers');
const uploadRoutes = require('../upload');
const addressRoutes = require('../address');
const addressLegacyRoutes = require('../addressLegacy');
const deliveryRoutes = require('../delivery');
const orderRoutes = require('../orders');
const configRoutes = require('../config');
const adminRoutes = require('../admin');
const driverRoutes = require('../driver');
const searchRoutes = require('../search');
const categoriesRoutes = require('../categories');

const router = Router();

router.use('/products', productRoutes);
router.use('/cart', cartRoutes);
router.use('/home', homeRoutes);
router.use('/auth', authRoutes);
router.use('/customers', customerRoutes);
router.use('/upload', uploadRoutes);
router.use('/addresses', addressRoutes);
router.use('/address', addressLegacyRoutes);
router.use('/delivery', deliveryRoutes);
router.use('/orders', orderRoutes);
router.use('/config', configRoutes);
router.use('/admin', adminRoutes);
router.use('/driver', driverRoutes);
router.use('/search', searchRoutes);
router.use('/categories', categoriesRoutes);

module.exports = router;
