const router = require('express').Router();
const bcrypt = require('bcryptjs');
const fs = require('fs');
const path = require('path');
const auth = require('../middleware/auth');
const requireAdmin = require('../middleware/admin');
const { User, Party, Notification, PartyMessage } = require('../models');

router.use(auth, requireAdmin);
const userFields = 'email username nickname age avatar bio role isBanned banReason bannedAt settings friends friendRequests createdAt';
const pageSize = 50;
const pageFor = (req) => Math.max(1, Number.parseInt(req.query.page, 10) || 1);
const escapedSearch = (value) => String(value || '').trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const pagination = (page, total) => ({ page, pageSize, total, pages: Math.max(1, Math.ceil(total / pageSize)) });

router.get('/verification-requests', async (_req, res, next) => {
  try {
    const requests = await User.find({ role: 'user', verificationStatus: 'pending' }).select('email username nickname age createdAt').sort({ createdAt: 1 }).lean();
    res.json({ requests });
  } catch (error) { next(error); }
});

router.get('/verification-requests/:id/images/:kind', async (req, res, next) => {
  try {
    const documentKey = { identity: 'identityDocument', face: 'facePhoto' }[req.params.kind];
    if (!documentKey) return res.status(404).json({ message: 'A kép nem található.' });
    const user = await User.findOne({ _id: req.params.id, verificationStatus: 'pending' })
      .select('+verificationDocuments.identityDocument +verificationDocuments.facePhoto');
    const filename = user?.verificationDocuments?.[documentKey];
    if (!filename || path.basename(filename) !== filename) return res.status(404).json({ message: 'A kép nem található.' });
    res.set('Cache-Control', 'private, no-store');
    res.sendFile(path.join(__dirname, '../../private/verification', filename), (error) => {
      if (error && !res.headersSent) {
        if (error.code === 'ENOENT') return res.status(404).json({ message: 'A feltöltött kép fájlja nem található a szerveren.' });
        next(error);
      }
    });
  } catch (error) { next(error); }
});

router.post('/verification-requests/:id/decision', async (req, res, next) => {
  try {
    const { decision } = req.body;
    if (!['approved', 'rejected'].includes(decision)) return res.status(400).json({ message: 'Érvényes döntést válassz.' });
    const user = await User.findOne({ _id: req.params.id, role: 'user', verificationStatus: 'pending' })
      .select('+verificationDocuments.identityDocument +verificationDocuments.facePhoto');
    if (!user) return res.status(404).json({ message: 'A függőben lévő regisztráció nem található.' });
    const filenames = [user.verificationDocuments?.identityDocument, user.verificationDocuments?.facePhoto]
      .filter((filename) => typeof filename === 'string' && path.basename(filename) === filename);
    user.verificationStatus = decision;
    user.verificationReviewedAt = new Date();
    user.verificationDocuments = { identityDocument: undefined, facePhoto: undefined };
    await user.save();
    const verificationDirectory = path.join(__dirname, '../../private/verification');
    await Promise.all(filenames.map((filename) => fs.promises.unlink(path.join(verificationDirectory, filename)).catch(() => {})));
    res.json({ message: `A regisztráció ${decision === 'approved' ? 'jóváhagyva' : 'elutasítva'}.` });
  } catch (error) { next(error); }
});

router.get('/overview', async (_req, res, next) => {
  try {
    const [users, parties, notifications, messages, publicParties, admins] = await Promise.all([
      User.countDocuments(), Party.countDocuments(), Notification.countDocuments(), PartyMessage.countDocuments(),
      Party.countDocuments({ visibility: 'public' }), User.countDocuments({ role: 'admin' })
    ]);
    res.json({ stats: { users, parties, notifications, messages, publicParties, admins } });
  } catch (error) { next(error); }
});

router.get('/users', async (req, res, next) => {
  try {
    const page = pageFor(req);
    const search = escapedSearch(req.query.q);
    const filter = search ? { $or: [{ email: new RegExp(search, 'i') }, { username: new RegExp(search, 'i') }, { nickname: new RegExp(search, 'i') }] } : {};
    const [users, total] = await Promise.all([User.find(filter).select(userFields).sort({ createdAt: -1 }).skip((page - 1) * pageSize).limit(pageSize).lean(), User.countDocuments(filter)]);
    res.json({ users, pagination: pagination(page, total) });
  } catch (error) { next(error); }
});

