const cloudinary = require('cloudinary').v2;
const { Readable } = require('stream');

const CLOUDINARY_PREFIX = 'cloudinary:';
let beallitva = false;

/** Egyszer beállítja a Cloudinary-klienst a környezet konfigurációjából. */
function configureCloudinary() {
  if (beallitva) return;
  if (process.env.CLOUDINARY_URL) {
    cloudinary.config({ secure: true });
  } else {
    const {
      CLOUDINARY_CLOUD_NAME: felhoNev,
      CLOUDINARY_API_KEY: apiKulcs,
      CLOUDINARY_API_SECRET: apiTitok,
    } = process.env;
    if (!felhoNev || !apiKulcs || !apiTitok) {
      const hiba = new Error('A képfeltöltéshez állítsd be a Cloudinary környezeti változókat.');
      hiba.status = 503;
      throw hiba;
    }
    cloudinary.config({
      cloud_name: felhoNev,
      api_key: apiKulcs,
      api_secret: apiTitok,
      secure: true,
    });
  }
  beallitva = true;
}

/** Feltölti a képadatot, majd visszaadja a szolgáltató azonosítóit és URL-jét. */
function uploadImage(kepAdat, { folder, type = 'upload' }) {
  configureCloudinary();
  return new Promise((megoldas, elutasitas) => {
    const adatfolyam = cloudinary.uploader.upload_stream(
      {
        folder,
        resource_type: 'image',
        type,
        overwrite: false,
        unique_filename: true,
        use_filename: false,
      },
      (hiba, eredmeny) => {
        if (hiba) return elutasitas(hiba);
        megoldas({
          publicId: eredmeny.public_id,
          secureUrl: eredmeny.secure_url,
          format: eredmeny.format,
          version: eredmeny.version,
        });
      }
    );
    Readable.from([kepAdat]).pipe(adatfolyam);
  });
}

/** Törli a megadott képet a Cloudinaryből. */
function destroyImage(publicId, type = 'upload') {
  configureCloudinary();
  return cloudinary.uploader.destroy(publicId, { resource_type: 'image', type });
}

/** Ellenőrzi, hogy az érték a szolgáltató saját azonosítója-e. */
function isCloudinaryId(value) {
  return typeof value === 'string' && value.startsWith(CLOUDINARY_PREFIX);
}

/** Eltávolítja a belső előtagot, a többi értéket változatlanul hagyja. */
function toCloudinaryId(value) {
  return isCloudinaryId(value) ? value.slice(CLOUDINARY_PREFIX.length) : value;
}

/** Hitelesített, rövid életű kép-URL-en keresztül továbbítja a képet a válasznak. */
async function sendAuthenticatedImage(res, publicId, { version, format } = {}) {
  configureCloudinary();
  const url = cloudinary.url(publicId, {
    secure: true,
    resource_type: 'image',
    type: 'authenticated',
    sign_url: true,
    version,
    format,
  });
  const letoltesValasza = await fetch(url, { redirect: 'error' });
  if (!letoltesValasza.ok || !letoltesValasza.body) {
    const hiba = new Error(
      letoltesValasza.status === 404
        ? 'A kép nem található a Cloudinaryben.'
        : 'A kép betöltése nem sikerült a Cloudinaryből.'
    );
    hiba.status = letoltesValasza.status === 404 ? 404 : 502;
    throw hiba;
  }
  res.set(
    'Content-Type',
    letoltesValasza.headers.get('content-type') || 'application/octet-stream'
  );
  res.set('Cache-Control', 'private, no-store');
  Readable.fromWeb(letoltesValasza.body).pipe(res);
}

module.exports = {
  CLOUDINARY_PREFIX,
  configureCloudinary,
  destroyImage,
  isCloudinaryId,
  sendAuthenticatedImage,
  toCloudinaryId,
  uploadImage,
};
