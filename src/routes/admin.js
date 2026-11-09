const router = require('express').Router();
const bcrypt = require('bcryptjs');
const fs = require('fs');
const path = require('path');
const auth = require('../middleware/auth');
const requireAdmin = require('../middleware/admin');
const { User, Party, Notification, PartyMessage, AdminAuditLog } = require('../models');
const {
  destroyImage,
  isCloudinaryId,
  sendAuthenticatedImage,
  toCloudinaryId,
} = require('../services/cloudinary');

router.use(auth, requireAdmin);
const resourceLabels = {
  users: 'felhasználó',
  parties: 'buli',
  items: 'tétel',
  notifications: 'értesítés',
  messages: 'chatüzenet',
  'verification-requests': 'regisztráció',
};
const changedFieldLabels = {
  email: 'e-mail-cím',
  username: 'felhasználónév',
  nickname: 'becenév',
  age: 'életkor',
  avatar: 'profilkép',
  bio: 'bemutatkozás',
  isBanned: 'fiókállapot',
  banReason: 'kitiltási indok',
  settings: 'beállítások',
  friends: 'ismerőslista',
  friendRequests: 'barátfelkérések',
  title: 'buli neve',
  host: 'szervező',
  date: 'időpont',
  location: 'helyszín',
  visibility: 'láthatóság',
  ticketPrice: 'belépő',
  maxGuests: 'létszámkorlát',
  minAge: 'korhatár',
  inviteCode: 'meghívókód',
  coverImage: 'borítókép',
  description: 'leírás',
  coordinates: 'helykoordináták',
  members: 'résztvevők',
  contributions: 'hozható tételek',
  partyId: 'buli',
  user: 'felhasználó',
  name: 'tétel neve',
  quantity: 'mennyiség',
  price: 'ár',
  category: 'kategória',
  icon: 'ikon',
  recipient: 'címzett',
  sender: 'feladó',
  party: 'buli',
  targetUser: 'célfelhasználó',
  type: 'értesítéstípus',
  inviteRequestStatus: 'meghívási kérelem állapota',
  message: 'üzenet',
  read: 'olvasottság',
  text: 'üzenet szövege',
  password: 'jelszó',
};
/** Meghatározza a naplóbejegyzés művelettípusát az útvonal és a kérés alapján. */
function auditAction(req, resource, segments) {
  if (resource === 'verification-requests' && segments[2] === 'decision')
    return req.body?.decision === 'approved' ? 'approve' : 'reject';
  if (resource === 'users' && segments[2] === 'ban') return req.body?.isBanned ? 'ban' : 'unban';
  return (
    { POST: 'create', PATCH: 'update', PUT: 'update', DELETE: 'delete' }[req.method] || 'update'
  );
}
/** Összehasonlításhoz egységes, JSON-kompatibilis formára alakít egy értéket. */
function normalizedAuditValue(value, field) {
  if (value === '' || value === undefined) return null;
  if (value === null) return null;
  if (value instanceof Date) return value.toISOString();
  if (value && typeof value.toHexString === 'function') return value.toHexString();
  if (field === 'date' && typeof value === 'string') {
    const parsedDate = new Date(value);
    if (!Number.isNaN(parsedDate.getTime())) return parsedDate.toISOString();
  }
  if (Array.isArray(value)) return value.map((entry) => normalizedAuditValue(entry));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .filter((key) => key !== '_id' && key !== '__v')
        .sort()
        .map((key) => [key, normalizedAuditValue(value[key], key)])
    );
  }
  return value;
}
/** Biztonságosan felismeri és szöveggé alakítja az adatbázis-azonosítókat. */
function auditObjectId(value) {
  if (value && typeof value.toHexString === 'function') return value.toHexString();
  if (typeof value === 'string' && /^[a-f\d]{24}$/i.test(value)) return value;
  return '';
}
/** Felhasználói azonosítókhoz olvasható neveket keres a napló megjelenítéséhez. */
async function auditUserLabels(ids) {
  const uniqueIds = [...new Set(ids.map(auditObjectId).filter(Boolean))];
  if (!uniqueIds.length) return new Map();
  const users = await User.find({ _id: { $in: uniqueIds } })
    .select('nickname username')
    .lean();
  return new Map(
    users.map((user) => [
      String(user._id),
      `${user.nickname || user.username}${user.username ? ` (@${user.username})` : ''}`,
    ])
  );
}
/** Az adatbázisbeli mezőértéket adatvédelmi szempontból biztonságos szöveggé alakítja. */
async function readableAuditValue(value, field) {
  if (['user', 'host', 'recipient', 'sender', 'targetUser'].includes(field)) {
    const id = auditObjectId(value);
    if (!id) return value;
    return (await auditUserLabels([id])).get(id) || 'Felhasználó már nem található';
  }
  if (['party', 'partyId'].includes(field)) {
    const id = auditObjectId(value);
    if (!id) return value;
    const party = await Party.findById(id).select('title').lean();
    return party?.title || 'Buli már nem található';
  }
  if (field === 'friends' || field === 'friendRequests') {
    const labels = await auditUserLabels(value || []);
    return (value || []).map(
      (id) => labels.get(auditObjectId(id)) || 'Felhasználó már nem található'
    );
  }
  if (field === 'members') {
    const members = value || [];
    const labels = await auditUserLabels(members.map((member) => member.user));
    return members.map(
      (member) =>
        `${labels.get(auditObjectId(member.user)) || 'Felhasználó már nem található'} · ${member.status || 'állapot nélkül'}`
    );
  }
  if (field === 'contributions') {
    return (value || []).map(
      (item) =>
        `${item.name || 'Tétel'} × ${item.quantity || '1'} · ${Number(item.price || 0).toLocaleString('hu-HU')} Ft`
    );
  }
  return value;
}
/** Meghatározza, mely mezők értéke változik ténylegesen egy adminisztrátori műveletben. */
async function actuallyChangedFields(resource, segments, body) {
  try {
    let existing;
    let keys = Object.keys(body || {});
    if (resource === 'users') {
      if (segments[2] === 'ban') return [];
      existing = await User.findById(segments[1])
        .select(
          'email username nickname age avatar bio isBanned banReason settings friends friendRequests +passwordHash'
        )
        .lean();
    } else if (resource === 'parties') {
      existing = await Party.findById(segments[1])
        .select(
          'title coverImage description host visibility inviteCode date location coordinates ticketPrice maxGuests minAge members contributions'
        )
        .lean();
    } else if (resource === 'items') {
      const party = await Party.findById(segments[1]).select('contributions').lean();
      existing = party?.contributions?.find((item) => String(item._id) === String(segments[2]));
      keys = keys.filter((key) =>
        ['user', 'name', 'quantity', 'price', 'category', 'icon'].includes(key)
      );
    } else if (resource === 'notifications') {
      existing = await Notification.findById(segments[1]).lean();
    } else if (resource === 'messages') {
      existing = await PartyMessage.findById(segments[1]).lean();
    }
    if (!existing) return [];
    const changed = keys
      .filter(
        (key) =>
          Object.prototype.hasOwnProperty.call(existing, key) &&
          JSON.stringify(normalizedAuditValue(existing[key], key)) !==
            JSON.stringify(normalizedAuditValue(body[key], key))
      )
      .map((key) => ({ key, from: existing[key], to: body[key] }));
    return Promise.all(
      changed.map(async (change) => ({
        ...change,
        from: await readableAuditValue(change.from, change.key),
        to: await readableAuditValue(change.to, change.key),
      }))
    );
  } catch (_error) {
    return [];
  }
}
/** Magyar, tömör összefoglalót készít a módosított mezőkről. */
function auditFieldSummary(body, keys = Object.keys(body || {})) {
  const fieldKeys = keys.map((entry) => (typeof entry === 'string' ? entry : entry.key));
  const fields = fieldKeys.map((key) => changedFieldLabels[key] || key);
  if (body?.password && fieldKeys.includes('password')) fields.push('jelszó beállítása');
  return [...new Set(fields.filter((field) => field !== 'jelszó'))];
}
/** Egy mező értékét naplózáshoz olvasható és biztonságos formázza. */
function auditValueText(value, key) {
  if (key === 'password') return 'rejtett';
  if (key === 'banReason') return 'indok rejtve';
  if (value === undefined || value === null || value === '') return 'nincs megadva';
  if (typeof value === 'boolean') return value ? 'igen' : 'nem';
  if (typeof value === 'number') return value.toLocaleString('hu-HU');
  if (value instanceof Date || (key === 'date' && typeof value === 'string')) {
    const date = new Date(value);
    if (!Number.isNaN(date.getTime()))
      return new Intl.DateTimeFormat('hu-HU', { dateStyle: 'short', timeStyle: 'short' }).format(
        date
      );
  }
  if (value && typeof value.toHexString === 'function') return value.toHexString();
  if (Array.isArray(value)) return `[${value.map((entry) => auditValueText(entry)).join(', ')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value)
      .map(
        ([field, entry]) => `${changedFieldLabels[field] || field}: ${auditValueText(entry, field)}`
      )
      .join(', ')}}`;
  }
  const text = String(value).replace(/\s+/g, ' ').trim();
  return `„${text.length > 90 ? `${text.slice(0, 87)}…` : text}”`;
}
/** Leírja az adminművelet lényegét anélkül, hogy érzékeny adatot naplózna. */
function describeAuditAction(action, resource, name, body, changedFields) {
  const target = resourceLabels[resource] || resource;
  const namedTarget = name ? `: ${name}` : '';
  if (action === 'approve') return `Regisztráció jóváhagyása${namedTarget}`;
  if (action === 'reject') return `Regisztráció elutasítása${namedTarget}`;
  if (action === 'ban') return `Felhasználó kitiltása${namedTarget}`;
  if (action === 'unban') return `Felhasználó kitiltásának feloldása${namedTarget}`;
  if (action === 'create') {
    const fields = auditFieldSummary(body, changedFields);
    return `Új ${target} létrehozása${namedTarget}${fields.length ? ` · Megadott mezők: ${fields.join(', ')}` : ''}`;
  }
  if (action === 'delete')
    return `${target[0].toUpperCase()}${target.slice(1)} törlése${namedTarget}`;
  const changes = auditFieldSummary(body, changedFields);
  const transitions = changedFields.map((change) => {
    if (typeof change === 'string') return `${changedFieldLabels[change] || change} megadva`;
    if (change.key === 'password') return 'jelszó megváltozott';
    if (change.key === 'banReason') return 'kitiltási indok módosult (tartalma rejtett)';
    return `${changedFieldLabels[change.key] || change.key}: ${auditValueText(change.from, change.key)} → ${auditValueText(change.to, change.key)}`;
  });
  return `${target[0].toUpperCase()}${target.slice(1)} módosítása${namedTarget}${changes.length ? ` · Módosítás: ${transitions.join('; ')}` : ' · Nem változott adat'}`;
}
/** Megkeresi a naplózott erőforrás ember számára érthető nevét. */
async function auditResourceName(resource, segments, body = {}) {
  try {
    if (resource === 'users') {
      const user = segments[1]
        ? await User.findById(segments[1]).select('nickname username').lean()
        : null;
      return String(body.nickname || user?.nickname || user?.username || '');
    }
    if (resource === 'parties') {
      const party = segments[1] ? await Party.findById(segments[1]).select('title').lean() : null;
      return String(body.title || party?.title || '');
    }
    if (resource === 'verification-requests') {
      const user = segments[1]
        ? await User.findById(segments[1]).select('nickname username').lean()
        : null;
      return String(user?.nickname || user?.username || '');
    }
    if (resource === 'items') {
      const partyId = segments[1] || body.partyId;
      const party = partyId
        ? await Party.findById(partyId).select('contributions.name').lean()
        : null;
      const item = party?.contributions?.find(
        (entry) => String(entry._id) === String(segments[2] || '')
      );
      return String(body.name || item?.name || '');
    }
    if (resource === 'notifications') {
      const notification = segments[1]
        ? await Notification.findById(segments[1]).select('message').lean()
        : null;
      return String(body.message || notification?.message || '');
    }
    if (resource === 'messages') {
      const message = segments[1]
        ? await PartyMessage.findById(segments[1]).select('text').lean()
        : null;
      return String(body.text || message?.text || '');
    }
    return '';
  } catch (_error) {
    return '';
  }
}

