process.env.JWT_SECRET ||= 'test-secret-for-gallery-tests';

jest.mock('../src/services/cloudinary', () => ({
  CLOUDINARY_PREFIX: 'cloudinary:',
  uploadImage: jest.fn(),
  destroyImage: jest.fn().mockResolvedValue({ result: 'ok' }),
  isCloudinaryId: jest.fn((value) => typeof value === 'string' && value.startsWith('cloudinary:')),
  toCloudinaryId: jest.fn((value) => value.startsWith('cloudinary:') ? value.slice('cloudinary:'.length) : value),
  sendAuthenticatedImage: jest.fn(async (response) => response.type('image/png').send(Buffer.from('mock cloud image')))
}));

const { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } = require('@jest/globals');
const jwt = require('jsonwebtoken');
const getRequest = require('./helpers/getRequest');
const { clearTestDatabase, connectTestDatabase, disconnectTestDatabase } = require('./helpers/database');
const { Party, User } = require('../src/models');
const request = require('supertest');
const { app } = require('../server');
const { uploadImage, sendAuthenticatedImage } = require('../src/services/cloudinary');

describe('Szerver és adatbázis', () => {
  beforeAll(async () => {
    await connectTestDatabase();
  });

  beforeEach(() => {
    uploadImage.mockReset();
    uploadImage.mockResolvedValue({ publicId: 'kimithoz/party-gallery/mock-photo', secureUrl: 'https://res.cloudinary.com/test/image/upload/mock.jpg', format: 'png', version: 123 });
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
    expect(savedParty.galleryImages[0].filename).toBe('cloudinary:kimithoz/party-gallery/mock-photo');
    expect(uploadImage).toHaveBeenCalledWith(png, { folder: `kimithoz/party-gallery/${party._id}`, type: 'authenticated' });

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
      passwordHash: 'test-password-hash'
    });
    const token = jwt.sign({ sub: user._id.toString() }, process.env.JWT_SECRET);
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=', 'base64');

    const response = await request(app)
      .post('/api/parties/cover-image')
      .set('Authorization', `Bearer ${token}`)
      .attach('image', png, { filename: 'cover.png', contentType: 'image/png' })
      .expect(201);

    expect(response.body.imageUrl).toMatch(/^https:\/\/res\.cloudinary\.com\//);
    expect(uploadImage).toHaveBeenCalledWith(png, { folder: 'kimithoz/covers' });
  });

  it('a regisztrációs dokumentumokat privát Cloudinary-tárhelyre tölti fel', async () => {
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=', 'base64');
    uploadImage
      .mockResolvedValueOnce({ publicId: 'kimithoz/verification/id-photo', format: 'png', version: 456 })
      .mockResolvedValueOnce({ publicId: 'kimithoz/verification/face-photo', format: 'png', version: 789 });

    await request(app)
      .post('/api/auth/register')
      .field('email', 'cloudinary-user@example.com')
      .field('username', 'cloudinary_user')
      .field('nickname', 'Cloudinary')
      .field('age', '25')
      .field('password', 'secure-password')
      .attach('identityDocument', png, { filename: 'id.png', contentType: 'image/png' })
      .attach('facePhoto', png, { filename: 'face.png', contentType: 'image/png' })
      .expect(201);

    const savedUser = await User.findOne({ email: 'cloudinary-user@example.com' })
      .select('+verificationDocuments.identityDocument +verificationDocuments.facePhoto');
    expect(savedUser.verificationDocuments.identityDocument).toBe('cloudinary:kimithoz/verification/id-photo');
    expect(savedUser.verificationDocuments.facePhoto).toBe('cloudinary:kimithoz/verification/face-photo');
    expect(uploadImage).toHaveBeenCalledTimes(2);
    expect(uploadImage).toHaveBeenNthCalledWith(1, png, { folder: 'kimithoz/verification', type: 'authenticated' });
  });
});