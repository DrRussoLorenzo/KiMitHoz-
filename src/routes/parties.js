const router = require('express').Router();
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const auth = require('../middleware/auth');
const { Party, User, Notification, PartyMessage } = require('../models');
const { ARCHIVE_DELAY_MS, archiveExpiredParties } = require('../services/partyArchive');
const { CLOUDINARY_PREFIX, destroyImage, isCloudinaryId, sendAuthenticatedImage, uploadImage } = require('../services/cloudinary');
const emojiOnly = /^(?:(?:\p{Extended_Pictographic}(?:\uFE0F|\p{Emoji_Modifier})?(?:\u200D\p{Extended_Pictographic}(?:\uFE0F|\p{Emoji_Modifier})?)*)|(?:\p{Regional_Indicator}{2})|(?:[0-9#*]\uFE0F?\u20E3))$/u;

const iconValue = (value) => {
  if (typeof value !== 'string' || value.length > 2048) return false;
  if (emojiOnly.test(value)) return true;
  try { return ['http:', 'https:'].includes(new URL(value).protocol); } catch (_error) { return false; }
};

router.use(auth);

const galleryExtensions = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/gif': '.gif', 'image/webp': '.webp' };
const galleryUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, callback) => {
    if (galleryExtensions[file.mimetype]) return callback(null, true);
    callback(Object.assign(new Error('JPG, PNG, GIF vagy WebP képet tölts fel.'), { status: 400 }));
  }
});
const receiveGalleryImage = (req, res, next) => galleryUpload.single('image')(req, res, (error) => {
  if (error?.code === 'LIMIT_FILE_SIZE') error.status = 413;
  next(error);
});
const removeGalleryAsset = (image) => isCloudinaryId(image?.filename)
  ? destroyImage(image.filename.slice(CLOUDINARY_PREFIX.length), 'authenticated').catch(() => {})
  : image?.filename && path.basename(image.filename) === image.filename
    ? fs.promises.unlink(path.join(__dirname, '../../private/party-gallery', image.filename)).catch(() => {})
    : Promise.resolve();
const canAccessGallery = (party, user) => String(party.host?._id || party.host) === String(user._id)
  || party.members.some((member) => String(member.user?._id || member.user) === String(user._id) && member.status === 'going');

const coverUpload = multer({
  storage: multer.memoryStorage(),
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
  uploadImage(req.file.buffer, { folder: 'kimithoz/covers' })
    .then(({ secureUrl }) => res.status(201).json({ imageUrl: secureUrl }))
    .catch((error) => res.status(error.status || 502).json({ message: error.status ? error.message : 'A borítókép feltöltése nem sikerült.' }));
});

// A listákhoz a frontend által megjelenített publikus felhasználói mezőket töltjük be.
const populateParty = (query) => query.populate('host', 'username nickname avatar').populate('members.user', 'username nickname avatar').populate('contributions.user', 'username nickname avatar');
const memberOf = (party, userId) => party.members.find((member) => member.user?._id?.equals(userId) || member.user?.equals?.(userId));
const canChat = (party, userId) => party.host.equals(userId) || memberOf(party, userId)?.status === 'going';
const meetsMinimumAge = (user, party) => Number.isInteger(user.age) && user.age >= (party.minAge || 16);
const ageRequirementMessage = (party) => `Ehhez a bulihoz legalább ${party.minAge || 16} évesnek kell lenned.`;

router.get('/:id/chat/messages', async (req, res, next) => {
  try {
    const party = await Party.findById(req.params.id).select('host members');
    if (!party) return res.status(404).json({ message: 'A buli nem található.' });
    if (!canChat(party, req.user._id)) return res.status(403).json({ message: 'A chatet csak a buli résztvevői érhetik el.' });
    let messages;
    const target = req.query.messageId && /^[a-f\d]{24}$/i.test(req.query.messageId)
      ? await PartyMessage.findOne({ _id: req.query.messageId, party: party._id }).select('_id createdAt').lean()
      : null;
    if (target) {
      const beforeFilter = { party: party._id, $or: [{ createdAt: { $lt: target.createdAt } }, { createdAt: target.createdAt, _id: { $lt: target._id } }] };
      const afterFilter = { party: party._id, $or: [{ createdAt: { $gt: target.createdAt } }, { createdAt: target.createdAt, _id: { $gt: target._id } }] };
      const [before, targetMessage, after] = await Promise.all([
        PartyMessage.find(beforeFilter).sort({ createdAt: -1, _id: -1 }).limit(49).populate('sender', 'nickname avatar').lean(),
        PartyMessage.findById(target._id).populate('sender', 'nickname avatar').lean(),
        PartyMessage.find(afterFilter).sort({ createdAt: 1, _id: 1 }).limit(50).populate('sender', 'nickname avatar').lean()
      ]);
      messages = [...before.reverse(), targetMessage, ...after];
    } else {
      messages = await PartyMessage.find({ party: party._id }).sort({ createdAt: -1, _id: -1 }).limit(100).populate('sender', 'nickname avatar').lean();
      messages.reverse();
    }
    res.json({ messages });
  } catch (error) { next(error); }
});