router.use(async (req, res, next) => {
  if (!['POST', 'PATCH', 'PUT', 'DELETE'].includes(req.method)) return next();
  const segments = req.path.split('/').filter(Boolean);
  const resource = segments[0] || 'unknown';
  req.adminAuditAction = auditAction(req, resource, segments);
  req.adminAuditResourceName = await auditResourceName(resource, segments, req.body || {});
  req.adminAuditChangedFields =
    req.adminAuditAction === 'update'
      ? await actuallyChangedFields(resource, segments, req.body || {})
      : Object.keys(req.body || {});
  req.adminAuditDescription = describeAuditAction(
    req.adminAuditAction,
    resource,
    req.adminAuditResourceName,
    req.body || {},
    req.adminAuditChangedFields
  );
  const sendJson = res.json.bind(res);
  res.json = (body) => {
    if (res.statusCode < 200 || res.statusCode >= 300) return sendJson(body);
    const resourceId =
      req.params.itemId ||
      req.params.id ||
      req.params.userId ||
      req.params.partyId ||
      body?.user?._id ||
      body?.party?._id ||
      body?.item?._id ||
      body?.notification?._id ||
      body?.message?._id ||
      '';
    const targetName =
      req.adminAuditResourceName ||
      body?.user?.nickname ||
      body?.party?.title ||
      body?.item?.name ||
      body?.notification?.message ||
      body?.message?.text ||
      body?.message ||
      body?.item?.name ||
      '';
    const description =
      req.adminAuditDescription ||
      describeAuditAction(
        req.adminAuditAction,
        resource,
        targetName,
        req.body || {},
        req.adminAuditChangedFields
      );
    AdminAuditLog.create({
      actor: req.user._id,
      method: req.method,
      action: req.adminAuditAction,
      description: description.slice(0, 600),
      resource,
      resourceId: String(resourceId),
      resourceName: String(targetName).slice(0, 240),
      statusCode: res.statusCode,
    })
      .then(() => sendJson(body))
      .catch((error) => {
        console.error('Nem sikerült rögzíteni az admin műveletet:', error.message);
        sendJson(body);
      });
    return res;
  };
  next();
});
const userFields =
  'email username nickname age avatar bio role isBanned banReason bannedAt settings friends friendRequests createdAt';
