const router = require('express').Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const path = require('path');
const multer = require('multer');
const { User } = require('../models');
const auth = require('../middleware/auth');
const { CLOUDINARY_PREFIX, destroyImage, uploadImage } = require('../services/cloudinary');

const ellenorzesiKepFeltoltes = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 2 },
  fileFilter: (_keres, fajl, visszahivas) => {
    const kiterjesztesek = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' };
    if (
      kiterjesztesek[fajl.mimetype] &&
      path.extname(fajl.originalname).toLowerCase() === kiterjesztesek[fajl.mimetype]
    )
      return visszahivas(null, true);
    visszahivas(
      Object.assign(
        new Error('A személyi igazolvány és az arckép JPG, PNG vagy WebP formátumú lehet.'),
        { status: 400 }
      )
    );
  },
});

// A jelszóhash soha nem kerül vissza az API-válaszba.
/** A kliensnek szükséges fiókadatokat adja vissza; titkos és belső mezőket kihagy. */
const nyilvanosFelhasznalo = (felhasznalo) => ({
  id: felhasznalo._id,
  email: felhasznalo.email,
  username: felhasznalo.username,
  nickname: felhasznalo.nickname,
  age: felhasznalo.age,
  avatar: felhasznalo.avatar,
  bio: felhasznalo.bio,
  role: felhasznalo.role || 'user',
  isBanned: Boolean(felhasznalo.isBanned),
  verificationStatus: felhasznalo.verificationStatus || 'approved',
  verificationReviewedAt: felhasznalo.verificationReviewedAt,
  settings: felhasznalo.settings,
});
/** Aláírt, hét napig érvényes munkamenet-tokent készít. */
const munkamenetToken = (felhasznalo) =>
  jwt.sign({ sub: felhasznalo._id.toString() }, process.env.JWT_SECRET, { expiresIn: '7d' });

// A regisztráció bizonyítékai csak az adminisztrátori ellenőrzéshez érhetők el.
router.post(
  '/register',
  ellenorzesiKepFeltoltes.fields([
    { name: 'identityDocument', maxCount: 1 },
    { name: 'facePhoto', maxCount: 1 },
  ]),
  async (keres, valasz, folytatas) => {
    const feltoltottKepek = [];
    const feltoltesekTorlese = () =>
      Promise.all(
        feltoltottKepek.map((kep) => destroyImage(kep.publicId, 'authenticated').catch(() => {}))
      );
    let letrehozottFelhasznalo;
    try {
      const { email, username, nickname, birthDate, password } = keres.body;
      if (
        !email ||
        !username ||
        !nickname ||
        !birthDate ||
        !password ||
        !keres.files?.identityDocument?.[0] ||
        !keres.files?.facePhoto?.[0]
      )
        return valasz.status(400).json({
          message:
            'Minden mező, a születési dátum, a személyi igazolvány képe és az arckép megadása kötelező.',
        });
      const normalizaltEmail = String(email).toLowerCase().trim();
      if (!/^\S+@\S+\.\S+$/.test(normalizaltEmail))
        return valasz.status(400).json({ message: 'Adj meg egy érvényes e-mail-címet.' });
      if (!/^[a-zA-Z0-9_]{3,24}$/.test(username))
        return valasz
          .status(400)
          .json({ message: 'A felhasználónév 3–24 karakteres lehet (betű, szám, _).' });
      const szuletesiDatum = new Date(`${birthDate}T00:00:00.000Z`);
      if (
        !/^\d{4}-\d{2}-\d{2}$/.test(birthDate) ||
        Number.isNaN(szuletesiDatum.getTime()) ||
        szuletesiDatum.toISOString().slice(0, 10) !== birthDate
      )
        return valasz.status(400).json({ message: 'Adj meg egy érvényes születési dátumot.' });
      const most = new Date();
      let eletkor = most.getUTCFullYear() - szuletesiDatum.getUTCFullYear();
      if (
        most.getUTCMonth() < szuletesiDatum.getUTCMonth() ||
        (most.getUTCMonth() === szuletesiDatum.getUTCMonth() &&
          most.getUTCDate() < szuletesiDatum.getUTCDate())
      )
        eletkor -= 1;
      if (eletkor < 16 || eletkor > 120)
        return valasz
          .status(400)
          .json({ message: 'A regisztrációhoz 16 és 120 év közötti életkor szükséges.' });
      if (typeof password !== 'string' || password.length < 8)
        return valasz.status(400).json({ message: 'A jelszó legalább 8 karakter legyen.' });
      const igazolvanyKep = await uploadImage(keres.files.identityDocument[0].buffer, {
        folder: 'kimithoz/verification',
        type: 'authenticated',
      });
      feltoltottKepek.push(igazolvanyKep);
      const arckep = await uploadImage(keres.files.facePhoto[0].buffer, {
        folder: 'kimithoz/verification',
        type: 'authenticated',
      });
      feltoltottKepek.push(arckep);
      letrehozottFelhasznalo = await User.create({
        email: normalizaltEmail,
        username,
        nickname,
        age: eletkor,
        birthDate: szuletesiDatum,
        passwordHash: await bcrypt.hash(password, 12),
        verificationStatus: 'pending',
        verificationDocuments: {
          identityDocument: `${CLOUDINARY_PREFIX}${igazolvanyKep.publicId}`,
          facePhoto: `${CLOUDINARY_PREFIX}${arckep.publicId}`,
        },
      });
      valasz.status(201).json({
        message:
          'A regisztrációs kérelmedet rögzítettük. Az adminisztrátori ellenőrzés és jóváhagyás után tudsz bejelentkezni.',
      });
    } catch (hiba) {
      if (letrehozottFelhasznalo) await letrehozottFelhasznalo.deleteOne().catch(() => {});
      await feltoltesekTorlese();
      if (hiba.code === 11000)
        return valasz
          .status(409)
          .json({ message: 'Ez az e-mail-cím vagy felhasználónév már foglalt.' });
      folytatas(hiba);
    }
  }
);

// Bejelentkezés csak adminisztrátori jóváhagyás után.
router.post('/login', async (keres, valasz, folytatas) => {
  try {
    const { email, password } = keres.body;
    const felhasznalo = await User.findOne({
      email: String(email || '')
        .toLowerCase()
        .trim(),
    }).select('+passwordHash');
    if (!felhasznalo || !(await bcrypt.compare(password || '', felhasznalo.passwordHash)))
      return valasz.status(401).json({ message: 'Hibás e-mail-cím vagy jelszó.' });
    if (felhasznalo.isBanned && felhasznalo.role !== 'admin')
      return valasz.status(403).json({
        message: felhasznalo.banReason
          ? `A fiókodat kitiltották: ${felhasznalo.banReason}`
          : 'A fiókodat kitiltották.',
      });
    if (felhasznalo.verificationStatus !== 'approved')
      return valasz.status(403).json({
        message:
          felhasznalo.verificationStatus === 'rejected'
            ? 'A regisztrációs kérelmedet elutasítottuk. További információért vedd fel a kapcsolatot az adminisztrátorral.'
            : 'A regisztrációs kérelmed még adminisztrátori ellenőrzésre vár.',
      });
    valasz.json({ token: munkamenetToken(felhasznalo), user: nyilvanosFelhasznalo(felhasznalo) });
  } catch (hiba) {
    folytatas(hiba);
  }
});

// A kliens ezzel ellenőrzi a mentett munkamenet érvényességét.
router.get('/me', auth, (keres, valasz) => valasz.json({ user: nyilvanosFelhasznalo(keres.user) }));
module.exports = router;
