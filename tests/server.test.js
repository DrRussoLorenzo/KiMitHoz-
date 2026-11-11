process.env.JWT_SECRET ||= 'test-secret-for-gallery-tests';

jest.mock('../src/services/cloudinary', () => ({
  CLOUDINARY_PREFIX: 'cloudinary:',
  uploadImage: jest.fn(),
  destroyImage: jest.fn().mockResolvedValue({ result: 'ok' }),
  isCloudinaryId: jest.fn((value) => typeof value === 'string' && value.startsWith('cloudinary:')),
  toCloudinaryId: jest.fn((value) =>
    value.startsWith('cloudinary:') ? value.slice('cloudinary:'.length) : value
  ),
  sendAuthenticatedImage: jest.fn(async (response) =>
    response.type('image/png').send(Buffer.from('mock cloud image'))
  ),
}));

const {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} = require('@jest/globals');
const jwt = require('jsonwebtoken');
const getRequest = require('./helpers/getRequest');
const {
  clearTestDatabase,
  connectTestDatabase,
  disconnectTestDatabase,
} = require('./helpers/database');
const { AdminAuditLog, Notification, Party, PartyMessage, User } = require('../src/models');
const request = require('supertest');
const { app } = require('../server');
const { uploadImage, sendAuthenticatedImage } = require('../src/services/cloudinary');