const pageSize = 50;
/** A lekérdezési paraméterből pozitív oldalszámot állít elő. */
const pageFor = (req) => Math.max(1, Number.parseInt(req.query.page, 10) || 1);
/** A keresési kifejezést reguláris kifejezésben használhatóvá teszi. */
const escapedSearch = (value) =>
  String(value || '')
    .trim()
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** Elkészíti az adminlisták közös lapozási adatait. */
const pagination = (page, total) => ({
  page,
  pageSize,
  total,
  pages: Math.max(1, Math.ceil(total / pageSize)),
});

router.get('/verification-requests', async (_req, res, next) => {
  try {
    const requests = await User.find({ role: 'user', verificationStatus: 'pending' })
      .select('email username nickname age birthDate createdAt')
      .sort({ createdAt: 1 })
      .lean();
    res.json({ requests });
  } catch (error) {
    next(error);
  }
});

router.get('/verification-requests/:id/images/:kind', async (req, res, next) => {
  try {
    const documentKey = { identity: 'identityDocument', face: 'facePhoto' }[req.params.kind];
    if (!documentKey) return res.status(404).json({ message: 'A kép nem található.' });
    const user = await User.findOne({ _id: req.params.id, verificationStatus: 'pending' }).select(
      '+verificationDocuments.identityDocument +verificationDocuments.facePhoto'
    );
    const storedImage = user?.verificationDocuments?.[documentKey];
    if (isCloudinaryId(storedImage)) {
      res.set('Cache-Control', 'private, no-store');
      await sendAuthenticatedImage(res, toCloudinaryId(storedImage));
      return;
    }
    if (!storedImage || path.basename(storedImage) !== storedImage)
      return res.status(404).json({ message: 'A kép nem található.' });
    res.set('Cache-Control', 'private, no-store');
    res.sendFile(path.join(__dirname, '../../private/verification', storedImage), (error) => {
      if (error && !res.headersSent) {
        if (error.code === 'ENOENT')
          return res
            .status(404)
            .json({ message: 'A feltöltött kép fájlja nem található a szerveren.' });
        next(error);
      }
    });
  } catch (error) {
    next(error);
  }
});

