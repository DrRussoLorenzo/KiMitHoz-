require('dotenv').config();

// A szerver belépési pontja: itt állítjuk össze az Express alkalmazást és a külső szolgáltatásokat.
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
const kiszolgaloPort = process.env.PORT || 3000;

// Biztonsági fejlécek, engedélyezett kliens és a JSON/űrlap kérések feldolgozása.
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({ origin: process.env.CLIENT_ORIGIN || true }));
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(
  '/api/auth',
  rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 40,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
  })
);

app.get('/api/health', (_keres, valasz) =>
  valasz.json({
    ok: true,
    database: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected',
  })
);

// Az API útvonalak külön fájlokban vannak, témakörönként; minden csoport saját routert kap.
app.use('/api/auth', authRoutes);
app.use('/api/users', userRoutes);
app.use('/api/parties', partyRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api', (_keres, valasz) =>
  valasz.status(404).json({
    message:
      'Az API-végpont nem található. Indítsd újra a szervert, hogy betöltse a legújabb útvonalakat.',
  })
);

// A frontend fájljait közvetlenül ugyanaz az Express szerver szolgálja ki.
app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (_keres, valasz) => valasz.sendFile(path.join(__dirname, 'public', 'index.html')));

// Központi hibakezelő: a belső hibákat olvasható HTTP-válasszá alakítja.
app.use((hiba, _keres, valasz, _folytatas) => {
  console.error(hiba);
  if (hiba.name === 'ValidationError') {
    const ellenorzesiUzenet = Object.values(hiba.errors).map(
      (ellenorzesiHiba) => ellenorzesiHiba.message
    )[0];
    return valasz
      .status(400)
      .json({ message: ellenorzesiUzenet || 'A megadott adatok érvénytelenek.' });
  }
  if (hiba.code === 11000)
    return valasz.status(409).json({ message: 'Az adat ütközik egy már létező rekorddal.' });
  valasz
    .status(hiba.status || 500)
    .json({ message: hiba.status ? hiba.message : 'Váratlan szerverhiba történt.' });
});

/** Ellenőrzi a kötelező konfigurációt, előkészíti az adatbázist és elindítja a webkiszolgálót. */
async function start() {
  // A szerver csak működő MongoDB-kapcsolattal indul el.
  if (!process.env.MONGODB_URI) throw new Error('Hiányzik a MONGODB_URI környezeti változó.');
  if (!process.env.JWT_SECRET) throw new Error('Hiányzik a JWT_SECRET környezeti változó.');
  await mongoose.connect(process.env.MONGODB_URI);
  await User.init();
  await archiveExpiredParties();
  const archivIdozito = setInterval(
    () => {
      archiveExpiredParties().catch((hiba) =>
        console.error('Nem sikerült archiválni a lejárt bulikat:', hiba.message)
      );
    },
    60 * 60 * 1000
  );
  archivIdozito.unref();
  console.log('MongoDB kapcsolat létrejött.');
  if (Boolean(process.env.ADMIN_EMAIL) !== Boolean(process.env.ADMIN_PASSWORD))
    throw new Error(
      'Az admin fiók beállításához az ADMIN_EMAIL és ADMIN_PASSWORD változót együtt add meg.'
    );
  if (process.env.ADMIN_EMAIL && process.env.ADMIN_PASSWORD) {
    if (process.env.ADMIN_PASSWORD.length < 8)
      throw new Error('Az ADMIN_PASSWORD legalább 8 karakter legyen.');
    const meglevoAdmin = await User.findOne({ role: 'admin' });
    if (!meglevoAdmin) {
      const emailCim = process.env.ADMIN_EMAIL.trim().toLowerCase();
      let adminFelhasznalo = await User.findOne({ email: emailCim }).select('+passwordHash');
      if (!adminFelhasznalo) {
        let felhasznalonev = (
          process.env.ADMIN_USERNAME || `admin_${crypto.randomBytes(4).toString('hex')}`
        )
          .toLowerCase()
          .replace(/[^a-z0-9_]/g, '_')
          .slice(0, 24);
        if (felhasznalonev.length < 3 || (await User.exists({ username: felhasznalonev })))
          felhasznalonev = `admin_${crypto.randomBytes(4).toString('hex')}`;
        adminFelhasznalo = new User({
          email: emailCim,
          username: felhasznalonev,
          nickname: process.env.ADMIN_NICKNAME || 'Admin',
          age: 18,
          passwordHash: await bcrypt.hash(process.env.ADMIN_PASSWORD, 12),
          role: 'admin',
        });
      } else {
        adminFelhasznalo.passwordHash = await bcrypt.hash(process.env.ADMIN_PASSWORD, 12);
        adminFelhasznalo.role = 'admin';
      }
      await adminFelhasznalo.save();
      console.log(`Admin fiók előkészítve: ${adminFelhasznalo.email}`);
    } else if (meglevoAdmin.email !== process.env.ADMIN_EMAIL.trim().toLowerCase()) {
      console.warn(
        `Már létezik egy admin fiók (${meglevoAdmin.email}); az ADMIN_EMAIL beállítás nem módosította.`
      );
    }
  } else {
    console.warn(
      'Az admin fiók nincs beállítva. A létrehozáshoz konfiguráld az ADMIN_EMAIL és ADMIN_PASSWORD változókat.'
    );
  }
  return app.listen(kiszolgaloPort, () =>
    console.log(`KiMitHoz? elérhető: http://localhost:${kiszolgaloPort}`)
  );
}

if (require.main === module) {
  start().catch((hiba) => {
    console.error('Nem sikerült elindítani a szervert:', hiba.message);
    process.exit(1);
  });
}

module.exports = { app, start };
