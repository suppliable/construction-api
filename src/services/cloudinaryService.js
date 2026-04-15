const cloudinary = require('cloudinary').v2;

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

async function uploadImage(dataUri) {
  const result = await cloudinary.uploader.upload(dataUri, {
    folder: 'suppliable-products'
  });
  return result.secure_url;
}

module.exports = { uploadImage };