router.post('/users', async (req, res, next) => {
  try {
    const { email, username, nickname, age, password } = req.body;
    if (!email || !username || !nickname || !password) return res.status(400).json({ message: 'Az e-mail, felhasználónév, becenév és jelszó kötelező.' });
    if (password.length < 8) return res.status(400).json({ message: 'A jelszó legalább 8 karakter legyen.' });
    const user = await User.create({ email, username, nickname, age: age === '' || age == null ? undefined : Number(age), passwordHash: await bcrypt.hash(password, 12), avatar: req.body.avatar || '', bio: req.body.bio || '', isBanned: Boolean(req.body.isBanned), banReason: req.body.banReason || '', bannedAt: req.body.isBanned ? new Date() : undefined });
    res.status(201).json({ user: await User.findById(user._id).select(userFields).lean() });
  } catch (error) { next(error); }
});

router.patch('/users/:id', async (req, res, next) => {
  try {
    const user = await User.findById(req.params.id).select('+passwordHash');
    if (!user) return res.status(404).json({ message: 'A felhasználó nem található.' });
    for (const key of ['email', 'username', 'nickname', 'avatar', 'bio', 'age']) {
      if (req.body[key] === undefined) continue;
      user[key] = key === 'age' && (req.body[key] === '' || req.body[key] == null) ? undefined : req.body[key];
    }
    if (req.body.password) {
      if (typeof req.body.password !== 'string' || req.body.password.length < 8) return res.status(400).json({ message: 'A jelszó legalább 8 karakter legyen.' });
      user.passwordHash = await bcrypt.hash(req.body.password, 12);
    }
    if (req.body.settings && typeof req.body.settings === 'object') {
      if (['light', 'dark'].includes(req.body.settings.theme)) user.settings.theme = req.body.settings.theme;
      if (['hu', 'en'].includes(req.body.settings.language)) user.settings.language = req.body.settings.language;
      if (typeof req.body.settings.notifications === 'boolean') user.settings.notifications = req.body.settings.notifications;
    }
    if (Array.isArray(req.body.friends)) user.friends = req.body.friends;
    if (Array.isArray(req.body.friendRequests)) user.friendRequests = req.body.friendRequests;
    if (typeof req.body.isBanned === 'boolean' && user.role !== 'admin') {
      user.isBanned = req.body.isBanned;
      user.banReason = req.body.isBanned ? String(req.body.banReason || '').trim().slice(0, 240) : '';
      user.bannedAt = req.body.isBanned ? user.bannedAt || new Date() : undefined;
    }
    await user.save();
    res.json({ user: await User.findById(user._id).select(userFields).lean() });
  } catch (error) { next(error); }
});

router.patch('/users/:id/ban', async (req, res, next) => {
  try {
    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ message: 'A felhasználó nem található.' });
    if (user.role === 'admin' || user._id.equals(req.user._id)) return res.status(400).json({ message: 'Admin fiók vagy a saját fiókod nem tiltható ki.' });
    if (typeof req.body.isBanned !== 'boolean') return res.status(400).json({ message: 'Add meg, hogy a fiók kitiltott legyen-e.' });
    user.isBanned = req.body.isBanned;
    user.banReason = user.isBanned ? String(req.body.reason || '').trim().slice(0, 240) : '';
    user.bannedAt = user.isBanned ? new Date() : undefined;
    await user.save();
    res.json({ message: user.isBanned ? 'A felhasználó kitiltva.' : 'A kitiltás feloldva.', user: await User.findById(user._id).select(userFields).lean() });
  } catch (error) { next(error); }
});

router.delete('/users/:id', async (req, res, next) => {
  try {
    const user = await User.findById(req.params.id).select('_id role +verificationDocuments');
    if (!user) return res.status(404).json({ message: 'A felhasználó nem található.' });
    if (user.role === 'admin') return res.status(400).json({ message: 'Az egyetlen admin fiók nem törölhető.' });
    const hosted = await Party.find({ host: user._id }).select('_id');
    const partyIds = hosted.map((party) => party._id);
    await Promise.all([
      Party.deleteMany({ _id: { $in: partyIds } }),
      Notification.deleteMany({ $or: [{ party: { $in: partyIds } }, { recipient: user._id }, { sender: user._id }, { targetUser: user._id }] }),
      PartyMessage.deleteMany({ $or: [{ party: { $in: partyIds } }, { sender: user._id }] }),
      User.updateMany({ _id: { $ne: user._id } }, { $pull: { friends: user._id, friendRequests: user._id } }),
      Party.updateMany({ host: { $ne: user._id } }, { $pull: { members: { user: user._id }, contributions: { user: user._id } } })
    ]);
    const verificationFiles = [user.verificationDocuments?.identityDocument, user.verificationDocuments?.facePhoto]
      .filter((filename) => typeof filename === 'string' && path.basename(filename) === filename);
    await Promise.all(verificationFiles.map((filename) => fs.promises.unlink(path.join(__dirname, '../../private/verification', filename)).catch(() => {})));
    await user.deleteOne();
    res.json({ message: 'A felhasználó és kapcsolódó adatai törölve.' });
  } catch (error) { next(error); }
});

