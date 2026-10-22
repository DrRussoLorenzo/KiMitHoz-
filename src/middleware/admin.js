module.exports = function requireAdmin(req, res, next) {
  if (req.user?.role !== 'admin') return res.status(403).json({ message: 'Ehhez a művelethez admin jogosultság szükséges.' });
  next();
};