router.post('/verification-requests/:id/decision', async (req, res, next) => {
  try {
    const { decision } = req.body;
    if (!['approved', 'rejected'].includes(decision))
      return res.status(400).json({ message: 'Érvényes döntést válassz.' });
    const user = await User.findOne({
      _id: req.params.id,
      role: 'user',
      verificationStatus: 'pending',
    }).select('+verificationDocuments.identityDocument +verificationDocuments.facePhoto');
    if (!user)
      return res.status(404).json({ message: 'A függőben lévő regisztráció nem található.' });
    const storedImages = [
      user.verificationDocuments?.identityDocument,
      user.verificationDocuments?.facePhoto,
    ].filter((storedImage) => typeof storedImage === 'string');
    user.verificationStatus = decision;
    user.verificationReviewedAt = new Date();
    user.verificationDocuments = { identityDocument: undefined, facePhoto: undefined };
    await user.save();
    const verificationDirectory = path.join(__dirname, '../../private/verification');
    await Promise.all(
      storedImages.map((storedImage) =>
        isCloudinaryId(storedImage)
          ? destroyImage(toCloudinaryId(storedImage), 'authenticated').catch(() => {})
          : path.basename(storedImage) === storedImage
            ? fs.promises.unlink(path.join(verificationDirectory, storedImage)).catch(() => {})
            : Promise.resolve()
      )
    );
    res.json({
      message: `A regisztráció ${decision === 'approved' ? 'jóváhagyva' : 'elutasítva'}.`,
    });
  } catch (error) {
    next(error);
  }
});

router.get('/overview', async (_req, res, next) => {
  try {
    const [
      users,
      parties,
      notifications,
      messages,
      publicParties,
      admins,
      pendingVerifications,
      contentTotals,
    ] = await Promise.all([
      User.countDocuments(),
      Party.countDocuments(),
      Notification.countDocuments(),
      PartyMessage.countDocuments(),
      Party.countDocuments({ visibility: 'public' }),
      User.countDocuments({ role: 'admin' }),
      User.countDocuments({ role: 'user', verificationStatus: 'pending' }),
      Party.aggregate([
        {
          $group: {
            _id: null,
            items: { $sum: { $size: { $ifNull: ['$contributions', []] } } },
            galleryImages: { $sum: { $size: { $ifNull: ['$galleryImages', []] } } },
          },
        },
      ]),
    ]);
    res.json({
      stats: {
        users,
        parties,
        notifications,
        messages,
        publicParties,
        admins,
        pendingVerifications,
        items: contentTotals[0]?.items || 0,
        galleryImages: contentTotals[0]?.galleryImages || 0,
      },
    });
  } catch (error) {
    next(error);
  }
});

router.get('/options', async (_req, res, next) => {
  try {
    const [users, parties] = await Promise.all([
      User.find().select('nickname username email').sort({ nickname: 1 }).limit(5000).lean(),
      Party.find().select('title date location').sort({ date: -1 }).limit(5000).lean(),
    ]);
    res.json({
      users: users.map(({ _id, nickname, username, email }) => ({
        _id,
        nickname,
        username,
        email,
      })),
      parties: parties.map(({ _id, title, date, location }) => ({ _id, title, date, location })),
    });
  } catch (error) {
    next(error);
  }
});

router.get('/audit-logs', async (req, res, next) => {
  try {
    const page = pageFor(req);
    const search = escapedSearch(req.query.q);
    const conditions = [];
    if (search)
      conditions.push({
        $or: [
          { resource: new RegExp(search, 'i') },
          { resourceId: new RegExp(search, 'i') },
          { resourceName: new RegExp(search, 'i') },
          { description: new RegExp(search, 'i') },
          { method: new RegExp(search, 'i') },
        ],
      });
    if (
      ['create', 'update', 'delete', 'approve', 'reject', 'ban', 'unban'].includes(req.query.action)
    )
      conditions.push({ action: req.query.action });
    const filter = conditions.length ? { $and: conditions } : {};
    const [auditLogs, total] = await Promise.all([
      AdminAuditLog.find(filter)
        .populate('actor', 'nickname username email')
        .sort({ createdAt: -1 })
        .skip((page - 1) * pageSize)
        .limit(pageSize)
        .lean(),
      AdminAuditLog.countDocuments(filter),
    ]);
    const logsWithNames = await Promise.all(
      auditLogs.map(async (log) => ({
        ...log,
        resourceName:
          log.resourceName ||
          (await auditResourceName(log.resource, [log.resource, log.resourceId])),
      }))
    );
    res.json({ auditLogs: logsWithNames, pagination: pagination(page, total) });
  } catch (error) {
    next(error);
  }
});

