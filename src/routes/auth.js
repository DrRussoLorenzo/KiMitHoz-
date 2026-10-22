const router = require('express').Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const { User } = require('../models');
const auth = require('../middleware/auth');

const verificationDirectory = path.join(__dirname, '../../private/verification');
const verificationUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, callback) => fs.mkdir(verificationDirectory, { recursive: true }, (error) => callback(error, verificationDirectory)),
    filename: (_req, file, callback) => callback(null, `${crypto.randomBytes(24).toString('hex')}${path.extname(file.originalname).toLowerCase()}`)
  }),
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
  const discardUploads = () => Promise.all(uploadedFiles.map((file) => fs.promises.unlink(file.path).catch(() => {})));
  let createdUser;
  try {
    const { email, username, nickname, age, password } = req.body;
    if (!email || !username || !nickname || !age || !password || !req.files?.identityDocument?.[0] || !req.files?.facePhoto?.[0]) { await discardUploads(); return res.status(400).json({ message: 'Minden mező, a személyi igazolvány képe és az arckép megadása kötelező.' }); }
    const normalizedEmail = String(email).toLowerCase().trim();
    if (!/^\S+@\S+\.\S+$/.test(normalizedEmail)) { await discardUploads(); return res.status(400).json({ message: 'Adj meg egy érvényes e-mail-címet.' }); }
    if (!/^[a-zA-Z0-9_]{3,24}$/.test(username)) { await discardUploads(); return res.status(400).json({ message: 'A felhasználónév 3–24 karakteres lehet (betű, szám, _).' }); }
    const parsedAge = Number(age);
    if (!Number.isInteger(parsedAge) || parsedAge < 16 || parsedAge > 120) { await discardUploads(); return res.status(400).json({ message: 'Az életkor 16 és 120 év közötti egész szám legyen.' }); }
    if (typeof password !== 'string' || password.length < 8) { await discardUploads(); return res.status(400).json({ message: 'A jelszó legalább 8 karakter legyen.' }); }
    createdUser = await User.create({
      email: normalizedEmail, username, nickname, age: parsedAge,
      passwordHash: await bcrypt.hash(password, 12),
      verificationStatus: 'pending',
      verificationDocuments: {
        identityDocument: req.files.identityDocument[0].filename,
        facePhoto: req.files.facePhoto[0].filename
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
