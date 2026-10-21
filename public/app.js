// A böngészőben élő munkamenet és az aktuális képernyő adatai.
const state = { token: localStorage.getItem('kimihez-token'), user: null, parties: [], discoverParties: [], friends: [], requests: [], notifications: [], view: 'home', authMode: 'login', activeParty: null, viewedProfile: null };
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (v = '') => String(v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const emojiOnly = /^(?:(?:\p{Extended_Pictographic}(?:\uFE0F|\p{Emoji_Modifier})?(?:\u200D\p{Extended_Pictographic}(?:\uFE0F|\p{Emoji_Modifier})?)*)|(?:\p{Regional_Indicator}{2})|(?:[0-9#*]\uFE0F?\u20E3))$/u;
function isImageUrl(value) { try { return ['http:', 'https:'].includes(new URL(value).protocol); } catch (_error) { return false; } }
function isCoverImageValue(value) { return isImageUrl(value) || /^\/uploads\/[a-f0-9]{32}\.(?:jpg|png|gif|webp)$/i.test(value); }
function itemIconMarkup(value) { return isImageUrl(value) ? `<img class="contribution-icon-image" src="${esc(value)}" alt="" loading="lazy">` : `<span class="contribution-icon">${esc(value || '✳')}</span>`; }
const initial = (v = '?') => esc(v.trim().slice(0, 1).toUpperCase() || '?');
const avatarMarkup = (user, className = 'avatar', id = '') => {
  let image = '';
  try {
    const url = new URL(user?.avatar || '');
    if (['http:', 'https:'].includes(url.protocol)) image = `<img src="${esc(url.href)}" alt="" loading="lazy" onerror="this.remove()">`;
  } catch (_error) { /* No image URL: show the initials fallback. */ }
  return `<span${id ? ` id="${esc(id)}"` : ''} class="${className}">${image}${initial(user?.nickname || '?')}</span>`;
};
const dateLabel = d => new Intl.DateTimeFormat('hu-HU', { month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(d));
const dateValue = d => { const x = new Date(d); x.setMinutes(x.getMinutes() - x.getTimezoneOffset()); return x.toISOString().slice(0, 16); };
let toastTimer;
let discoveryMap;
let partyLocationMap;
let partyLocationMarker;
let partyChatTimer;
let partyChatLoading = false;
let reverseLookupAt = 0;
// Közös JSON/API kliens: Bearer tokent csatol és olvasható hibát dob.
async function api(path, options = {}) {
  const isMultipart = options.body instanceof FormData;
  const response = await fetch(`/api${path}`, { ...options, headers: { ...(!isMultipart ? { 'Content-Type': 'application/json' } : {}), ...(state.token ? { Authorization: `Bearer ${state.token}` } : {}), ...options.headers } });
  const responseText = await response.text();
  let data = {};
  try { data = responseText ? JSON.parse(responseText) : {}; }
  catch (_error) { data.message = `A szerver nem JSON választ adott (HTTP ${response.status}).`; }
  if (!response.ok) { if (response.status === 401 && state.token) logout(false); throw new Error(data.message || `Szerverhiba (HTTP ${response.status}).`); }
  return data;
}
// Rövid, közös visszajelzés a sikeres műveletekhez és hibákhoz.
function toast(message, error = false) { const node = $('#toast'); node.textContent = message; node.classList.toggle('error', error); node.classList.add('show'); clearTimeout(toastTimer); toastTimer = setTimeout(() => node.classList.remove('show'), 3000); }
function logout(message = true) { state.token = null; state.user = null; localStorage.removeItem('kimihez-token'); $('#app-shell').classList.add('hidden'); $('#auth-screen').classList.remove('hidden'); if (message) toast('Sikeresen kijelentkeztél.'); }
function showApp() { $('#auth-screen').classList.add('hidden'); $('#app-shell').classList.remove('hidden'); $('#sidebar-name').textContent = state.user.nickname; $('#sidebar-username').textContent = `@${state.user.username}`; $('#sidebar-avatar').outerHTML = avatarMarkup(state.user, 'avatar', 'sidebar-avatar'); document.body.classList.toggle('dark', state.user.settings?.theme === 'dark'); }
function setAuthMode(mode) { state.authMode = mode; $$('.auth-tabs button').forEach(b => b.classList.toggle('active', b.dataset.auth === mode)); const reg = mode === 'register'; $('#nickname-field').classList.toggle('hidden', !reg); $('#username-field').classList.toggle('hidden', !reg); $('#age-field').classList.toggle('hidden', !reg); $('#auth-title').textContent = reg ? 'Kezdődjön a közös sztori.' : 'Jó, hogy itt vagy.'; $('#auth-subtitle').textContent = reg ? 'Hozd létre a fiókod, és szervezz emlékezetes estéket.' : 'Jelentkezz be, és nézd meg, mi készül.'; $('#auth-eyebrow').textContent = reg ? 'CSATLAKOZZ A KÖZÖSSÉGHEZ' : 'ÜDV ÚJRA ITTHON'; $('#auth-submit').innerHTML = `${reg ? 'Fiók létrehozása' : 'Bejelentkezés'} <span>→</span>`; }
const statusOf = party => party.members?.find(m => (m.user?._id || m.user)?.toString() === state.user.id)?.status;
async function refreshData() {
  const [mine, friends, notes] = await Promise.all([api('/parties/mine'), api('/users/friends'), api('/notifications')]);
  state.parties = mine.parties; state.friends = friends.friends; state.requests = friends.requests; state.notifications = notes.notifications;
  $('#notification-count').textContent = notes.unread; $('#notification-count').classList.toggle('hidden', !notes.unread); $('#notification-dot').classList.toggle('hidden', !notes.unread);
}
function heading(k, t, d, a = '') { return `<div class="page-heading"><div><span class="greeting-kicker">${k}</span><h1>${t}</h1><p>${d}</p></div>${a}</div>`; }
function empty(icon, title, text, button = '') { return `<div class="empty-state"><div class="empty-icon">${icon}</div><h3>${title}</h3><p>${text}</p>${button}</div>`; }
// Közös kártya a kezdőlapon, a bulilistában és a felfedezésnél.
function card(p) {
  const going = (p.members || []).filter((member) => member.status === 'going');
  return `<article class="party-card" data-party="${p._id}">
    <div class="party-cover">${p.coverImage ? `<img class="party-cover-image" src="${esc(p.coverImage)}" alt="${esc(p.title)} borítóképe" loading="lazy">` : ''}<span class="pill">${p.visibility === 'public' ? 'Nyilvános' : 'Meghívásos'}</span>${p.coverImage ? '' : '<span class="cover-emoji">🎉</span>'}</div>
    <div class="party-card-body"><h3>${esc(p.title)}</h3><div class="party-meta"><span>◷ ${dateLabel(p.date)}</span><span>⌖ ${esc(p.location)}</span></div>
      <div class="party-bottom"><div class="mini-stack">${going.slice(0, 4).map((member) => avatarMarkup(member.user, 'mini-avatar')).join('')}</div><small>${going.length} / ${p.maxGuests} fő</small></div>
    </div>
  </article>`;
}
function homePage() {
  const upcoming = state.parties
    .filter((party) => new Date(party.date) > new Date() && statusOf(party) !== 'declined')
    .sort((a, b) => new Date(a.date) - new Date(b.date));
  const nextParty = upcoming[0];
  const hero = `<section class="hero-card"><div class="hero-copy">
    <span class="eyebrow">${nextParty ? 'A KÖVETKEZŐ PROGRAMOD' : 'LEGYEN EBBŐL VALAMI'}</span>
    <h2>${nextParty ? esc(nextParty.title) : 'A jó esték egy ötlettel kezdődnek.'}</h2>
    <p>${nextParty ? `${dateLabel(nextParty.date)} · ${esc(nextParty.location)}` : 'Hívd össze a barátaid, és tervezzétek meg együtt.'}</p>
    <button class="button button-dark button-small" ${nextParty ? `data-action="view-party" data-party="${nextParty._id}"` : 'data-action="create"'}>${nextParty ? 'Részletek megnyitása' : 'Kezdjük el'} →</button>
  </div><span class="hero-shape"></span><span class="hero-emoji">${nextParty ? '🎉' : '🪩'}</span></section>`;
  const stats = `<div class="stats-grid">
    <button type="button" class="stat-card" data-view="parties" aria-label="Közelgő bulik megnyitása"><span class="stat-icon">✳</span><span><strong>${upcoming.length}</strong><small>Közelgő buli</small></span></button>
    <button type="button" class="stat-card" data-view="friends" aria-label="Barátok megnyitása"><span class="stat-icon">♧</span><span><strong>${state.friends.length}</strong><small>Barátod van itt</small></span></button>
    <button type="button" class="stat-card" data-view="notifications" aria-label="Értesítések megnyitása"><span class="stat-icon">✉</span><span><strong>${state.notifications.filter((item) => !item.read).length}</strong><small>Új értesítés</small></span></button>
  </div>`;
  const partyList = upcoming.length
    ? upcoming.slice(0, 3).map(card).join('')
    : empty('🪩', 'Még nincs programod', 'Hozz létre egy bulit, vagy nézz körül a nyilvános események között.', '<button class="button button-lime button-small" data-view="discover">Események felfedezése</button>');

  return `${heading('A TE KÖVETKEZŐ JÓ ESTÉD', `Szia, ${esc(state.user.nickname)}! ✳`, 'Készen állsz valami emlékezetesre?', '<button class="button button-dark" data-action="create">＋ Buli szervezése</button>')}${hero}${stats}<div class="section-row"><h2>Közelgő bulik</h2><button class="text-button" data-view="parties">Összes buli →</button></div><div class="party-grid">${partyList}</div>`;
}

function partiesPage() {
  const parties = state.parties.filter((party) => statusOf(party) !== 'declined' || party.host?._id === state.user.id);
  const content = parties.length
    ? parties.map(card).join('')
    : empty('🎈', 'Még üres a naptárad', 'Szervezz egy bulit, vagy csatlakozz meghívóval.', '<button class="button button-lime button-small" data-action="join-code">Meghívókód megadása</button>');

  return `${heading('A TI TERVEITEK', 'Bulijaim', 'Minden meghívásod és szervezésed egy helyen.', '<button class="button button-dark" data-action="create">＋ Új buli</button>')}<div class="party-grid">${content}</div>`;
}
async function discoverPage() {
  const { parties } = await api('/parties/discover');
  state.discoverParties = parties;
  const partyCards = parties.length
    ? parties.map(card).join('')
    : empty('⌖', 'Most nincs nyilvános buli', 'Hozd létre te az elsőt.', '<button class="button button-lime button-small" data-action="create">Buli szervezése</button>');

  return `${heading('KÖZELI ÉLMÉNYEK', 'Felfedezés', 'Nyilvános események, új emberek, jó történetek.')}
    <div class="search-row"><input id="invite-code" class="search-input" placeholder="Meghívókód…"><button class="button button-dark" data-action="join-code">Csatlakozás</button></div>
    <section class="map-panel"><div class="map-heading"><div><strong>Bulik a térképen</strong><small>Csak a nyilvános események helyszíne látható.</small></div><span class="map-count">${parties.filter((party) => party.coordinates?.lat != null && party.coordinates?.lng != null).length} helyszín</span></div><div id="discover-map" class="map-canvas" aria-label="Nyilvános bulik térképe"></div></section>
    <div class="section-row"><h2>Nyilvános bulik</h2></div><div class="party-grid">${partyCards}</div>`;
}

function mapStyleForTheme() { return `https://tiles.openfreemap.org/styles/${document.body.classList.contains('dark') ? 'dark' : 'positron'}`; }
function applyMapTheme() {
  const style = mapStyleForTheme();
  if (discoveryMap) discoveryMap.setStyle(style);
  if (partyLocationMap) partyLocationMap.setStyle(style);
}
// A felfedező térképre kizárólag a nyilvános API által visszaadott események kerülhetnek.
function initDiscoveryMap(parties) {
  const container = $('#discover-map');
  if (discoveryMap) { discoveryMap.remove(); discoveryMap = null; }
  if (!container || !window.maplibregl) return;
  discoveryMap = new maplibregl.Map({ container, style: mapStyleForTheme(), center: [19.0402, 47.4979], zoom: 6, attributionControl: true });
  const bounds = new maplibregl.LngLatBounds();
  let markerCount = 0;
  parties.filter(p => Number.isFinite(p.coordinates?.lat) && Number.isFinite(p.coordinates?.lng)).forEach(p => {
    const point = [p.coordinates.lng, p.coordinates.lat];
    const popup = new maplibregl.Popup({ offset: 25, className: 'party-map-popup' }).setHTML(`<strong>${esc(p.title)}</strong><br>${esc(p.location)}<br><button class="map-popup-button" data-action="view-party" data-party="${esc(p._id)}">Részletek →</button>`);
    new maplibregl.Marker({ color: '#8f2abe' }).setLngLat(point).setPopup(popup).addTo(discoveryMap);
    bounds.extend(point);
    markerCount += 1;
  });
  if (markerCount) discoveryMap.fitBounds(bounds, { padding: 48, maxZoom: 13 });
}

// A térképpont a rejtett koordinátamezőket és a cím űrlapmezőt frissíti.
function syncPartyCoordinates(lat, lng) {
  const form = $('#party-form');
  if (!form) return;
  form.elements.coordinatesLat.value = lat.toFixed(6);
  form.elements.coordinatesLng.value = lng.toFixed(6);
  if (!form.elements.location.value.trim()) form.elements.location.value = `Térképen kijelölt hely: ${lat.toFixed(5)}, ${lng.toFixed(5)}`;
  $('#map-selection-status').textContent = 'Helyszín kijelölve · ' + lat.toFixed(4) + ', ' + lng.toFixed(4);
}

// A kijelölt pontból címet kér az OpenStreetMap Nominatim szolgáltatástól.
async function reverseGeocode(lat, lng) {
  const now = Date.now();
  if (now - reverseLookupAt < 1100) return;
  reverseLookupAt = now;
  try {
    const response = await fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lng}`);
    if (!response.ok) return;
    const result = await response.json();
    if (result.display_name && $('#party-form')) $('#party-form').elements.location.value = result.display_name.slice(0, 160);
  } catch (_error) { /* A térképpont akkor is használható, ha a címszolgáltatás nem érhető el. */ }
}

// Csak nyilvános eseménynél jelenik meg; privát buli koordinátát nem tárol.
function initPartyLocationMap(party = null) {
  const container = $('#party-location-map');
  if (!container || !window.maplibregl) return;
  if (partyLocationMap) { partyLocationMap.remove(); partyLocationMap = null; partyLocationMarker = null; }
  const lat = party?.coordinates?.lat;
  const lng = party?.coordinates?.lng;
  const center = Number.isFinite(lat) && Number.isFinite(lng) ? [lng, lat] : [19.0402, 47.4979];
  partyLocationMap = new maplibregl.Map({ container, style: mapStyleForTheme(), center, zoom: Number.isFinite(lat) && Number.isFinite(lng) ? 14 : 6 });
  if (Number.isFinite(lat) && Number.isFinite(lng)) {
    partyLocationMarker = new maplibregl.Marker({ color: '#8f2abe' }).setLngLat(center).addTo(partyLocationMap);
    syncPartyCoordinates(lat, lng);
  }
  partyLocationMap.on('click', event => {
    const { lat: pointLat, lng: pointLng } = event.lngLat;
    if (partyLocationMarker) partyLocationMarker.setLngLat([pointLng, pointLat]);
    else partyLocationMarker = new maplibregl.Marker({ color: '#8f2abe' }).setLngLat([pointLng, pointLat]).addTo(partyLocationMap);
    syncPartyCoordinates(pointLat, pointLng);
    reverseGeocode(pointLat, pointLng);
  });
  setTimeout(() => partyLocationMap?.resize(), 50);
}

// Címkeresés a térképen: a választott pont bekerül a buli űrlapjába.
async function findPartyAddress() {
  const form = $('#party-form');
  const query = form?.elements.location.value.trim();
  if (!query) return toast('Előbb írd be a címet vagy a hely nevét.', true);
  try {
    const response = await fetch(`https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&q=${encodeURIComponent(query)}`);
    const results = await response.json();
    if (!results.length) return toast('A megadott helyet nem találtam.', true);
    const lat = Number(results[0].lat);
    const lng = Number(results[0].lon);
    partyLocationMap.flyTo({ center: [lng, lat], zoom: 15 });
    if (partyLocationMarker) partyLocationMarker.setLngLat([lng, lat]); else partyLocationMarker = new maplibregl.Marker({ color: '#8f2abe' }).setLngLat([lng, lat]).addTo(partyLocationMap);
    syncPartyCoordinates(lat, lng);
  } catch (_error) { toast('A címkeresés most nem érhető el.', true); }
}
function friendsPage() { const people = state.friends.map(p => `<div class="person-row friend-profile-link" data-profile-user="${esc(p.id)}" role="button" tabindex="0" aria-label="${esc(p.nickname)} profiljának megnyitása">${avatarMarkup(p)}<div class="person-details"><strong>${esc(p.nickname)}</strong><small>@${esc(p.username)}</small></div><span class="profile-link-arrow" aria-hidden="true">→</span></div>`).join(''); const requests = state.requests.map(p => `<div class="person-row">${avatarMarkup(p)}<div class="person-details"><strong>${esc(p.nickname)}</strong><small>@${esc(p.username)} · felkérés</small></div><button class="button button-lime button-small" data-action="accept-friend" data-user="${p.id}">Elfogadás</button></div>`).join(''); return `${heading('JÓ TÁRSASÁG','Barátok','Találd meg a barátaid, és hívjátok össze a csapatot.')}<div class="content-grid"><section><div class="search-row"><input id="friend-search" class="search-input" placeholder="Keresés név vagy felhasználónév alapján"><button class="button button-dark" data-action="search-friends">Keresés</button></div><div id="friend-results" class="friends-list"></div><div class="friends-list">${people || empty('♧','Még nincsenek barátaid','Keress rájuk név alapján.')}</div></section><aside class="surface-card"><h2>Felkérések</h2>${requests || '<p class="muted">Nincs új felkérés.</p>'}</aside></div>`; }
function viewedProfilePage() {
  const profile = state.viewedProfile;
  const avatar = profile.avatar
    ? `<button type="button" class="profile-image-preview" data-action="preview-profile-image" data-image="${esc(profile.avatar)}" aria-label="Profilkép megtekintése teljes méretben">${avatarMarkup(profile, 'avatar profile-avatar')}<span>Kép megtekintése</span></button>`
    : avatarMarkup(profile, 'avatar profile-avatar');
  return `${heading('ISMERŐS PROFILJA', esc(profile.nickname), `@${esc(profile.username)}`, '<button class="button button-outline button-small" data-view="friends">← Vissza a barátokhoz</button>')}<section class="surface-card public-profile-card">${avatar}<h2>${esc(profile.nickname)}</h2><p class="muted">@${esc(profile.username)}</p><p class="profile-bio">${esc(profile.bio || 'Ehhez a profilhoz még nincs bemutatkozás.')}</p></section>`;
}
function notificationsPage() {
  const rows = state.notifications.map((notification) => {
    const party = notification.party && state.parties.find((item) => item._id === notification.party._id);
    const pendingInvite = notification.type === 'party-invite' && party && statusOf(party) === 'invited';
    const pendingFriend = notification.type === 'friend-request' && notification.sender && state.requests.some((request) => request.id === notification.sender._id);
    const inviteRequest = notification.type === 'party-invite-request' && notification.inviteRequestStatus === 'pending' && party;
    const actions = inviteRequest ? `<div class="notification-actions"><button class="button button-lime button-small" data-action="respond-invite-request" data-party="${notification.party._id}" data-notification="${notification._id}" data-status="accept">Elfogadás</button><button class="button button-outline button-small" data-action="respond-invite-request" data-party="${notification.party._id}" data-notification="${notification._id}" data-status="decline">Elutasítás</button></div>`
      : pendingInvite ? `<div class="notification-actions"><button class="button button-lime button-small" data-action="respond" data-party="${party._id}" data-status="going">Csatlakozom</button><button class="button button-outline button-small" data-action="respond" data-party="${party._id}" data-status="declined">Kihagyom</button></div>`
      : pendingFriend ? `<button class="button button-lime button-small" data-action="accept-friend" data-user="${notification.sender._id}">Visszaigazolás</button>` : '';
    return `<article class="notification-row">${avatarMarkup(notification.sender || { nickname: 'K' })}<div class="notification-copy"><strong>${esc(notification.message)}</strong><small>${dateLabel(notification.createdAt)}${notification.read ? '' : ' · Új'}</small>${actions}</div></article>`;
  }).join('');

  return `${heading('MARADJ KÉPBEN', 'Értesítések', 'Meghívók és fontos hírek.', '<button class="button button-outline button-small" data-action="read-all">Olvasottnak jelölés</button>')}<div class="notification-list">${rows || empty('✉', 'Minden naprakész', 'Ha meghívnak egy buliba, itt fogod látni.')}</div>`;
}
function profilePage() {
  const avatar = state.user.avatar
    ? `<button type="button" class="profile-image-preview" data-action="preview-profile-image" data-image="${esc(state.user.avatar)}" aria-label="Profilkép megtekintése teljes méretben">${avatarMarkup(state.user, 'avatar profile-avatar')}<span>Kép megtekintése</span></button>`
    : avatarMarkup(state.user, 'avatar profile-avatar');
  return `${heading('RÓLAD SZÓL','Profilom','Állítsd be a profilodat.')}<section class="surface-card"><form id="profile-form">${avatar}<label class="field">Profilkép URL-je<input name="avatar" type="url" maxlength="2048" value="${esc(state.user.avatar || '')}" placeholder="https://pelda.hu/profilkep.jpg"><small>Csak kép URL-jét add meg; üresen hagyva az alapértelmezett monogram jelenik meg.</small></label><label class="field">Becenév<input name="nickname" value="${esc(state.user.nickname)}" required></label><label class="field">Bemutatkozás<textarea name="bio">${esc(state.user.bio || '')}</textarea></label><div class="setting-row"><strong>Sötét megjelenés</strong><input type="checkbox" name="theme" ${state.user.settings?.theme === 'dark' ? 'checked' : ''}></div><div class="setting-row"><strong>Értesítések</strong><input type="checkbox" name="notifications" ${state.user.settings?.notifications !== false ? 'checked' : ''}></div><button class="button button-dark" type="submit">Mentés</button><button class="button button-outline" type="button" data-action="logout">Kijelentkezés</button></form></section>`;
}
function openImageViewer(imageUrl) {
  let url;
  try { url = new URL(imageUrl); } catch (_error) { return; }
  if (!['http:', 'https:'].includes(url.protocol)) return;
  $('#modal-root').innerHTML = `<div class="image-viewer-backdrop" data-action="dismiss-image-viewer" role="presentation"><button type="button" class="image-viewer-close" data-action="close-image-viewer" aria-label="Bezárás">×</button><img class="image-viewer-image" src="${esc(url.href)}" alt="Profilkép teljes méretben"><span class="image-viewer-hint">Kattints a bezáráshoz vagy nyomj Esc-et</span></div>`;
}
async function openParty(id) { const { party } = await api(`/parties/${id}`); state.activeParty = party; state.view = 'party-detail'; await render(); }
function chatTime(value) { return new Intl.DateTimeFormat('hu-HU', { hour: '2-digit', minute: '2-digit' }).format(new Date(value)); }
async function refreshPartyChat(partyId, scrollToBottom = false, showError = false) {
  if (partyChatLoading || state.view !== 'party-detail' || state.activeParty?._id !== partyId) return;
  const container = $('#party-chat-messages');
  if (!container) return;
  partyChatLoading = true;
  const wasAtBottom = scrollToBottom || container.scrollHeight - container.scrollTop - container.clientHeight < 60;
  try {
    const { messages } = await api(`/parties/${encodeURIComponent(partyId)}/chat/messages`);
    if (state.view !== 'party-detail' || state.activeParty?._id !== partyId) return;
    container.innerHTML = messages.map((message) => {
      const own = (message.sender?._id || message.sender)?.toString() === state.user.id;
      return `<article class="chat-message ${own ? 'own' : ''}">${avatarMarkup(message.sender || { nickname: '?' }, 'chat-avatar')}<div class="chat-message-body"><div class="chat-message-meta"><strong>${esc(message.sender?.nickname || 'Résztvevő')}</strong><time datetime="${esc(message.createdAt)}">${chatTime(message.createdAt)}</time></div><p>${esc(message.text)}</p></div></article>`;
    }).join('') || '<p class="chat-empty">Még nincs üzenet. Kezdd el a beszélgetést!</p>';
    if (wasAtBottom) container.scrollTop = container.scrollHeight;
  } catch (error) {
    if (showError) toast(error.message, true);
  } finally {
    partyChatLoading = false;
  }
}
// Ugyanaz az űrlap hoz létre bulit és szerkeszti a házigazda saját eseményét.
function partyModal(p = null) {
  const edit = Boolean(p);
  const guests = p ? p.members.filter(m => m.status === 'going').length : 2;
  const value = p || { title:'', coverImage:'', date:'', location:'', maxGuests:20, ticketPrice:0, description:'', visibility:'private' };
  const publicParty = value.visibility === 'public';
  const lat = p?.coordinates?.lat ?? '';
  const lng = p?.coordinates?.lng ?? '';
  openModal(edit ? 'Buli szerkesztése' : 'Szervezz egy bulit', `<form id="party-form" ${edit ? `data-party-id="${p._id}"` : ''}>
    <div class="form-grid">
      <label class="field span-two">A buli neve<input name="title" value="${esc(value.title)}" maxlength="90" required></label>
      <label class="field span-two">Borítókép URL-je<input name="coverImage" id="party-cover-url" type="text" inputmode="url" maxlength="2048" value="${esc(value.coverImage || '')}" placeholder="https://pelda.hu/kep.jpg"><small>Vagy válassz egy JPG, PNG, GIF vagy WebP képet (max. 5 MB).</small></label>
      <label class="field span-two">Kép feltöltése<input id="party-cover-upload" type="file" accept="image/jpeg,image/png,image/gif,image/webp"></label>
      <div id="party-cover-preview" class="party-cover-preview span-two ${value.coverImage ? '' : 'hidden'}">${value.coverImage ? `<img src="${esc(value.coverImage)}" alt="Borítókép előnézete">` : ''}</div>
      <label class="field">Dátum és idő<input name="date" type="datetime-local" value="${edit ? dateValue(value.date) : ''}" min="${dateValue(new Date(Date.now()+3600000))}" required></label>
      <label class="field">Helyszín<input name="location" value="${esc(value.location)}" maxlength="160" placeholder="Cím vagy hely neve" required></label>
      <label class="field">Létszámkorlát<input name="maxGuests" type="number" value="${value.maxGuests}" min="${edit ? Math.max(2, guests) : 2}" max="1000" required></label>
      <label class="field">Belépő (Ft)<input name="ticketPrice" type="number" value="${value.ticketPrice}" min="0" required></label>
      <label class="field span-two">Leírás<textarea name="description" rows="3" maxlength="1200">${esc(value.description || '')}</textarea></label>
      <label class="field span-two">Láthatóság<select name="visibility" id="party-visibility"><option value="private" ${!publicParty ? 'selected' : ''}>Privát — csak a buli résztvevői láthatják</option><option value="public" ${publicParty ? 'selected' : ''}>Nyilvános — mindenki felfedezheti</option></select></label>
      <div id="party-location-picker" class="location-picker span-two ${publicParty ? '' : 'hidden'}"><p class="muted">Írd be a hely nevét, vagy kattints a térképen a pontos hely kiválasztásához.</p><button type="button" class="button button-outline button-small" data-action="find-address">Cím megkeresése a térképen</button><div id="party-location-map" class="map-canvas map-picker"></div><small id="map-selection-status" class="map-status">${lat !== '' ? `Helyszín kijelölve · ${Number(lat).toFixed(4)}, ${Number(lng).toFixed(4)}` : 'Nincs térképen kijelölt hely.'}</small></div>
      <input type="hidden" name="coordinatesLat" value="${lat}"><input type="hidden" name="coordinatesLng" value="${lng}">
    </div>
    <div class="modal-actions"><button class="button button-outline" type="button" data-action="close-modal">Mégse</button><button class="button button-dark" type="submit">${edit ? 'Változások mentése' : 'Buli létrehozása'} →</button></div>
  </form>${edit ? `<form id="delete-party-form" class="danger-zone" data-party-id="${p._id}" data-party-title="${esc(p.title)}"><h3>Buli törlése</h3><p>A művelet végleges. A megerősítéshez írd be pontosan a buli nevét: <strong>${esc(p.title)}</strong></p><label class="field">A buli neve<input name="confirmation" autocomplete="off" required></label><button class="button button-outline danger-button" type="submit">Buli végleges törlése</button></form>` : ''}`);
  if (publicParty) initPartyLocationMap(p);
}
function renderParty(p) {
  const isHost = p.host?._id === state.user.id;
  const canChatParty = isHost || statusOf(p) === 'going';
  const attending = p.members.filter((member) => member.status === 'going');
  const formatFt = amount => `${new Intl.NumberFormat('hu-HU').format(amount)} Ft`;
  const totalItemPrice = p.contributions.reduce((total, item) => total + (Number(item.price) || 0), 0);
  const baseShare = attending.length ? Math.floor(totalItemPrice / attending.length) : 0;
  const remainder = attending.length ? totalItemPrice % attending.length : 0;
  const costSummary = `<div id="cost-summary" class="cost-summary hidden"><h3>Költségösszegzés</h3><div class="cost-summary-total"><span>Tételek összesen</span><strong>${formatFt(totalItemPrice)}</strong></div><p class="muted">${attending.length ? `A végösszeg ${attending.length} résztvevő között egyenlően osztva (az esetleges maradék forintot az első résztvevők kapják).` : 'A felosztáshoz még nincs résztvevő.'}</p>${attending.map((member, index) => `<div class="cost-person-row">${avatarMarkup(member.user)}<span>${esc(member.user?.nickname || 'Résztvevő')}</span><strong>${formatFt(baseShare + (index < remainder ? 1 : 0))}</strong></div>`).join('')}</div>`;
  const attendees = attending.map((member) => {
    const memberId = member.user?._id || member.user;
    const canRemove = isHost && memberId?.toString() !== state.user.id;
    return `<div class="person-row">${avatarMarkup(member.user)}<strong>${esc(member.user?.nickname || '')}</strong>${canRemove ? `<button class="button button-outline button-small member-remove" data-action="remove-member" data-party="${esc(p._id)}" data-user="${esc(memberId)}">Eltávolítás</button>` : ''}</div>`;
  }).join('');
  const items = p.contributions.map((item) => {
    const itemOwnerId = item.user?._id || item.user;
    const canDeleteItem = isHost || itemOwnerId?.toString() === state.user.id;
    return `<div class="contribution-row">${itemIconMarkup(item.icon || '✳')}<div class="person-details"><strong>${esc(item.name)} × ${esc(item.quantity)}</strong><small>${esc(item.user?.nickname || '')}</small></div><strong class="contribution-price">${formatFt(Number(item.price) || 0)}</strong>${canDeleteItem ? `<button class="button button-outline button-small item-delete" data-action="delete-item" data-party="${esc(p._id)}" data-item="${esc(item._id)}" aria-label="${esc(item.name)} törlése">Törlés</button>` : ''}</div>`;
  }).join('');
  const canInviteFriends = isHost || statusOf(p) === 'going';
  const canLeave = !isHost && statusOf(p) === 'going';
  const eligibleFriends = state.friends.filter((friend) => !p.members.some((member) => (member.user?._id || member.user)?.toString() === friend.id && ['going', 'invited'].includes(member.status)));
  const inviteFriends = canInviteFriends ? `<h2>${isHost ? 'Hívd meg a barátaid' : 'Kérj meghívót a barátaidnak'}</h2>${eligibleFriends.map((friend) => `<div class="person-row">${avatarMarkup(friend)}<div class="person-details"><strong>${esc(friend.nickname)}</strong><small>@${esc(friend.username)}</small></div><button class="button button-outline button-small" data-action="invite-friend" data-user="${friend.id}" data-party="${p._id}">${isHost ? 'Meghívás' : 'Meghívás kérése'}</button></div>`).join('') || '<p class="muted">Nincs meghívható ismerősöd.</p>'}` : '';
  const join = p.visibility === 'public' && !isHost && statusOf(p) !== 'going' ? `<button class="button button-dark button-small" data-action="join-public" data-party="${p._id}">Csatlakozom</button>` : '';
  return `${heading('A KÖZÖS TERV', 'Buli részletei', 'Minden fontos tudnivaló egy helyen.', '<button class="button button-outline button-small" data-view="parties">← Vissza</button>')}
    ${p.coverImage ? `<div class="party-detail-cover"><img src="${esc(p.coverImage)}" alt="${esc(p.title)} borítóképe"></div>` : ''}
    <section class="party-detail-head"><div><span class="pill">${p.visibility === 'public' ? 'Nyilvános' : 'Privát buli'}</span><h1>${esc(p.title)}</h1><span class="muted">Szervezi: ${esc(p.host?.nickname || '')}</span></div><div>${p.inviteCode ? `<button class="button button-dark button-small" data-action="copy-code" data-code="${p.inviteCode}">Kód: ${p.inviteCode} ⧉</button>` : ''}${join}${canLeave ? `<button class="button button-outline button-small leave-party-button" data-action="leave-party" data-party="${esc(p._id)}">Kilépés a buliból</button>` : ''}${isHost ? '<button class="button button-outline button-small" data-action="edit-party">Szerkesztés</button>' : ''}</div></section>
    <div class="party-detail-columns"><section class="surface-card"><h2>Az eseményről</h2><div class="detail-line">◷ ${dateLabel(p.date)}</div><div class="detail-line">⌖ ${esc(p.location)}</div><div class="detail-line">♧ ${attending.length} / ${p.maxGuests} fő · ${p.ticketPrice ? `${p.ticketPrice} Ft` : 'Ingyenes'}</div><div class="detail-line">✳ ${esc(p.description || 'Nincs leírás.')}</div><h2>Résztvevők</h2>${attendees}${inviteFriends}</section>
    <section class="surface-card"><div class="contribution-heading"><h2>Ki mit hoz?</h2><button type="button" class="button button-outline button-small" data-action="toggle-cost-summary" aria-expanded="false">Összegzés</button></div>${costSummary}${isHost || statusOf(p) === 'going' ? '<form id="item-form" class="form-grid"><label class="field span-two">Tétel neve<input name="name" required maxlength="100"></label><label class="field">Ikon<input name="icon" value="🍽️" maxlength="2048" placeholder="Emoji vagy kép URL-je" aria-label="Tétel ikonja: emoji vagy kép URL-je" required><small>Csak egy emoji vagy http(s) kép URL adható meg.</small></label><label class="field">Mennyiség<input name="quantity" value="1"></label><label class="field">Ár (Ft)<input name="price" type="number" min="0" step="1" value="0" required></label><label class="field">Kategória<select name="category"><option value="étel">Étel</option><option value="ital">Ital</option><option value="egyéb">Egyéb</option></select></label><button class="button button-lime button-small span-two">＋ Hozzáadás</button></form>' : ''}${items || '<p class="muted">Még nincs tétel.</p>'}<div class="contribution-total"><span>Tételek összesen</span><strong>${formatFt(totalItemPrice)}</strong></div></section></div>
    ${canChatParty ? `<section class="surface-card party-chat"><div class="party-chat-heading"><div><h2>Beszélgetés</h2><p class="muted">A buli résztvevőinek közös chatje</p></div><span class="chat-live-indicator">● Frissül</span></div><div id="party-chat-messages" class="party-chat-messages" role="log" aria-live="polite" aria-label="Buli chat üzenetei"><p class="chat-empty">Üzenetek betöltése…</p></div><form id="party-chat-form" class="party-chat-form" data-party-id="${esc(p._id)}"><label class="sr-only" for="party-chat-input">Üzenet</label><textarea id="party-chat-input" name="text" rows="2" maxlength="1000" placeholder="Írj üzenetet…" required></textarea><button class="button button-dark" type="submit">Küldés <span aria-hidden="true">→</span></button></form></section>` : ''}`;
}
function openModal(title, content) { $('#modal-root').innerHTML = `<div class="modal-backdrop" data-action="dismiss-modal"><section class="modal"><div class="modal-head"><h2>${title}</h2><button class="modal-close" data-action="close-modal">×</button></div>${content}</section></div>`; }
// Az aktuális nézet HTML-jét rajzolja ki, majd szükség esetén inicializálja a térképet.
async function render() {
  clearInterval(partyChatTimer);
  partyChatTimer = null;
  const labels = { home: 'Áttekintés', parties: 'Bulijaim', discover: 'Felfedezés', friends: 'Barátok', notifications: 'Értesítések', profile: 'Profilom', 'friend-profile': 'Ismerős profilja', 'party-detail': 'Buli részletei' };
  $('#breadcrumb').innerHTML = `${labels[state.view]} <span>/</span> Neked`;
  $$('.nav-link').forEach((link) => link.classList.toggle('active', link.dataset.view === state.view));

  const content = state.view === 'home' ? homePage()
    : state.view === 'parties' ? partiesPage()
      : state.view === 'discover' ? await discoverPage()
        : state.view === 'friends' ? friendsPage()
          : state.view === 'notifications' ? notificationsPage()
            : state.view === 'profile' ? profilePage()
              : state.view === 'friend-profile' ? viewedProfilePage()
              : renderParty(state.activeParty);

  $('#page-content').innerHTML = content;
  if (state.view === 'discover') initDiscoveryMap(state.discoverParties);
  if (state.view === 'party-detail' && state.activeParty?._id && $('#party-chat-messages')) {
    const partyId = state.activeParty._id;
    await refreshPartyChat(partyId, true, true);
    if (state.view === 'party-detail' && state.activeParty?._id === partyId) partyChatTimer = setInterval(() => refreshPartyChat(partyId), 5000);
  }
}
function joinModal(prefill = '') { openModal('Csatlakozás meghívókóddal', `<form id="join-form"><label class="field">Meghívókód<input name="inviteCode" value="${esc(prefill)}" required></label><button class="button button-dark">Csatlakozás →</button></form>`); }
async function searchFriends() { const q = $('#friend-search')?.value.trim(); if (!q) return; const { users } = await api(`/users/search?q=${encodeURIComponent(q)}`); $('#friend-results').innerHTML = users.map(p => `<div class="person-row">${avatarMarkup(p)}<strong>${esc(p.nickname)}</strong><button class="button button-outline button-small" data-action="send-friend" data-user="${p.id}">＋ Barát</button></div>`).join('') || '<p class="muted">Nincs találat.</p>'; }
// Navigációs gombok és eseményműveletek közös eseménykezelője.
document.addEventListener('click', async event => {
  const nav = event.target.closest('[data-view]'); if (nav) { state.view = nav.dataset.view; $('.sidebar').classList.remove('open'); await render(); if (state.view === 'notifications') api('/notifications/read', { method:'PATCH' }).then(refreshData).then(render).catch(() => {}); return; }
  const friendProfile = event.target.closest('[data-profile-user]');
  if (friendProfile) {
    try { const { user } = await api(`/users/${encodeURIComponent(friendProfile.dataset.profileUser)}`); state.viewedProfile = user; state.view = 'friend-profile'; await render(); }
    catch (error) { toast(error.message, true); }
    return;
  }
  const partyCard = event.target.closest('.party-card[data-party]'); if (partyCard) { await openParty(partyCard.dataset.party); return; }
  const button = event.target.closest('[data-action]'); if (!button) return; const action = button.dataset.action;
  try {
    if (action === 'create') partyModal();
    if (action === 'edit-party' && state.activeParty?.host?._id === state.user.id) partyModal(state.activeParty);
    if (action === 'join-code') joinModal($('#invite-code')?.value || '');
    if (action === 'find-address') await findPartyAddress();
    if (action === 'view-party') await openParty(button.dataset.party);
    if (action === 'close-modal' || action === 'dismiss-modal' && event.target === button) $('#modal-root').innerHTML = '';
    if (action === 'preview-profile-image') openImageViewer(button.dataset.image);
    if (action === 'close-image-viewer' || action === 'dismiss-image-viewer' && event.target === button) $('#modal-root').innerHTML = '';
    if (action === 'logout') logout();
    if (action === 'search-friends') await searchFriends();
    if (action === 'send-friend') { await api(`/users/friends/request/${button.dataset.user}`, { method:'POST' }); button.disabled = true; button.textContent = 'Elküldve'; toast('Barátfelkérés elküldve.'); }
    if (action === 'accept-friend') { await api(`/users/friends/requests/${button.dataset.user}/accept`, { method:'POST' }); await refreshData(); await render(); toast('Felkérés elfogadva.'); }
    if (action === 'invite-friend') { const id = button.dataset.party || state.activeParty?._id; if (!id) return toast('Nyisd meg a bulit a meghíváshoz.'); const result = await api(`/parties/${id}/invite`, { method:'POST', body:JSON.stringify({ userId:button.dataset.user }) }); toast(result.message); }
    if (action === 'respond-invite-request') { const result = await api(`/parties/${button.dataset.party}/invite-requests/${button.dataset.notification}/respond`, { method:'POST', body:JSON.stringify({ status:button.dataset.status }) }); await refreshData(); await render(); toast(result.message); }
    if (action === 'respond') { await api(`/parties/${button.dataset.party}/respond`, { method:'POST', body:JSON.stringify({ status:button.dataset.status }) }); await refreshData(); await render(); }
    if (action === 'read-all') { await api('/notifications/read', { method:'PATCH' }); await refreshData(); await render(); }
    if (action === 'copy-code') { await navigator.clipboard.writeText(button.dataset.code); toast('Kód másolva.'); }
    if (action === 'join-public') { const { party } = await api(`/parties/${button.dataset.party}/join`, { method:'POST' }); await refreshData(); await openParty(party._id); }
    if (action === 'leave-party' && window.confirm('Biztosan kilépsz ebből a buliból?')) { const partyId = button.dataset.party; const result = await api(`/parties/${encodeURIComponent(partyId)}/leave`, { method:'POST' }); state.activeParty = null; await refreshData(); state.view = 'parties'; await render(); toast(result.message); }
    if (action === 'toggle-cost-summary') { const summary = $('#cost-summary'); summary.classList.toggle('hidden'); const expanded = !summary.classList.contains('hidden'); button.setAttribute('aria-expanded', String(expanded)); button.textContent = expanded ? 'Összegzés elrejtése' : 'Összegzés'; }
    if (action === 'delete-item' && window.confirm('Biztosan törlöd ezt a tételt?')) { await api(`/parties/${button.dataset.party}/items/${button.dataset.item}`, { method:'DELETE' }); await openParty(button.dataset.party); toast('A tétel törölve.'); }
    if (action === 'remove-member' && window.confirm('Biztosan eltávolítod ezt a résztvevőt a buliból?')) { await api(`/parties/${button.dataset.party}/members/${button.dataset.user}`, { method:'DELETE' }); await openParty(button.dataset.party); toast('A résztvevő eltávolítva a buliból.'); }
  } catch (error) { toast(error.message, true); }
});
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && $('#modal-root .image-viewer-backdrop')) $('#modal-root').innerHTML = '';
  if ((event.key === 'Enter' || event.key === ' ') && event.target.matches('[data-profile-user]')) {
    event.preventDefault();
    event.target.click();
  }
});
// Belépés, buli létrehozás/szerkesztés, csatlakozás és profilmentés.
document.addEventListener('submit', async event => {
  const form = event.target;
  try {
    if (form.id === 'auth-form') { event.preventDefault(); const result = await api(`/auth/${state.authMode === 'register' ? 'register' : 'login'}`, { method:'POST', body:JSON.stringify(Object.fromEntries(new FormData(form))) }); state.token = result.token; state.user = { ...result.user, id:result.user.id || result.user._id }; localStorage.setItem('kimihez-token', state.token); showApp(); await refreshData(); state.view = 'home'; await render(); }
    if (form.id === 'party-form') { event.preventDefault(); const data = Object.fromEntries(new FormData(form)); data.maxGuests = Number(data.maxGuests); data.ticketPrice = Number(data.ticketPrice); const lat = data.coordinatesLat; const lng = data.coordinatesLng; delete data.coordinatesLat; delete data.coordinatesLng; data.coordinates = lat !== '' && lng !== '' ? { lat: Number(lat), lng: Number(lng) } : null; if (data.visibility === 'private') data.coordinates = null; const id = form.dataset.partyId; if (id) { const { party } = await api(`/parties/${id}`, { method:'PATCH', body:JSON.stringify(data) }); $('#modal-root').innerHTML = ''; await refreshData(); state.activeParty = party; await render(); toast('A buli adatai frissültek.'); } else { const { party } = await api('/parties', { method:'POST', body:JSON.stringify(data) }); $('#modal-root').innerHTML = ''; await refreshData(); await openParty(party._id); toast('A buli elkészült!'); } }
    if (form.id === 'delete-party-form') { event.preventDefault(); const confirmation = new FormData(form).get('confirmation').trim(); if (confirmation !== form.dataset.partyTitle) { toast('A beírt név nem egyezik a buli nevével.', true); return; } await api(`/parties/${form.dataset.partyId}`, { method:'DELETE', body:JSON.stringify({ confirmation }) }); $('#modal-root').innerHTML = ''; state.activeParty = null; await refreshData(); state.view = 'parties'; await render(); toast('A buli törölve.'); }
    if (form.id === 'join-form') { event.preventDefault(); const { party } = await api('/parties/join', { method:'POST', body:JSON.stringify(Object.fromEntries(new FormData(form))) }); $('#modal-root').innerHTML = ''; await refreshData(); await openParty(party._id); }
    if (form.id === 'item-form') { event.preventDefault(); const data = Object.fromEntries(new FormData(form)); data.price = Number(data.price); data.icon = data.icon.trim(); if (!emojiOnly.test(data.icon) && !isImageUrl(data.icon)) { form.elements.icon.setCustomValidity('Adj meg egyetlen emojit vagy http(s) kép URL-t.'); form.elements.icon.reportValidity(); return; } form.elements.icon.setCustomValidity(''); await api(`/parties/${state.activeParty._id}/items`, { method:'POST', body:JSON.stringify(data) }); await openParty(state.activeParty._id); }
    if (form.id === 'party-chat-form') { event.preventDefault(); const text = new FormData(form).get('text').trim(); if (!text) return; await api(`/parties/${encodeURIComponent(form.dataset.partyId)}/chat/messages`, { method:'POST', body:JSON.stringify({ text }) }); form.reset(); await refreshPartyChat(form.dataset.partyId, true, true); }
    if (form.id === 'profile-form') { event.preventDefault(); const d = Object.fromEntries(new FormData(form)); const { user } = await api('/users/me', { method:'PATCH', body:JSON.stringify({ nickname:d.nickname, avatar:d.avatar.trim(), bio:d.bio, settings:{ theme:form.elements.theme.checked ? 'dark' : 'light', notifications:form.elements.notifications.checked } }) }); state.user = { ...user, id:user.id || user._id }; showApp(); await refreshData(); await render(); toast('A profilod frissült.'); }
  } catch (error) { toast(error.message, true); }
});
// A privát/nyilvános kapcsoló vezérli a térképes helyválasztót.
document.addEventListener('change', event => {
  if (event.target.id === 'party-cover-upload') {
    const file = event.target.files?.[0];
    if (!file) return;
    const formData = new FormData();
    formData.append('image', file);
    api('/parties/cover-image', { method:'POST', body:formData }).then(({ imageUrl }) => {
      $('#party-cover-url').value = imageUrl;
      $('#party-cover-preview').innerHTML = `<img src="${esc(imageUrl)}" alt="Borítókép előnézete">`;
      $('#party-cover-preview').classList.remove('hidden');
      toast('A borítókép feltöltve.');
    }).catch(error => toast(error.message, true));
    return;
  }
  if (event.target.id !== 'party-visibility') return;
  const picker = $('#party-location-picker');
  const publicParty = event.target.value === 'public';
  picker.classList.toggle('hidden', !publicParty);
  if (!publicParty) {
    $('#party-form').elements.coordinatesLat.value = '';
    $('#party-form').elements.coordinatesLng.value = '';
    if (partyLocationMap) { partyLocationMap.remove(); partyLocationMap = null; partyLocationMarker = null; }
    return;
  }
  initPartyLocationMap();
});
document.addEventListener('input', event => {
  if (event.target.id !== 'party-cover-url') return;
  const preview = $('#party-cover-preview');
  const value = event.target.value.trim();
  event.target.setCustomValidity(!value || isCoverImageValue(value) ? '' : 'Adj meg érvényes http(s) kép URL-t, vagy tölts fel képet.');
  if (!value) { preview.innerHTML = ''; preview.classList.add('hidden'); return; }
  if (!isCoverImageValue(value)) return;
  preview.innerHTML = `<img src="${esc(value)}" alt="Borítókép előnézete">`;
  preview.classList.remove('hidden');
});
document.addEventListener('input', event => {
  if (event.target.name !== 'icon' || event.target.form?.id !== 'item-form') return;
  const value = event.target.value.trim();
  event.target.setCustomValidity(!value || emojiOnly.test(value) || isImageUrl(value) ? '' : 'Adj meg egyetlen emojit vagy http(s) kép URL-t.');
});
$$('.auth-tabs button').forEach(button => button.addEventListener('click', () => setAuthMode(button.dataset.auth)));
$('#theme-toggle').addEventListener('click', async () => { try { const theme = document.body.classList.contains('dark') ? 'light' : 'dark'; const { user } = await api('/users/me', { method:'PATCH', body:JSON.stringify({ settings:{ theme } }) }); state.user = { ...user, id:user.id || user._id }; document.body.classList.toggle('dark', theme === 'dark'); applyMapTheme(); } catch (error) { toast(error.message, true); } });
$('#create-party-top').addEventListener('click', () => partyModal());
$('#sidebar-profile').addEventListener('click', async () => { state.view = 'profile'; await render(); });
$('#mobile-menu').addEventListener('click', () => $('.sidebar').classList.toggle('open'));
async function boot() { if (!state.token) return; try { const { user } = await api('/auth/me'); state.user = { ...user, id:user.id || user._id }; showApp(); await refreshData(); await render(); } catch (_error) { logout(false); } }
boot();