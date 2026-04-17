const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const dotenv = require('dotenv');
dotenv.config();

const productRoutes = require('./src/routes/products');
const cartRoutes = require('./src/routes/cart');
const homeRoutes = require('./src/routes/home');
const authRoutes = require('./src/routes/auth');
const customerRoutes = require('./src/routes/customers');
const uploadRoutes = require('./src/routes/upload');
const addressRoutes = require('./src/routes/address');
const deliveryRoutes = require('./src/routes/delivery');

const app = express();

// Static files
app.use(express.static('public'));

// Middleware
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
app.use('/api/address', addressRoutes);
app.use('/api/delivery', deliveryRoutes);

// Error handler
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ success: false, message: err.message });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});
