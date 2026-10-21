const router = require('express').Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { User } = require('../models');
const auth = require('../middleware/auth');

// A jelszóhash soha nem kerül vissza az API-válaszba.
const publicUser = (user) => ({ id: user._id, email: user.email, username: user.username, nickname: user.nickname, age: user.age, avatar: user.avatar, bio: user.bio, settings: user.settings });
const tokenFor = (user) => jwt.sign({ sub: user._id.toString() }, process.env.JWT_SECRET, { expiresIn: '7d' });

// Új fiók létrehozása, jelszóhash-eléssel.
router.post('/register', async (req, res, next) => {
  try {
    const { email, username, nickname, parsedage, password } = req.body;
    if (!email || !username || !nickname || !age  || !password) return res.status(400).json({ message: 'Minden mező kitöltése kötelező.' });
    if (!/^\S+@\S+\.\S+$/.test(email)) return res.status(400).json({ message: 'Adj meg egy érvényes e-mail-címet.' });
    if (!/^[a-zA-Z0-9_]{3,24}$/.test(username)) return res.status(400).json({ message: 'A felhasználónév 3–24 karakteres lehet (betű, szám, _).' });
    const parsedAge = Number(age);
    if (!Number.isInteger(parsedAge) || parsedAge < 16 || parsedAge > 120) return res.status(400).json({ message: 'Az életkor 16 és 120 közötti egész szám legyen.' });
    if (password.length < 8) return res.status(400).json({ message: 'A jelszó legalább 8 karakter legyen.' });
    const passwordHash = await bcrypt.hash(password, 12);
    const user = await User.create({ email, username, nickname, parsedAge, passwordHash });
    res.status(201).json({ token: tokenFor(user), user: publicUser(user) });
  } catch (error) {
    if (error.code === 11000) return res.status(409).json({ message: 'Ez az e-mail-cím vagy felhasználónév már foglalt.' });
    next(error);
  }
});

// Bejelentkezés e-mail-címmel és jelszóval.
router.post('/login', async (req, res, next) => {
  try {
    const { email, password } = req.body;
    const user = await User.findOne({ email: String(email || '').toLowerCase().trim() }).select('+passwordHash');
    if (!user || !await bcrypt.compare(password || '', user.passwordHash)) return res.status(401).json({ message: 'Hibás e-mail-cím vagy jelszó.' });
    res.json({ token: tokenFor(user), user: publicUser(user) });
  } catch (error) { next(error); }
});

// A kliens ezzel ellenőrzi a mentett munkamenet érvényességét.
router.get('/me', auth, (req, res) => res.json({ user: publicUser(req.user) }));
module.exports = router;