const jwt = require('jsonwebtoken');
const { User } = require('../models');

module.exports = async function authenticate(req, res, next) {
  const token = req.headers.authorization?.replace(/^Bearer\s+/i, '');
  if (!token) return res.status(401).json({ message: 'A folytatáshoz jelentkezz be.' });
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    const user = await User.findById(payload.sub);
    if (!user) return res.status(401).json({ message: 'A felhasználói fiók nem található.' });
    req.user = user;
    next();
  } catch (_error) {
    return res.status(401).json({ message: 'A munkamenet lejárt, jelentkezz be újra.' });
  }
};