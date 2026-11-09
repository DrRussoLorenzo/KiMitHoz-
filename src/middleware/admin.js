/** Az adminisztrátori útvonalakat csak megfelelő jogosultságú fiók érheti el. */
module.exports = function adminJogosultsagEllenorzese(keres, valasz, folytatas) {
  if (keres.user?.role !== 'admin')
    return valasz.status(403).json({ message: 'Ehhez a művelethez admin jogosultság szükséges.' });
  folytatas();
};
