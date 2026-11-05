require('dotenv').config();

// Express middleware, API útvonalak és a statikus frontend kiszolgálása.
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const mongoose = require('mongoose');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const authRoutes = require('./src/routes/auth');
const userRoutes = require('./src/routes/users');
const partyRoutes = require('./src/routes/parties');
const notificationRoutes = require('./src/routes/notifications');
const adminRoutes = require('./src/routes/admin');
const bcrypt = require('bcryptjs');
const { User } = require('./src/models');
const { archiveExpiredParties } = require('./src/services/partyArchive');

const app = express();
const port = process.env.PORT || 3000;

// Alap biztonsági és JSON beállítások.
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({ origin: process.env.CLIENT_ORIGIN || true }));
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));
app.use('/api/auth', rateLimit({ windowMs: 15 * 60 * 1000, limit: 40, standardHeaders: 'draft-7', legacyHeaders: false }));

app.get('/api/health', (_req, res) => res.json({ ok: true, database: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected' }));

// Az API útvonalak külön fájlokban vannak, témakörönként.
app.use('/api/auth', authRoutes);
app.use('/api/users', userRoutes);
app.use('/api/parties', partyRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api', (_req, res) => res.status(404).json({ message: 'Az API-végpont nem található. Indítsd újra a szervert, hogy betöltse a legújabb útvonalakat.' }));

// A frontend fájljait közvetlenül ugyanaz az Express szerver szolgálja ki.
app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.use((err, _req, res, _next) => {
  console.error(err);
  if (err.name === 'ValidationError') {
    const validationMessage = Object.values(err.errors).map((validationError) => validationError.message)[0];
    return res.status(400).json({ message: validationMessage || 'A megadott adatok érvénytelenek.' });
  }
  if (err.code === 11000) return res.status(409).json({ message: 'Az adat ütközik egy már létező rekorddal.' });
  res.status(err.status || 500).json({ message: err.status ? err.message : 'Váratlan szerverhiba történt.' });
});

async function start() {
  // A szerver csak működő MongoDB-kapcsolattal indul el.
  if (!process.env.MONGODB_URI) throw new Error('Hiányzik a MONGODB_URI környezeti változó.');
  if (!process.env.JWT_SECRET) throw new Error('Hiányzik a JWT_SECRET környezeti változó.');
  await mongoose.connect(process.env.MONGODB_URI);
  await User.init();
  await archiveExpiredParties();
  const archiveTimer = setInterval(() => {
    archiveExpiredParties().catch((error) => console.error('Nem sikerült archiválni a lejárt bulikat:', error.message));
  }, 60 * 60 * 1000);
  archiveTimer.unref();
  console.log('MongoDB kapcsolat létrejött.');
  if (Boolean(process.env.ADMIN_EMAIL) !== Boolean(process.env.ADMIN_PASSWORD)) throw new Error('Az admin fiók beállításához az ADMIN_EMAIL és ADMIN_PASSWORD változót együtt add meg.');
  if (process.env.ADMIN_EMAIL && process.env.ADMIN_PASSWORD) {
    if (process.env.ADMIN_PASSWORD.length < 8) throw new Error('Az ADMIN_PASSWORD legalább 8 karakter legyen.');
    const existingAdmin = await User.findOne({ role: 'admin' });
    if (!existingAdmin) {
      const email = process.env.ADMIN_EMAIL.trim().toLowerCase();
      let admin = await User.findOne({ email }).select('+passwordHash');
      if (!admin) {
        let username = (process.env.ADMIN_USERNAME || `admin_${crypto.randomBytes(4).toString('hex')}`).toLowerCase().replace(/[^a-z0-9_]/g, '_').slice(0, 24);
        if (username.length < 3 || await User.exists({ username })) username = `admin_${crypto.randomBytes(4).toString('hex')}`;
        admin = new User({ email, username, nickname: process.env.ADMIN_NICKNAME || 'Admin', age: 18, passwordHash: await bcrypt.hash(process.env.ADMIN_PASSWORD, 12), role: 'admin' });
      } else {
        admin.passwordHash = await bcrypt.hash(process.env.ADMIN_PASSWORD, 12);
        admin.role = 'admin';
      }
      await admin.save();
      console.log(`Admin fiók előkészítve: ${admin.email}`);
    } else if (existingAdmin.email !== process.env.ADMIN_EMAIL.trim().toLowerCase()) {
      console.warn(`Már létezik egy admin fiók (${existingAdmin.email}); az ADMIN_EMAIL beállítás nem módosította.`);
    }
  } else {
    console.warn('Az admin fiók nincs beállítva. A létrehozáshoz konfiguráld az ADMIN_EMAIL és ADMIN_PASSWORD változókat.');
  }
  return app.listen(port, () => console.log(`KiMitHoz? elérhető: http://localhost:${port}`));
}

if (require.main === module) {
  start().catch((error) => {
    console.error('Nem sikerült elindítani a szervert:', error.message);
    process.exit(1);
  });
}

module.exports = { app, start };