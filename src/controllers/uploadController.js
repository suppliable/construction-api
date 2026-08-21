const multer = require('multer');
const { uploadToFirebase } = require('../services/storageService');
const logger = require('../utils/logger');

// 5 MB cap and a type allowlist, matching the admin image routes (routes/admin.js).
// Without a limit an arbitrarily large body is buffered in memory and then handed
// to sharp, so the bound matters more now than it did for a straight passthrough.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
});

const ALLOWED_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

// Multer reports a rejected upload by calling next(err), which skips the route
// handler entirely — so the size limit has to be caught here. The global error
// handler keys off err.statusCode, which MulterError doesn't set, and would
// otherwise turn an oversized upload into a 500.
const receiveFile = (req, res, next) => {
  upload.single('image')(req, res, (err) => {
    if (err instanceof multer.MulterError) {
      const message = err.code === 'LIMIT_FILE_SIZE'
        ? 'Image must be 5 MB or smaller'
        : err.message;
      return res.status(400).json({ success: false, error: err.code, message });
    }
    if (err) return next(err);
    next();
  });
};

const uploadImage = [
  receiveFile,
  async (req, res) => {
    try {
      if (!req.file) return res.status(400).json({ success: false, message: 'No file uploaded' });
      if (!ALLOWED_MIME_TYPES.includes(req.file.mimetype)) {
        return res.status(400).json({ success: false, message: 'Only jpeg, png, webp images are allowed' });
      }
      const image_url = await uploadToFirebase(req.file.buffer, req.file.mimetype, 'products');
      res.json({ success: true, image_url });
    } catch (err) {
      (req.log || logger).error({ err }, '[Upload] image upload failed');
      res.status(500).json({ success: false, message: err.message });
    }
  }
];

module.exports = { uploadImage };
