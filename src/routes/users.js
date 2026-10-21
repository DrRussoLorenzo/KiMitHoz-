const router = require('express').Router();
const auth = require('../middleware/auth');
const { User, Notification } = require('../models');

router.use(auth);
// Nyilvános profilmezők; a jelszóhash nem része a felhasználókártyának.
const card = (user) => ({ id: user._id, username: user.username, nickname: user.nickname, avatar: user.avatar, bio: user.bio });

// Ismerőslista és beérkezett felkérések.
router.get('/friends', async (req, res, next) => {
  try {
    const user = await User.findById(req.user.id).populate('friends', 'username nickname avatar bio').populate('friendRequests', 'username nickname avatar bio');
    res.json({ friends: user.friends.map(card), requests: user.friendRequests.map(card) });
  } catch (error) { next(error); }
});

// Felhasználók keresése név vagy felhasználónév alapján.
router.get('/search', async (req, res, next) => {
  try {
    const q = String(req.query.q || '').trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (q.length < 2) return res.json({ users: [] });
    const users = await User.find({ _id: { $ne: req.user.id }, $or: [{ username: new RegExp(q, 'i') }, { nickname: new RegExp(q, 'i') }] }).select('username nickname avatar bio').limit(12);
    res.json({ users: users.map(card) });
  } catch (error) { next(error); }
});

// Csak az aktuális felhasználó ismerősei profilját adja vissza.
router.get('/:id', async (req, res, next) => {
  try {
    if (!req.user.friends.some((id) => id.equals(req.params.id))) return res.status(404).json({ message: 'A profil nem található.' });
    const user = await User.findById(req.params.id).select('username nickname avatar bio');
    if (!user) return res.status(404).json({ message: 'A profil nem található.' });
    res.json({ user: card(user) });
  } catch (error) { next(error); }
});

// Barátfelkérés elküldése; értesítést a címzett beállítása szerint küldünk.
router.post('/friends/request/:id', async (req, res, next) => {
  try {
    const recipient = await User.findById(req.params.id);
    if (!recipient || recipient.id === req.user.id) return res.status(404).json({ message: 'A felhasználó nem található.' });
    if (req.user.friends.some((id) => id.equals(recipient._id))) return res.status(409).json({ message: 'Már barátok vagytok.' });
    if (recipient.friendRequests.some((id) => id.equals(req.user._id))) return res.status(409).json({ message: 'A felkérés már elküldésre került.' });
    recipient.friendRequests.addToSet(req.user._id);
    await recipient.save();
    if (recipient.settings.notifications) {
      await Notification.create({ recipient: recipient._id, sender: req.user._id, type: 'friend-request', message: `${req.user.nickname} barátnak jelölt.` });
    }
    res.status(201).json({ message: 'Barátfelkérés elküldve.' });
  } catch (error) { next(error); }
});

// Felkérés elfogadása mindkét fél ismerőslistáján.
router.post('/friends/requests/:id/accept', async (req, res, next) => {
  try {
    const sender = await User.findById(req.params.id);
    if (!sender || !req.user.friendRequests.some((id) => id.equals(sender._id))) return res.status(404).json({ message: 'A felkérés nem található.' });
    req.user.friendRequests.pull(sender._id); req.user.friends.addToSet(sender._id);
    sender.friends.addToSet(req.user._id);
    await Promise.all([req.user.save(), sender.save()]);
    res.json({ message: 'Mostantól barátok vagytok.' });
  } catch (error) { next(error); }
});

// Csak a profil és a felhasználói beállítások módosíthatók itt.
router.patch('/me', async (req, res, next) => {
  try {
    const allowed = ['nickname', 'avatar', 'bio'];
    for (const key of allowed) {
      if (req.body[key] === undefined) continue;
      const value = String(req.body[key]).trim();
      if (key === 'avatar' && value) {
        let imageUrl;
        try { imageUrl = new URL(value); } catch (_error) { return res.status(400).json({ message: 'Adj meg egy érvényes profilkép URL-t.' }); }
        if (!['http:', 'https:'].includes(imageUrl.protocol) || value.length > 2048) return res.status(400).json({ message: 'A profilkép URL-je HTTP vagy HTTPS cím legyen, legfeljebb 2048 karakterrel.' });
      }
      req.user[key] = value;
    }
    if (req.body.settings) {
      if (['light', 'dark'].includes(req.body.settings.theme)) req.user.settings.theme = req.body.settings.theme;
      if (['hu', 'en'].includes(req.body.settings.language)) req.user.settings.language = req.body.settings.language;
      if (typeof req.body.settings.notifications === 'boolean') req.user.settings.notifications = req.body.settings.notifications;
    }
    await req.user.save();
    res.json({ user: { id: req.user._id, email: req.user.email, username: req.user.username, nickname: req.user.nickname, avatar: req.user.avatar, bio: req.user.bio, settings: req.user.settings } });
  } catch (error) { next(error); }
});

module.exports = router;