const router = require('express').Router();
const multer = require('multer');
const auth = require('../middleware/auth');
const { User, Notification } = require('../models');
const { uploadImage } = require('../services/cloudinary');

router.use(auth);
const profilkepKiterjesztesek = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
};
const profilkepFeltoltes = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
  fileFilter: (_keres, fajl, visszahivas) => {
    if (profilkepKiterjesztesek[fajl.mimetype]) return visszahivas(null, true);
    visszahivas(
      Object.assign(new Error('JPG, PNG vagy WebP profilképet tölts fel.'), { status: 400 })
    );
  },
});
/** Profilkép-feltöltési hiba esetén a fájlméretkorlátot is HTTP-hibakóddá alakítja. */
const profilkepFogadasa = (keres, valasz, folytatas) =>
  profilkepFeltoltes.single('image')(keres, valasz, (hiba) => {
    if (hiba?.code === 'LIMIT_FILE_SIZE') hiba.status = 413;
    folytatas(hiba);
  });
// Nyilvános profilmezők; a jelszóhash nem része a felhasználókártyának.
const nyilvanosAdatlap = (felhasznalo) => ({
  id: felhasznalo._id,
  username: felhasznalo.username,
  nickname: felhasznalo.nickname,
  age: felhasznalo.age,
  avatar: felhasznalo.avatar,
  bio: felhasznalo.bio,
});

// Ismerőslista és beérkezett felkérések.
router.get('/friends', async (keres, valasz, folytatas) => {
  try {
    const felhasznalo = await User.findById(keres.user.id)
      .populate('friends', 'username nickname age avatar bio')
      .populate('friendRequests', 'username nickname age avatar bio');
    valasz.json({
      friends: felhasznalo.friends.map(nyilvanosAdatlap),
      requests: felhasznalo.friendRequests.map(nyilvanosAdatlap),
    });
  } catch (hiba) {
    folytatas(hiba);
  }
});

// Felhasználók keresése név vagy felhasználónév alapján.
router.get('/search', async (keres, valasz, folytatas) => {
  try {
    const keresesiSzoveg = String(keres.query.q || '')
      .trim()
      .replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (keresesiSzoveg.length < 2) return valasz.json({ users: [] });
    const talalatok = await User.find({
      _id: { $ne: keres.user.id },
      $or: [
        { username: new RegExp(keresesiSzoveg, 'i') },
        { nickname: new RegExp(keresesiSzoveg, 'i') },
      ],
    })
      .select('username nickname avatar bio')
      .limit(12);
    valasz.json({ users: talalatok.map(nyilvanosAdatlap) });
  } catch (hiba) {
    folytatas(hiba);
  }
});

// Csak az aktuális felhasználó ismerősei profilját adja vissza.
router.get('/:id', async (keres, valasz, folytatas) => {
  try {
    if (!keres.user.friends.some((azonosito) => azonosito.equals(keres.params.id)))
      return valasz.status(404).json({ message: 'A profil nem található.' });
    const felhasznalo = await User.findById(keres.params.id).select(
      'username nickname age avatar bio'
    );
    if (!felhasznalo) return valasz.status(404).json({ message: 'A profil nem található.' });
    valasz.json({ user: nyilvanosAdatlap(felhasznalo) });
  } catch (hiba) {
    folytatas(hiba);
  }
});

// Barátfelkérés elküldése; értesítést a címzett beállítása szerint küldünk.
router.post('/friends/request/:id', async (keres, valasz, folytatas) => {
  try {
    const cimzett = await User.findById(keres.params.id);
    if (!cimzett || cimzett.id === keres.user.id)
      return valasz.status(404).json({ message: 'A felhasználó nem található.' });
    if (keres.user.friends.some((azonosito) => azonosito.equals(cimzett._id)))
      return valasz.status(409).json({ message: 'Már barátok vagytok.' });
    if (cimzett.friendRequests.some((azonosito) => azonosito.equals(keres.user._id)))
      return valasz.status(409).json({ message: 'A felkérés már elküldésre került.' });
    cimzett.friendRequests.addToSet(keres.user._id);
    await cimzett.save();
    if (cimzett.settings.notifications) {
      await Notification.create({
        recipient: cimzett._id,
        sender: keres.user._id,
        type: 'friend-request',
        message: `${keres.user.nickname} barátnak jelölt.`,
      });
    }
    valasz.status(201).json({ message: 'Barátfelkérés elküldve.' });
  } catch (hiba) {
    folytatas(hiba);
  }
});