router.get('/users', async (req, res, next) => {
  try {
    const page = pageFor(req);
    const search = escapedSearch(req.query.q);
    const filter = search
      ? {
          $or: [
            { email: new RegExp(search, 'i') },
            { username: new RegExp(search, 'i') },
            { nickname: new RegExp(search, 'i') },
          ],
        }
      : {};
    const [users, total] = await Promise.all([
      User.find(filter)
        .select(userFields)
        .sort({ createdAt: -1 })
        .skip((page - 1) * pageSize)
        .limit(pageSize)
        .lean(),
      User.countDocuments(filter),
    ]);
    res.json({ users, pagination: pagination(page, total) });
  } catch (error) {
    next(error);
  }
});

router.post('/users', async (req, res, next) => {
  try {
    const { email, username, nickname, age, password } = req.body;
    if (!email || !username || !nickname || !password)
      return res
        .status(400)
        .json({ message: 'Az e-mail, felhasználónév, becenév és jelszó kötelező.' });
    if (password.length < 8)
      return res.status(400).json({ message: 'A jelszó legalább 8 karakter legyen.' });
    const user = await User.create({
      email,
      username,
      nickname,
      age: age === '' || age == null ? undefined : Number(age),
      passwordHash: await bcrypt.hash(password, 12),
      avatar: req.body.avatar || '',
      bio: req.body.bio || '',
      isBanned: Boolean(req.body.isBanned),
      banReason: req.body.banReason || '',
      bannedAt: req.body.isBanned ? new Date() : undefined,
    });
    res.status(201).json({ user: await User.findById(user._id).select(userFields).lean() });
  } catch (error) {
    next(error);
  }
});

router.patch('/users/:id', async (req, res, next) => {
  try {
    const user = await User.findById(req.params.id).select('+passwordHash');
    if (!user) return res.status(404).json({ message: 'A felhasználó nem található.' });
    for (const key of ['email', 'username', 'nickname', 'avatar', 'bio', 'age']) {
      if (req.body[key] === undefined) continue;
      user[key] =
        key === 'age' && (req.body[key] === '' || req.body[key] == null)
          ? undefined
          : req.body[key];
    }
    if (req.body.password) {
      if (typeof req.body.password !== 'string' || req.body.password.length < 8)
        return res.status(400).json({ message: 'A jelszó legalább 8 karakter legyen.' });
      user.passwordHash = await bcrypt.hash(req.body.password, 12);
    }
    if (req.body.settings && typeof req.body.settings === 'object') {
      if (['light', 'dark'].includes(req.body.settings.theme))
        user.settings.theme = req.body.settings.theme;
      if (['hu', 'en'].includes(req.body.settings.language))
        if (['hu', 'en', 'de'].includes(req.body.settings.language))
          user.settings.language = req.body.settings.language;
      if (typeof req.body.settings.notifications === 'boolean')
        user.settings.notifications = req.body.settings.notifications;
    }
    if (Array.isArray(req.body.friends)) user.friends = req.body.friends;
    if (Array.isArray(req.body.friendRequests)) user.friendRequests = req.body.friendRequests;
    if (typeof req.body.isBanned === 'boolean' && user.role !== 'admin') {
      user.isBanned = req.body.isBanned;
      user.banReason = req.body.isBanned
        ? String(req.body.banReason || '')
            .trim()
            .slice(0, 240)
        : '';
      user.bannedAt = req.body.isBanned ? user.bannedAt || new Date() : undefined;
    }
    await user.save();
    res.json({ user: await User.findById(user._id).select(userFields).lean() });
  } catch (error) {
    next(error);
  }
});

router.patch('/users/:id/ban', async (req, res, next) => {
  try {
    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ message: 'A felhasználó nem található.' });
    if (user.role === 'admin' || user._id.equals(req.user._id))
      return res.status(400).json({ message: 'Admin fiók vagy a saját fiókod nem tiltható ki.' });
    if (typeof req.body.isBanned !== 'boolean')
      return res.status(400).json({ message: 'Add meg, hogy a fiók kitiltott legyen-e.' });
    user.isBanned = req.body.isBanned;
    user.banReason = user.isBanned
      ? String(req.body.reason || '')
          .trim()
          .slice(0, 240)
      : '';
    user.bannedAt = user.isBanned ? new Date() : undefined;
    await user.save();
    res.json({
      message: user.isBanned ? 'A felhasználó kitiltva.' : 'A kitiltás feloldva.',
      user: await User.findById(user._id).select(userFields).lean(),
    });
  } catch (error) {
    next(error);
  }
});

