'use strict';

const STATUS = { pending: 'Pending', in_progress: 'In Progress', hold: 'On Hold', done: 'Done' };
const PRIO = { low: 'Low', medium: 'Medium', high: 'High' };
const ROLE = { admin: 'Admin', owner: 'Project Owner', reviewer: 'Reviewer' };
const MAX_IMG_BYTES = 1_200_000;

const state = { user: null, projects: [], filters: { q: '', status: '', priority: '' } };
const app = document.getElementById('app');
const topbar = document.getElementById('topbar');

// ---------- helpers ----------
function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  let value;
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'value') value = v;
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  for (const c of kids.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  if (value !== undefined) el.value = value;
  return el;
}
function mount(...nodes) { app.replaceChildren(...nodes.flat().filter(Boolean)); }

async function api(path, method = 'GET', body) {
  const res = await fetch('/api' + path, {
    method,
    credentials: 'same-origin',
    headers: body !== undefined ? { 'content-type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let data = {};
  try { data = await res.json(); } catch { /* non-JSON */ }
  if (!res.ok) {
    if (res.status === 401 && state.user && path !== '/login') { state.user = null; route(); }
    throw new Error(data.error || `Request failed (${res.status})`);
  }
  return data;
}
let toastTimer;
function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg; t.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 2500);
}
async function guard(fn) { try { return await fn(); } catch (e) { toast(e.message); } }

const fmtDate = (d) => (d ? new Date(d + 'T00:00:00').toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '—');
const fmtTime = (s) => new Date(s * 1000).toLocaleString();
const todayStr = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const isOverdue = (p) => p.due_date && p.status !== 'done' && p.due_date < todayStr();
const badge = (cls, label) => h('span', { class: 'badge ' + cls }, label);
const statusBadge = (s) => badge(s, STATUS[s]);
const prioBadge = (p) => badge(p, PRIO[p]);
const options = (map, selected) => Object.entries(map).map(([k, v]) => h('option', { value: k, selected: k === selected }, v));
const canCreate = () => state.user && state.user.role !== 'reviewer';

function openDialog(content, cls = '') {
  const dlg = h('dialog', { class: cls }, content);
  dlg.addEventListener('close', () => dlg.remove());
  document.body.append(dlg);
  dlg.showModal();
  return dlg;
}

// ---------- chrome ----------
function renderTopbar() {
  if (!state.user) { topbar.hidden = true; return; }
  topbar.hidden = false;
  const here = location.hash || '#/';
  const link = (href, label) => h('a', { class: 'nav' + (here === href || (href === '#/' && here.startsWith('#/project')) ? ' active' : ''), href }, label);
  topbar.replaceChildren(
    h('span', { class: 'brand' }, '📋 Project Tracker'),
    link('#/', 'Projects'),
    state.user.role === 'admin' ? link('#/users', 'Users') : null,
    h('span', { class: 'muted small' }, `${state.user.display_name || state.user.username} · ${ROLE[state.user.role]}`),
    h('button', { class: 'small', onclick: changePasswordDialog }, 'Change password'),
    h('button', { class: 'small', onclick: async () => { await guard(() => api('/logout', 'POST')); state.user = null; location.hash = '#/'; route(); } }, 'Sign out'),
  );
}

// ---------- login / setup ----------
async function renderLogin() {
  const { needsSetup } = await api('/setup-status');
  const err = h('div', { class: 'error' });
  const user = h('input', { id: 'u', autocomplete: 'username', required: true });
  const pass = h('input', { id: 'p', type: 'password', autocomplete: needsSetup ? 'new-password' : 'current-password', required: true });
  const form = h('form', { class: 'card login', onsubmit: async (e) => {
    e.preventDefault(); err.textContent = '';
    try {
      const r = await api(needsSetup ? '/setup' : '/login', 'POST', { username: user.value, password: pass.value });
      state.user = r.user || (await api('/me')).user;
      location.hash = '#/'; route();
    } catch (ex) { err.textContent = ex.message; }
  } },
    h('h1', null, needsSetup ? 'Create admin account' : 'Sign in'),
    needsSetup ? h('p', { class: 'muted' }, 'First run: this account becomes the administrator. Use a strong password (8+ characters).') : h('p', { class: 'muted' }, 'Project Tracker'),
    h('div', { class: 'field' }, h('label', { for: 'u' }, 'Username'), user),
    h('div', { class: 'field' }, h('label', { for: 'p' }, 'Password'), pass),
    err,
    h('button', { class: 'primary', type: 'submit' }, needsSetup ? 'Create admin' : 'Sign in'),
  );
  mount(form);
}

function changePasswordDialog() {
  const cur = h('input', { type: 'password', autocomplete: 'current-password', required: true });
  const nw = h('input', { type: 'password', autocomplete: 'new-password', required: true, minlength: 8 });
  const err = h('div', { class: 'error' });
  const dlg = openDialog(h('form', { method: 'dialog', onsubmit: async (e) => {
    e.preventDefault(); err.textContent = '';
    try { await api('/change-password', 'POST', { current: cur.value, password: nw.value }); dlg.close(); toast('Password changed'); }
    catch (ex) { err.textContent = ex.message; }
  } },
    h('h2', null, 'Change password'),
    h('div', { class: 'field' }, h('label', null, 'Current password'), cur),
    h('div', { class: 'field' }, h('label', null, 'New password (min 8)'), nw),
    err,
    h('div', { class: 'row' }, h('button', { class: 'primary', type: 'submit' }, 'Save'), h('button', { type: 'button', onclick: () => dlg.close() }, 'Cancel')),
  ));
}

// ---------- project list ----------
async function renderList() {
  const [{ projects }] = await Promise.all([api('/projects')]);
  state.projects = projects;
  const body = h('div');
  const draw = () => {
    const f = state.filters, q = f.q.toLowerCase();
    const rows = state.projects.filter((p) =>
      (!f.status || p.status === f.status) && (!f.priority || p.priority === f.priority) &&
      (!q || p.name.toLowerCase().includes(q) || p.description.toLowerCase().includes(q) || (p.owner_name || '').toLowerCase().includes(q)));
    const count = (s) => state.projects.filter((p) => p.status === s).length;
    body.replaceChildren(
      h('div', { class: 'stats' },
        h('div', { class: 'stat' }, h('b', null, state.projects.length), 'Total'),
        ...Object.keys(STATUS).map((s) => h('div', { class: 'stat' }, h('b', null, count(s)), STATUS[s]))),
      h('div', { class: 'card table-wrap' }, rows.length ? h('table', null,
        h('thead', null, h('tr', null, ['Project', 'Status', 'Priority', 'Start', 'Due', 'Owner', '💬', '🖧'].map((t) => h('th', null, t)))),
        h('tbody', null, rows.map((p) => h('tr', { class: 'click', tabindex: 0, onclick: () => (location.hash = '#/project/' + p.id),
          onkeydown: (e) => { if (e.key === 'Enter') location.hash = '#/project/' + p.id; } },
          h('td', null, h('b', null, p.name)),
          h('td', null, statusBadge(p.status)),
          h('td', null, prioBadge(p.priority)),
          h('td', null, fmtDate(p.start_date)),
          h('td', { class: isOverdue(p) ? 'overdue' : '' }, fmtDate(p.due_date), isOverdue(p) ? ' (overdue)' : ''),
          h('td', null, p.owner_name || '—'),
          h('td', null, p.comment_count),
          h('td', null, p.topology_count),
        ))),
      ) : h('p', { class: 'muted center' }, state.projects.length ? 'No projects match the filters.' : 'No projects yet.')),
    );
  };
  const search = h('input', { class: 'grow', placeholder: 'Search projects…', value: state.filters.q, oninput: (e) => { state.filters.q = e.target.value; draw(); } });
  const fs = h('select', { onchange: (e) => { state.filters.status = e.target.value; draw(); }, value: state.filters.status },
    h('option', { value: '' }, 'All statuses'), options(STATUS));
  const fp = h('select', { onchange: (e) => { state.filters.priority = e.target.value; draw(); }, value: state.filters.priority },
    h('option', { value: '' }, 'All priorities'), options(PRIO));
  draw();
  mount(
    h('div', { class: 'row spread', }, h('h1', null, 'Projects'),
      canCreate() ? h('button', { class: 'primary', onclick: () => projectDialog() }, '+ New project') : null),
    h('div', { class: 'row card' }, search, fs, fp),
    body,
  );
}

async function projectDialog(project) {
  const editing = !!project;
  let owners = [];
  if (state.user.role === 'admin') {
    owners = (await api('/users')).users.filter((u) => u.role !== 'reviewer');
  }
  const f = {
    name: h('input', { required: true, maxlength: 120, value: project?.name || '' }),
    description: h('textarea', { maxlength: 5000, value: project?.description || '' }),
    status: h('select', { value: project?.status || 'pending' }, options(STATUS)),
    priority: h('select', { value: project?.priority || 'medium' }, options(PRIO)),
    start: h('input', { type: 'date', value: project?.start_date || '' }),
    due: h('input', { type: 'date', value: project?.due_date || '' }),
    owner: owners.length ? h('select', { value: project?.owner_id || state.user.id },
      owners.map((u) => h('option', { value: u.id }, `${u.display_name || u.username} (${ROLE[u.role]})`))) : null,
  };
  const err = h('div', { class: 'error' });
  const field = (label, el) => h('div', { class: 'field' }, h('label', null, label), el);
  const dlg = openDialog(h('form', { method: 'dialog', onsubmit: async (e) => {
    e.preventDefault(); err.textContent = '';
    const payload = { name: f.name.value, description: f.description.value, status: f.status.value, priority: f.priority.value,
      start_date: f.start.value, due_date: f.due.value };
    if (f.owner) payload.owner_id = Number(f.owner.value);
    try {
      if (editing) await api('/projects/' + project.id, 'PUT', payload);
      else { const r = await api('/projects', 'POST', payload); location.hash = '#/project/' + r.id; }
      dlg.close(); toast('Saved'); route();
    } catch (ex) { err.textContent = ex.message; }
  } },
    h('h2', null, editing ? 'Edit project' : 'New project'),
    field('Name', f.name), field('Description', f.description),
    h('div', { class: 'fields' }, field('Status', f.status), field('Priority', f.priority), field('Start date', f.start), field('Due date', f.due),
      f.owner ? field('Owner', f.owner) : null),
    err,
    h('div', { class: 'row' }, h('button', { class: 'primary', type: 'submit' }, 'Save'), h('button', { type: 'button', onclick: () => dlg.close() }, 'Cancel')),
  ));
}

// ---------- project detail (used for signed-in and shared views) ----------
// ctx: { token } for shared view, or {} for signed-in view
async function renderDetail(id, ctx = {}) {
  const shared = !!ctx.token;
  const data = await api(shared ? '/shared/' + ctx.token : '/projects/' + id);
  const { project: p, topologies, comments, perms } = data;
  const base = shared ? `/shared/${ctx.token}` : `/projects/${p.id}`;
  const imgUrl = (t) => `/api/topologies/${t.id}` + (shared ? `?t=${ctx.token}` : '');
  const reload = () => route();

  const quick = (field, map, cur) => h('select', { class: 'small', 'aria-label': field, value: cur,
    onchange: (e) => guard(async () => { await api(base, 'PUT', { [field]: e.target.value }); toast('Updated'); reload(); }) }, options(map));

  const shareBox = h('div');
  const drawShare = (token) => {
    shareBox.replaceChildren();
    if (!perms.canEdit || shared) return;
    const link = token ? `${location.origin}/#/share/${token}` : null;
    shareBox.append(
      h('h2', null, 'Share with a 3rd person'),
      h('p', { class: 'muted small' }, 'Anyone with the link can view this project and add comments, but cannot change anything. No account needed.'),
      h('div', { class: 'row' },
        h('button', { onclick: () => guard(async () => { const r = await api(base + '/share', 'POST'); drawShare(r.share_token); }) }, token ? 'Regenerate link' : 'Create share link'),
        token ? h('button', { onclick: () => guard(async () => { await navigator.clipboard.writeText(link); toast('Link copied'); }) }, 'Copy link') : null,
        token ? h('button', { class: 'danger', onclick: () => guard(async () => { await api(base + '/share', 'DELETE'); drawShare(null); toast('Sharing disabled'); }) }, 'Disable') : null),
      token ? h('div', { class: 'sharebox' }, link) : null);
  };
  drawShare(p.share_token);

  // topologies
  const fileInput = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/gif,image/webp', multiple: true, onchange: async (e) => {
    for (const file of e.target.files) {
      await guard(async () => {
        const { mime, data: b64 } = await prepareImage(file);
        await api(base + '/topologies', 'POST', { name: file.name, mime, data: b64 });
        toast('Uploaded ' + file.name);
      });
    }
    reload();
  } });
  const gallery = topologies.length ? h('div', { class: 'gallery' }, topologies.map((t) => h('div', { class: 'topo' },
    h('img', { src: imgUrl(t), alt: t.name, loading: 'lazy', onclick: () => lightbox(imgUrl(t), t.name) }),
    h('div', { class: 'cap' }, h('span', { title: t.name }, t.name),
      perms.canEdit ? h('button', { class: 'small danger', onclick: () => confirm('Delete this topology?') && guard(async () => { await api('/topologies/' + t.id, 'DELETE'); reload(); }) }, 'Delete') : null),
  ))) : h('p', { class: 'muted' }, 'No topologies uploaded.');

  // comments
  const guestName = h('input', { placeholder: 'Your name', maxlength: 50, value: safeGet('guestName') || '', required: true });
  const text = h('textarea', { placeholder: 'Add a comment…', maxlength: 2000, required: true });
  const commentForm = h('form', { onsubmit: (e) => {
    e.preventDefault();
    guard(async () => {
      const payload = { body: text.value };
      if (shared) { payload.author = guestName.value; safeSet('guestName', guestName.value); }
      await api(base + '/comments', 'POST', payload);
      reload();
    });
  } },
    shared ? h('div', { class: 'field' }, guestName) : null,
    h('div', { class: 'field' }, text),
    h('button', { class: 'primary', type: 'submit' }, 'Post comment'));

  mount(
    shared ? h('div', { class: 'banner' }, '👁 You are viewing a read-only shared project. You can add comments below.') : h('a', { href: '#/' }, '← All projects'),
    h('div', { class: 'card' },
      h('div', { class: 'row spread' }, h('h1', null, p.name),
        perms.canEdit ? h('div', { class: 'row' },
          h('button', { onclick: () => projectDialog(p) }, 'Edit'),
          h('button', { class: 'danger', onclick: () => confirm(`Delete "${p.name}" and all its comments and topologies?`) && guard(async () => { await api(base, 'DELETE'); location.hash = '#/'; toast('Deleted'); }) }, 'Delete')) : null),
      h('div', { class: 'meta' },
        h('div', null, h('span', null, 'Status'), perms.canEdit ? quick('status', STATUS, p.status) : statusBadge(p.status)),
        h('div', null, h('span', null, 'Priority'), perms.canEdit ? quick('priority', PRIO, p.priority) : prioBadge(p.priority)),
        h('div', null, h('span', null, 'Start date'), fmtDate(p.start_date)),
        h('div', { class: isOverdue(p) ? 'overdue' : '' }, h('span', null, 'Due date'), fmtDate(p.due_date), isOverdue(p) ? ' (overdue)' : ''),
        h('div', null, h('span', null, 'Owner'), p.owner_name || '—')),
      p.description ? h('p', { class: 'desc' }, p.description) : h('p', { class: 'muted' }, 'No description.')),
    h('div', { class: 'card' }, h('div', { class: 'row spread' }, h('h2', null, `Topologies (${topologies.length})`),
      perms.canEdit ? h('div', null, fileInput) : null), gallery),
    h('div', { class: 'card' }, shareBox),
    h('div', { class: 'card' }, h('h2', null, `Comments (${comments.length})`),
      comments.length ? comments.map((c) => h('div', { class: 'comment' },
        h('div', { class: 'row spread' },
          h('div', null, h('span', { class: 'who' }, c.author), c.is_guest ? ' ' : null, c.is_guest ? badge('role', 'guest') : null, ' ', h('span', { class: 'muted small' }, fmtTime(c.created_at))),
          !shared && (perms.isAdmin || c.user_id === perms.userId) ? h('button', { class: 'small danger', onclick: () => guard(async () => { await api('/comments/' + c.id, 'DELETE'); reload(); }) }, 'Delete') : null),
        h('div', { class: 'body' }, c.body))) : h('p', { class: 'muted' }, 'No comments yet.'),
      commentForm),
  );
  if (shared) topbar.hidden = true;
}