router.get('/parties', async (req, res, next) => {
  try {
    const page = pageFor(req);
    const search = escapedSearch(req.query.q);
    const filter = search ? { $or: [{ title: new RegExp(search, 'i') }, { location: new RegExp(search, 'i') }] } : {};
    const [parties, total] = await Promise.all([Party.find(filter).populate('host', 'username nickname').sort({ createdAt: -1 }).skip((page - 1) * pageSize).limit(pageSize).lean(), Party.countDocuments(filter)]);
    res.json({ parties, pagination: pagination(page, total) });
  } catch (error) { next(error); }
});

router.post('/parties', async (req, res, next) => {
  try {
    const { title, host, date, location } = req.body;
    if (!title || !host || !date || !location) return res.status(400).json({ message: 'A név, szervező, időpont és helyszín kötelező.' });
    const party = await Party.create(req.body);
    res.status(201).json({ party: await Party.findById(party._id).populate('host', 'username nickname').lean() });
  } catch (error) { next(error); }
});

router.patch('/parties/:id', async (req, res, next) => {
  try {
    const party = await Party.findById(req.params.id);
    if (!party) return res.status(404).json({ message: 'A buli nem található.' });
    const allowed = ['title', 'coverImage', 'description', 'host', 'visibility', 'inviteCode', 'date', 'location', 'coordinates', 'ticketPrice', 'maxGuests', 'members', 'contributions'];
    for (const key of allowed) if (req.body[key] !== undefined) party[key] = req.body[key];
    await party.save();
    res.json({ party: await Party.findById(party._id).populate('host', 'username nickname').lean() });
  } catch (error) { next(error); }
});

router.delete('/parties/:id', async (req, res, next) => {
  try {
    const party = await Party.findByIdAndDelete(req.params.id);
    if (!party) return res.status(404).json({ message: 'A buli nem található.' });
    await Promise.all([Notification.deleteMany({ party: party._id }), PartyMessage.deleteMany({ party: party._id })]);
    res.json({ message: 'A buli és kapcsolódó üzenetei törölve.' });
  } catch (error) { next(error); }
});

router.get('/items', async (req, res, next) => {
  try {
    const page = pageFor(req);
    const search = escapedSearch(req.query.q);
    const filter = search ? { $or: [{ 'contributions.name': new RegExp(search, 'i') }, { 'contributions.category': new RegExp(search, 'i') }] } : {};
    const base = [{ $unwind: '$contributions' }, ...(search ? [{ $match: filter }] : [])];
    const [items, countResult] = await Promise.all([
      Party.aggregate([...base, { $sort: { createdAt: -1 } }, { $skip: (page - 1) * pageSize }, { $limit: pageSize }, { $project: { _id: '$contributions._id', partyId: '$_id', partyTitle: '$title', user: '$contributions.user', name: '$contributions.name', quantity: '$contributions.quantity', price: '$contributions.price', category: '$contributions.category', icon: '$contributions.icon' } }]),
      Party.aggregate([...base, { $count: 'total' }])
    ]);
    const userIds = [...new Set(items.map((item) => String(item.user)))];
    const users = await User.find({ _id: { $in: userIds } }).select('username nickname').lean();
    const userMap = new Map(users.map((user) => [String(user._id), user]));
    res.json({ items: items.map((item) => ({ ...item, user: userMap.get(String(item.user)) || item.user })), pagination: pagination(page, countResult[0]?.total || 0) });
  } catch (error) { next(error); }
});

router.post('/items', async (req, res, next) => {
  try {
    const { partyId, user: userId, name, quantity = '1', price = 0, category = 'egyéb', icon = '✳' } = req.body;
    if (!partyId || !userId || !String(name || '').trim()) return res.status(400).json({ message: 'A buli, a hozzáadó felhasználó és a tétel neve kötelező.' });
    const [party, user] = await Promise.all([Party.findById(partyId), User.findById(userId).select('_id')]);
    if (!party || !user) return res.status(404).json({ message: 'A buli vagy a felhasználó nem található.' });
    party.contributions.push({ user: user._id, name: String(name).trim(), quantity: String(quantity), price: Number(price), category, icon: String(icon) });
    await party.save();
    res.status(201).json({ message: 'A tétel hozzáadva.', item: party.contributions[party.contributions.length - 1] });
  } catch (error) { next(error); }
});

