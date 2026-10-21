const router = require('express').Router();
const crypto = require('crypto');
const path = require('path');
const multer = require('multer');
const auth = require('../middleware/auth');
const { Party, User, Notification } = require('../models');
const emojiOnly = /^(?:(?:\p{Extended_Pictographic}(?:\uFE0F|\p{Emoji_Modifier})?(?:\u200D\p{Extended_Pictographic}(?:\uFE0F|\p{Emoji_Modifier})?)*)|(?:\p{Regional_Indicator}{2})|(?:[0-9#*]\uFE0F?\u20E3))$/u;

const iconValue = (value) => {
  if (typeof value !== 'string' || value.length > 2048) return false;
  if (emojiOnly.test(value)) return true;
  try { return ['http:', 'https:'].includes(new URL(value).protocol); } catch (_error) { return false; }
};

router.use(auth);

const coverUpload = multer({
  storage: multer.diskStorage({
    destination: path.join(__dirname, '../../public/uploads'),
    filename: (_req, file, callback) => callback(null, `${crypto.randomBytes(16).toString('hex')}${path.extname(file.originalname).toLowerCase()}`)
  }),
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, callback) => {
    const validTypes = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/gif': '.gif', 'image/webp': '.webp' };
    if (validTypes[file.mimetype] && path.extname(file.originalname).toLowerCase() === validTypes[file.mimetype]) return callback(null, true);
    callback(Object.assign(new Error('JPG, PNG, GIF vagy WebP képet tölts fel.'), { status: 400 }));
  }
});

const validCoverImage = (value) => {
  if (typeof value !== 'string' || value.length > 2048) return false;
  if (/^\/uploads\/[a-f0-9]{32}\.(?:jpg|png|gif|webp)$/i.test(value)) return true;
  try { return ['http:', 'https:'].includes(new URL(value).protocol); } catch (_error) { return false; }
};

router.post('/cover-image', coverUpload.single('image'), (req, res) => {
  if (!req.file) return res.status(400).json({ message: 'Válassz ki egy képfájlt.' });
  res.status(201).json({ imageUrl: `/uploads/${req.file.filename}` });
});

// A listákhoz a frontend által megjelenített publikus felhasználói mezőket töltjük be.
const populateParty = (query) => query.populate('host', 'username nickname avatar').populate('members.user', 'username nickname avatar').populate('contributions.user', 'username nickname avatar');
const memberOf = (party, userId) => party.members.find((member) => member.user?._id?.equals(userId) || member.user?.equals?.(userId));

// Nyilvános eseményhez kell koordináta; privát buli helyét nem tesszük térképre.
const validateCoordinates = (coordinates) => {
  if (!coordinates || coordinates.lat === '' || coordinates.lng === '') return null;
  const lat = Number(coordinates.lat);
  const lng = Number(coordinates.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  return { lat, lng };
};

router.get('/mine', async (req, res, next) => {
  try {
    const parties = await populateParty(Party.find({ $or: [{ host: req.user._id }, { members: { $elemMatch: { user: req.user._id, status: { $in: ['invited', 'going'] } } } }] })).sort({ date: 1 });
    res.json({ parties });
  } catch (error) { next(error); }
});

router.get('/discover', async (req, res, next) => {
  try {
    const parties = await populateParty(Party.find({ visibility: 'public', date: { $gte: new Date() } })).sort({ date: 1 }).limit(60);
    res.json({ parties });
  } catch (error) { next(error); }
});

router.post('/', async (req, res, next) => {
  try {
    const { title, coverImage = '', description = '', date, location, coordinates, visibility = 'private', ticketPrice = 0, maxGuests = 30 } = req.body;
    if (!title || !date || !location) return res.status(400).json({ message: 'A buli neve, időpontja és helyszíne kötelező.' });
    if (!validCoverImage(coverImage)) return res.status(400).json({ message: 'Adj meg érvényes http(s) kép URL-t vagy tölts fel képet.' });
    if (Number.isNaN(new Date(date).getTime()) || new Date(date) <= new Date()) return res.status(400).json({ message: 'A buli időpontja a jövőben legyen.' });
    const normalizedCoordinates = validateCoordinates(coordinates);
    if (visibility === 'public' && !normalizedCoordinates) return res.status(400).json({ message: 'Nyilvános bulihoz jelölj ki egy helyet a térképen.' });
    const party = await Party.create({ title, coverImage, description, date, location, coordinates: visibility === 'public' ? normalizedCoordinates : undefined, visibility, ticketPrice, maxGuests, host: req.user._id, inviteCode: visibility === 'private' ? crypto.randomBytes(4).toString('hex').toUpperCase() : undefined, members: [{ user: req.user._id, status: 'going' }] });
    res.status(201).json({ party: await populateParty(Party.findById(party._id)) });
  } catch (error) { next(error); }
});

router.post('/join', async (req, res, next) => {
  try {
    const code = String(req.body.inviteCode || '').trim().toUpperCase();
    if (!code) return res.status(400).json({ message: 'Add meg a meghívókódot.' });
    const party = await Party.findOne({ inviteCode: code });
    if (!party) return res.status(404).json({ message: 'Nem található buli ezzel a meghívókóddal.' });
    if (party.members.some((member) => member.user.equals(req.user._id) && member.status === 'going')) return res.status(409).json({ message: 'Már csatlakoztál ehhez a bulihoz.' });
    if (party.members.filter((member) => member.status === 'going').length >= party.maxGuests) return res.status(409).json({ message: 'A buli elérte a maximális létszámot.' });
    const existing = party.members.find((member) => member.user.equals(req.user._id));
    if (existing) existing.status = 'going'; else party.members.push({ user: req.user._id, status: 'going' });
    await party.save();
    res.json({ party: await populateParty(Party.findById(party._id)) });
  } catch (error) { next(error); }
});

router.get('/:id', async (req, res, next) => {
  try {
    const party = await populateParty(Party.findById(req.params.id));
    if (!party) return res.status(404).json({ message: 'A buli nem található.' });
    // Privát buli részleteit csak a házigazda vagy nem visszautasító résztvevő láthatja.
    const membership = memberOf(party, req.user._id);
    if (party.visibility === 'private' && !party.host._id.equals(req.user._id) && (!membership || membership.status === 'declined')) return res.status(403).json({ message: 'Ehhez a privát bulihoz nincs hozzáférésed.' });
    res.json({ party });
  } catch (error) { next(error); }
});

router.patch('/:id', async (req, res, next) => {
  try {
    const party = await Party.findById(req.params.id);
    if (!party) return res.status(404).json({ message: 'A buli nem található.' });
    if (!party.host.equals(req.user._id)) return res.status(403).json({ message: 'Csak a házigazda szerkesztheti ezt a bulit.' });

    const { title, coverImage, description, date, location, coordinates, visibility, ticketPrice, maxGuests } = req.body;
    if (title !== undefined) {
      if (typeof title !== 'string' || !title.trim() || title.trim().length > 90) return res.status(400).json({ message: 'A buli neve 1–90 karakteres legyen.' });
      party.title = title.trim();
    }
    if (coverImage !== undefined) {
      if (!validCoverImage(coverImage)) return res.status(400).json({ message: 'Adj meg érvényes http(s) kép URL-t vagy tölts fel képet.' });
      party.coverImage = coverImage;
    }
    if (description !== undefined) {
      if (typeof description !== 'string' || description.length > 1200) return res.status(400).json({ message: 'A leírás legfeljebb 1200 karakter lehet.' });
      party.description = description;
    }
    if (date !== undefined) {
      const parsedDate = new Date(date);
      if (Number.isNaN(parsedDate.getTime()) || parsedDate <= new Date()) return res.status(400).json({ message: 'A buli időpontja a jövőben legyen.' });
      party.date = parsedDate;
    }
    if (location !== undefined) {
      if (typeof location !== 'string' || !location.trim() || location.trim().length > 160) return res.status(400).json({ message: 'A helyszín 1–160 karakteres legyen.' });
      party.location = location.trim();
    }
    if (coordinates !== undefined) {
      const normalizedCoordinates = validateCoordinates(coordinates);
      if (!normalizedCoordinates && (visibility || party.visibility) === 'public') return res.status(400).json({ message: 'Nyilvános bulihoz jelölj ki egy helyet a térképen.' });
      party.coordinates = normalizedCoordinates;
    }
    if (visibility !== undefined) {
      if (!['private', 'public'].includes(visibility)) return res.status(400).json({ message: 'Érvénytelen láthatóság.' });
      party.visibility = visibility;
      if (visibility === 'private' && !party.inviteCode) party.inviteCode = crypto.randomBytes(4).toString('hex').toUpperCase();
      if (visibility === 'public') party.inviteCode = undefined;
      if (visibility === 'public' && (!party.coordinates || !Number.isFinite(party.coordinates.lat) || !Number.isFinite(party.coordinates.lng))) return res.status(400).json({ message: 'Nyilvános bulihoz jelölj ki egy helyet a térképen.' });
      if (visibility === 'private') party.coordinates = undefined;
    }
    if (ticketPrice !== undefined) {
      if (!Number.isFinite(Number(ticketPrice)) || Number(ticketPrice) < 0) return res.status(400).json({ message: 'A belépő összege nem lehet negatív.' });
      party.ticketPrice = Number(ticketPrice);
    }
    if (maxGuests !== undefined) {
      const count = Number(maxGuests);
      const attending = party.members.filter((member) => member.status === 'going').length;
      if (!Number.isInteger(count) || count < 2 || count > 1000 || count < attending) return res.status(400).json({ message: `A létszámkorlát legalább ${Math.max(2, attending)} fő legyen.` });
      party.maxGuests = count;
    }

    try {
      await party.save();
    } catch (error) {
      if (error.code !== 11000 || !party.inviteCode || party.visibility !== 'private') throw error;
      party.inviteCode = crypto.randomBytes(4).toString('hex').toUpperCase();
      await party.save();
    }
    res.json({ party: await populateParty(Party.findById(party._id)) });
  } catch (error) { next(error); }
});

router.delete('/:id', async (req, res, next) => {
  try {
    const party = await Party.findById(req.params.id);
    if (!party) return res.status(404).json({ message: 'A buli nem található.' });
    if (!party.host.equals(req.user._id)) return res.status(403).json({ message: 'Csak a házigazda törölheti ezt a bulit.' });
    if (typeof req.body.confirmation !== 'string' || req.body.confirmation.trim() !== party.title) return res.status(400).json({ message: 'A törléshez írd be pontosan a buli nevét.' });
    await Notification.deleteMany({ party: party._id });
    await party.deleteOne();
    res.json({ message: 'A buli törölve.' });
  } catch (error) { next(error); }
});

router.post('/:id/join', async (req, res, next) => {
  try {
    const party = await Party.findById(req.params.id);
    if (!party || party.visibility !== 'public') return res.status(404).json({ message: 'A nyilvános buli nem található.' });
    if (party.members.some((member) => member.user.equals(req.user._id) && member.status === 'going')) return res.status(409).json({ message: 'Már csatlakoztál ehhez a bulihoz.' });
    if (party.members.filter((member) => member.status === 'going').length >= party.maxGuests) return res.status(409).json({ message: 'A buli elérte a maximális létszámot.' });
    const existing = party.members.find((member) => member.user.equals(req.user._id));
    if (existing) existing.status = 'going'; else party.members.push({ user: req.user._id, status: 'going' });
    await party.save();
    res.json({ party: await populateParty(Party.findById(party._id)) });
  } catch (error) { next(error); }
});

router.post('/:id/invite', async (req, res, next) => {
  try {
    const party = await Party.findById(req.params.id);
    if (!party) return res.status(404).json({ message: 'A buli nem található.' });
    const isHost = party.host.equals(req.user._id);
    const membership = memberOf(party, req.user._id);
    if (!isHost && (!membership || membership.status !== 'going')) return res.status(403).json({ message: 'Csak a buli résztvevői kérhetnek meghívót.' });
    const friend = await User.findById(req.body.userId);
    if (!friend || !req.user.friends.some((id) => id.equals(friend._id))) return res.status(404).json({ message: 'Csak ismerősnek küldhetsz meghívót.' });
    const existing = party.members.find((member) => member.user.equals(friend._id));
    if (existing?.status === 'going') return res.status(409).json({ message: 'Ez a barát már részt vesz a bulin.' });
    if (existing?.status === 'invited') return res.status(409).json({ message: 'Ennek a barátnak már van függőben lévő meghívója.' });

    if (!isHost) {
      const pendingRequest = await Notification.exists({ recipient: party.host, party: party._id, targetUser: friend._id, type: 'party-invite-request', inviteRequestStatus: 'pending' });
      if (pendingRequest) return res.status(409).json({ message: 'Ehhez a baráthoz már elküldted a meghívási kérelmet.' });
      await Notification.create({ recipient: party.host, sender: req.user._id, targetUser: friend._id, party: party._id, type: 'party-invite-request', inviteRequestStatus: 'pending', message: `${req.user.nickname} szeretné meghívni ${friend.nickname} nevű ismerősét erre: ${party.title}` });
      return res.status(201).json({ message: 'A meghívási kérelmet elküldtük a szervezőnek.' });
    }

    if (existing) existing.status = 'invited'; else party.members.push({ user: friend._id, status: 'invited' });
    await party.save();
    if (friend.settings.notifications) await Notification.create({ recipient: friend._id, sender: req.user._id, party: party._id, type: 'party-invite', message: `${req.user.nickname} meghívott erre: ${party.title}` });
    res.status(201).json({ message: 'Meghívó elküldve.' });
  } catch (error) { next(error); }
});

router.post('/:id/invite-requests/:notificationId/respond', async (req, res, next) => {
  try {
    const party = await Party.findById(req.params.id);
    if (!party) return res.status(404).json({ message: 'A buli nem található.' });
    if (!party.host.equals(req.user._id)) return res.status(403).json({ message: 'Csak a szervező bírálhatja el a kérelmet.' });
    if (!['accept', 'decline'].includes(req.body.status)) return res.status(400).json({ message: 'Érvénytelen döntés.' });
    const request = await Notification.findOne({ _id: req.params.notificationId, recipient: req.user._id, party: party._id, type: 'party-invite-request', inviteRequestStatus: 'pending' });
    if (!request) return res.status(404).json({ message: 'A meghívási kérelem nem található.' });
    const friend = await User.findById(request.targetUser);
    if (!friend) return res.status(404).json({ message: 'A meghívni kívánt felhasználó már nem található.' });

    if (req.body.status === 'accept') {
      if (party.members.filter((member) => member.status === 'going').length >= party.maxGuests) return res.status(409).json({ message: 'A buli elérte a maximális létszámot.' });
      const existing = party.members.find((member) => member.user.equals(friend._id));
      if (existing?.status === 'going' || existing?.status === 'invited') return res.status(409).json({ message: 'A felhasználó már részt vesz, vagy már meghívást kapott.' });
      if (existing) existing.status = 'invited'; else party.members.push({ user: friend._id, status: 'invited' });
      await party.save();
      if (friend.settings.notifications) await Notification.create({ recipient: friend._id, sender: req.user._id, party: party._id, type: 'party-invite', message: `${req.user.nickname} meghívott erre: ${party.title}` });
    } else {
      if (friend.settings.notifications) await Notification.create({ recipient: request.sender, sender: req.user._id, party: party._id, type: 'system', message: `${req.user.nickname} elutasította ${friend.nickname} meghívását erre: ${party.title}` });
    }

    request.read = true;
    request.inviteRequestStatus = req.body.status === 'accept' ? 'accepted' : 'declined';
    await request.save();
    res.json({ message: req.body.status === 'accept' ? 'A meghívást jóváhagytad.' : 'A meghívási kérelmet elutasítottad.' });
  } catch (error) { next(error); }
});

router.post('/:id/respond', async (req, res, next) => {
  try {
    const party = await Party.findById(req.params.id);
    const membership = party && party.members.find((member) => member.user.equals(req.user._id));
    if (!party || !membership || membership.status !== 'invited') return res.status(404).json({ message: 'A meghívó nem található.' });
    if (!['going', 'declined'].includes(req.body.status)) return res.status(400).json({ message: 'Érvénytelen válasz.' });
    if (req.body.status === 'going' && party.members.filter((member) => member.status === 'going').length >= party.maxGuests) return res.status(409).json({ message: 'A buli elérte a maximális létszámot.' });
    membership.status = req.body.status;
    await party.save();
    res.json({ party: await populateParty(Party.findById(party._id)) });
  } catch (error) { next(error); }
});

router.delete('/:id/members/:userId', async (req, res, next) => {
  try {
    const party = await Party.findById(req.params.id);
    if (!party) return res.status(404).json({ message: 'A buli nem található.' });
    if (!party.host.equals(req.user._id)) return res.status(403).json({ message: 'Csak a házigazda távolíthat el résztvevőt.' });
    if (party.host.equals(req.params.userId)) return res.status(400).json({ message: 'A házigazda nem távolíthatja el saját magát.' });
    const membership = party.members.find((member) => member.user.equals(req.params.userId) && member.status === 'going');
    if (!membership) return res.status(404).json({ message: 'A résztvevő nem található.' });
    party.members.pull(membership._id);
    await party.save();
    res.json({ party: await populateParty(Party.findById(party._id)) });
  } catch (error) { next(error); }
});

router.post('/:id/items', async (req, res, next) => {
  try {
    const party = await Party.findById(req.params.id);
    if (!party || !memberOf(party, req.user._id) || memberOf(party, req.user._id).status !== 'going') return res.status(403).json({ message: 'Csak résztvevő adhat hozzá tételt.' });
    const { name, quantity = '1', category = 'egyéb' } = req.body;
    const icon = typeof req.body.icon === 'string' && req.body.icon.trim() ? req.body.icon.trim() : '✳';
    if (!name?.trim()) return res.status(400).json({ message: 'A tétel megnevezése kötelező.' });
    if (!iconValue(icon)) return res.status(400).json({ message: 'Az ikon egyetlen emoji vagy http(s) kép URL lehet.' });
    party.contributions.push({ user: req.user._id, name: name.trim(), quantity, category, icon });
    await party.save();
    res.status(201).json({ party: await populateParty(Party.findById(party._id)) });
  } catch (error) { next(error); }
});

router.delete('/:id/items/:itemId', async (req, res, next) => {
  try {
    const party = await Party.findById(req.params.id);
    if (!party) return res.status(404).json({ message: 'A buli nem található.' });
    const item = party.contributions.id(req.params.itemId);
    if (!item) return res.status(404).json({ message: 'A tétel nem található.' });
    if (!party.host.equals(req.user._id) && !item.user?.equals(req.user._id)) return res.status(403).json({ message: 'Ezt a tételt csak a hozzáadója vagy a házigazda törölheti.' });
    item.deleteOne();
    await party.save();
    res.json({ party: await populateParty(Party.findById(party._id)) });
  } catch (error) { next(error); }
});

module.exports = router;