function lightbox(src, name) {
  const img = h('img', { src, alt: name, onclick: () => img.classList.toggle('zoom') });
  const dlg = openDialog(h('div', null,
    h('div', { class: 'row spread' }, h('b', null, name), h('button', { onclick: () => dlg.close() }, 'Close')),
    h('p', { class: 'muted small' }, 'Click the image to toggle full size.'),
    h('div', { class: 'scroll' }, img)), 'wide');
}

function safeGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
function safeSet(k, v) { try { localStorage.setItem(k, v); } catch { /* ignore */ } }

// Read image; downscale/re-encode as JPEG if it is too big for storage
async function prepareImage(file) {
  const allowed = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
  if (!allowed.includes(file.type)) throw new Error('Only PNG, JPEG, GIF or WebP images are supported');
  if (file.size <= MAX_IMG_BYTES) return { mime: file.type, data: await blobToB64(file) };
  const bmp = await createImageBitmap(file);
  let scale = Math.min(1, 2200 / Math.max(bmp.width, bmp.height));
  for (let i = 0; i < 6; i++) {
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(bmp.width * scale)); c.height = Math.max(1, Math.round(bmp.height * scale));
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
    ctx.drawImage(bmp, 0, 0, c.width, c.height);
    const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.85));
    if (blob && blob.size <= MAX_IMG_BYTES) return { mime: 'image/jpeg', data: await blobToB64(blob) };
    scale *= 0.75;
  }
  throw new Error('Image is too large even after compression');
}
function blobToB64(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1]);
    r.onerror = () => reject(new Error('Could not read file'));
    r.readAsDataURL(blob);
  });
}