// Felkérés elfogadása mindkét fél ismerőslistáján.
router.post('/friends/requests/:id/accept', async (keres, valasz, folytatas) => {
  try {
    const felado = await User.findById(keres.params.id);
    if (!felado || !keres.user.friendRequests.some((azonosito) => azonosito.equals(felado._id)))
      return valasz.status(404).json({ message: 'A felkérés nem található.' });
    keres.user.friendRequests.pull(felado._id);
    keres.user.friends.addToSet(felado._id);
    felado.friends.addToSet(keres.user._id);
    await Promise.all([keres.user.save(), felado.save()]);
    valasz.json({ message: 'Mostantól barátok vagytok.' });
  } catch (hiba) {
    folytatas(hiba);
  }
});

// Csak a profil és a felhasználói beállítások módosíthatók itt.
router.patch('/me', async (keres, valasz, folytatas) => {
  try {
    const modositthatoMezok = ['nickname', 'avatar', 'bio'];
    for (const mezo of modositthatoMezok) {
      if (keres.body[mezo] === undefined) continue;
      const ertek = String(keres.body[mezo]).trim();
      if (mezo === 'avatar' && ertek) {
        let kepUrl;
        try {
          kepUrl = new URL(ertek);
        } catch (_hiba) {
          return valasz.status(400).json({ message: 'Adj meg egy érvényes profilkép URL-t.' });
        }
        if (!['http:', 'https:'].includes(kepUrl.protocol) || ertek.length > 2048)
          return valasz.status(400).json({
            message: 'A profilkép URL-je HTTP vagy HTTPS cím legyen, legfeljebb 2048 karakterrel.',
          });
      }
      keres.user[mezo] = ertek;
    }
    if (keres.body.settings) {
      if (['light', 'dark'].includes(keres.body.settings.theme))
        keres.user.settings.theme = keres.body.settings.theme;
      if (['hu', 'en', 'de'].includes(keres.body.settings.language))
        keres.user.settings.language = keres.body.settings.language;
      if (typeof keres.body.settings.notifications === 'boolean')
        keres.user.settings.notifications = keres.body.settings.notifications;
      if (
        keres.body.settings.colors &&
        typeof keres.body.settings.colors === 'object' &&
        !Array.isArray(keres.body.settings.colors)
      ) {
        for (const kulcs of ['primary', 'accent', 'background', 'selection', 'field']) {
          const szin = keres.body.settings.colors[kulcs];
          if (szin === undefined) continue;
          if (typeof szin !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(szin))
            return valasz
              .status(400)
              .json({ message: 'A témaszínek érvényes, 6 jegyű hexadecimális színek legyenek.' });
          keres.user.settings.colors[kulcs] = szin;
        }
      }
    }
    await keres.user.save();
    valasz.json({
      user: {
        id: keres.user._id,
        email: keres.user.email,
        username: keres.user.username,
        nickname: keres.user.nickname,
        age: keres.user.age,
        avatar: keres.user.avatar,
        bio: keres.user.bio,
        settings: keres.user.settings,
      },
    });
  } catch (hiba) {
    folytatas(hiba);
  }
});

router.post('/me/avatar', profilkepFogadasa, async (keres, valasz, folytatas) => {
  try {
    if (!keres.file)
      return valasz.status(400).json({ message: 'Válassz ki egy JPG, PNG vagy WebP képet.' });
    const { secureUrl: biztonsagosUrl } = await uploadImage(keres.file.buffer, {
      folder: 'kimithoz/avatars',
    });
    keres.user.avatar = biztonsagosUrl;
    await keres.user.save();
    valasz.status(201).json({
      user: {
        id: keres.user._id,
        email: keres.user.email,
        username: keres.user.username,
        nickname: keres.user.nickname,
        age: keres.user.age,
        avatar: keres.user.avatar,
        bio: keres.user.bio,
        settings: keres.user.settings,
      },
    });
  } catch (hiba) {
    folytatas(hiba);
  }
});

module.exports = router;
