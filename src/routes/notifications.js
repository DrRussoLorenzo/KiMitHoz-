const router = require('express').Router();
const auth = require('../middleware/auth');
const { Notification } = require('../models');

router.use(auth);
// Legutóbbi értesítések és teljes, pontos olvasatlan darabszám.
router.get('/', async (keres, valasz, folytatas) => {
  try {
    const ertesitesek = await Notification.find({ recipient: keres.user._id })
      .populate('sender', 'username nickname avatar')
      .populate('targetUser', 'username nickname avatar')
      .populate('party', 'title date location')
      .populate('partyMessage', '_id')
      .sort({ createdAt: -1 })
      .limit(40);
    const olvasatlanDarab = await Notification.countDocuments({
      recipient: keres.user._id,
      read: false,
    });
    valasz.json({ notifications: ertesitesek, unread: olvasatlanDarab });
  } catch (hiba) {
    folytatas(hiba);
  }
});
// Az összes értesítést olvasottnak jelöli az aktuális felhasználónál.
router.patch('/read', async (keres, valasz, folytatas) => {
  try {
    await Notification.updateMany(
      { recipient: keres.user._id, read: false },
      { $set: { read: true } }
    );
    valasz.json({ message: 'Értesítések olvasottnak jelölve.' });
  } catch (hiba) {
    folytatas(hiba);
  }
});
module.exports = router;
