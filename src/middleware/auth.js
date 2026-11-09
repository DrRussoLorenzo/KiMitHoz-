const jwt = require('jsonwebtoken');
const { User } = require('../models');

/** Ellenőrzi a munkamenet tokent, a fiók állapotát és a jóváhagyást. */
module.exports = async function hitelesites(keres, valasz, folytatas) {
  const token = keres.headers.authorization?.replace(/^Bearer\s+/i, '');
  if (!token) return valasz.status(401).json({ message: 'A folytatáshoz jelentkezz be.' });
  try {
    const tokenAdatok = jwt.verify(token, process.env.JWT_SECRET);
    const felhasznalo = await User.findById(tokenAdatok.sub);
    if (!felhasznalo)
      return valasz.status(401).json({ message: 'A felhasználói fiók nem található.' });
    if (felhasznalo.isBanned && felhasznalo.role !== 'admin')
      return valasz.status(403).json({
        message: felhasznalo.banReason
          ? `A fiókodat kitiltották: ${felhasznalo.banReason}`
          : 'A fiókodat kitiltották.',
      });
    if (felhasznalo.role !== 'admin' && felhasznalo.verificationStatus !== 'approved')
      return valasz
        .status(403)
        .json({ message: 'A fiókod még nem kapta meg az adminisztrátori jóváhagyást.' });
    keres.user = felhasznalo;
    folytatas();
  } catch (_hiba) {
    return valasz.status(401).json({ message: 'A munkamenet lejárt, jelentkezz be újra.' });
  }
};