router.delete('/users/:id', async (req, res, next) => {
  try {
    const user = await User.findById(req.params.id).select('_id role +verificationDocuments');
    if (!user) return res.status(404).json({ message: 'A felhasználó nem található.' });
    if (user.role === 'admin')
      return res.status(400).json({ message: 'Az egyetlen admin fiók nem törölhető.' });
    const hosted = await Party.find({ host: user._id }).select('_id +galleryImages.filename');
    const partyIds = hosted.map((party) => party._id);
    await Promise.all(
      hosted.flatMap((party) =>
        party.galleryImages.map((image) => {
          const filename = image.filename;
          if (isCloudinaryId(filename))
            return destroyImage(toCloudinaryId(filename), 'authenticated').catch(() => {});
          return typeof filename === 'string' && path.basename(filename) === filename
            ? fs.promises
                .unlink(path.join(__dirname, '../../private/party-gallery', filename))
                .catch(() => {})
            : Promise.resolve();
        })
      )
    );
    await Promise.all([
      Party.deleteMany({ _id: { $in: partyIds } }),
      Notification.deleteMany({
        $or: [
          { party: { $in: partyIds } },
          { recipient: user._id },
          { sender: user._id },
          { targetUser: user._id },
        ],
      }),
      PartyMessage.deleteMany({ $or: [{ party: { $in: partyIds } }, { sender: user._id }] }),
      User.updateMany(
        { _id: { $ne: user._id } },
        { $pull: { friends: user._id, friendRequests: user._id } }
      ),
      Party.updateMany(
        { host: { $ne: user._id } },
        { $pull: { members: { user: user._id }, contributions: { user: user._id } } }
      ),
    ]);
    const verificationImages = [
      user.verificationDocuments?.identityDocument,
      user.verificationDocuments?.facePhoto,
    ].filter((storedImage) => typeof storedImage === 'string');
    await Promise.all(
      verificationImages.map((storedImage) =>
        isCloudinaryId(storedImage)
          ? destroyImage(toCloudinaryId(storedImage), 'authenticated').catch(() => {})
          : path.basename(storedImage) === storedImage
            ? fs.promises
                .unlink(path.join(__dirname, '../../private/verification', storedImage))
                .catch(() => {})
            : Promise.resolve()
      )
    );
    await user.deleteOne();
    res.json({ message: 'A felhasználó és kapcsolódó adatai törölve.' });
  } catch (error) {
    next(error);
  }
});

router.get('/parties', async (req, res, next) => {
  try {
    const page = pageFor(req);
    const search = escapedSearch(req.query.q);
    const filter = search
      ? { $or: [{ title: new RegExp(search, 'i') }, { location: new RegExp(search, 'i') }] }
      : {};
    const [parties, total] = await Promise.all([
      Party.find(filter)
        .populate('host', 'username nickname')
        .sort({ createdAt: -1 })
        .skip((page - 1) * pageSize)
        .limit(pageSize)
        .lean(),
      Party.countDocuments(filter),
    ]);
    res.json({ parties, pagination: pagination(page, total) });
  } catch (error) {
    next(error);
  }
});

router.post('/parties', async (req, res, next) => {
  try {
    const { title, host, date, location } = req.body;
    if (!title || !host || !date || !location)
      return res.status(400).json({ message: 'A név, szervező, időpont és helyszín kötelező.' });
    const party = await Party.create(req.body);
    res.status(201).json({
      party: await Party.findById(party._id).populate('host', 'username nickname').lean(),
    });
  } catch (error) {
    next(error);
  }
});

router.patch('/parties/:id', async (req, res, next) => {
  try {
    const party = await Party.findById(req.params.id);
    if (!party) return res.status(404).json({ message: 'A buli nem található.' });
    const allowed = [
      'title',
      'coverImage',
      'description',
      'host',
      'visibility',
      'inviteCode',
      'date',
      'location',
      'coordinates',
      'ticketPrice',
      'maxGuests',
      'members',
      'contributions',
    ];
    for (const key of allowed) if (req.body[key] !== undefined) party[key] = req.body[key];
    await party.save();
    res.json({
      party: await Party.findById(party._id).populate('host', 'username nickname').lean(),
    });
  } catch (error) {
    next(error);
  }
});

router.delete('/parties/:id', async (req, res, next) => {
  try {
    const party = await Party.findById(req.params.id).select('+galleryImages.filename');
    if (!party) return res.status(404).json({ message: 'A buli nem található.' });
    await Promise.all(
      party.galleryImages.map((image) => {
        const filename = image.filename;
        if (isCloudinaryId(filename))
          return destroyImage(toCloudinaryId(filename), 'authenticated').catch(() => {});
        return typeof filename === 'string' && path.basename(filename) === filename
          ? fs.promises
              .unlink(path.join(__dirname, '../../private/party-gallery', filename))
              .catch(() => {})
          : Promise.resolve();
      })
    );
    await party.deleteOne();
    await Promise.all([
      Notification.deleteMany({ party: party._id }),
      PartyMessage.deleteMany({ party: party._id }),
    ]);
    res.json({ message: 'A buli és kapcsolódó üzenetei törölve.' });
  } catch (error) {
    next(error);
  }
});

router.get('/items', async (req, res, next) => {
  try {
    const page = pageFor(req);
    const search = escapedSearch(req.query.q);
    const filter = search
      ? {
          $or: [
            { 'contributions.name': new RegExp(search, 'i') },
            { 'contributions.category': new RegExp(search, 'i') },
          ],
        }
      : {};
    const base = [{ $unwind: '$contributions' }, ...(search ? [{ $match: filter }] : [])];
    const [items, countResult] = await Promise.all([
      Party.aggregate([
        ...base,
        { $sort: { createdAt: -1 } },
        { $skip: (page - 1) * pageSize },
        { $limit: pageSize },
        {
          $project: {
            _id: '$contributions._id',
            partyId: '$_id',
            partyTitle: '$title',
            user: '$contributions.user',
            name: '$contributions.name',
            quantity: '$contributions.quantity',
            price: '$contributions.price',
            category: '$contributions.category',
            icon: '$contributions.icon',
          },
        },
      ]),
      Party.aggregate([...base, { $count: 'total' }]),
    ]);
    const userIds = [...new Set(items.map((item) => String(item.user)))];
    const users = await User.find({ _id: { $in: userIds } })
      .select('username nickname')
      .lean();
    const userMap = new Map(users.map((user) => [String(user._id), user]));
    res.json({
      items: items.map((item) => ({ ...item, user: userMap.get(String(item.user)) || item.user })),
      pagination: pagination(page, countResult[0]?.total || 0),
    });
  } catch (error) {
    next(error);
  }
});

