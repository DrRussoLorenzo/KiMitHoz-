const router = require('express').Router();
const auth = require('../middleware/auth');
const { Notification } = require('../models');

router.use(auth);
// Legutóbbi értesítések és teljes, pontos olvasatlan darabszám.
router.get('/', async (req, res, next) => {
  try {
    const notifications = await Notification.find({ recipient: req.user._id }).populate('sender', 'username nickname avatar').populate('targetUser', 'username nickname avatar').populate('party', 'title date location').sort({ createdAt: -1 }).limit(40);
    const unread = await Notification.countDocuments({ recipient: req.user._id, read: false });
    res.json({ notifications, unread });
  } catch (error) { next(error); }
});
// Az összes értesítést olvasottnak jelöli az aktuális felhasználónál.
router.patch('/read', async (req, res, next) => {
  try {
    await Notification.updateMany({ recipient: req.user._id, read: false }, { $set: { read: true } });
    res.json({ message: 'Értesítések olvasottnak jelölve.' });
  } catch (error) { next(error); }
});
module.exports = router;