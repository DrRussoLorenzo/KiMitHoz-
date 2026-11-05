const cloudinary = require('cloudinary').v2;
const { Readable } = require('stream');

const CLOUDINARY_PREFIX = 'cloudinary:';
let configured = false;

function configureCloudinary() {
  if (configured) return;
  if (process.env.CLOUDINARY_URL) {
    cloudinary.config({ secure: true });
  } else {
    const { CLOUDINARY_CLOUD_NAME: cloud_name, CLOUDINARY_API_KEY: api_key, CLOUDINARY_API_SECRET: api_secret } = process.env;
    if (!cloud_name || !api_key || !api_secret) {
      const error = new Error('A képfeltöltéshez állítsd be a Cloudinary környezeti változókat.');
      error.status = 503;
      throw error;
    }
    cloudinary.config({ cloud_name, api_key, api_secret, secure: true });
  }
  configured = true;
}

function uploadImage(buffer, { folder, type = 'upload' }) {
  configureCloudinary();
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream({
      folder,
      resource_type: 'image',
      type,
      overwrite: false,
      unique_filename: true,
      use_filename: false
    }, (error, result) => {
      if (error) return reject(error);
      resolve({
        publicId: result.public_id,
        secureUrl: result.secure_url,
        format: result.format,
        version: result.version
      });
    });
    Readable.from([buffer]).pipe(stream);
  });
}

function destroyImage(publicId, type = 'upload') {
  configureCloudinary();
  return cloudinary.uploader.destroy(publicId, { resource_type: 'image', type });
}

function isCloudinaryId(value) {
  return typeof value === 'string' && value.startsWith(CLOUDINARY_PREFIX);
}

function toCloudinaryId(value) {
  return isCloudinaryId(value) ? value.slice(CLOUDINARY_PREFIX.length) : value;
}

async function sendAuthenticatedImage(res, publicId, { version, format } = {}) {
  configureCloudinary();
  const url = cloudinary.url(publicId, {
    secure: true,
    resource_type: 'image',
    type: 'authenticated',
    sign_url: true,
    version,
    format
  });
  const response = await fetch(url, { redirect: 'error' });
  if (!response.ok || !response.body) {
    const error = new Error(response.status === 404 ? 'A kép nem található a Cloudinaryben.' : 'A kép betöltése nem sikerült a Cloudinaryből.');
    error.status = response.status === 404 ? 404 : 502;
    throw error;
  }
  res.set('Content-Type', response.headers.get('content-type') || 'application/octet-stream');
  res.set('Cache-Control', 'private, no-store');
  Readable.fromWeb(response.body).pipe(res);
}

module.exports = {
  CLOUDINARY_PREFIX,
  configureCloudinary,
  destroyImage,
  isCloudinaryId,
  sendAuthenticatedImage,
  toCloudinaryId,
  uploadImage
};