router.post('/:id/chat/messages', async (req, res, next) => {
  try {
    const party = await Party.findById(req.params.id).select('host members title');
    if (!party) return res.status(404).json({ message: 'A buli nem található.' });
    if (!canChat(party, req.user._id)) return res.status(403).json({ message: 'A chatbe csak a buli résztvevői írhatnak.' });
    const text = typeof req.body.text === 'string' ? req.body.text.trim() : '';
    if (!text || text.length > 1000) return res.status(400).json({ message: 'Az üzenet 1–1000 karakter hosszú lehet.' });
    const requestedMentions = req.body.mentionedUserIds === undefined ? [] : req.body.mentionedUserIds;
    if (!Array.isArray(requestedMentions) || requestedMentions.length > 20) return res.status(400).json({ message: 'Legfeljebb 20 résztvevőt jelölhetsz meg egy üzenetben.' });
    const allowedMentionIds = new Set([
      String(party.host),
      ...party.members.filter((member) => member.status === 'going').map((member) => String(member.user))
    ]);
    const mentionedUserIds = [...new Set(requestedMentions.map((id) => typeof id === 'string' ? id : ''))];
    if (mentionedUserIds.some((id) => !/^[a-f\d]{24}$/i.test(id) || !allowedMentionIds.has(id) || id === String(req.user._id))) {
      return res.status(400).json({ message: 'Csak a buli többi résztvevőjét jelölheted meg.' });
    }
    const mentionedUsers = mentionedUserIds.length
      ? await User.find({ _id: { $in: mentionedUserIds } }).select('username settings.notifications').lean()
      : [];
    if (mentionedUsers.length !== mentionedUserIds.length || mentionedUsers.some((user) => !text.toLowerCase().includes(`@${user.username.toLowerCase()}`))) {
      return res.status(400).json({ message: 'Az üzenetben is szerepeljen a megjelölt felhasználó @neve.' });
    }
    const message = await PartyMessage.create({ party: party._id, sender: req.user._id, text, mentionedUsers: mentionedUserIds });
    if (mentionedUserIds.length) {
      const notificationText = Array.from(`${req.user.nickname} megemlített a(z) ${party.title} buli chatjében: ${text}`).slice(0, 240).join('');
      await Notification.insertMany(mentionedUsers.filter((user) => user.settings?.notifications !== false).map(({ _id }) => ({ recipient: _id, sender: req.user._id, party: party._id, partyMessage: message._id, type: 'party-mention', message: notificationText })));
    }
    await message.populate('sender', 'nickname avatar');
    res.status(201).json({ message });
  } catch (error) { next(error); }
});

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
    const parties = await populateParty(Party.find({ isArchived: { $ne: true }, $or: [{ host: req.user._id }, { members: { $elemMatch: { user: req.user._id, status: { $in: ['invited', 'going'] } } } }] })).sort({ date: 1 });
    res.json({ parties });
  } catch (error) { next(error); }
});

router.get('/discover', async (req, res, next) => {
  try {
    const parties = await populateParty(Party.find({ visibility: 'public', date: { $gte: new Date() } })).sort({ date: 1 }).limit(60);
    res.json({ parties });
  } catch (error) { next(error); }
});

router.get('/archive', async (req, res, next) => {
  try {
    await archiveExpiredParties();
    const parties = await Party.find({
      isArchived: true,
      $or: [
        { host: req.user._id },
        { members: { $elemMatch: { user: req.user._id, status: 'going' } } }
      ]
    }).select('title coverImage date location host galleryImages._id galleryImages.uploadedAt galleryImages.uploadedBy galleryImages.format galleryImages.version +galleryImages.filename')
      .populate('host', 'nickname')
      .sort({ date: -1 })
      .lean();
    res.json({ parties: parties.map((party) => ({
      ...party,
      galleryImages: (party.galleryImages || []).map(({ filename: _filename, ...image }) => image)
    })) });
  } catch (error) { next(error); }
});

