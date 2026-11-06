const tokenKey = 'KiMitHoz-token';
let token = localStorage.getItem(tokenKey);
let currentUser;
let activeTab = 'users';
let records = [];
let searchTerm = '';
let auditActionFilter = '';
let currentPage = 1;
let pageData = { page: 1, pages: 1, total: 0 };
let searchTimer;
let verificationPreviewUrl;
let verificationZoom = 1;
let editorOptions = { users: [], parties: [] };
let editorOptionsPromise;
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
      field('Ismerősök', 'friends', (item.friends || []).map(idOf), 'lookup-users-multiple', false, 'Ctrl vagy Shift lenyomásával több felhasználót is kijelölhetsz.'),
      field('Függő barátfelkérések', 'friendRequests', (item.friendRequests || []).map(idOf), 'lookup-users-multiple', false, 'Ctrl vagy Shift lenyomásával több felhasználót is kijelölhetsz.'),
      field('Jelszó', 'password', '', 'password', false, 'Szerkesztésnél hagyd üresen, ha nem szeretnéd megváltoztatni.')
    ]
  },
  verification: {
    title: 'Regisztrációk ellenőrzése', endpoint: '/verification-requests', columns: ['Felhasználó', 'Életkor / születési dátum', 'Állapot', 'Dokumentumok', 'Regisztráció'],
    cells: item => [
      `<span class="record-primary">${esc(item.nickname)}</span><span class="record-secondary">@${esc(item.username)} · ${esc(item.email)}</span>`,
      `<span class="record-primary">${esc(item.age)} év</span><span class="record-secondary">Született: ${item.birthDate ? esc(new Intl.DateTimeFormat('hu-HU', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' }).format(new Date(item.birthDate))) : 'Nincs megadva'}</span>`, 'Ellenőrzésre vár',
      `<div class="admin-image-actions"><button type="button" class="admin-image-link" data-verification-image="identity" data-user="${esc(item._id)}" aria-label="Személyi igazolvány megtekintése"><i class="fa-regular fa-id-card" aria-hidden="true"></i><span><strong>Személyi</strong><small>Megtekintés</small></span></button><button type="button" class="admin-image-link" data-verification-image="face" data-user="${esc(item._id)}" aria-label="Arckép megtekintése"><i class="fa-regular fa-image" aria-hidden="true"></i><span><strong>Arckép</strong><small>Megtekintés</small></span></button></div>`,
      dateText(item.createdAt)
    ], fields: () => []
  },
  parties: {
    title: 'Bulik', endpoint: '/parties', columns: ['Esemény', 'Szervező', 'Időpont', 'Láthatóság'],
    cells: item => [`<span class="record-primary">${esc(item.title)}</span><span class="record-secondary">${esc(item.location)}</span>`, esc(labelOf(item.host)), dateText(item.date), item.visibility === 'public' ? 'Nyilvános' : 'Privát'],
    fields: item => [
      field('Buli neve', 'title', item.title, 'text', true), field('Szervező', 'host', idOf(item.host), 'lookup-user', true),
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
    cells: item => [`<span class="record-primary">${esc(item.name)}</span><span class="record-secondary">${esc(item.category)} · ${esc(item.icon || '✳')}</span>`, `<span class="record-primary">${esc(item.partyTitle)}</span>`, esc(labelOf(item.user)), `${esc(item.quantity || '1')} · ${Number(item.price || 0).toLocaleString('hu-HU')} Ft`],
    fields: item => [
      field('Buli', 'partyId', item.partyId, 'lookup-party', true), field('Hozzáadó', 'user', idOf(item.user), 'lookup-user', true),
      field('Tétel neve', 'name', item.name, 'text', true), field('Mennyiség', 'quantity', item.quantity || '1'),
      field('Ár (Ft)', 'price', item.price ?? 0, 'number'), field('Kategória', 'category', item.category || 'egyéb', 'select', true, '', ['étel', 'ital', 'egyéb']),
      field('Ikon vagy kép URL', 'icon', item.icon || '✳')
    ]
  },
  gallery: {
    title: 'Galéria', endpoint: '/gallery', resultKey: 'gallery', readOnly: true, allowDelete: true, noAdd: true,
    columns: ['Kép', 'Buli', 'Feltöltő', 'Feltöltés ideje'],
    cells: item => [`<button type="button" class="admin-gallery-open" data-admin-gallery-open="/gallery/${encodeURIComponent(item.partyId)}/${encodeURIComponent(item._id)}/image" data-gallery-label="${esc(item.partyTitle)} galériaképe" aria-label="${esc(item.partyTitle)} képének megnyitása"><img class="admin-gallery-thumb" data-admin-gallery-image="/gallery/${encodeURIComponent(item.partyId)}/${encodeURIComponent(item._id)}/image" alt="" loading="lazy"></button>`, `<span class="record-primary">${esc(item.partyTitle)}</span>`, esc(labelOf(item.uploadedBy)), dateText(item.uploadedAt)],
    fields: () => []
  },
  notifications: {
    title: 'Értesítések', endpoint: '/notifications', columns: ['Üzenet', 'Címzett', 'Típus', 'Állapot'],
    cells: item => [esc(item.message), esc(labelOf(item.recipient)), esc(item.type), item.read ? 'Olvasott' : 'Olvasatlan'],
    fields: item => [
      field('Címzett', 'recipient', idOf(item.recipient), item._id ? 'lookup-user' : 'lookup-user-or-all', true, item._id ? '' : 'A „Minden felhasználónak” a függő és kitiltott fiókokat is tartalmazza.'), field('Feladó', 'sender', idOf(item.sender), 'lookup-user'),
      field('Buli', 'party', idOf(item.party), 'lookup-party'), field('Célfelhasználó', 'targetUser', idOf(item.targetUser), 'lookup-user'),
      field('Típus', 'type', item.type || 'system', 'select', true, '', ['party-invite', 'party-invite-request', 'friend-request', 'party-mention', 'system']),
      field('Meghívási kérelem állapota', 'inviteRequestStatus', item.inviteRequestStatus || '', 'select', false, '', ['', 'pending', 'accepted', 'declined']),
      field('Üzenet', 'message', item.message, 'textarea', true), field('Olvasott', 'read', Boolean(item.read), 'checkbox')
    ]
  },
  messages: {
    title: 'Chatüzenetek', endpoint: '/messages', columns: ['Üzenet', 'Buli', 'Feladó', 'Létrehozva'],
    cells: item => [esc(item.text), esc(labelOf(item.party)), esc(labelOf(item.sender)), dateText(item.createdAt)],
    fields: item => [field('Buli', 'party', idOf(item.party), 'lookup-party', true), field('Feladó', 'sender', idOf(item.sender), 'lookup-user', true), field('Üzenet', 'text', item.text, 'textarea', true)]
  },
  audit: {
    title: 'Műveleti napló', endpoint: '/audit-logs', resultKey: 'auditLogs', readOnly: true,
    columns: ['Adminisztrátor', 'Művelet', 'Érintett elem', 'Mit csinált?', 'Eredmény', 'Időpont', 'Részletek'],
    cells: item => {
      const resourceLabels = { users: 'Felhasználó', parties: 'Buli', items: 'Tétel', notifications: 'Értesítés', messages: 'Chatüzenet', 'verification-requests': 'Regisztráció' };
      const methodLabels = { POST: 'Létrehozás / döntés', PATCH: 'Módosítás', PUT: 'Módosítás', DELETE: 'Törlés' };
      const actionLabels = { create: 'Létrehozás', update: 'Módosítás', delete: 'Törlés', approve: 'Jóváhagyás', reject: 'Elutasítás', ban: 'Kitiltás', unban: 'Feloldás' };
      const action = item.action || ({ POST: 'create', PATCH: 'update', PUT: 'update', DELETE: 'delete' })[item.method];
      return [`<span class="record-primary">${esc(item.actor?.nickname || item.actor?.username || 'Admin')}</span><span class="record-secondary">${esc(item.actor?.email || '')}</span>`, `<span class="audit-method-badge audit-method-${esc(item.method?.toLowerCase())}">${esc(actionLabels[action] || methodLabels[item.method] || item.method)}</span><span class="record-secondary">${esc(resourceLabels[item.resource] || item.resource)}</span>`, `<span class="record-primary">${esc(item.resourceName || 'Név nem elérhető')}</span>`, `<span class="audit-summary">${esc(item.description || 'A művelet részlete nem érhető el.')}</span>`, `<span class="audit-status-badge">${Number(item.statusCode)} · Sikeres</span>`, dateText(item.createdAt), '<span class="audit-open-hint">Részletek <span aria-hidden="true">→</span></span>'];
    }, fields: () => []
  }
};
function field(label, name, value = '', type = 'text', required = false, help = '', options = []) {
  const span = type === 'textarea' || ['coordinates', 'members', 'contributions', 'message', 'bio', 'description', 'text'].includes(name);
  let input;
  if (type === 'textarea') input = `<textarea name="${name}" ${required ? 'required' : ''}>${esc(value ?? '')}</textarea>`;
  else if (type === 'select') input = `<select name="${name}" ${required ? 'required' : ''}>${options.map(option => `<option value="${esc(option)}" ${String(value) === option ? 'selected' : ''}>${option ? esc(option) : 'Nincs megadva'}</option>`).join('')}</select>`;
  else if (type === 'checkbox') input = `<input name="${name}" type="checkbox" ${value ? 'checked' : ''}>`;
  else if (type === 'lookup-users-multiple') {
    const selectedIds = new Set((Array.isArray(value) ? value : []).map(idOf).map(String));
    input = `<select name="${name}" multiple size="6">${editorOptions.users.map(user => `<option value="${esc(user._id)}" ${selectedIds.has(String(user._id)) ? 'selected' : ''}>${esc(`${user.nickname || user.username} · @${user.username}`)}</option>`).join('')}</select>`;
  }
  else if (type === 'lookup-user' || type === 'lookup-party' || type === 'lookup-user-or-all') {
    const isUser = type !== 'lookup-party';
    const records = editorOptions[isUser ? 'users' : 'parties'];
    const currentId = idOf(value);
    const selectedExists = records.some(record => String(record._id) === String(currentId));
    const currentLabel = isUser ? labelOf(value) : value?.title || '';
    const fallback = currentId && !selectedExists ? `<option value="${esc(currentId)}" selected>${esc(currentLabel || 'Jelenlegi kapcsolat')}</option>` : '';
    const optionsHtml = records.map(record => {
      const optionLabel = isUser
        ? `${record.nickname || record.username} · @${record.username}${record.email ? ` · ${record.email}` : ''}`
        : `${record.title}${record.location ? ` · ${record.location}` : ''}`;
      return `<option value="${esc(record._id)}" ${String(record._id) === String(currentId) ? 'selected' : ''}>${esc(optionLabel)}</option>`;
    }).join('');
    input = `<select name="${name}" ${required ? 'required' : ''}><option value="">${isUser ? 'Felhasználó kiválasztása…' : 'Buli kiválasztása…'}</option>${type === 'lookup-user-or-all' ? '<option value="all">Minden felhasználónak</option>' : ''}${fallback}${optionsHtml}</select>`;
  }
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
  const values = [
    ['Felhasználók', stats.users, 'users'], ['Bulik', stats.parties, 'parties'],
    ['Nyilvános bulik', stats.publicParties, 'parties'], ['Tételek', stats.items, 'items'],
    ['Galériaképek', stats.galleryImages, 'gallery'], ['Értesítések', stats.notifications, 'notifications'],
    ['Chatüzenetek', stats.messages, 'messages']
  ];
  $('#admin-stats').innerHTML = `${values.map(([label, count, tab]) => `<button type="button" class="admin-stat admin-stat-link" data-admin-stat-tab="${tab}" aria-label="${label} kezelése"><strong>${Number(count).toLocaleString('hu-HU')}</strong><span>${label}</span><small>Megnyitás →</small></button>`).join('')}<button type="button" class="admin-stat admin-stat-pending ${stats.pendingVerifications ? 'has-pending' : ''}" data-admin-stat-tab="verification" aria-label="Függő regisztrációk ellenőrzése"><strong>${Number(stats.pendingVerifications).toLocaleString('hu-HU')}</strong><span>Várakozó regisztráció</span><small>${stats.pendingVerifications ? 'Ellenőrzésre vár →' : 'Nincs függő kérelem'}</small></button>`;
}
async function loadRecords() {
  const cfg = config[activeTab];
  $('#admin-status').textContent = 'Adatok betöltése…';
  try {
    const query = new URLSearchParams({ page: currentPage, q: searchTerm });
    if (activeTab === 'audit' && auditActionFilter) query.set('action', auditActionFilter);
    const result = await request(`${cfg.endpoint}?${query}`);
    records = result[cfg.resultKey || activeTab] || result.requests || [];
    pageData = result.pagination || { page: 1, pages: 1, total: records.length };
    if (currentPage > pageData.pages) { currentPage = pageData.pages; return loadRecords(); }
    renderTable();
    $('#admin-status').textContent = `${records.length} rekord megjelenítve a ${pageData.total} találatból`;
  } catch (error) { $('#admin-status').textContent = error.message; }
}
function renderTable() {
  const cfg = config[activeTab];
  $('.admin-table').classList.toggle('admin-audit-table', activeTab === 'audit');
  const actionColumn = cfg.readOnly && !cfg.allowDelete ? '' : '<th>Műveletek</th>';
  $('#admin-thead').innerHTML = `<tr>${cfg.columns.map(column => `<th>${column}</th>`).join('')}${actionColumn}</tr>`;
  $('#admin-tbody').innerHTML = records.length ? records.map((item, index) => `<tr${activeTab === 'audit' ? ` class="admin-audit-row" data-audit-index="${index}" tabindex="0" aria-label="Műveleti naplóbejegyzés részleteinek megnyitása"` : ''}>${cfg.cells(item).map(cell => `<td>${cell}</td>`).join('')}${cfg.readOnly && !cfg.allowDelete ? '' : `<td><div class="admin-row-actions">${cfg.allowDelete ? `<button class="danger" data-delete="${esc(item._id)}" data-party="${esc(item.partyId)}">Törlés</button>` : activeTab === 'verification' ? `<button data-decision="approved" data-user="${esc(item._id)}">Elfogadás</button><button class="danger" data-decision="rejected" data-user="${esc(item._id)}">Elutasítás</button>` : `${activeTab === 'users' && item.role !== 'admin' ? `<button data-ban="${esc(item._id)}" data-banned="${Boolean(item.isBanned)}">${item.isBanned ? 'Feloldás' : 'Kitiltás'}</button>` : ''}<button data-edit="${esc(item._id)}">Szerkesztés</button><button class="danger" data-delete="${esc(item._id)}" ${activeTab === 'items' ? `data-party="${esc(item.partyId)}"` : ''}>Törlés</button>`}</div></td>`}</tr>`).join('') : `<tr><td class="admin-empty" colspan="${cfg.columns.length + (cfg.readOnly && !cfg.allowDelete ? 0 : 1)}">Nincs megjeleníthető rekord.</td></tr>`;
  if (activeTab === 'gallery') loadGalleryPreviews();
  $('#admin-page-info').textContent = `${pageData.total.toLocaleString('hu-HU')} rekord · ${pageData.page}. / ${pageData.pages}. oldal`;
  $('#admin-prev').disabled = pageData.page <= 1;
  $('#admin-next').disabled = pageData.page >= pageData.pages;
}
let galleryPreviewUrls = [];
async function loadGalleryPreviews() {
  galleryPreviewUrls.forEach(URL.revokeObjectURL);
  galleryPreviewUrls = [];
  await Promise.all($$('[data-admin-gallery-image]').map(async image => {
    try {
      const response = await fetch(`/api/admin${image.dataset.adminGalleryImage}`, { headers: { Authorization: `Bearer ${token}` } });
      if (!response.ok) return image.classList.add('admin-gallery-image-error');
      const objectUrl = URL.createObjectURL(await response.blob());
      galleryPreviewUrls.push(objectUrl);
      image.src = objectUrl;
    } catch { image.classList.add('admin-gallery-image-error'); }
  }));
}
async function openEditor(item = null) {
  if (!editorOptionsPromise) {
    editorOptionsPromise = request('/options').then(options => { editorOptions = options; return options; }).catch(error => { editorOptionsPromise = null; throw error; });
  }
  try { await editorOptionsPromise; }
  catch (error) { toast(`A választólisták betöltése nem sikerült: ${error.message}`, true); return; }
  const cfg = config[activeTab];
  const fields = cfg.fields(item || {});
  $('#admin-modal-root').innerHTML = `<div class="modal-backdrop admin-modal" data-close-admin><section class="modal admin-record-modal" role="dialog" aria-modal="true" aria-labelledby="admin-modal-title"><header class="admin-record-header"><div><span class="admin-modal-kicker">ADMINISZTRÁCIÓ · ${esc(cfg.title)}</span><h2 id="admin-modal-title">${item ? 'Rekord szerkesztése' : 'Új rekord létrehozása'}</h2><p>${item ? 'Módosítsd az adatokat, majd mentsd el a változásokat.' : 'Töltsd ki a szükséges mezőket a létrehozáshoz.'}</p></div><button class="modal-close" type="button" data-close-admin aria-label="Ablak bezárása">×</button></header><form id="admin-record-form" data-id="${esc(item?._id || '')}"><div class="admin-form-grid">${fields.join('')}</div><footer class="admin-form-actions"><span class="admin-form-note"><i class="fa-solid fa-lock" aria-hidden="true"></i> A módosítás admin naplóba kerül.</span><div><button type="button" class="button button-outline" data-close-admin>Mégse</button><button class="button button-dark">${item ? 'Változások mentése' : 'Létrehozás'} <span aria-hidden="true">→</span></button></div></footer></form></section></div>`;
  $('input[name="password"]', $('#admin-record-form'))?.setAttribute('autocomplete', 'new-password');
  $('input[name="password"]', $('#admin-record-form'))?.setAttribute('placeholder', 'Csak módosítás esetén töltsd ki');
}
function formPayload(form) {
  const payload = {};
  for (const [key, value] of new FormData(form)) payload[key] = value;
  for (const input of form.querySelectorAll('input[type="checkbox"]')) payload[input.name] = input.checked;
  for (const input of form.querySelectorAll('input[type="number"]')) payload[input.name] = input.value === '' ? null : Number(input.value);
  for (const select of form.querySelectorAll('select[multiple]')) payload[select.name] = [...select.selectedOptions].map(option => option.value);
  if (payload.password === '') delete payload.password;
  if (payload.age === null) payload.age = '';
  for (const key of ['coordinates', 'members', 'contributions', 'settings', 'friends', 'friendRequests']) {
    if (typeof payload[key] === 'string') { try { payload[key] = JSON.parse(payload[key] || (key === 'coordinates' ? '{}' : '[]')); } catch { throw new Error(`A(z) ${key} mező érvényes JSON legyen.`); } }
  }
  if (payload.date) payload.date = new Date(payload.date).toISOString();
  for (const key of ['sender', 'party', 'targetUser']) if (payload[key] === '') payload[key] = null;
  if (payload.inviteCode === '') payload.inviteCode = undefined;
  if (payload.inviteRequestStatus === '') payload.inviteRequestStatus = undefined;
  return payload;
}
function showAuditDetails(item) {
  const methodLabels = { POST: 'Létrehozás / döntés', PATCH: 'Módosítás', PUT: 'Módosítás', DELETE: 'Törlés' };
  const resourceLabels = { users: 'Felhasználó', parties: 'Buli', items: 'Tétel', notifications: 'Értesítés', messages: 'Chatüzenet', 'verification-requests': 'Regisztráció' };
  const actor = item.actor || {};
  const details = [
    ['Naplóbejegyzés azonosítója', item._id],
    ['Adminisztrátor neve', actor.nickname || actor.username || '—'],
    ['Adminisztrátor felhasználóneve', actor.username ? `@${actor.username}` : '—'],
    ['Adminisztrátor e-mail-címe', actor.email || '—'],
    ['Adminisztrátor azonosítója', idOf(actor) || '—'],
    ['Mit csinált az admin?', item.description || 'A művelet részlete nem érhető el.'],
    ['Művelet típusa', item.action || '—'],
    ['Művelet', methodLabels[item.method] || item.method || '—'],
    ['HTTP-metódus', item.method || '—'],
    ['Érintett adattípus', resourceLabels[item.resource] || item.resource || '—'],
    ['Adattípus technikai neve', item.resource || '—'],
    ['Érintett elem neve', item.resourceName || 'Név nem elérhető'],
    ['Érintett elem azonosítója', item.resourceId || '—'],
    ['HTTP-válaszkód', item.statusCode ?? '—'],
    ['Eredmény', Number(item.statusCode) >= 200 && Number(item.statusCode) < 300 ? 'Sikeres' : 'Sikertelen'],
    ['Időpont', item.createdAt ? new Intl.DateTimeFormat('hu-HU', { dateStyle: 'full', timeStyle: 'medium' }).format(new Date(item.createdAt)) : '—'],
    ['Időpont (UTC)', item.createdAt ? new Date(item.createdAt).toISOString() : '—'],
    ['Utoljára módosítva', item.updatedAt ? new Intl.DateTimeFormat('hu-HU', { dateStyle: 'full', timeStyle: 'medium' }).format(new Date(item.updatedAt)) : '—']
  ];
  $('#admin-modal-root').innerHTML = `<div class="modal-backdrop admin-modal" data-close-admin><section class="modal admin-audit-modal" role="dialog" aria-modal="true" aria-labelledby="audit-detail-title"><header class="admin-record-header"><div><span class="admin-modal-kicker">ADMINISZTRÁCIÓ · MŰVELETI NAPLÓ</span><h2 id="audit-detail-title">Művelet részletei</h2><p>${esc(item.resourceName || 'Név nem elérhető')} · ${dateText(item.createdAt)}</p></div><button class="modal-close" type="button" data-close-admin aria-label="Ablak bezárása">×</button></header><dl class="admin-audit-details">${details.map(([label, value]) => `<div class="admin-audit-detail"><dt>${esc(label)}</dt><dd>${esc(value)}</dd></div>`).join('')}</dl><footer class="admin-form-actions"><span class="admin-form-note"><i class="fa-solid fa-circle-info" aria-hidden="true"></i> Ez a naplóbejegyzés nem módosítható.</span><div><button type="button" class="button button-dark" data-close-admin>Bezárás</button></div></footer></section></div>`;
}
async function refresh() { await Promise.all([loadStats(), loadRecords()]); }
$('#admin-tabs').addEventListener('click', async event => {
  const button = event.target.closest('[data-admin-tab]'); if (!button) return;
  activeTab = button.dataset.adminTab; searchTerm = ''; auditActionFilter = ''; currentPage = 1; $('#admin-search').value = ''; $('#admin-audit-filter').value = '';
  $('#admin-audit-filter').classList.toggle('hidden', activeTab !== 'audit');
  $('#admin-add').classList.toggle('hidden', activeTab === 'verification' || config[activeTab].readOnly || config[activeTab].noAdd);
  document.querySelectorAll('[data-admin-tab]').forEach(tab => tab.classList.toggle('active', tab === button));
  await loadRecords();
});
$('#admin-stats').addEventListener('click', event => {
  const button = event.target.closest('[data-admin-stat-tab]');
  if (button) $(`#admin-tabs [data-admin-tab="${button.dataset.adminStatTab}"]`).click();
});
$('#admin-search').addEventListener('input', event => { searchTerm = event.target.value.trim(); currentPage = 1; clearTimeout(searchTimer); searchTimer = setTimeout(loadRecords, 250); });
$('#admin-audit-filter').addEventListener('change', event => { auditActionFilter = event.target.value; currentPage = 1; loadRecords(); });
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
  const zoomButton = event.target.closest('[data-image-zoom]');
  if (zoomButton) {
    verificationZoom = zoomButton.dataset.imageZoom === 'reset'
      ? 1
      : Math.min(4, Math.max(0.5, verificationZoom + (zoomButton.dataset.imageZoom === 'in' ? 0.5 : -0.5)));
    const preview = $('#admin-preview-image');
    preview.style.width = `${verificationZoom * 100}%`;
    $('#admin-zoom-level').textContent = `${Math.round(verificationZoom * 100)}%`;
    return;
  }
  const auditRow = event.target.closest('[data-audit-index]');
  if (auditRow) { showAuditDetails(records[Number(auditRow.dataset.auditIndex)]); return; }
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
      verificationZoom = 1;
      const label = imageButton.dataset.verificationImage === 'identity' ? 'Személyi igazolvány' : 'Arckép';
      $('#admin-modal-root').innerHTML = `<div class="modal-backdrop admin-modal" data-close-admin><section class="modal admin-image-modal" role="dialog" aria-modal="true" aria-label="${label}"><div class="modal-head"><h2>${label}</h2><button class="modal-close" type="button" data-close-admin aria-label="Bezárás">×</button></div><div class="admin-image-tools" aria-label="Nagyítás vezérlői"><button type="button" class="button button-outline button-small" data-image-zoom="out" aria-label="Kicsinyítés">−</button><output id="admin-zoom-level" aria-live="polite">100%</output><button type="button" class="button button-outline button-small" data-image-zoom="in" aria-label="Nagyítás">＋</button><button type="button" class="button button-outline button-small" data-image-zoom="reset">Visszaállítás</button></div><div class="admin-image-viewport"><img id="admin-preview-image" class="admin-image-preview" src="${verificationPreviewUrl}" alt="${label} feltöltött képe" style="width:100%"></div></section></div>`;
    } catch (error) { toast(error.message, true); }
    return;
  }
  const galleryImageButton = event.target.closest('[data-admin-gallery-open]');
  if (galleryImageButton) {
    try {
      const response = await fetch(`/api/admin${galleryImageButton.dataset.adminGalleryOpen}`, { headers: { Authorization: `Bearer ${token}` } });
      if (!response.ok) { const data = await response.json().catch(() => ({})); throw new Error(data.message || 'A kép betöltése nem sikerült.'); }
      const imageBlob = await response.blob();
      if (!imageBlob.type.startsWith('image/')) throw new Error('A szerver válasza nem képfájl.');
      if (verificationPreviewUrl) URL.revokeObjectURL(verificationPreviewUrl);
      verificationPreviewUrl = URL.createObjectURL(imageBlob);
      verificationZoom = 1;
      const label = galleryImageButton.dataset.galleryLabel || 'Galériakép';
      $('#admin-modal-root').innerHTML = `<div class="modal-backdrop admin-modal" data-close-admin><section class="modal admin-image-modal" role="dialog" aria-modal="true" aria-label="${esc(label)}"><div class="modal-head"><h2>${esc(label)}</h2><button class="modal-close" type="button" data-close-admin aria-label="Bezárás">×</button></div><div class="admin-image-tools" aria-label="Nagyítás vezérlői"><button type="button" class="button button-outline button-small" data-image-zoom="out" aria-label="Kicsinyítés">−</button><output id="admin-zoom-level" aria-live="polite">100%</output><button type="button" class="button button-outline button-small" data-image-zoom="in" aria-label="Nagyítás">＋</button><button type="button" class="button button-outline button-small" data-image-zoom="reset">Visszaállítás</button></div><div class="admin-image-viewport"><img id="admin-preview-image" class="admin-image-preview" src="${verificationPreviewUrl}" alt="${esc(label)}" style="width:100%"></div></section></div>`;
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
  const description = activeTab === 'users' ? `${item?.nickname} (${item?.email})` : activeTab === 'gallery' ? `${item?.partyTitle} galériaképét` : item?.title || item?.message || item?.text || 'ezt a rekordot';
  if (!window.confirm(`Biztosan törlöd ${description} adatait? Ez nem vonható vissza.`)) return;
  try {
    const endpoint = activeTab === 'gallery'
      ? `/gallery/${encodeURIComponent(remove.dataset.party)}/${encodeURIComponent(remove.dataset.delete)}`
      : activeTab === 'items'
      ? `/items/${encodeURIComponent(remove.dataset.party)}/${encodeURIComponent(remove.dataset.delete)}`
      : `${config[activeTab].endpoint}/${encodeURIComponent(remove.dataset.delete)}`;
    const result = await request(endpoint, { method: 'DELETE' }); toast(result.message || 'Törölve.'); await refresh();
  }
  catch (error) { toast(error.message, true); }
});
document.addEventListener('keydown', event => {
  const auditRow = event.target.closest('[data-audit-index]');
  if (auditRow && (event.key === 'Enter' || event.key === ' ')) {
    event.preventDefault();
    showAuditDetails(records[Number(auditRow.dataset.auditIndex)]);
  }
});
document.addEventListener('submit', async event => {
  if (event.target.id !== 'admin-record-form') return;
  event.preventDefault();
  try {
    const form = event.target; const payload = formPayload(form); const id = form.dataset.id;
    const broadcast = activeTab === 'notifications' && !id && payload.recipient === 'all';
    if (broadcast && !window.confirm('Az értesítést minden felhasználói fiók megkapja, a függő és kitiltott fiókok is. Biztosan elküldöd?')) return;
    const endpoint = broadcast
      ? '/notifications/broadcast'
      : activeTab === 'items' && id
      ? `/items/${encodeURIComponent(payload.partyId)}/${encodeURIComponent(id)}`
      : `${config[activeTab].endpoint}${id ? `/${encodeURIComponent(id)}` : ''}`;
    const result = await request(endpoint, { method: id ? 'PATCH' : 'POST', body: JSON.stringify(payload) });
    currentPage = id ? currentPage : 1;
    $('#admin-modal-root').innerHTML = ''; toast(broadcast ? result.message : id ? 'A rekord frissítve.' : 'A rekord létrehozva.'); await refresh();
  } catch (error) { toast(error.message, true); }
});
(async () => { try { if (await verifyAccess()) await refresh(); } catch (error) { $('#admin-status').textContent = error.message; } })();
