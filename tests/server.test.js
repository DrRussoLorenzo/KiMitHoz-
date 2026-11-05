process.env.JWT_SECRET ||= 'test-secret-for-gallery-tests';

const { afterAll, afterEach, beforeAll, describe, expect, it } = require('@jest/globals');
const fs = require('fs');
const path = require('path');
const jwt = require('jsonwebtoken');
const getRequest = require('./helpers/getRequest');
const { clearTestDatabase, connectTestDatabase, disconnectTestDatabase } = require('./helpers/database');
const { Party, User } = require('../src/models');
const request = require('supertest');
const { app } = require('../server');

describe('Szerver és adatbázis', () => {
  beforeAll(async () => {
    await connectTestDatabase();
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
      passwordHash: 'test-password-hash'
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

  it('a hét napnál régebbi bulit archiválja és megjeleníti a Galériában', async () => {
    const user = await User.create({
      email: 'galeria@example.com',
      username: 'galeria_user',
      nickname: 'Galéria teszt',
      passwordHash: 'test-password-hash'
    });
    const party = await Party.create({
      title: 'Lejárt buli',
      host: user._id,
      date: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000),
      location: 'Budapest',
      galleryImages: [{ filename: 'private-test-image.jpg', uploadedBy: user._id }]
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
      passwordHash: 'test-password-hash'
    });
    const party = await Party.create({
      title: 'Régi buli',
      host: user._id,
      date: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000),
      location: 'Budapest'
    });
    const token = jwt.sign({ sub: user._id.toString() }, process.env.JWT_SECRET);

    const response = await request(app)
      .post(`/api/parties/${party._id}/gallery`)
      .set('Authorization', `Bearer ${token}`)
      .attach('image', Buffer.from('fake image data'), { filename: 'photo.png', contentType: 'image/png' })
      .expect(410);

    expect(response.body.message).toMatch(/archiválva/i);
    expect((await Party.findById(party._id)).galleryImages).toHaveLength(0);
  });

  it('feltöltés után a képet csak a buli résztvevői érhetik el', async () => {
    const user = await User.create({
      email: 'resztvevo@example.com',
      username: 'resztvevo_user',
      nickname: 'Résztvevő teszt',
      passwordHash: 'test-password-hash'
    });
    const outsider = await User.create({
      email: 'kivulallo@example.com',
      username: 'kivulallo_user',
      nickname: 'Kívülálló teszt',
      passwordHash: 'test-password-hash'
    });
    const party = await Party.create({
      title: 'Képes buli',
      host: user._id,
      date: new Date(Date.now() - 60 * 60 * 1000),
      location: 'Budapest'
    });
    const token = jwt.sign({ sub: user._id.toString() }, process.env.JWT_SECRET);
    const outsiderToken = jwt.sign({ sub: outsider._id.toString() }, process.env.JWT_SECRET);
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=', 'base64');

    const upload = await request(app)
      .post(`/api/parties/${party._id}/gallery`)
      .set('Authorization', `Bearer ${token}`)
      .attach('image', png, { filename: 'photo.png', contentType: 'image/png' })
      .expect(201);
    const savedParty = await Party.findById(party._id).select('+galleryImages.filename');
    const filename = savedParty.galleryImages[0].filename;

    try {
      await request(app)
        .get(`/api/parties/${party._id}/gallery/${upload.body.imageId}/image`)
        .set('Authorization', `Bearer ${token}`)
        .expect('Content-Type', /image\/png/)
        .expect(200);

      await request(app)
        .get(`/api/parties/${party._id}/gallery/${upload.body.imageId}/image`)
        .set('Authorization', `Bearer ${outsiderToken}`)
        .expect(403);
    } finally {
      await fs.promises.unlink(path.join(__dirname, '../private/party-gallery', filename)).catch(() => {});
    }
  });
});