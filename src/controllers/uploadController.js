const multer = require('multer');
const { uploadImage: uploadToCloudinary } = require('../services/cloudinaryService');

const upload = multer({ storage: multer.memoryStorage() });

const uploadImage = [
  upload.single('image'),
  async (req, res) => {
    try {
      const base64 = req.file.buffer.toString('base64');
      const dataUri = `data:${req.file.mimetype};base64,${base64}`;
      const secure_url = await uploadToCloudinary(dataUri);
      res.json({ success: true, image_url: secure_url });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  }
];

module.exports = { uploadImage };
