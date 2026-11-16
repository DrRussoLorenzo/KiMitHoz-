const router = require('express').Router();
const rateLimit = require('express-rate-limit');
const auth = require('../middleware/auth');
const { MusicPlaylist } = require('../models');
const { searchMusic } = require('../services/youtube');
const { importPlaylist } = require('../services/musicImport');

router.use(auth);

const musicSearchLimit = rateLimit({
  windowMs: 60 * 1000,
  limit: 20,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { message: 'Túl sok zenei keresést indítottál. Próbáld újra egy perc múlva.' },
});
const playlistImportLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { message: 'Túl sok playlist-importot indítottál. Próbáld újra 15 perc múlva.' },
});
const validId = (value) => typeof value === 'string' && /^[a-f\d]{24}$/i.test(value);
const parseTrack = (body) => {
  const videoId = typeof body.videoId === 'string' ? body.videoId.trim() : '';
  const title = typeof body.title === 'string' ? body.title.trim() : '';
  const artist = typeof body.artist === 'string' ? body.artist.trim() : '';
  const thumbnail = typeof body.thumbnail === 'string' ? body.thumbnail.trim() : '';
  if (!/^[A-Za-z0-9_-]{11}$/.test(videoId)) return { error: 'Érvénytelen YouTube-videó.' };
  if (!title || title.length > 160 || !artist || artist.length > 120)
    return { error: 'A zeneszám címe és előadója kötelező.' };
  if (thumbnail && (!thumbnail.startsWith('https://i.ytimg.com/') || thumbnail.length > 2048))
    return { error: 'Érvénytelen YouTube-borítókép.' };
  return { track: { videoId, title, artist, thumbnail } };
};

router.get('/search', musicSearchLimit, async (req, res, next) => {
  try {
    const query = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    if (query.length < 2 || query.length > 100)
      return res.status(400).json({ message: 'A keresés 2–100 karakteres legyen.' });
    res.json({ tracks: await searchMusic(query) });
  } catch (error) {
    next(error);
  }
});

router.get('/playlists', async (req, res, next) => {
  try {
    const playlists = await MusicPlaylist.find({ owner: req.user._id })
      .sort({ updatedAt: -1 })
      .lean();
    res.json({ playlists });
  } catch (error) {
    next(error);
  }
});

router.post('/playlists', async (req, res, next) => {
  try {
    const title = typeof req.body.title === 'string' ? req.body.title.trim() : '';
    if (!title || title.length > 80)
      return res.status(400).json({ message: 'A műsorlista neve 1–80 karakteres legyen.' });
    const playlist = await MusicPlaylist.create({ owner: req.user._id, title, tracks: [] });
    res.status(201).json({ playlist });
  } catch (error) {
    next(error);
  }
});

router.post('/playlists/import', playlistImportLimit, async (req, res, next) => {
  try {
    const url = typeof req.body.url === 'string' ? req.body.url.trim() : '';
    if (!url || url.length > 2048)
      return res.status(400).json({ message: 'Adj meg egy érvényes lejátszási lista linket.' });
    const imported = await importPlaylist(url);
    const requestedTitle = typeof req.body.title === 'string' ? req.body.title.trim() : '';
    const title = (requestedTitle || imported.title || 'Importált műsorlista').slice(0, 80);
    const playlist = await MusicPlaylist.create({
      owner: req.user._id,
      title,
      tracks: imported.tracks.slice(0, 250).map((track) => ({
        videoId: track.videoId,
        title: track.title,
        artist: track.artist,
        thumbnail: track.thumbnail || '',
        addedBy: req.user._id,
      })),
    });
    res.status(201).json({
      playlist,
      message: `A műsorlista importálva. ${playlist.tracks.length} zeneszám került bele.`,
    });
  } catch (error) {
    next(error);
  }
});

router.delete('/playlists/:playlistId', async (req, res, next) => {
  try {
    if (!validId(req.params.playlistId))
      return res.status(404).json({ message: 'A műsorlista nem található.' });
    const playlist = await MusicPlaylist.findOneAndDelete({
      _id: req.params.playlistId,
      owner: req.user._id,
    });
    if (!playlist) return res.status(404).json({ message: 'A műsorlista nem található.' });
    res.json({ message: 'A műsorlista törölve.' });
  } catch (error) {
    next(error);
  }
});

router.post('/playlists/:playlistId/tracks', async (req, res, next) => {
  try {
    if (!validId(req.params.playlistId))
      return res.status(404).json({ message: 'A műsorlista nem található.' });
    const parsed = parseTrack(req.body);
    if (parsed.error) return res.status(400).json({ message: parsed.error });
    const playlist = await MusicPlaylist.findOne({
      _id: req.params.playlistId,
      owner: req.user._id,
    });
    if (!playlist) return res.status(404).json({ message: 'A műsorlista nem található.' });
    if (playlist.tracks.length >= 250)
      return res.status(400).json({ message: 'Egy műsorlistában legfeljebb 250 zeneszám lehet.' });
    playlist.tracks.push({ ...parsed.track, addedBy: req.user._id });
    await playlist.save();
    res.status(201).json({ playlist });
  } catch (error) {
    next(error);
  }
});

router.delete('/playlists/:playlistId/tracks/:trackId', async (req, res, next) => {
  try {
    if (!validId(req.params.playlistId) || !validId(req.params.trackId))
      return res.status(404).json({ message: 'A zeneszám nem található.' });
    const playlist = await MusicPlaylist.findOne({
      _id: req.params.playlistId,
      owner: req.user._id,
    });
    if (!playlist) return res.status(404).json({ message: 'A műsorlista nem található.' });
    const track = playlist.tracks.id(req.params.trackId);
    if (!track) return res.status(404).json({ message: 'A zeneszám nem található.' });
    track.deleteOne();
    await playlist.save();
    res.json({ playlist });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
