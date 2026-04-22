const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const dotenv = require('dotenv');
const path = require('path');
dotenv.config();

const productRoutes = require('./src/routes/products');
const cartRoutes = require('./src/routes/cart');
const homeRoutes = require('./src/routes/home');
const authRoutes = require('./src/routes/auth');
const customerRoutes = require('./src/routes/customers');
const uploadRoutes = require('./src/routes/upload');
const addressRoutes = require('./src/routes/address'); // mounted at /api/addresses
const addressLegacyRoutes = require('./src/routes/addressLegacy'); // Flutter legacy: /api/address
const deliveryRoutes = require('./src/routes/delivery');
const orderRoutes = require('./src/routes/orders');
const configRoutes = require('./src/routes/config');
const adminRoutes = require('./src/routes/admin');
const driverRoutes = require('./src/routes/driver');
const searchRoutes = require('./src/routes/search');
const categoriesRoutes = require('./src/routes/categories');

const app = express();

// Static files
app.use(express.static('public'));
app.use('/admin', express.static(path.join(__dirname, 'admin-portal')));

// Middleware
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors());
app.use(morgan('dev'));
app.use(express.json());

// Health check
app.get('/', (req, res) => {
  res.json({ message: 'Construction API is running!' });
});

// Routes
app.use('/api/products', productRoutes);
app.use('/api/cart', cartRoutes);
app.use('/api/home', homeRoutes);
app.use('/api/auth', authRoutes);
app.use('/api/customers', customerRoutes);
app.use('/api/upload', uploadRoutes);
app.use('/api/addresses', addressRoutes);
app.use('/api/address', addressLegacyRoutes);
app.use('/api/delivery', deliveryRoutes);
app.use('/api/orders', orderRoutes);
app.use('/api/config', configRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/driver', driverRoutes);
app.use('/api/search', searchRoutes);
app.use('/api/categories', categoriesRoutes);

// Error handler
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ success: false, message: err.message });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});
