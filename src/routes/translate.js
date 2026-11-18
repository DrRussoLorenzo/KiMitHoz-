const router = require('express').Router();
const rateLimit = require('express-rate-limit');
const auth = require('../middleware/auth');

const MAX_BATCH_SIZE = 12;
const MAX_TEXT_LENGTH = 1600;
const MAX_BATCH_CHARACTERS = 5000;
const translationCache = new Map();
const CACHE_TTL_MS = 12 * 60 * 60 * 1000;
const MAX_CACHE_ENTRIES = 5000;

router.use(
  rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 30,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
  })
);
router.use(auth);

router.post('/', async (request, response) => {
  const target = request.body?.target;
  const texts = request.body?.texts;
  if (!['en', 'de'].includes(target))
    return response.status(400).json({ message: 'A célnyelv csak angol vagy német lehet.' });
  if (
    !Array.isArray(texts) ||
    texts.length === 0 ||
    texts.length > MAX_BATCH_SIZE ||
    texts.some((text) => typeof text !== 'string' || text.length > MAX_TEXT_LENGTH) ||
    texts.reduce((total, text) => total + text.length, 0) > MAX_BATCH_CHARACTERS
  )
    return response.status(400).json({ message: 'Érvénytelen vagy túl hosszú fordítási kérés.' });

  const uniqueTexts = [...new Set(texts)];
  const translations = new Map();
  const missingTexts = [];
  const now = Date.now();
  for (const text of uniqueTexts) {
    const cacheKey = `${target}\u0000${text}`;
    const cached = translationCache.get(cacheKey);
    if (cached && cached.expiresAt > now) translations.set(text, cached.translation);
    else {
      if (cached) translationCache.delete(cacheKey);
      missingTexts.push(text);
    }
  }

  if (missingTexts.length) {
    const apiKey = process.env.GOOGLE_TRANSLATE_API_KEY;
    if (!apiKey)
      return response.status(503).json({ message: 'A fordítási szolgáltatás nincs beállítva.' });
    try {
      const googleResponse = await fetch(
        `https://translation.googleapis.com/language/translate/v2?key=${encodeURIComponent(apiKey)}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ q: missingTexts, target, format: 'text' }),
          signal: AbortSignal.timeout(10000),
        }
      );
      if (!googleResponse.ok)
        return response.status(502).json({ message: 'A fordítási szolgáltatás nem érhető el.' });
      const result = await googleResponse.json();
      const translatedTexts = result.data?.translations;
      if (!Array.isArray(translatedTexts) || translatedTexts.length !== missingTexts.length)
        return response.status(502).json({ message: 'Érvénytelen válasz érkezett a fordítótól.' });

      translatedTexts.forEach((entry, index) => {
        const source = missingTexts[index];
        const translation =
          typeof entry.translatedText === 'string' ? entry.translatedText : source;
        translations.set(source, translation);
        if (translationCache.size >= MAX_CACHE_ENTRIES)
          translationCache.delete(translationCache.keys().next().value);
        translationCache.set(`${target}\u0000${source}`, {
          translation,
          expiresAt: now + CACHE_TTL_MS,
        });
      });
    } catch (_error) {
      return response.status(502).json({ message: 'A fordítási szolgáltatás nem érhető el.' });
    }
  }

  response.json({ translations: texts.map((text) => translations.get(text) || text) });
});

module.exports = router;