router.post('/:id/gallery', receiveGalleryImage, async (req, res, next) => {
  let uploadedAsset;
  try {
    await archiveExpiredParties();
    const party = await Party.findById(req.params.id);
    if (!party) return res.status(404).json({ message: 'A buli nem található.' });
    if (!canAccessGallery(party, req.user)) return res.status(403).json({ message: 'A galériát csak a buli résztvevői használhatják.' });
    if (party.isArchived || Date.now() >= new Date(party.date).getTime() + ARCHIVE_DELAY_MS) {
      return res.status(410).json({ message: 'A buli galériája már archiválva van, új képet nem lehet feltölteni.' });
    }
    if (Date.now() < new Date(party.date).getTime()) {
      return res.status(400).json({ message: 'Képet a buli napjától lehet feltölteni.' });
    }
    if (!req.file) return res.status(400).json({ message: 'Válassz ki egy képet a feltöltéshez.' });
    if (party.galleryImages.length >= 30) {
      return res.status(400).json({ message: 'Egy buli galériájába legfeljebb 30 kép tölthető fel.' });
    }
    uploadedAsset = await uploadImage(req.file.buffer, { folder: `kimithoz/party-gallery/${party._id}`, type: 'authenticated' });
    party.galleryImages.push({ filename: `${CLOUDINARY_PREFIX}${uploadedAsset.publicId}`, format: uploadedAsset.format, version: uploadedAsset.version, uploadedBy: req.user._id });
    await party.save();
    res.status(201).json({ message: 'A kép bekerült a buli galériájába.', imageId: party.galleryImages[party.galleryImages.length - 1]._id });
  } catch (error) {
    if (uploadedAsset?.publicId) await destroyImage(uploadedAsset.publicId, 'authenticated').catch(() => {});
    next(error);
  }
});

router.get('/:id/gallery/:imageId/image', async (req, res, next) => {
  try {
    const party = await Party.findById(req.params.id).select('host members galleryImages._id galleryImages.format galleryImages.version +galleryImages.filename');
    if (!party) return res.status(404).json({ message: 'A buli nem található.' });
    if (!canAccessGallery(party, req.user)) return res.status(403).json({ message: 'A galériát csak a buli résztvevői láthatják.' });
    const image = party.galleryImages.id(req.params.imageId);
    if (!image || !image.filename) return res.status(404).json({ message: 'A kép nem található.' });
    if (isCloudinaryId(image.filename)) {
      await sendAuthenticatedImage(res, image.filename.slice(CLOUDINARY_PREFIX.length), image);
      return;
    }
    if (path.basename(image.filename) !== image.filename) return res.status(404).json({ message: 'A kép nem található.' });
    res.set('Cache-Control', 'private, no-store');
    res.sendFile(path.join(__dirname, '../../private/party-gallery', image.filename), (error) => {
      if (error && !res.headersSent) {
        if (error.code === 'ENOENT') return res.status(404).json({ message: 'A kép fájlja nem található a szerveren.' });
        next(error);
      }
    });
  } catch (error) { next(error); }
});

router.post('/', async (req, res, next) => {
  try {
    const { title, coverImage = '', description = '', date, location, coordinates, visibility = 'private', ticketPrice = 0, maxGuests = 30, minAge = 16 } = req.body;
    if (!title || !date || !location) return res.status(400).json({ message: 'A buli neve, időpontja és helyszíne kötelező.' });
    if (!Number.isInteger(Number(minAge)) || Number(minAge) < 16 || Number(minAge) > 120) return res.status(400).json({ message: 'A minimális életkor 16 és 120 év közötti egész szám legyen.' });
    if (!Number.isInteger(req.user.age) || Number(minAge) > req.user.age) return res.status(403).json({ message: `A saját bulidhoz legalább ${Number(minAge)} évesnek kell lenned.` });
    if (!validCoverImage(coverImage)) return res.status(400).json({ message: 'Adj meg érvényes http(s) kép URL-t vagy tölts fel képet.' });
    if (Number.isNaN(new Date(date).getTime()) || new Date(date) <= new Date()) return res.status(400).json({ message: 'A buli időpontja a jövőben legyen.' });
    const normalizedCoordinates = validateCoordinates(coordinates);
    if (visibility === 'public' && !normalizedCoordinates) return res.status(400).json({ message: 'Nyilvános bulihoz jelölj ki egy helyet a térképen.' });
    const party = await Party.create({ title, coverImage, description, date, location, coordinates: visibility === 'public' ? normalizedCoordinates : undefined, visibility, ticketPrice, maxGuests, minAge: Number(minAge), host: req.user._id, inviteCode: visibility === 'private' ? crypto.randomBytes(4).toString('hex').toUpperCase() : undefined, members: [{ user: req.user._id, status: 'going' }] });
    res.status(201).json({ party: await populateParty(Party.findById(party._id)) });
  } catch (error) { next(error); }
});