router.post('/items', async (req, res, next) => {
  try {
    const {
      partyId,
      user: userId,
      name,
      quantity = '1',
      price = 0,
      category = 'egyéb',
      icon = '✳',
    } = req.body;
    if (!partyId || !userId || !String(name || '').trim())
      return res
        .status(400)
        .json({ message: 'A buli, a hozzáadó felhasználó és a tétel neve kötelező.' });
    const [party, user] = await Promise.all([
      Party.findById(partyId),
      User.findById(userId).select('_id'),
    ]);
    if (!party || !user)
      return res.status(404).json({ message: 'A buli vagy a felhasználó nem található.' });
    party.contributions.push({
      user: user._id,
      name: String(name).trim(),
      quantity: String(quantity),
      price: Number(price),
      category,
      icon: String(icon),
    });
    await party.save();
    res.status(201).json({
      message: 'A tétel hozzáadva.',
      item: party.contributions[party.contributions.length - 1],
    });
  } catch (error) {
    next(error);
  }
});

router.patch('/items/:partyId/:itemId', async (req, res, next) => {
  try {
    const party = await Party.findById(req.params.partyId);
    const item = party?.contributions.id(req.params.itemId);
    if (!item) return res.status(404).json({ message: 'A tétel nem található.' });
    for (const key of ['user', 'name', 'quantity', 'price', 'category', 'icon'])
      if (req.body[key] !== undefined) item[key] = req.body[key];
    await party.save();
    res.json({ message: 'A tétel frissítve.', item });
  } catch (error) {
    next(error);
  }
});

router.delete('/items/:partyId/:itemId', async (req, res, next) => {
  try {
    const party = await Party.findById(req.params.partyId);
    const item = party?.contributions.id(req.params.itemId);
    if (!item) return res.status(404).json({ message: 'A tétel nem található.' });
    item.deleteOne();
    await party.save();
    res.json({ message: 'A tétel törölve.' });
  } catch (error) {
    next(error);
  }
});

router.get('/gallery', async (req, res, next) => {
  try {
    const page = pageFor(req);
    const search = escapedSearch(req.query.q);
    const pipeline = [
      ...(search ? [{ $match: { title: new RegExp(search, 'i') } }] : []),
      { $unwind: '$galleryImages' },
      { $sort: { 'galleryImages.uploadedAt': -1, _id: -1 } },
    ];
    const [images, countResult] = await Promise.all([
      Party.aggregate([
        ...pipeline,
        { $skip: (page - 1) * pageSize },
        { $limit: pageSize },
        {
          $project: {
            _id: '$galleryImages._id',
            partyId: '$_id',
            partyTitle: '$title',
            uploadedBy: '$galleryImages.uploadedBy',
            uploadedAt: '$galleryImages.uploadedAt',
            format: '$galleryImages.format',
          },
        },
      ]),
      Party.aggregate([...pipeline, { $count: 'total' }]),
    ]);
    const userIds = [...new Set(images.map((image) => String(image.uploadedBy)))];
    const users = await User.find({ _id: { $in: userIds } })
      .select('username nickname')
      .lean();
    const userMap = new Map(users.map((user) => [String(user._id), user]));
    res.json({
      gallery: images.map((image) => ({
        ...image,
        uploadedBy: userMap.get(String(image.uploadedBy)) || image.uploadedBy,
      })),
      pagination: pagination(page, countResult[0]?.total || 0),
    });
  } catch (error) {
    next(error);
  }
});

router.get('/gallery/:partyId/:imageId/image', async (req, res, next) => {
  try {
    const party = await Party.findById(req.params.partyId).select(
      'galleryImages._id galleryImages.format galleryImages.version +galleryImages.filename'
    );
    const image = party?.galleryImages.id(req.params.imageId);
    if (!image || !image.filename)
      return res.status(404).json({ message: 'A galériakép nem található.' });
    if (isCloudinaryId(image.filename)) {
      await sendAuthenticatedImage(res, toCloudinaryId(image.filename), image);
      return;
    }
    if (path.basename(image.filename) !== image.filename)
      return res.status(404).json({ message: 'A galériakép nem található.' });
    res.set('Cache-Control', 'private, no-store');
    res.sendFile(path.join(__dirname, '../../private/party-gallery', image.filename), (error) => {
      if (error && !res.headersSent) {
        if (error.code === 'ENOENT')
          return res.status(404).json({ message: 'A galériakép fájlja nem található.' });
        next(error);
      }
    });
  } catch (error) {
    next(error);
  }
});

