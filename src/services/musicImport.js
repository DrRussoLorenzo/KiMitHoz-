const { searchMusic } = require('./youtube');
const jwt = require('jsonwebtoken');
const { User } = require('../models');

const MAX_IMPORTED_TRACKS = 100;
const SPOTIFY_PAGE_SIZE = 50;

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

async function fetchJson(url, options = {}, provider = 'külső lejátszási lista') {
  const response = await fetch(url, { signal: AbortSignal.timeout(12000), ...options });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    let message = `${provider} hibát jelzett (HTTP ${response.status}).`;
    let status = response.status === 404 ? 404 : 502;
    if (provider === 'Spotify hitelesítés' && [400, 401, 403].includes(response.status)) {
      if (data.error === 'invalid_grant') {
        message = 'A Spotify-hozzáférés lejárt vagy visszavonták. Csatlakoztasd újra a Spotify-fiókodat.';
        status = 409;
      } else {
        message =
          'A Spotify hitelesítés nem sikerült. Ellenőrizd a kliensazonosítót, titkot és hogy a SPOTIFY_REDIRECT_URI pontosan egyezzen a Spotify Dashboardon megadott címmel.';
        status = 503;
      }
    } else if (provider === 'Spotify' && response.status === 403) {
      message =
        'A Spotify nem enged hozzáférést ehhez a listához. Csatlakozz a lista tulajdonosának vagy egy közreműködőnek a fiókjával. Ha az app Development mode-ban van, a Spotify Dashboardon a csatlakozó fiókot is add hozzá az engedélyezett felhasználókhoz. A nyilvános lista önmagában nem ad API-hozzáférést.';
      status = 403;
    } else if (provider === 'Spotify' && response.status === 401) {
      message = 'A Spotify-kapcsolat lejárt. Csatlakoztasd újra a Spotify-fiókodat.';
      status = 401;
    } else if (provider === 'Spotify' && response.status === 429) {
      message = 'A Spotify API kérési limitje betelt. Várj néhány percet, majd próbáld újra.';
      status = 429;
    } else if (response.status === 429) {
      status = 429;
    }
    const error = new Error(message);
    error.status = status;
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

async function spotifyAccessToken(userId) {
  const clientId = process.env.SPOTIFY_CLIENT_ID;
  const clientSecret = process.env.SPOTIFY_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    const error = new Error('Spotify-importhoz add meg a SPOTIFY_CLIENT_ID és SPOTIFY_CLIENT_SECRET értékét a szerver .env fájljában.');
    error.status = 503;
    throw error;
  }
  const user = await User.findById(userId).select(
    '+spotify.accessToken +spotify.refreshToken +spotify.expiresAt'
  );
  if (!user?.spotify?.refreshToken) {
    const error = new Error('Előbb csatlakoztasd a Spotify-fiókodat a Zene oldalon.');
    error.status = 409;
    throw error;
  }
  if (
    user.spotify.accessToken &&
    user.spotify.expiresAt &&
    user.spotify.expiresAt.getTime() > Date.now() + 60_000
  )
    return user.spotify.accessToken;

  const authorization = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: user.spotify.refreshToken,
  });
  const data = await fetchJson('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${authorization}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
  }, 'Spotify hitelesítés');
  user.spotify.accessToken = data.access_token;
  user.spotify.expiresAt = new Date(Date.now() + (Number(data.expires_in) || 3600) * 1000);
  if (data.refresh_token) user.spotify.refreshToken = data.refresh_token;
  await user.save();
  return user.spotify.accessToken;
}

async function importSpotifyPlaylist(playlistId, userId) {
  const token = await spotifyAccessToken(userId);
  const headers = { Authorization: `Bearer ${token}` };
  const [sourceTracks, playlist] = await Promise.all([
    collectSpotifyPlaylistItems(playlistId, token),
    fetchJson(`https://api.spotify.com/v1/playlists/${encodeURIComponent(playlistId)}?fields=name`, {
      headers,
    }, 'Spotify'),
  ]);
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
    tracks: converted.filter(Boolean),
  };
}