router.post('/join', async (req, res, next) => {
  try {
    const code = String(req.body.inviteCode || '').trim().toUpperCase();
    if (!code) return res.status(400).json({ message: 'Add meg a meghívókódot.' });
    const party = await Party.findOne({ inviteCode: code });
    if (!party) return res.status(404).json({ message: 'Nem található buli ezzel a meghívókóddal.' });
    if (!meetsMinimumAge(req.user, party)) return res.status(403).json({ message: ageRequirementMessage(party) });
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

    const { title, coverImage, description, date, location, coordinates, visibility, ticketPrice, maxGuests, minAge } = req.body;
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
    if (minAge !== undefined) {
      const ageLimit = Number(minAge);
      if (!Number.isInteger(ageLimit) || ageLimit < 16 || ageLimit > 120) return res.status(400).json({ message: 'A minimális életkor 16 és 120 év közötti egész szám legyen.' });
      if (!Number.isInteger(req.user.age) || ageLimit > req.user.age) return res.status(400).json({ message: 'A szervező életkora nem lehet alacsonyabb a buli korhatáránál.' });
      const memberIds = party.members.filter((member) => ['going', 'invited'].includes(member.status)).map((member) => member.user);
      const underageMember = await User.findOne({ _id: { $in: memberIds }, $or: [{ age: { $lt: ageLimit } }, { age: { $exists: false } }] }).select('nickname');
      if (underageMember) return res.status(400).json({ message: `A korhatár nem emelhető: ${underageMember.nickname} jelenlegi résztvevőként vagy meghívottként nem felelne meg.` });
      party.minAge = ageLimit;
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
    const party = await Party.findById(req.params.id).select('+galleryImages.filename');
    if (!party) return res.status(404).json({ message: 'A buli nem található.' });
    if (!party.host.equals(req.user._id)) return res.status(403).json({ message: 'Csak a házigazda törölheti ezt a bulit.' });
    if (typeof req.body.confirmation !== 'string' || req.body.confirmation.trim() !== party.title) return res.status(400).json({ message: 'A törléshez írd be pontosan a buli nevét.' });
    await Promise.all(party.galleryImages.map(removeGalleryAsset));
    await Notification.deleteMany({ party: party._id });
    await PartyMessage.deleteMany({ party: party._id });
    await party.deleteOne();
    res.json({ message: 'A buli törölve.' });
  } catch (error) { next(error); }
});

router.post('/:id/join', async (req, res, next) => {
  try {
    const party = await Party.findById(req.params.id);
    if (!party || party.visibility !== 'public') return res.status(404).json({ message: 'A nyilvános buli nem található.' });
    if (!meetsMinimumAge(req.user, party)) return res.status(403).json({ message: ageRequirementMessage(party) });
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
    if (!meetsMinimumAge(friend, party)) return res.status(403).json({ message: `${friend.nickname} nem felel meg a buli korhatárának (${party.minAge || 16} év).` });
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
      if (!meetsMinimumAge(friend, party)) return res.status(403).json({ message: `${friend.nickname} nem felel meg a buli korhatárának (${party.minAge || 16} év).` });
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
    if (req.body.status === 'going' && !meetsMinimumAge(req.user, party)) return res.status(403).json({ message: ageRequirementMessage(party) });
    if (req.body.status === 'going' && party.members.filter((member) => member.status === 'going').length >= party.maxGuests) return res.status(409).json({ message: 'A buli elérte a maximális létszámot.' });
    membership.status = req.body.status;
    await party.save();
    res.json({ party: await populateParty(Party.findById(party._id)) });
  } catch (error) { next(error); }
});

router.post('/:id/leave', async (req, res, next) => {
  try {
    const party = await Party.findById(req.params.id);
    if (!party) return res.status(404).json({ message: 'A buli nem található.' });
    if (party.host.equals(req.user._id)) return res.status(400).json({ message: 'A szervező nem léphet ki a saját bulijából. A buli törölhető vagy átadható másik szervezőnek.' });
    const membership = party.members.find((member) => member.user.equals(req.user._id) && member.status === 'going');
    if (!membership) return res.status(404).json({ message: 'Nem vagy résztvevője ennek a bulinak.' });
    party.members.pull(membership._id);
    await party.save();
    res.json({ message: 'Kiléptél a buliból.' });
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
    const parsedQuantity = Number(quantity);
    const price = Number(req.body.price ?? 0);
    const icon = typeof req.body.icon === 'string' && req.body.icon.trim() ? req.body.icon.trim() : '✳';
    if (!name?.trim()) return res.status(400).json({ message: 'A tétel megnevezése kötelező.' });
    if (!Number.isInteger(parsedQuantity) || parsedQuantity < 1 || parsedQuantity > 1000) return res.status(400).json({ message: 'A mennyiség 1 és 1000 közötti egész szám legyen.' });
    if (!Number.isSafeInteger(price) || price < 0 || price > 1000000) return res.status(400).json({ message: 'Az ár 0 és 1 000 000 Ft közötti egész összeg legyen.' });
    if (!iconValue(icon)) return res.status(400).json({ message: 'Az ikon egyetlen emoji vagy http(s) kép URL lehet.' });
    party.contributions.push({ user: req.user._id, name: name.trim(), quantity: String(parsedQuantity), price, category, icon });
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