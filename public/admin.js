const tokenKey = 'kimihez-token';
let token = localStorage.getItem(tokenKey);
let currentUser;
let activeTab = 'users';
let records = [];
let searchTerm = '';
let currentPage = 1;
let pageData = { page: 1, pages: 1, total: 0 };
let searchTimer;
let verificationPreviewUrl;
const $ = (selector, root = document) => root.querySelector(selector);
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const idOf = value => value && typeof value === 'object' ? value._id || value.id || '' : value || '';
const labelOf = value => value && typeof value === 'object' ? value.nickname || value.username || value.title || idOf(value) : value || '—';
const config = {
  users: {
    title: 'Felhasználók', endpoint: '/users', columns: ['Felhasználó', 'E-mail', 'Fiókállapot', 'Regisztráció'],
    cells: item => [`<span class="record-primary">${esc(item.nickname)}</span><span class="record-secondary">@${esc(item.username)}</span>`, esc(item.email), item.role === 'admin' ? '<b>Admin</b>' : item.isBanned ? '<b class="admin-banned">Kitiltva</b>' : 'Aktív', dateText(item.createdAt)],
    fields: item => [
      field('E-mail-cím', 'email', item.email, 'email', true), field('Felhasználónév', 'username', item.username, 'text', true),
      field('Becenév', 'nickname', item.nickname, 'text', true), field('Életkor', 'age', item.age, 'number'),
      field('Profilkép URL', 'avatar', item.avatar), field('Bemutatkozás', 'bio', item.bio, 'textarea'),
      field('Kitiltva', 'isBanned', Boolean(item.isBanned), 'checkbox'), field('Kitiltás indoka', 'banReason', item.banReason, 'text'),
      field('Beállítások JSON', 'settings', JSON.stringify(item.settings || { theme: 'light', language: 'hu', notifications: true }, null, 2), 'textarea'),
      field('Ismerősök azonosítói JSON', 'friends', JSON.stringify((item.friends || []).map(idOf), null, 2), 'textarea'),
      field('Barátfelkérések azonosítói JSON', 'friendRequests', JSON.stringify((item.friendRequests || []).map(idOf), null, 2), 'textarea'),
      field('Jelszó', 'password', '', 'password', false, 'Szerkesztésnél hagyd üresen, ha nem szeretnéd megváltoztatni.')
    ]
  },
  verification: {
    title: 'Regisztrációk ellenőrzése', endpoint: '/verification-requests', columns: ['Felhasználó', 'Életkor', 'Állapot', 'Dokumentumok', 'Regisztráció'],
    cells: item => [
      `<span class="record-primary">${esc(item.nickname)}</span><span class="record-secondary">@${esc(item.username)} · ${esc(item.email)}</span>`,
      `${esc(item.age)} év`, 'Ellenőrzésre vár',
      `<button class="admin-image-link" data-verification-image="identity" data-user="${esc(item._id)}">Személyi igazolvány</button><br><button class="admin-image-link" data-verification-image="face" data-user="${esc(item._id)}">Arckép</button>`,
      dateText(item.createdAt)
    ], fields: () => []
  },
  parties: {
    title: 'Bulik', endpoint: '/parties', columns: ['Esemény', 'Szervező', 'Időpont', 'Láthatóság'],
    cells: item => [`<span class="record-primary">${esc(item.title)}</span><span class="record-secondary">${esc(item.location)}</span>`, esc(labelOf(item.host)), dateText(item.date), item.visibility === 'public' ? 'Nyilvános' : 'Privát'],
    fields: item => [
      field('Buli neve', 'title', item.title, 'text', true), field('Szervező felhasználói azonosítója', 'host', idOf(item.host), 'text', true),
      field('Dátum és idő', 'date', item.date ? localDate(item.date) : '', 'datetime-local', true), field('Helyszín', 'location', item.location, 'text', true),
      field('Láthatóság', 'visibility', item.visibility || 'private', 'select', true, '', ['private', 'public']), field('Belépő (Ft)', 'ticketPrice', item.ticketPrice ?? 0, 'number'),
      field('Maximális létszám', 'maxGuests', item.maxGuests ?? 30, 'number'), field('Minimális életkor', 'minAge', item.minAge ?? 16, 'number'), field('Meghívókód', 'inviteCode', item.inviteCode),
      field('Borítókép URL', 'coverImage', item.coverImage), field('Leírás', 'description', item.description, 'textarea'),
      field('Koordináták JSON', 'coordinates', JSON.stringify(item.coordinates || {}, null, 2), 'textarea', false, 'Példa: {"lat": 47.5, "lng": 19.04}'),
      field('Résztvevők JSON', 'members', JSON.stringify((item.members || []).map(member => ({ user: idOf(member.user), status: member.status })), null, 2), 'textarea', false, 'A felhasználók azonosítóit add meg.'),
      field('Hozzájárulások JSON', 'contributions', JSON.stringify((item.contributions || []).map(contribution => ({ user: idOf(contribution.user), name: contribution.name, quantity: contribution.quantity, price: contribution.price, category: contribution.category, icon: contribution.icon })), null, 2), 'textarea', false, 'A felhasználók azonosítóit add meg.')
    ]
  },
  items: {
    title: 'Tételek', endpoint: '/items', columns: ['Tétel', 'Buli', 'Hozzáadó', 'Mennyiség / ár'],
    cells: item => [`<span class="record-primary">${esc(item.name)}</span><span class="record-secondary">${esc(item.category)} · ${esc(item.icon || '✳')}</span>`, `<span class="record-primary">${esc(item.partyTitle)}</span><span class="record-secondary">${esc(item.partyId)}</span>`, esc(labelOf(item.user)), `${esc(item.quantity || '1')} · ${Number(item.price || 0).toLocaleString('hu-HU')} Ft`],
    fields: item => [
      field('Buli azonosítója', 'partyId', item.partyId, 'text', true), field('Hozzáadó felhasználó azonosítója', 'user', idOf(item.user), 'text', true),
      field('Tétel neve', 'name', item.name, 'text', true), field('Mennyiség', 'quantity', item.quantity || '1'),
      field('Ár (Ft)', 'price', item.price ?? 0, 'number'), field('Kategória', 'category', item.category || 'egyéb', 'select', true, '', ['étel', 'ital', 'egyéb']),
      field('Ikon vagy kép URL', 'icon', item.icon || '✳')
    ]
  },
  notifications: {
    title: 'Értesítések', endpoint: '/notifications', columns: ['Üzenet', 'Címzett', 'Típus', 'Állapot'],
    cells: item => [esc(item.message), esc(labelOf(item.recipient)), esc(item.type), item.read ? 'Olvasott' : 'Olvasatlan'],
    fields: item => [
      field('Címzett felhasználói azonosítója', 'recipient', idOf(item.recipient), 'text', true), field('Feladó azonosítója', 'sender', idOf(item.sender)),
      field('Buli azonosítója', 'party', idOf(item.party)), field('Célfelhasználó azonosítója', 'targetUser', idOf(item.targetUser)),
      field('Típus', 'type', item.type || 'system', 'select', true, '', ['party-invite', 'party-invite-request', 'friend-request', 'system']),
      field('Meghívási kérelem állapota', 'inviteRequestStatus', item.inviteRequestStatus || '', 'select', false, '', ['', 'pending', 'accepted', 'declined']),
      field('Üzenet', 'message', item.message, 'textarea', true), field('Olvasott', 'read', Boolean(item.read), 'checkbox')
    ]
  },
  messages: {
    title: 'Chatüzenetek', endpoint: '/messages', columns: ['Üzenet', 'Buli', 'Feladó', 'Létrehozva'],
    cells: item => [esc(item.text), esc(labelOf(item.party)), esc(labelOf(item.sender)), dateText(item.createdAt)],
    fields: item => [field('Buli azonosítója', 'party', idOf(item.party), 'text', true), field('Feladó felhasználói azonosítója', 'sender', idOf(item.sender), 'text', true), field('Üzenet', 'text', item.text, 'textarea', true)]
  }
};
function field(label, name, value = '', type = 'text', required = false, help = '', options = []) {
  const span = type === 'textarea' || ['coordinates', 'members', 'contributions', 'message', 'bio', 'description', 'text'].includes(name);
  let input;
  if (type === 'textarea') input = `<textarea name="${name}" ${required ? 'required' : ''}>${esc(value ?? '')}</textarea>`;
  else if (type === 'select') input = `<select name="${name}" ${required ? 'required' : ''}>${options.map(option => `<option value="${esc(option)}" ${String(value) === option ? 'selected' : ''}>${option ? esc(option) : 'Nincs megadva'}</option>`).join('')}</select>`;
  else if (type === 'checkbox') input = `<input name="${name}" type="checkbox" ${value ? 'checked' : ''}>`;
  else input = `<input name="${name}" type="${type}" value="${esc(value ?? '')}" ${required ? 'required' : ''} ${type === 'number' ? 'step="any"' : ''}>`;
  return `<label class="field ${span ? 'span-two' : ''}">${esc(label)}${input}${help ? `<small class="admin-help">${esc(help)}</small>` : ''}</label>`;
}
function localDate(value) { const date = new Date(value); if (Number.isNaN(date.getTime())) return ''; date.setMinutes(date.getMinutes() - date.getTimezoneOffset()); return date.toISOString().slice(0, 16); }
function dateText(value) { if (!value) return '—'; const date = new Date(value); return Number.isNaN(date.getTime()) ? '—' : esc(new Intl.DateTimeFormat('hu-HU', { dateStyle: 'short', timeStyle: 'short' }).format(date)); }
async function request(path, options = {}) {
  const response = await fetch(`/api/admin${path}`, { ...options, headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), Authorization: `Bearer ${token}`, ...options.headers } });
  const text = await response.text(); let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data.message = 'Érvénytelen szerverválasz.'; }
  if (!response.ok) { if (response.status === 401 || response.status === 403) { localStorage.removeItem(tokenKey); location.href = '/'; } throw new Error(data.message || `Hiba (${response.status}).`); }
  return data;
}
function toast(message, isError = false) { const node = $('#toast'); node.textContent = message; node.classList.toggle('error', isError); node.classList.add('show'); setTimeout(() => node.classList.remove('show'), 3200); }
function applyAdminTheme(theme) {
  const dark = theme === 'dark';
  document.body.classList.toggle('dark', dark);
  const button = $('#admin-theme-toggle');
  button.textContent = dark ? '☀️' : '🌙';
  button.setAttribute('aria-label', dark ? 'Világos mód bekapcsolása' : 'Sötét mód bekapcsolása');
}
async function verifyAccess() {
  if (!token) { location.href = '/'; return false; }
  const response = await fetch('/api/auth/me', { headers: { Authorization: `Bearer ${token}` } });
  if (!response.ok) { localStorage.removeItem(tokenKey); location.href = '/'; return false; }
  const data = await response.json(); currentUser = data.user;
  if (currentUser.role !== 'admin') { location.href = '/'; return false; }
  $('#admin-identity').textContent = `${currentUser.nickname} · ${currentUser.email}`;
  applyAdminTheme(currentUser.settings?.theme || 'light');
  return true;
}
async function loadStats() {
  const { stats } = await request('/overview');
  const values = [['Felhasználók', stats.users], ['Bulik', stats.parties], ['Nyilvános bulik', stats.publicParties], ['Értesítések', stats.notifications], ['Chatüzenetek', stats.messages]];
  $('#admin-stats').innerHTML = values.map(([label, count]) => `<article class="admin-stat"><strong>${Number(count).toLocaleString('hu-HU')}</strong><span>${label}</span></article>`).join('');
}
async function loadRecords() {
  const cfg = config[activeTab];
  $('#admin-status').textContent = 'Adatok betöltése…';
  try {
    const query = new URLSearchParams({ page: currentPage, q: searchTerm });
    const result = await request(`${cfg.endpoint}?${query}`);
    records = result[activeTab] || result.requests || [];
    pageData = result.pagination || { page: 1, pages: 1, total: records.length };
    if (currentPage > pageData.pages) { currentPage = pageData.pages; return loadRecords(); }
    renderTable();
    $('#admin-status').textContent = `${records.length} rekord megjelenítve a ${pageData.total} találatból`;
  } catch (error) { $('#admin-status').textContent = error.message; }
}
function renderTable() {
  const cfg = config[activeTab];
  $('#admin-thead').innerHTML = `<tr>${cfg.columns.map(column => `<th>${column}</th>`).join('')}<th>Műveletek</th></tr>`;
  $('#admin-tbody').innerHTML = records.length ? records.map(item => `<tr>${cfg.cells(item).map(cell => `<td>${cell}</td>`).join('')}<td><div class="admin-row-actions">${activeTab === 'verification' ? `<button data-decision="approved" data-user="${esc(item._id)}">Elfogadás</button><button class="danger" data-decision="rejected" data-user="${esc(item._id)}">Elutasítás</button>` : `${activeTab === 'users' && item.role !== 'admin' ? `<button data-ban="${esc(item._id)}" data-banned="${Boolean(item.isBanned)}">${item.isBanned ? 'Feloldás' : 'Kitiltás'}</button>` : ''}<button data-edit="${esc(item._id)}">Szerkesztés</button><button class="danger" data-delete="${esc(item._id)}" ${activeTab === 'items' ? `data-party="${esc(item.partyId)}"` : ''}>Törlés</button>`}</div></td></tr>`).join('') : `<tr><td class="admin-empty" colspan="${cfg.columns.length + 1}">Nincs megjeleníthető rekord.</td></tr>`;
  $('#admin-page-info').textContent = `${pageData.total.toLocaleString('hu-HU')} rekord · ${pageData.page}. / ${pageData.pages}. oldal`;
  $('#admin-prev').disabled = pageData.page <= 1;
  $('#admin-next').disabled = pageData.page >= pageData.pages;
}
function openEditor(item = null) {
  const cfg = config[activeTab];
  const fields = cfg.fields(item || {});
  $('#admin-modal-root').innerHTML = `<div class="modal-backdrop admin-modal" data-close-admin><section class="modal" role="dialog" aria-modal="true" aria-labelledby="admin-modal-title"><div class="modal-head"><h2 id="admin-modal-title">${item ? 'Rekord szerkesztése' : `Új rekord · ${cfg.title}`}</h2><button class="modal-close" type="button" data-close-admin>×</button></div><form id="admin-record-form" data-id="${esc(item?._id || '')}"><div class="admin-form-grid">${fields.join('')}</div><div class="admin-form-actions"><button type="button" class="button button-outline" data-close-admin>Mégse</button><button class="button button-dark">${item ? 'Mentés' : 'Létrehozás'} →</button></div></form></section></div>`;
}
function formPayload(form) {
  const payload = {};
  for (const [key, value] of new FormData(form)) payload[key] = value;
  for (const input of form.querySelectorAll('input[type="checkbox"]')) payload[input.name] = input.checked;
  for (const input of form.querySelectorAll('input[type="number"]')) payload[input.name] = input.value === '' ? null : Number(input.value);
  if (payload.password === '') delete payload.password;
  if (payload.age === null) payload.age = '';
  for (const key of ['coordinates', 'members', 'contributions', 'settings', 'friends', 'friendRequests']) {
    if (payload[key] !== undefined) { try { payload[key] = JSON.parse(payload[key] || (key === 'coordinates' ? '{}' : '[]')); } catch { throw new Error(`A(z) ${key} mező érvényes JSON legyen.`); } }
  }
  if (payload.date) payload.date = new Date(payload.date).toISOString();
  for (const key of ['sender', 'party', 'targetUser']) if (payload[key] === '') payload[key] = null;
  if (payload.inviteCode === '') payload.inviteCode = undefined;
  if (payload.inviteRequestStatus === '') payload.inviteRequestStatus = undefined;
  return payload;
}
async function refresh() { await Promise.all([loadStats(), loadRecords()]); }
$('#admin-tabs').addEventListener('click', async event => {
  const button = event.target.closest('[data-admin-tab]'); if (!button) return;
  activeTab = button.dataset.adminTab; searchTerm = ''; currentPage = 1; $('#admin-search').value = '';
  $('#admin-add').classList.toggle('hidden', activeTab === 'verification');
  document.querySelectorAll('[data-admin-tab]').forEach(tab => tab.classList.toggle('active', tab === button));
  await loadRecords();
});
$('#admin-search').addEventListener('input', event => { searchTerm = event.target.value.trim(); currentPage = 1; clearTimeout(searchTimer); searchTimer = setTimeout(loadRecords, 250); });
$('#admin-prev').addEventListener('click', () => { if (currentPage > 1) { currentPage -= 1; loadRecords(); } });
$('#admin-next').addEventListener('click', () => { if (currentPage < pageData.pages) { currentPage += 1; loadRecords(); } });
$('#admin-add').addEventListener('click', () => openEditor());
$('#admin-refresh').addEventListener('click', () => refresh().catch(error => toast(error.message, true)));
$('#admin-logout').addEventListener('click', () => { localStorage.removeItem(tokenKey); location.href = '/'; });
$('#admin-theme-toggle').addEventListener('click', async () => {
  const theme = document.body.classList.contains('dark') ? 'light' : 'dark';
  applyAdminTheme(theme);
  try {
    const response = await fetch('/api/users/me', { method: 'PATCH', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ settings: { theme } }) });
    if (!response.ok) { const data = await response.json().catch(() => ({})); throw new Error(data.message || 'A témabeállítás mentése nem sikerült.'); }
    currentUser.settings = { ...currentUser.settings, theme };
  } catch (error) { toast(error.message, true); }
});
document.addEventListener('click', async event => {
  const close = event.target.closest('[data-close-admin]');
  if (close && (event.target === close || close.matches('button'))) { $('#admin-modal-root').innerHTML = ''; if (verificationPreviewUrl) URL.revokeObjectURL(verificationPreviewUrl); verificationPreviewUrl = null; return; }
  const edit = event.target.closest('[data-edit]');
  if (edit) { openEditor(records.find(item => item._id === edit.dataset.edit)); return; }
  const imageButton = event.target.closest('[data-verification-image]');
  if (imageButton) {
    try {
      const response = await fetch(`/api/admin/verification-requests/${encodeURIComponent(imageButton.dataset.user)}/images/${imageButton.dataset.verificationImage}`, { headers: { Authorization: `Bearer ${token}` } });
      if (!response.ok) { const data = await response.json().catch(() => ({})); throw new Error(data.message || 'A kép betöltése nem sikerült.'); }
      const imageBlob = await response.blob();
      if (!imageBlob.type.startsWith('image/')) throw new Error('A szerver válasza nem képfájl.');
      if (verificationPreviewUrl) URL.revokeObjectURL(verificationPreviewUrl);
      verificationPreviewUrl = URL.createObjectURL(imageBlob);
      const label = imageButton.dataset.verificationImage === 'identity' ? 'Személyi igazolvány' : 'Arckép';
      $('#admin-modal-root').innerHTML = `<div class="modal-backdrop admin-modal" data-close-admin><section class="modal admin-image-modal" role="dialog" aria-modal="true" aria-label="${label}"><div class="modal-head"><h2>${label}</h2><button class="modal-close" type="button" data-close-admin aria-label="Bezárás">×</button></div><img class="admin-image-preview" src="${verificationPreviewUrl}" alt="${label} feltöltött képe"></section></div>`;
    } catch (error) { toast(error.message, true); }
    return;
  }
  const decision = event.target.closest('[data-decision]');
  if (decision) {
    const isApproval = decision.dataset.decision === 'approved';
    if (!window.confirm(isApproval ? 'Jóváhagyod ezt a regisztrációt?' : 'Elutasítod ezt a regisztrációt?')) return;
    try {
      const result = await request(`/verification-requests/${encodeURIComponent(decision.dataset.user)}/decision`, { method: 'POST', body: JSON.stringify({ decision: decision.dataset.decision }) });
      toast(result.message); await loadRecords();
    } catch (error) { toast(error.message, true); }
    return;
  }
  const ban = event.target.closest('[data-ban]');
  if (ban) {
    const isBanned = ban.dataset.banned !== 'true';
    let reason = '';
    if (isBanned) {
      if (!window.confirm('Biztosan kitiltod ezt a felhasználót? A meglévő munkamenetét is letiltjuk.')) return;
      reason = window.prompt('Kitiltás indoka (opcionális):', '') || '';
    } else if (!window.confirm('Feloldod ennek a felhasználónak a kitiltását?')) return;
    try { const result = await request(`/users/${encodeURIComponent(ban.dataset.ban)}/ban`, { method: 'PATCH', body: JSON.stringify({ isBanned, reason }) }); toast(result.message); await refresh(); }
    catch (error) { toast(error.message, true); }
    return;
  }
  const remove = event.target.closest('[data-delete]');
  if (!remove) return;
  const item = records.find(record => record._id === remove.dataset.delete);
  const description = activeTab === 'users' ? `${item?.nickname} (${item?.email})` : item?.title || item?.message || item?.text || 'ezt a rekordot';
  if (!window.confirm(`Biztosan törlöd ${description} adatait? Ez nem vonható vissza.`)) return;
  try {
    const endpoint = activeTab === 'items'
      ? `/items/${encodeURIComponent(remove.dataset.party)}/${encodeURIComponent(remove.dataset.delete)}`
      : `${config[activeTab].endpoint}/${encodeURIComponent(remove.dataset.delete)}`;
    const result = await request(endpoint, { method: 'DELETE' }); toast(result.message || 'Törölve.'); await refresh();
  }
  catch (error) { toast(error.message, true); }
});
document.addEventListener('submit', async event => {
  if (event.target.id !== 'admin-record-form') return;
  event.preventDefault();
  try {
    const form = event.target; const payload = formPayload(form); const id = form.dataset.id;
    const endpoint = activeTab === 'items' && id
      ? `/items/${encodeURIComponent(payload.partyId)}/${encodeURIComponent(id)}`
      : `${config[activeTab].endpoint}${id ? `/${encodeURIComponent(id)}` : ''}`;
    const result = await request(endpoint, { method: id ? 'PATCH' : 'POST', body: JSON.stringify(payload) });
    currentPage = id ? currentPage : 1;
    $('#admin-modal-root').innerHTML = ''; toast(id ? 'A rekord frissítve.' : 'A rekord létrehozva.'); await refresh();
  } catch (error) { toast(error.message, true); }
});
(async () => { try { if (await verifyAccess()) await refresh(); } catch (error) { $('#admin-status').textContent = error.message; } })();