async function collectSpotifyPlaylistItems(playlistId, token) {
  const params = new URLSearchParams({
    limit: String(SPOTIFY_PAGE_SIZE),
    offset: '0',
    market: 'HU',
  });
  const headers = { Authorization: `Bearer ${token}` };
  const tracks = [];
  while (true) {
    const data = await fetchJson(
      `https://api.spotify.com/v1/playlists/${encodeURIComponent(playlistId)}/items?${params}`,
      { headers },
      'Spotify'
    );
    const items = data.items || [];
    const page = items
      .map((item) => item.item || item.track)
      .filter((track) => track && !track.is_local && track.name);
    tracks.push(...page);
    if (!data.next || !items.length) break;
    params.set('offset', String(Number(params.get('offset')) + items.length));
  }
  return tracks;
}

function spotifyRedirectUri() {
  if (process.env.SPOTIFY_REDIRECT_URI) return process.env.SPOTIFY_REDIRECT_URI;
  const appOrigin = process.env.CLIENT_ORIGIN || `http://127.0.0.1:${process.env.PORT || 3000}`;
  try {
    return new URL('/api/music/spotify/callback', appOrigin).toString();
  } catch (_error) {
    const error = new Error('A Spotify-kapcsolathoz állítsd be a SPOTIFY_REDIRECT_URI változót, és regisztráld ugyanazt a címet a Spotify Developer Dashboardon.');
    error.status = 503;
    throw error;
  }
}

function spotifyAuthorizationUrl(userId) {
  if (!process.env.SPOTIFY_CLIENT_ID || !process.env.SPOTIFY_CLIENT_SECRET) {
    const error = new Error('Állítsd be a SPOTIFY_CLIENT_ID és SPOTIFY_CLIENT_SECRET értékét a szerver .env fájljában.');
    error.status = 503;
    throw error;
  }
  const state = jwt.sign({ sub: String(userId), purpose: 'spotify-connect' }, process.env.JWT_SECRET, {
    expiresIn: '10m',
  });
  const params = new URLSearchParams({
    client_id: process.env.SPOTIFY_CLIENT_ID,
    response_type: 'code',
    redirect_uri: spotifyRedirectUri(),
    scope: 'playlist-read-private playlist-read-collaborative',
    state,
  });
  return `https://accounts.spotify.com/authorize?${params}`;
}

async function completeSpotifyAuthorization(code, state) {
  let stateData;
  try {
    stateData = jwt.verify(state, process.env.JWT_SECRET);
  } catch (_error) {
    const error = new Error('A Spotify-kapcsolat lejárt vagy érvénytelen. Indítsd újra a csatlakoztatást.');
    error.status = 400;
    throw error;
  }
  if (stateData.purpose !== 'spotify-connect' || !/^[a-f\d]{24}$/i.test(stateData.sub)) {
    const error = new Error('Érvénytelen Spotify-kapcsolati kérés.');
    error.status = 400;
    throw error;
  }
  const clientId = process.env.SPOTIFY_CLIENT_ID;
  const clientSecret = process.env.SPOTIFY_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    const error = new Error('Hiányzik a Spotify kliensazonosító vagy klienskulcs.');
    error.status = 503;
    throw error;
  }
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: spotifyRedirectUri(),
  });
  const authorization = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const token = await fetchJson('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${authorization}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
  }, 'Spotify hitelesítés');
  const user = await User.findById(stateData.sub).select(
    '+spotify.accessToken +spotify.refreshToken +spotify.expiresAt'
  );
  if (!user) {
    const error = new Error('A KiMitHoz-fiók már nem található.');
    error.status = 404;
    throw error;
  }
  user.spotify = {
    accessToken: token.access_token,
    refreshToken: token.refresh_token || user.spotify?.refreshToken || '',
    expiresAt: new Date(Date.now() + (Number(token.expires_in) || 3600) * 1000),
  };
  await user.save();
  return user;
}

async function importPlaylist(url, userId) {
  const source = parsePlaylistUrl(url);
  if (!source) {
    const error = new Error('Adj meg egy nyilvános YouTube- vagy Spotify-lejátszási lista linket.');
    error.status = 400;
    throw error;
  }
  return source.provider === 'youtube'
    ? importYouTubePlaylist(source.id)
    : importSpotifyPlaylist(source.id, userId);
}

module.exports = {
  completeSpotifyAuthorization,
  importPlaylist,
  parsePlaylistUrl,
  spotifyAuthorizationUrl,
  spotifyRedirectUri,
};