router.patch('/items/:partyId/:itemId', async (req, res, next) => {
  try {
    const party = await Party.findById(req.params.partyId);
    const item = party?.contributions.id(req.params.itemId);
    if (!item) return res.status(404).json({ message: 'A tétel nem található.' });
    for (const key of ['user', 'name', 'quantity', 'price', 'category', 'icon']) if (req.body[key] !== undefined) item[key] = req.body[key];
    await party.save();
    res.json({ message: 'A tétel frissítve.', item });
  } catch (error) { next(error); }
});

router.delete('/items/:partyId/:itemId', async (req, res, next) => {
  try {
    const party = await Party.findById(req.params.partyId);
    const item = party?.contributions.id(req.params.itemId);
    if (!item) return res.status(404).json({ message: 'A tétel nem található.' });
    item.deleteOne();
    await party.save();
    res.json({ message: 'A tétel törölve.' });
  } catch (error) { next(error); }
});

router.get('/notifications', async (req, res, next) => {
  try {
    const page = pageFor(req);
    const search = escapedSearch(req.query.q);
    const filter = search ? { $or: [{ message: new RegExp(search, 'i') }, { type: new RegExp(search, 'i') }] } : {};
    const [notifications, total] = await Promise.all([Notification.find(filter).populate('recipient', 'username nickname').populate('sender', 'username nickname').sort({ createdAt: -1 }).skip((page - 1) * pageSize).limit(pageSize).lean(), Notification.countDocuments(filter)]);
    res.json({ notifications, pagination: pagination(page, total) });
  } catch (error) { next(error); }
});

router.post('/notifications', async (req, res, next) => {
  try {
    const notification = await Notification.create(req.body);
    res.status(201).json({ notification });
  } catch (error) { next(error); }
});

router.patch('/notifications/:id', async (req, res, next) => {
  try {
    const notification = await Notification.findById(req.params.id);
    if (!notification) return res.status(404).json({ message: 'Az értesítés nem található.' });
    for (const key of ['recipient', 'sender', 'party', 'targetUser', 'type', 'inviteRequestStatus', 'message', 'read']) {
      if (req.body[key] !== undefined) notification[key] = req.body[key];
    }
    await notification.save();
    res.json({ notification });
  } catch (error) { next(error); }
});

router.delete('/notifications/:id', async (req, res, next) => {
  try {
    const notification = await Notification.findByIdAndDelete(req.params.id);
    if (!notification) return res.status(404).json({ message: 'Az értesítés nem található.' });
    res.json({ message: 'Az értesítés törölve.' });
  } catch (error) { next(error); }
});

router.get('/messages', async (req, res, next) => {
  try {
    const page = pageFor(req);
    const search = escapedSearch(req.query.q);
    const filter = search ? { text: new RegExp(search, 'i') } : {};
    const [messages, total] = await Promise.all([PartyMessage.find(filter).populate('party', 'title').populate('sender', 'username nickname').sort({ createdAt: -1 }).skip((page - 1) * pageSize).limit(pageSize).lean(), PartyMessage.countDocuments(filter)]);
    res.json({ messages, pagination: pagination(page, total) });
  } catch (error) { next(error); }
});

router.post('/messages', async (req, res, next) => {
  try {
    const message = await PartyMessage.create(req.body);
    res.status(201).json({ message });
  } catch (error) { next(error); }
});

router.patch('/messages/:id', async (req, res, next) => {
  try {
    const message = await PartyMessage.findById(req.params.id);
    if (!message) return res.status(404).json({ message: 'Az üzenet nem található.' });
    for (const key of ['party', 'sender', 'text']) if (req.body[key] !== undefined) message[key] = req.body[key];
    await message.save();
    res.json({ message });
  } catch (error) { next(error); }
});

router.delete('/messages/:id', async (req, res, next) => {
  try {
    const message = await PartyMessage.findByIdAndDelete(req.params.id);
    if (!message) return res.status(404).json({ message: 'Az üzenet nem található.' });
    res.json({ message: 'Az üzenet törölve.' });
  } catch (error) { next(error); }
});

module.exports = router;