// ---------- users (admin) ----------
async function renderUsers() {
  if (state.user.role !== 'admin') { location.hash = '#/'; return; }
  const { users } = await api('/users');
  const nu = h('input', { required: true, placeholder: 'username', autocomplete: 'off' });
  const nn = h('input', { placeholder: 'display name', autocomplete: 'off' });
  const np = h('input', { type: 'password', required: true, placeholder: 'password (min 8)', minlength: 8, autocomplete: 'new-password' });
  const nr = h('select', { value: 'owner' }, options(ROLE, 'owner'));
  const err = h('div', { class: 'error' });
  mount(
    h('h1', null, 'Users'),
    h('form', { class: 'card', onsubmit: async (e) => {
      e.preventDefault(); err.textContent = '';
      try { await api('/users', 'POST', { username: nu.value, display_name: nn.value, password: np.value, role: nr.value }); toast('User added'); route(); }
      catch (ex) { err.textContent = ex.message; }
    } }, h('h2', null, 'Add user'), h('div', { class: 'row' }, nu, nn, np, nr, h('button', { class: 'primary', type: 'submit' }, 'Add')), err),
    h('div', { class: 'card table-wrap' }, h('table', null,
      h('thead', null, h('tr', null, ['Username', 'Name', 'Role', 'Actions'].map((t) => h('th', null, t)))),
      h('tbody', null, users.map((u) => h('tr', null,
        h('td', null, h('b', null, u.username), u.id === state.user.id ? ' (you)' : ''),
        h('td', null, u.display_name),
        h('td', null, h('select', { 'aria-label': 'Role', value: u.role, onchange: (e) => guard(async () => { await api('/users/' + u.id, 'PUT', { role: e.target.value }); toast('Role updated'); route(); }) }, options(ROLE))),
        h('td', { class: 'row' },
          h('button', { class: 'small', onclick: () => { const pw = prompt(`New password for ${u.username} (min 8 characters):`); if (pw) guard(async () => { await api('/users/' + u.id, 'PUT', { password: pw }); toast('Password reset'); }); } }, 'Reset password'),
          h('button', { class: 'small danger', disabled: u.id === state.user.id, onclick: () => confirm(`Delete user ${u.username}?`) && guard(async () => { await api('/users/' + u.id, 'DELETE'); toast('User deleted'); route(); }) }, 'Delete')),
      )))),
    ),
  );
}

// ---------- router ----------
async function route() {
  try {
    const hash = location.hash || '#/';
    const share = hash.match(/^#\/share\/([a-f0-9]+)$/);
    if (share) { state.user = state.user || null; topbar.hidden = true; await renderDetail(null, { token: share[1] }); return; }

    if (state.user === null || state.user === undefined || !state.user.id) {
      state.user = (await api('/me')).user;
    }
    renderTopbar();
    if (!state.user) { await renderLogin(); return; }
    const proj = hash.match(/^#\/project\/(\d+)$/);
    if (proj) await renderDetail(Number(proj[1]));
    else if (hash === '#/users') await renderUsers();
    else await renderList();
    renderTopbar();
  } catch (e) {
    mount(h('div', { class: 'card' }, h('h2', null, 'Something went wrong'), h('p', null, e.message), h('a', { href: '#/' }, 'Back to projects')));
  }
}
window.addEventListener('hashchange', route);
route();
