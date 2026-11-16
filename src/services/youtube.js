const YOUTUBE_SEARCH_URL = 'https://www.googleapis.com/youtube/v3/search';
const searchCache = new Map();

const youtubeErrorMessage = (status, payload) => {
  const reason = payload.error?.errors?.[0]?.reason || payload.error?.status || '';
  if (['keyInvalid', 'API_KEY_INVALID'].includes(reason))
    return 'A YouTube API-kulcs érvénytelen. Ellenőrizd a YOUTUBE_API_KEY értékét a szerver .env fájljában.';
  if (['accessNotConfigured', 'SERVICE_DISABLED', 'youtubeSignupRequired'].includes(reason))
    return 'A YouTube Data API v3 nincs engedélyezve a Google Cloud-projektben, amelyhez az API-kulcs tartozik.';
  if (
    ['ipRefererBlocked', 'API_KEY_IP_ADDRESS_BLOCKED', 'API_KEY_HTTP_REFERRER_BLOCKED'].includes(
      reason
    )
  )
    return 'A Google Cloud API-kulcs korlátozása blokkolja a szerverkérést. Backendhez szerver-IP-korlátozás kell, nem webhely (HTTP-referrer) korlátozás.';
  if (['quotaExceeded', 'dailyLimitExceeded', 'userRateLimitExceeded'].includes(reason))
    return 'A YouTube Data API kvótája elfogyott vagy túllépted a kérési limitet. Ellenőrizd a projekt kvótáját a Google Cloud Console-ban.';
  if (status === 400)
    return 'A YouTube API elutasította a keresési paramétereket. Próbálj rövidebb keresőkifejezést, vagy ellenőrizd az API-kérést.';
  return 'A YouTube-keresés nem sikerült. Ellenőrizd a Google Cloud API-beállításokat és próbáld újra.';
};

/** Kereshető zenéket ad vissza a hivatalos YouTube Data API v3 keresőjéből. */
async function searchMusic(query) {
  const apiKey = process.env.YOUTUBE_API_KEY;
  if (!apiKey) {
    const error = new Error('A zene kereséséhez állítsd be a YOUTUBE_API_KEY környezeti változót.');
    error.status = 503;
    throw error;
  }

  const cacheKey = query.trim().toLocaleLowerCase();
  const cached = searchCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.tracks;
  if (cached) searchCache.delete(cacheKey);

  const params = new URLSearchParams({
    part: 'snippet',
    type: 'video',
    videoCategoryId: '10',
    videoEmbeddable: 'true',
    maxResults: '10',
    regionCode: 'HU',
    q: query,
    key: apiKey,
  });
  let response;
  try {
    response = await fetch(`${YOUTUBE_SEARCH_URL}?${params}`, {
      signal: AbortSignal.timeout(8000),
    });
  } catch (_error) {
    const error = new Error('A YouTube-keresés időtúllépés miatt nem sikerült.');
    error.status = 504;
    throw error;
  }
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(youtubeErrorMessage(response.status, payload));
    error.status = response.status === 400 ? 400 : response.status === 403 ? 503 : 502;
    throw error;
  }

  const tracks = (payload.items || [])
    .filter((item) => /^[A-Za-z0-9_-]{11}$/.test(item.id?.videoId || ''))
    .map((item) => ({
      videoId: item.id.videoId,
      title: String(item.snippet?.title || '').slice(0, 160),
      artist: String(item.snippet?.channelTitle || 'Ismeretlen előadó').slice(0, 120),
      thumbnail: String(
        item.snippet?.thumbnails?.medium?.url || item.snippet?.thumbnails?.default?.url || ''
      ).slice(0, 2048),
    }));
  if (searchCache.size >= 100) searchCache.delete(searchCache.keys().next().value);
  searchCache.set(cacheKey, { tracks, expiresAt: Date.now() + 5 * 60 * 1000 });
  return tracks;
}

module.exports = { searchMusic };