describe('Szerver és adatbázis', () => {
  beforeAll(async () => {
    await connectTestDatabase();
  });

  beforeEach(() => {
    uploadImage.mockReset();
    uploadImage.mockResolvedValue({
      publicId: 'kimithoz/party-gallery/mock-photo',
      secureUrl: 'https://res.cloudinary.com/test/image/upload/mock.jpg',
      format: 'png',
      version: 123,
    });
    sendAuthenticatedImage.mockClear();
  });

  afterEach(async () => {
    await clearTestDatabase();
  });

  afterAll(async () => {
    await disconnectTestDatabase();
  });

  it('GET /api/health jelzi a sikeres MongoDB-kapcsolatot', async () => {
    const response = await getRequest('/api/health');

    expect(response.body).toEqual({ ok: true, database: 'connected' });
  });

  it('elmenti és visszaolvassa a felhasználót a tesztadatbázisból', async () => {
    const createdUser = await User.create({
      email: 'teszt@example.com',
      username: 'teszt_user',
      nickname: 'Teszt',
      passwordHash: 'test-password-hash',
    });

    const savedUser = await User.findById(createdUser._id);

    expect(savedUser).not.toBeNull();
    expect(savedUser.email).toBe('teszt@example.com');
    expect(savedUser.username).toBe('teszt_user');
  });

  it('GET / kiszolgálja a frontend HTML-oldalát', async () => {
    const response = await getRequest('/');

    expect(response.headers['content-type']).toMatch(/text\/html/);
  });

  it('a 18.png képet a publikus uploads útvonalon szolgálja ki', async () => {
    const response = await getRequest('/uploads/18.png');

    expect(response.headers['content-type']).toMatch(/image\/png/);
    expect(response.body.length).toBeGreaterThan(0);
  });

  it('a hét napnál régebbi bulit archiválja és megjeleníti a Galériában', async () => {
    const user = await User.create({
      email: 'galeria@example.com',
      username: 'galeria_user',
      nickname: 'Galéria teszt',
      passwordHash: 'test-password-hash',
    });
    const party = await Party.create({
      title: 'Lejárt buli',
      host: user._id,
      date: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000),
      location: 'Budapest',
      galleryImages: [{ filename: 'private-test-image.jpg', uploadedBy: user._id }],
    });
    const token = jwt.sign({ sub: user._id.toString() }, process.env.JWT_SECRET);

    const response = await request(app)
      .get('/api/parties/archive')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(response.body.parties).toHaveLength(1);
    expect(String(response.body.parties[0]._id)).toBe(String(party._id));
    expect(response.body.parties[0].galleryImages).toHaveLength(1);
    expect(response.body.parties[0].galleryImages[0]._id).toBeTruthy();
    expect(response.body.parties[0].galleryImages[0]).not.toHaveProperty('filename');
    expect((await Party.findById(party._id)).isArchived).toBe(true);
  });

  it('nem enged képet feltölteni az archiválási határidő után', async () => {
    const user = await User.create({
      email: 'feltoltes@example.com',
      username: 'feltolto_user',
      nickname: 'Feltöltő teszt',
      passwordHash: 'test-password-hash',
    });
    const party = await Party.create({
      title: 'Régi buli',
      host: user._id,
      date: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000),
      location: 'Budapest',
    });
    const token = jwt.sign({ sub: user._id.toString() }, process.env.JWT_SECRET);

    const response = await request(app)
      .post(`/api/parties/${party._id}/gallery`)
      .set('Authorization', `Bearer ${token}`)
      .attach('image', Buffer.from('fake image data'), {
        filename: 'photo.png',
        contentType: 'image/png',
      })
      .expect(410);

    expect(response.body.message).toMatch(/archiválva/i);
    expect((await Party.findById(party._id)).galleryImages).toHaveLength(0);
  });

  it('feltöltés után a képet csak a buli résztvevői érhetik el', async () => {
    const user = await User.create({
      email: 'resztvevo@example.com',
      username: 'resztvevo_user',
      nickname: 'Résztvevő teszt',
      passwordHash: 'test-password-hash',
    });
    const outsider = await User.create({
      email: 'kivulallo@example.com',
      username: 'kivulallo_user',
      nickname: 'Kívülálló teszt',
      passwordHash: 'test-password-hash',
    });
    const party = await Party.create({
      title: 'Képes buli',
      host: user._id,
      date: new Date(Date.now() - 60 * 60 * 1000),
      location: 'Budapest',
    });
    const token = jwt.sign({ sub: user._id.toString() }, process.env.JWT_SECRET);
    const outsiderToken = jwt.sign({ sub: outsider._id.toString() }, process.env.JWT_SECRET);
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=',
      'base64'
    );

    const upload = await request(app)
      .post(`/api/parties/${party._id}/gallery`)
      .set('Authorization', `Bearer ${token}`)
      .attach('image', png, { filename: 'photo.png', contentType: 'image/png' })
      .expect(201);
    const savedParty = await Party.findById(party._id).select('+galleryImages.filename');
    expect(savedParty.galleryImages[0].filename).toBe(
      'cloudinary:kimithoz/party-gallery/mock-photo'
    );
    expect(uploadImage).toHaveBeenCalledWith(png, {
      folder: `kimithoz/party-gallery/${party._id}`,
      type: 'authenticated',
    });

    await request(app)
      .get(`/api/parties/${party._id}/gallery/${upload.body.imageId}/image`)
      .set('Authorization', `Bearer ${token}`)
      .expect('Content-Type', /image\/png/)
      .expect(200);
    expect(sendAuthenticatedImage).toHaveBeenCalled();

    await request(app)
      .get(`/api/parties/${party._id}/gallery/${upload.body.imageId}/image`)
      .set('Authorization', `Bearer ${outsiderToken}`)
      .expect(403);
  });

  it('a buli borítóképét Cloudinarybe tölti fel', async () => {
    const user = await User.create({
      email: 'borito@example.com',
      username: 'borito_user',
      nickname: 'Borító teszt',
      passwordHash: 'test-password-hash',
    });
    const token = jwt.sign({ sub: user._id.toString() }, process.env.JWT_SECRET);
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=',
      'base64'
    );

    const response = await request(app)
      .post('/api/parties/cover-image')
      .set('Authorization', `Bearer ${token}`)
      .attach('image', png, { filename: 'cover.png', contentType: 'image/png' })
      .expect(201);

    expect(response.body.imageUrl).toMatch(/^https:\/\/res\.cloudinary\.com\//);
    expect(uploadImage).toHaveBeenCalledWith(png, { folder: 'kimithoz/covers' });
  });

  it('profilképet tölt fel, elmenti a profilra, és elutasítja a nem támogatott formátumot', async () => {
    const user = await User.create({
      email: 'avatar-upload@example.com',
      username: 'avatar_upload',
      nickname: 'Profilkép teszt',
      passwordHash: 'test-password-hash',
    });
    const token = jwt.sign({ sub: user._id.toString() }, process.env.JWT_SECRET);
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=',
      'base64'
    );

    const response = await request(app)
      .post('/api/users/me/avatar')
      .set('Authorization', `Bearer ${token}`)
      .attach('image', png, { filename: 'avatar.png', contentType: 'image/png' })
      .expect(201);

    expect(response.body.user.avatar).toBe('https://res.cloudinary.com/test/image/upload/mock.jpg');
    expect((await User.findById(user._id)).avatar).toBe(response.body.user.avatar);
    expect(uploadImage).toHaveBeenCalledWith(png, { folder: 'kimithoz/avatars' });

    await request(app)
      .post('/api/users/me/avatar')
      .set('Authorization', `Bearer ${token}`)
      .attach('image', Buffer.from('not an image'), {
        filename: 'avatar.txt',
        contentType: 'text/plain',
      })
      .expect(400);
  });

  it('a profil nyelvi beállítása magyar, angol és német lehet', async () => {
    const user = await User.create({
      email: 'language-setting@example.com',
      username: 'language_setting',
      nickname: 'Nyelv teszt',
      passwordHash: 'test-password-hash',
    });
    const token = jwt.sign({ sub: user._id.toString() }, process.env.JWT_SECRET);

    for (const language of ['hu', 'en', 'de']) {
      const response = await request(app)
        .patch('/api/users/me')
        .set('Authorization', `Bearer ${token}`)
        .send({ settings: { language } })
        .expect(200);
      expect(response.body.user.settings.language).toBe(language);
      expect((await User.findById(user._id)).settings.language).toBe(language);
    }
  });

  it('a profil öt témaszínét elmenti és csak érvényes hex színeket fogad el', async () => {
    const user = await User.create({
      email: 'theme-colors@example.com',
      username: 'theme_colors',
      nickname: 'Színteszt',
      passwordHash: 'test-password-hash',
    });
    const token = jwt.sign({ sub: user._id.toString() }, process.env.JWT_SECRET);
    const colors = {
      primary: '#123abc',
      accent: '#aabbcc',
      background: '#fefefe',
      selection: '#d9e8ff',
      field: '#f0e2d4',
    };

    const response = await request(app)
      .patch('/api/users/me')
      .set('Authorization', `Bearer ${token}`)
      .send({ settings: { colors } })
      .expect(200);

    expect(response.body.user.settings.colors).toMatchObject(colors);
    expect((await User.findById(user._id)).settings.colors).toMatchObject(colors);
    await request(app)
      .patch('/api/users/me')
      .set('Authorization', `Bearer ${token}`)
      .send({ settings: { colors: { primary: 'red' } } })
      .expect(400);
  });

  it('a tételek mennyiségét 1–1000, árát 0–1 000 000 Ft közé korlátozza', async () => {
    const user = await User.create({
      email: 'tetel@example.com',
      username: 'tetel_user',
      nickname: 'Tétel teszt',
      passwordHash: 'test-password-hash',
    });
    const party = await Party.create({
      title: 'Tételteszt buli',
      host: user._id,
      date: new Date(Date.now() + 60 * 60 * 1000),
      location: 'Budapest',
      members: [{ user: user._id, status: 'going' }],
    });
    const token = jwt.sign({ sub: user._id.toString() }, process.env.JWT_SECRET);
    const endpoint = `/api/parties/${party._id}/items`;

    await request(app)
      .post(endpoint)
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Érvényes tétel', quantity: '1000', price: 1000000 })
      .expect(201);

    await request(app)
      .post(endpoint)
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Túl sok', quantity: '1001', price: 0 })
      .expect(400);

    await request(app)
      .post(endpoint)
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Túl drága', quantity: '1', price: 1000001 })
      .expect(400);
  });

  it('a chatben megjelölt résztvevők értesítést kapnak, más fiók nem jelölhető meg', async () => {
    const sender = await User.create({
      email: 'chat-sender@example.com',
      username: 'chat_sender',
      nickname: 'Chat küldő',
      passwordHash: 'test-password-hash',
    });
    const mentioned = await User.create({
      email: 'chat-mentioned@example.com',
      username: 'megjelolt',
      nickname: 'Megjelölt',
      passwordHash: 'test-password-hash',
    });
    const muted = await User.create({
      email: 'chat-muted@example.com',
      username: 'nemker',
      nickname: 'Némított',
      passwordHash: 'test-password-hash',
      settings: { notifications: false },
    });
    const invited = await User.create({
      email: 'chat-invited@example.com',
      username: 'meghivott',
      nickname: 'Meghívott',
      passwordHash: 'test-password-hash',
    });
    const party = await Party.create({
      title: 'Chatteszt buli',
      host: sender._id,
      date: new Date(Date.now() + 60 * 60 * 1000),
      location: 'Budapest',
      members: [
        { user: sender._id, status: 'going' },
        { user: mentioned._id, status: 'going' },
        { user: muted._id, status: 'going' },
        { user: invited._id, status: 'invited' },
      ],
    });
    const token = jwt.sign({ sub: sender._id.toString() }, process.env.JWT_SECRET);
    const endpoint = `/api/parties/${party._id}/chat/messages`;

    const response = await request(app)
      .post(endpoint)
      .set('Authorization', `Bearer ${token}`)
      .send({
        text: 'Szia @megjelolt és @nemker!',
        mentionedUserIds: [String(mentioned._id), String(muted._id)],
      })
      .expect(201);

    expect(response.body.message.mentionedUsers.map(String)).toEqual(
      expect.arrayContaining([String(mentioned._id), String(muted._id)])
    );
    expect(await PartyMessage.countDocuments({ party: party._id })).toBe(1);
    expect(
      await Notification.countDocuments({
        recipient: mentioned._id,
        type: 'party-mention',
        party: party._id,
      })
    ).toBe(1);
    expect(
      await Notification.countDocuments({
        recipient: muted._id,
        type: 'party-mention',
        party: party._id,
      })
    ).toBe(0);
    const notification = await Notification.findOne({
      recipient: mentioned._id,
      type: 'party-mention',
    });
    expect(notification.message).toContain('Chatteszt buli');
    expect(notification.message).toContain('Szia @megjelolt');
    expect(String(notification.partyMessage)).toBe(String(response.body.message._id));

    await PartyMessage.insertMany(
      Array.from({ length: 105 }, (_, index) => ({
        party: party._id,
        sender: sender._id,
        text: `Későbbi chat ${index}`,
        createdAt: new Date(Date.now() + index * 1000),
        updatedAt: new Date(Date.now() + index * 1000),
      }))
    );
    const mentionedToken = jwt.sign({ sub: mentioned._id.toString() }, process.env.JWT_SECRET);
    const targetChat = await request(app)
      .get(`${endpoint}?messageId=${response.body.message._id}`)
      .set('Authorization', `Bearer ${mentionedToken}`)
      .expect(200);
    expect(targetChat.body.messages).toHaveLength(51);
    expect(
      targetChat.body.messages.some((message) => message._id === response.body.message._id)
    ).toBe(true);

    const inbox = await request(app)
      .get('/api/notifications')
      .set('Authorization', `Bearer ${mentionedToken}`)
      .expect(200);
    expect(inbox.body.notifications[0].partyMessage._id).toBe(response.body.message._id);

    await request(app)
      .post(endpoint)
      .set('Authorization', `Bearer ${token}`)
      .send({ text: 'Szia @meghivott!', mentionedUserIds: [String(invited._id)] })
      .expect(400);
    expect(await PartyMessage.countDocuments({ party: party._id })).toBe(106);
  });

  it('az admin áttekintő számolja és kezeli a galériaképeket', async () => {
    const admin = await User.create({
      email: 'gallery-admin@example.com',
      username: 'gallery_admin',
      nickname: 'Galéria admin',
      passwordHash: 'test-password-hash',
      role: 'admin',
    });
    const uploader = await User.create({
      email: 'gallery-uploader@example.com',
      username: 'gallery_uploader',
      nickname: 'Feltöltő',
      passwordHash: 'test-password-hash',
    });
    const party = await Party.create({
      title: 'Admin galériateszt',
      host: admin._id,
      date: new Date(Date.now() - 60 * 60 * 1000),
      location: 'Budapest',
      contributions: [{ user: uploader._id, name: 'Üdítő' }],
      galleryImages: [
        { filename: 'cloudinary:gallery/one', format: 'png', uploadedBy: uploader._id },
        { filename: 'cloudinary:gallery/two', format: 'jpg', uploadedBy: uploader._id },
      ],
    });
    const token = jwt.sign({ sub: admin._id.toString() }, process.env.JWT_SECRET);

    const overview = await request(app)
      .get('/api/admin/overview')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(overview.body.stats.items).toBe(1);
    expect(overview.body.stats.galleryImages).toBe(2);

    const gallery = await request(app)
      .get('/api/admin/gallery')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(gallery.body.gallery).toHaveLength(2);
    expect(gallery.body.gallery[0]).toMatchObject({
      partyTitle: 'Admin galériateszt',
      uploadedBy: expect.objectContaining({ nickname: 'Feltöltő' }),
    });
    expect(gallery.body.gallery[0]).not.toHaveProperty('filename');

    await request(app)
      .get(`/api/admin/gallery/${party._id}/${gallery.body.gallery[0]._id}/image`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    await request(app)
      .delete(`/api/admin/gallery/${party._id}/${gallery.body.gallery[0]._id}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect((await Party.findById(party._id)).galleryImages).toHaveLength(1);
  });

  it('kiemeli a függő regisztrációkat és naplózza az adminisztrátori döntést', async () => {
    const admin = await User.create({
      email: 'admin-audit@example.com',
      username: 'admin_audit',
      nickname: 'Audit admin',
      passwordHash: 'test-password-hash',
      role: 'admin',
    });
    const applicant = await User.create({
      email: 'varakozo@example.com',
      username: 'varakozo_user',
      nickname: 'Várakozó',
      passwordHash: 'test-password-hash',
      verificationStatus: 'pending',
    });
    const token = jwt.sign({ sub: admin._id.toString() }, process.env.JWT_SECRET);

    const overview = await request(app)
      .get('/api/admin/overview')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(overview.body.stats.pendingVerifications).toBe(1);

    const options = await request(app)
      .get('/api/admin/options')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(options.body.users).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          _id: String(applicant._id),
          nickname: 'Várakozó',
          username: 'varakozo_user',
        }),
      ])
    );

    await request(app)
      .post(`/api/admin/verification-requests/${applicant._id}/decision`)
      .set('Authorization', `Bearer ${token}`)
      .send({ decision: 'approved' })
      .expect(200);

    const logs = await request(app)
      .get('/api/admin/audit-logs?q=Várakozó&action=approve')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(logs.body.auditLogs).toHaveLength(1);
    expect(logs.body.auditLogs[0]).toMatchObject({
      method: 'POST',
      action: 'approve',
      description: 'Regisztráció jóváhagyása: Várakozó',
      resource: 'verification-requests',
      resourceId: String(applicant._id),
      resourceName: 'Várakozó',
      statusCode: 200,
    });
    expect(logs.body.auditLogs[0].actor.nickname).toBe('Audit admin');
    expect(await AdminAuditLog.countDocuments()).toBe(1);

    const unmatchedFilter = await request(app)
      .get('/api/admin/audit-logs?action=delete')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(unmatchedFilter.body.auditLogs).toHaveLength(0);
  });

  it('csak a ténylegesen módosult mezőket írja az admin naplóba', async () => {
    const admin = await User.create({
      email: 'audit-editor@example.com',
      username: 'audit_editor',
      nickname: 'Napló admin',
      passwordHash: 'test-password-hash',
      role: 'admin',
    });
    const target = await User.create({
      email: 'szerkesztett@example.com',
      username: 'szerkesztett_user',
      nickname: 'Eredeti név',
      age: 20,
      passwordHash: 'test-password-hash',
    });
    const token = jwt.sign({ sub: admin._id.toString() }, process.env.JWT_SECRET);

    await request(app)
      .patch(`/api/admin/users/${target._id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ email: target.email, username: target.username, nickname: 'Új név', age: target.age })
      .expect(200);

    const logs = await request(app)
      .get('/api/admin/audit-logs?action=update')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(logs.body.auditLogs).toHaveLength(1);
    expect(logs.body.auditLogs[0].description).toBe(
      'Felhasználó módosítása: Új név · Módosítás: becenév: „Eredeti név” → „Új név”'
    );
  });

  it('a listamezőknél az elemek nevét írja ki elemszám helyett', async () => {
    const admin = await User.create({
      email: 'audit-list-admin@example.com',
      username: 'audit_list_admin',
      nickname: 'Lista admin',
      passwordHash: 'test-password-hash',
      role: 'admin',
    });
    const target = await User.create({
      email: 'lista-cel@example.com',
      username: 'lista_cel',
      nickname: 'Célfiók',
      passwordHash: 'test-password-hash',
    });
    const friend = await User.create({
      email: 'barat@example.com',
      username: 'tesztbarat',
      nickname: 'Tesztbarát',
      passwordHash: 'test-password-hash',
    });
    const token = jwt.sign({ sub: admin._id.toString() }, process.env.JWT_SECRET);

    await request(app)
      .patch(`/api/admin/users/${target._id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ friends: [friend._id.toString()] })
      .expect(200);

    const logs = await request(app)
      .get('/api/admin/audit-logs?action=update')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(logs.body.auditLogs[0].description).toContain(
      'ismerőslista: [] → [„Tesztbarát (@tesztbarat)”]'
    );
    expect(logs.body.auditLogs[0].description).not.toContain('1 elem');
  });

  it('tömeges adminértesítést minden fióknak küld, a függő és kitiltott fiókoknak is', async () => {
    const admin = await User.create({
      email: 'broadcast-admin@example.com',
      username: 'broadcast_admin',
      nickname: 'Broadcast admin',
      passwordHash: 'test-password-hash',
      role: 'admin',
    });
    const activeOne = await User.create({
      email: 'active-one@example.com',
      username: 'active_one',
      nickname: 'Aktív egy',
      passwordHash: 'test-password-hash',
    });
    const activeTwo = await User.create({
      email: 'active-two@example.com',
      username: 'active_two',
      nickname: 'Aktív kettő',
      passwordHash: 'test-password-hash',
    });
    await User.create({
      email: 'pending@example.com',
      username: 'pending_user',
      nickname: 'Függő',
      passwordHash: 'test-password-hash',
      verificationStatus: 'pending',
    });
    await User.create({
      email: 'banned@example.com',
      username: 'banned_user',
      nickname: 'Kitiltott',
      passwordHash: 'test-password-hash',
      isBanned: true,
    });
    const token = jwt.sign({ sub: admin._id.toString() }, process.env.JWT_SECRET);

    const response = await request(app)
      .post('/api/admin/notifications/broadcast')
      .set('Authorization', `Bearer ${token}`)
      .send({ message: 'Fontos közlemény', type: 'system' })
      .expect(201);

    expect(response.body.recipientCount).toBe(5);
    expect(await Notification.countDocuments({ message: 'Fontos közlemény' })).toBe(5);
    expect(
      await Notification.countDocuments({
        recipient: { $in: [activeOne._id, activeTwo._id] },
        message: 'Fontos közlemény',
      })
    ).toBe(2);
    expect(
      await Notification.countDocuments({ message: 'Fontos közlemény', recipient: admin._id })
    ).toBe(1);
    expect(
      await Notification.countDocuments({
        message: 'Fontos közlemény',
        recipient: { $in: await User.find({ verificationStatus: 'pending' }).distinct('_id') },
      })
    ).toBe(1);
    expect(
      await Notification.countDocuments({
        message: 'Fontos közlemény',
        recipient: { $in: await User.find({ isBanned: true }).distinct('_id') },
      })
    ).toBe(1);
  });

  it('az adminpanelről egy felhasználónak is hozzáadható új értesítés', async () => {
    const admin = await User.create({
      email: 'single-notification-admin@example.com',
      username: 'single_notif_admin',
      nickname: 'Értesítés admin',
      passwordHash: 'test-password-hash',
      role: 'admin',
    });
    const recipient = await User.create({
      email: 'single-notification-user@example.com',
      username: 'single_notif_user',
      nickname: 'Értesítés címzett',
      passwordHash: 'test-password-hash',
    });
    const token = jwt.sign({ sub: admin._id.toString() }, process.env.JWT_SECRET);

    const response = await request(app)
      .post('/api/admin/notifications')
      .set('Authorization', `Bearer ${token}`)
      .send({
        recipient: String(recipient._id),
        type: 'system',
        message: 'Egyedi adminértesítés',
        read: false,
      })
      .expect(201);

    expect(String(response.body.notification.recipient)).toBe(String(recipient._id));
    expect(
      await Notification.countDocuments({
        recipient: recipient._id,
        message: 'Egyedi adminértesítés',
      })
    ).toBe(1);
  });

  it('a regisztrációs dokumentumokat privát Cloudinary-tárhelyre tölti fel', async () => {
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=',
      'base64'
    );
    const birthDate = new Date();
    birthDate.setUTCFullYear(birthDate.getUTCFullYear() - 25);
    uploadImage
      .mockResolvedValueOnce({
        publicId: 'kimithoz/verification/id-photo',
        format: 'png',
        version: 456,
      })
      .mockResolvedValueOnce({
        publicId: 'kimithoz/verification/face-photo',
        format: 'png',
        version: 789,
      });

    await request(app)
      .post('/api/auth/register')
      .field('email', 'cloudinary-user@example.com')
      .field('username', 'cloudinary_user')
      .field('nickname', 'Cloudinary')
      .field('birthDate', birthDate.toISOString().slice(0, 10))
      .field('password', 'secure-password')
      .attach('identityDocument', png, { filename: 'id.png', contentType: 'image/png' })
      .attach('facePhoto', png, { filename: 'face.png', contentType: 'image/png' })
      .expect(201);

    const savedUser = await User.findOne({ email: 'cloudinary-user@example.com' }).select(
      '+birthDate +verificationDocuments.identityDocument +verificationDocuments.facePhoto'
    );
    expect(savedUser.age).toBe(25);
    expect(savedUser.birthDate.toISOString().slice(0, 10)).toBe(
      birthDate.toISOString().slice(0, 10)
    );
    expect(await User.findById(savedUser._id).lean()).not.toHaveProperty('birthDate');
    expect(savedUser.verificationDocuments.identityDocument).toBe(
      'cloudinary:kimithoz/verification/id-photo'
    );
    expect(savedUser.verificationDocuments.facePhoto).toBe(
      'cloudinary:kimithoz/verification/face-photo'
    );
    expect(uploadImage).toHaveBeenCalledTimes(2);
    expect(uploadImage).toHaveBeenNthCalledWith(1, png, {
      folder: 'kimithoz/verification',
      type: 'authenticated',
    });

    const admin = await User.create({
      email: 'dob-admin@example.com',
      username: 'dob_admin',
      nickname: 'Dátum admin',
      passwordHash: 'test-password-hash',
      role: 'admin',
    });
    const adminToken = jwt.sign({ sub: admin._id.toString() }, process.env.JWT_SECRET);
    const pending = await request(app)
      .get('/api/admin/verification-requests')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    expect(pending.body.requests[0].birthDate).toBe(savedUser.birthDate.toISOString());
  });
});
