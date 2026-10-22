const jwt = require('jsonwebtoken');
const { User } = require('../models');

module.exports = async function authenticate(req, res, next) {
  const token = req.headers.authorization?.replace(/^Bearer\s+/i, '');
  if (!token) return res.status(401).json({ message: 'A folytatáshoz jelentkezz be.' });
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    const user = await User.findById(payload.sub);
    if (!user) return res.status(401).json({ message: 'A felhasználói fiók nem található.' });
    if (user.isBanned && user.role !== 'admin') return res.status(403).json({ message: user.banReason ? `A fiókodat kitiltották: ${user.banReason}` : 'A fiókodat kitiltották.' });
    if (user.role !== 'admin' && user.verificationStatus !== 'approved') return res.status(403).json({ message: 'A fiókod még nem kapta meg az adminisztrátori jóváhagyást.' });
    req.user = user;
    next();
  } catch (_error) {
    return res.status(401).json({ message: 'A munkamenet lejárt, jelentkezz be újra.' });
  }
};