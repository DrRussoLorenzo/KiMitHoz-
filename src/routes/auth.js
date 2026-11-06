const router = require('express').Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const path = require('path');
const multer = require('multer');
const { User } = require('../models');
const auth = require('../middleware/auth');
const { CLOUDINARY_PREFIX, destroyImage, uploadImage } = require('../services/cloudinary');

const verificationUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 2 },
  fileFilter: (_req, file, callback) => {
    const extensions = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' };
    if (extensions[file.mimetype] && path.extname(file.originalname).toLowerCase() === extensions[file.mimetype]) return callback(null, true);
    callback(Object.assign(new Error('A személyi igazolvány és az arckép JPG, PNG vagy WebP formátumú lehet.'), { status: 400 }));
  }
});

// A jelszóhash soha nem kerül vissza az API-válaszba.
const publicUser = (user) => ({ id: user._id, email: user.email, username: user.username, nickname: user.nickname, age: user.age, avatar: user.avatar, bio: user.bio, role: user.role || 'user', isBanned: Boolean(user.isBanned), verificationStatus: user.verificationStatus || 'approved', verificationReviewedAt: user.verificationReviewedAt, settings: user.settings });
const tokenFor = (user) => jwt.sign({ sub: user._id.toString() }, process.env.JWT_SECRET, { expiresIn: '7d' });

// A regisztráció bizonyítékai csak az adminisztrátori ellenőrzéshez érhetők el.
router.post('/register', verificationUpload.fields([{ name: 'identityDocument', maxCount: 1 }, { name: 'facePhoto', maxCount: 1 }]), async (req, res, next) => {
  const uploadedFiles = Object.values(req.files || {}).flat();
  const uploadedAssets = [];
  const discardUploads = () => Promise.all(uploadedAssets.map((asset) => destroyImage(asset.publicId, 'authenticated').catch(() => {})));
  let createdUser;
  try {
    const { email, username, nickname, birthDate, password } = req.body;
    if (!email || !username || !nickname || !birthDate || !password || !req.files?.identityDocument?.[0] || !req.files?.facePhoto?.[0]) return res.status(400).json({ message: 'Minden mező, a születési dátum, a személyi igazolvány képe és az arckép megadása kötelező.' });
    const normalizedEmail = String(email).toLowerCase().trim();
    if (!/^\S+@\S+\.\S+$/.test(normalizedEmail)) return res.status(400).json({ message: 'Adj meg egy érvényes e-mail-címet.' });
    if (!/^[a-zA-Z0-9_]{3,24}$/.test(username)) return res.status(400).json({ message: 'A felhasználónév 3–24 karakteres lehet (betű, szám, _).' });
    const parsedBirthDate = new Date(`${birthDate}T00:00:00.000Z`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(birthDate) || Number.isNaN(parsedBirthDate.getTime()) || parsedBirthDate.toISOString().slice(0, 10) !== birthDate) return res.status(400).json({ message: 'Adj meg egy érvényes születési dátumot.' });
    const now = new Date();
    let parsedAge = now.getUTCFullYear() - parsedBirthDate.getUTCFullYear();
    if (now.getUTCMonth() < parsedBirthDate.getUTCMonth() || now.getUTCMonth() === parsedBirthDate.getUTCMonth() && now.getUTCDate() < parsedBirthDate.getUTCDate()) parsedAge -= 1;
    if (parsedAge < 16 || parsedAge > 120) return res.status(400).json({ message: 'A regisztrációhoz 16 és 120 év közötti életkor szükséges.' });
    if (typeof password !== 'string' || password.length < 8) return res.status(400).json({ message: 'A jelszó legalább 8 karakter legyen.' });
    const identity = await uploadImage(req.files.identityDocument[0].buffer, { folder: 'kimithoz/verification', type: 'authenticated' });
    uploadedAssets.push(identity);
    const face = await uploadImage(req.files.facePhoto[0].buffer, { folder: 'kimithoz/verification', type: 'authenticated' });
    uploadedAssets.push(face);
    createdUser = await User.create({
      email: normalizedEmail, username, nickname, age: parsedAge, birthDate: parsedBirthDate,
      passwordHash: await bcrypt.hash(password, 12),
      verificationStatus: 'pending',
      verificationDocuments: {
        identityDocument: `${CLOUDINARY_PREFIX}${identity.publicId}`,
        facePhoto: `${CLOUDINARY_PREFIX}${face.publicId}`
      }
    });
    res.status(201).json({ message: 'A regisztrációs kérelmedet rögzítettük. Az adminisztrátori ellenőrzés és jóváhagyás után tudsz bejelentkezni.' });
  } catch (error) {
    if (createdUser) await createdUser.deleteOne().catch(() => {});
    await discardUploads();
    if (error.code === 11000) return res.status(409).json({ message: 'Ez az e-mail-cím vagy felhasználónév már foglalt.' });
    next(error);
  }
});

// Bejelentkezés csak adminisztrátori jóváhagyás után.
router.post('/login', async (req, res, next) => {
  try {
    const { email, password } = req.body;
    const user = await User.findOne({ email: String(email || '').toLowerCase().trim() }).select('+passwordHash');
    if (!user || !await bcrypt.compare(password || '', user.passwordHash)) return res.status(401).json({ message: 'Hibás e-mail-cím vagy jelszó.' });
    if (user.isBanned && user.role !== 'admin') return res.status(403).json({ message: user.banReason ? `A fiókodat kitiltották: ${user.banReason}` : 'A fiókodat kitiltották.' });
    if (user.verificationStatus !== 'approved') return res.status(403).json({ message: user.verificationStatus === 'rejected' ? 'A regisztrációs kérelmedet elutasítottuk. További információért vedd fel a kapcsolatot az adminisztrátorral.' : 'A regisztrációs kérelmed még adminisztrátori ellenőrzésre vár.' });
    res.json({ token: tokenFor(user), user: publicUser(user) });
  } catch (error) { next(error); }
});

// A kliens ezzel ellenőrzi a mentett munkamenet érvényességét.
router.get('/me', auth, (req, res) => res.json({ user: publicUser(req.user) }));
module.exports = router;