router.delete('/gallery/:partyId/:imageId', async (req, res, next) => {
  try {
    const party = await Party.findById(req.params.partyId).select('+galleryImages.filename');
    const image = party?.galleryImages.id(req.params.imageId);
    if (!image) return res.status(404).json({ message: 'A galériakép nem található.' });
    const filename = image.filename;
    image.deleteOne();
    await party.save();
    if (isCloudinaryId(filename))
      await destroyImage(toCloudinaryId(filename), 'authenticated').catch(() => {});
    else if (typeof filename === 'string' && path.basename(filename) === filename) {
      await fs.promises
        .unlink(path.join(__dirname, '../../private/party-gallery', filename))
        .catch(() => {});
    }
    res.json({ message: 'A galériakép törölve.' });
  } catch (error) {
    next(error);
  }
});

router.get('/notifications', async (req, res, next) => {
  try {
    const page = pageFor(req);
    const search = escapedSearch(req.query.q);
    const filter = search
      ? { $or: [{ message: new RegExp(search, 'i') }, { type: new RegExp(search, 'i') }] }
      : {};
    const [notifications, total] = await Promise.all([
      Notification.find(filter)
        .populate('recipient', 'username nickname')
        .populate('sender', 'username nickname')
        .populate('targetUser', 'username nickname')
        .populate('party', 'title')
        .sort({ createdAt: -1 })
        .skip((page - 1) * pageSize)
        .limit(pageSize)
        .lean(),
      Notification.countDocuments(filter),
    ]);
    res.json({ notifications, pagination: pagination(page, total) });
  } catch (error) {
    next(error);
  }
});

/** Értesítést küld a jogosult felhasználóknak adminisztrátori műveletből. */
async function broadcastNotification(messageValue, typeValue) {
  const message = typeof messageValue === 'string' ? messageValue.trim() : '';
  const type = typeValue || 'system';
  if (!message) throw Object.assign(new Error('Az értesítés szövege kötelező.'), { status: 400 });
  if (message.length > 240)
    throw Object.assign(new Error('Az értesítés legfeljebb 240 karakteres lehet.'), {
      status: 400,
    });
  if (!['party-invite', 'party-invite-request', 'friend-request', 'system'].includes(type))
    throw Object.assign(new Error('Érvénytelen értesítéstípus.'), { status: 400 });
  const recipients = await User.find().select('_id').lean();
  if (!recipients.length)
    throw Object.assign(new Error('Nincs felhasználói fiók, akinek értesítést lehetne küldeni.'), {
      status: 400,
    });
  await Notification.insertMany(
    recipients.map(({ _id }) => ({ recipient: _id, type, message, read: false }))
  );
  return {
    message: `Az értesítés elküldve ${recipients.length} felhasználónak.`,
    recipientCount: recipients.length,
  };
}

router.post('/notifications/broadcast', async (req, res, next) => {
  try {
    res.status(201).json(await broadcastNotification(req.body.message, req.body.type));
  } catch (error) {
    next(error);
  }
});

router.post('/notifications', async (req, res, next) => {
  try {
    if (req.body.recipient === 'all')
      return res.status(201).json(await broadcastNotification(req.body.message, req.body.type));
    const notification = await Notification.create(req.body);
    res.status(201).json({ notification });
  } catch (error) {
    next(error);
  }
});

router.patch('/notifications/:id', async (req, res, next) => {
  try {
    const notification = await Notification.findById(req.params.id);
    if (!notification) return res.status(404).json({ message: 'Az értesítés nem található.' });
    for (const key of [
      'recipient',
      'sender',
      'party',
      'targetUser',
      'type',
      'inviteRequestStatus',
      'message',
      'read',
    ]) {
      if (req.body[key] !== undefined) notification[key] = req.body[key];
    }
    await notification.save();
    res.json({ notification });
  } catch (error) {
    next(error);
  }
});

router.delete('/notifications/:id', async (req, res, next) => {
  try {
    const notification = await Notification.findByIdAndDelete(req.params.id);
    if (!notification) return res.status(404).json({ message: 'Az értesítés nem található.' });
    res.json({ message: 'Az értesítés törölve.' });
  } catch (error) {
    next(error);
  }
});

router.get('/messages', async (req, res, next) => {
  try {
    const page = pageFor(req);
    const search = escapedSearch(req.query.q);
    const filter = search ? { text: new RegExp(search, 'i') } : {};
    const [messages, total] = await Promise.all([
      PartyMessage.find(filter)
        .populate('party', 'title')
        .populate('sender', 'username nickname')
        .sort({ createdAt: -1 })
        .skip((page - 1) * pageSize)
        .limit(pageSize)
        .lean(),
      PartyMessage.countDocuments(filter),
    ]);
    res.json({ messages, pagination: pagination(page, total) });
  } catch (error) {
    next(error);
  }
});

router.post('/messages', async (req, res, next) => {
  try {
    const message = await PartyMessage.create(req.body);
    res.status(201).json({ message });
  } catch (error) {
    next(error);
  }
});

router.patch('/messages/:id', async (req, res, next) => {
  try {
    const message = await PartyMessage.findById(req.params.id);
    if (!message) return res.status(404).json({ message: 'Az üzenet nem található.' });
    for (const key of ['party', 'sender', 'text'])
      if (req.body[key] !== undefined) message[key] = req.body[key];
    await message.save();
    res.json({ message });
  } catch (error) {
    next(error);
  }
});

router.delete('/messages/:id', async (req, res, next) => {
  try {
    const message = await PartyMessage.findByIdAndDelete(req.params.id);
    if (!message) return res.status(404).json({ message: 'Az üzenet nem található.' });
    res.json({ message: 'Az üzenet törölve.' });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
