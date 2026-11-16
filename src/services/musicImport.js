const { searchMusic } = require('./youtube');

const MAX_IMPORTED_TRACKS = 100;
const SPOTIFY_IMPORT_LIMIT = 25;

function parsePlaylistUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch (_error) {
    return null;
  }
  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  if (['youtube.com', 'm.youtube.com', 'music.youtube.com'].includes(host)) {
    const playlistId = url.searchParams.get('list');
    return playlistId && /^[A-Za-z0-9_-]{10,80}$/.test(playlistId)
      ? { provider: 'youtube', id: playlistId }
      : null;
  }
  if (host === 'youtu.be') {
    const playlistId = url.searchParams.get('list');
    return playlistId && /^[A-Za-z0-9_-]{10,80}$/.test(playlistId)
      ? { provider: 'youtube', id: playlistId }
      : null;
  }
  if (host === 'open.spotify.com') {
    const match = url.pathname.match(/^\/playlist\/([A-Za-z0-9]+)\/?$/);
    return match ? { provider: 'spotify', id: match[1] } : null;
  }
  return null;
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, { signal: AbortSignal.timeout(12000), ...options });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(`A külső lejátszási lista szolgáltatója hibát jelzett (HTTP ${response.status}).`);
    error.status = response.status === 404 ? 404 : 502;
    throw error;
  }
  return data;
}

async function importYouTubePlaylist(playlistId) {
  const apiKey = process.env.YOUTUBE_API_KEY;
  if (!apiKey) {
    const error = new Error('YouTube-lista importjához állítsd be a YOUTUBE_API_KEY környezeti változót.');
    error.status = 503;
    throw error;
  }
  const playlistParams = new URLSearchParams({
    part: 'snippet',
    id: playlistId,
    key: apiKey,
  });
  const [playlistData, tracks] = await Promise.all([
    fetchJson(`https://www.googleapis.com/youtube/v3/playlists?${playlistParams}`),
    collectYouTubePlaylistTracks(playlistId, apiKey),
  ]);
  return {
    title: String(playlistData.items?.[0]?.snippet?.title || '').slice(0, 80),
    tracks,
  };
}

async function collectYouTubePlaylistTracks(playlistId, apiKey) {
  const tracks = [];
  let pageToken;
  do {
    const params = new URLSearchParams({
      part: 'snippet',
      playlistId,
      maxResults: '50',
      key: apiKey,
    });
    if (pageToken) params.set('pageToken', pageToken);
    const data = await fetchJson(`https://www.googleapis.com/youtube/v3/playlistItems?${params}`);
    for (const item of data.items || []) {
      const videoId = item.snippet?.resourceId?.videoId;
      if (!/^[A-Za-z0-9_-]{11}$/.test(videoId || '')) continue;
      tracks.push({
        videoId,
        title: String(item.snippet?.title || '').slice(0, 160),
        artist: String(item.snippet?.videoOwnerChannelTitle || item.snippet?.channelTitle || 'Ismeretlen előadó').slice(0, 120),
        thumbnail: String(item.snippet?.thumbnails?.medium?.url || item.snippet?.thumbnails?.default?.url || '').slice(0, 2048),
      });
      if (tracks.length >= MAX_IMPORTED_TRACKS) break;
    }
    pageToken = tracks.length >= MAX_IMPORTED_TRACKS ? null : data.nextPageToken;
  } while (pageToken);
  return tracks;
}

async function spotifyAccessToken() {
  const clientId = process.env.SPOTIFY_CLIENT_ID;
  const clientSecret = process.env.SPOTIFY_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    const error = new Error('Spotify-importhoz add meg a SPOTIFY_CLIENT_ID és SPOTIFY_CLIENT_SECRET értékét a szerver .env fájljában.');
    error.status = 503;
    throw error;
  }
  const authorization = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const body = new URLSearchParams({ grant_type: 'client_credentials' });
  const data = await fetchJson('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${authorization}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
  });
  return data.access_token;
}

async function importSpotifyPlaylist(playlistId) {
  const token = await spotifyAccessToken();
  const params = new URLSearchParams({ limit: '100', offset: '0' });
  const data = await fetchJson(`https://api.spotify.com/v1/playlists/${encodeURIComponent(playlistId)}/tracks?${params}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const playlist = await fetchJson(`https://api.spotify.com/v1/playlists/${encodeURIComponent(playlistId)}?fields=name`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const sourceTracks = (data.items || [])
    .map((item) => item.track)
    .filter((track) => track && !track.is_local && track.name)
    .slice(0, SPOTIFY_IMPORT_LIMIT);
  const converted = Array(sourceTracks.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(3, sourceTracks.length) }, async () => {
    while (cursor < sourceTracks.length) {
      const index = cursor++;
      const source = sourceTracks[index];
      const artist = (source.artists || []).map((item) => item.name).join(', ');
      if (!artist) continue;
      const results = await searchMusic(`${source.name} ${artist}`);
      converted[index] = results[0] || null;
    }
  });
  await Promise.all(workers);
  return {
    title: String(playlist.name || '').slice(0, 80),
    tracks: converted.filter(Boolean).slice(0, MAX_IMPORTED_TRACKS),
  };
}

async function importPlaylist(url) {
  const source = parsePlaylistUrl(url);
  if (!source) {
    const error = new Error('Adj meg egy nyilvános YouTube- vagy Spotify-lejátszási lista linket.');
    error.status = 400;
    throw error;
  }
  return source.provider === 'youtube'
    ? importYouTubePlaylist(source.id)
    : importSpotifyPlaylist(source.id);
}

module.exports = { importPlaylist, parsePlaylistUrl };
