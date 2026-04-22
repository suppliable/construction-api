const multer = require('multer');
const { uploadToFirebase } = require('../services/storageService');

const upload = multer({ storage: multer.memoryStorage() });

const uploadImage = [
  upload.single('image'),
  async (req, res) => {
    try {
      const image_url = await uploadToFirebase(req.file.buffer, req.file.mimetype, 'products');
      res.json({ success: true, image_url });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  }
];

module.exports = { uploadImage };
