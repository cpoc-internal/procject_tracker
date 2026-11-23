'use strict';

const STATUS = { pending: 'Pending', in_progress: 'In Progress', hold: 'On Hold', done: 'Done' };
const PRIO = { low: 'Low', medium: 'Medium', high: 'High' };
const ROLE = { admin: 'Admin', owner: 'Project Owner', reviewer: 'Reviewer' };
const MAX_IMG_BYTES = 4_000_000;
const MAX_TOPOLOGIES = 20;
const EMAIL_DOMAIN = 'tracker.example.com';

const state = { user: undefined, filters: { q: '', status: '', priority: '' } };
const app = document.getElementById('app');
const topbar = document.getElementById('topbar');

// =====================================================================
// Data layer (Supabase). Security is enforced by the database rules in supabase-setup.sql.
// =====================================================================
const cfg = window.APP_CONFIG || {};
const configured = cfg.SUPABASE_URL && !cfg.SUPABASE_URL.includes('YOUR-PROJECT') && cfg.SUPABASE_ANON_KEY && !cfg.SUPABASE_ANON_KEY.includes('YOUR-ANON');
const sb = configured ? window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY) : null;

function unwrap({ data, error }) {
  if (error) throw new Error(error.message || 'Request failed');
  return data;
}
const toEmail = (u) => u.trim().toLowerCase() + '@' + EMAIL_DOMAIN;
const topoUrl = (path) => sb.storage.from('topologies').getPublicUrl(path).data.publicUrl;
const ownerName = (o) => (o ? o.display_name || o.username : '');
const normProject = (r) => ({
  ...r,
  start_date: r.start_date || '',
  due_date: r.due_date || '',
  owner_name: r.owner_name !== undefined ? r.owner_name : ownerName(r.owner),
});
const randomHex = (n) => [...crypto.getRandomValues(new Uint8Array(n))].map((x) => x.toString(16).padStart(2, '0')).join('');

const D = {
  async profile() {
    const { data: { session } } = await sb.auth.getSession();
    if (!session) return null;
    const { data, error } = await sb.from('profiles').select('id,username,display_name,role').eq('id', session.user.id).maybeSingle();
    if (error) throw new Error('Could not read your profile: ' + error.message);
    return data;
  },
  async login(username, password) {
    const { error } = await sb.auth.signInWithPassword({ email: toEmail(username), password });
    if (error) throw new Error(/invalid login credentials/i.test(error.message) ? 'Invalid username or password' : error.message);
    const me = await D.profile();
    if (!me) { await sb.auth.signOut(); throw new Error('This account has no access. Ask an admin.'); }
    return me;
  },
  logout: () => sb.auth.signOut(),
  async changePassword(current, next) {
    if (next.length < 8) throw new Error('Password must be at least 8 characters');
    const { error } = await sb.auth.signInWithPassword({ email: toEmail(state.user.username), password: current });
    if (error) throw new Error('Current password is incorrect');
    unwrap(await sb.auth.updateUser({ password: next }));
  },

  async projects() {
    const rows = unwrap(await sb.from('projects')
      .select('*, owner:profiles(username,display_name), comments(count), topologies(count)')
      .order('created_at', { ascending: false }));
    return rows.map((r) => ({ ...normProject(r), comment_count: r.comments?.[0]?.count ?? 0, topology_count: r.topologies?.[0]?.count ?? 0 }));
  },
  async project(id) {
    const [p, t, c] = await Promise.all([
      sb.from('projects').select('*, owner:profiles(username,display_name)').eq('id', id).maybeSingle(),
      sb.from('topologies').select('*').eq('project_id', id).order('id'),
      sb.from('comments').select('*').eq('project_id', id).order('id'),
    ]);
    const project = unwrap(p);
    if (!project) throw new Error('Project not found');
    const me = state.user;
    return {
      project: normProject(project), topologies: unwrap(t), comments: unwrap(c),
      perms: { canEdit: me.role === 'admin' || (me.role === 'owner' && project.owner_id === me.id), userId: me.id, isAdmin: me.role === 'admin' },
      topoUrl,
    };
  },
  async shared(token) {
    const res = unwrap(await sb.rpc('shared_project', { p_token: token }));
    if (!res) throw new Error('This link is invalid or has been disabled');
    return { project: normProject(res.project), topologies: res.topologies, comments: res.comments, perms: { canEdit: false }, topoUrl };
  },
  async createProject(f) {
    const row = { ...f, owner_id: f.owner_id || state.user.id };
    return unwrap(await sb.from('projects').insert(row).select('id').single()).id;
  },
  async updateProject(id, patch) {
    const res = await sb.from('projects').update(patch).eq('id', id).select('id');
    const rows = unwrap(res);
    if (!rows.length) throw new Error('Not allowed');
  },
  async deleteProject(id) {
    const topos = unwrap(await sb.from('topologies').select('path').eq('project_id', id));
    if (topos.length) await sb.storage.from('topologies').remove(topos.map((t) => t.path));
    unwrap(await sb.from('projects').delete().eq('id', id));
  },
  async setShare(id, enabled) {
    const token = enabled ? randomHex(24) : null;
    await D.updateProject(id, { share_token: token });
    return token;
  },
  async uploadTopology(projectId, file, count) {
    if (count >= MAX_TOPOLOGIES) throw new Error(`Maximum of ${MAX_TOPOLOGIES} topologies per project`);
    const { blob, mime } = await prepareImage(file);
    const ext = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' }[mime];
    const path = `${projectId}/${crypto.randomUUID()}.${ext}`;
    const up = await sb.storage.from('topologies').upload(path, blob, { contentType: mime, upsert: false });
    if (up.error) throw new Error(up.error.message);
    const ins = await sb.from('topologies').insert({ project_id: projectId, name: file.name.slice(0, 120), path, mime, size: blob.size, uploaded_by: state.user.id });
    if (ins.error) { await sb.storage.from('topologies').remove([path]); throw new Error(ins.error.message); }
  },
  async deleteTopology(t) {
    unwrap(await sb.from('topologies').delete().eq('id', t.id));
    await sb.storage.from('topologies').remove([t.path]);
  },
  async addComment(projectId, body) {
    unwrap(await sb.from('comments').insert({ project_id: projectId, user_id: state.user.id, author: state.user.display_name || state.user.username, body, is_guest: false }));
  },
  async addGuestComment(token, author, body) {
    unwrap(await sb.rpc('shared_add_comment', { p_token: token, p_author: author, p_body: body }));
  },
  async deleteComment(id) { unwrap(await sb.from('comments').delete().eq('id', id)); },

  async users() { return unwrap(await sb.from('profiles').select('id,username,display_name,role,created_at').order('username')); },
  async createUser(u) {
    unwrap(await sb.rpc('admin_create_user', { p_username: u.username, p_display: u.display_name, p_password: u.password, p_role: u.role }));
  },
  async updateUser(id, patch) {
    unwrap(await sb.rpc('admin_update_user', { p_id: id, p_role: patch.role ?? null, p_display: patch.display_name ?? null, p_password: patch.password ?? null }));
  },
  async deleteUser(id) { unwrap(await sb.rpc('admin_delete_user', { p_id: id })); },
};

// =====================================================================
// UI helpers
// =====================================================================
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

let toastTimer;
function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg; t.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 2500);
}
async function guard(fn) { try { return await fn(); } catch (e) { toast(e.message); } }

const fmtDate = (d) => (d ? new Date(d + 'T00:00:00').toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '—');
const fmtTime = (s) => new Date(s).toLocaleString();
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
function safeGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
function safeSet(k, v) { try { localStorage.setItem(k, v); } catch { /* ignore */ } }

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
    h('button', { class: 'small', onclick: async () => { await guard(() => D.logout()); state.user = null; location.hash = '#/'; route(); } }, 'Sign out'),
  );
}

// =====================================================================
// Login
// =====================================================================
function renderLogin() {
  const err = h('div', { class: 'error' });
  const user = h('input', { id: 'u', autocomplete: 'username', required: true });
  const pass = h('input', { id: 'p', type: 'password', autocomplete: 'current-password', required: true });
  mount(h('form', { class: 'card login', onsubmit: async (e) => {
    e.preventDefault(); err.textContent = '';
    try { state.user = await D.login(user.value, pass.value); location.hash = '#/'; route(); }
    catch (ex) { err.textContent = ex.message; }
  } },
    h('h1', null, 'Sign in'),
    h('p', { class: 'muted' }, 'Project Tracker'),
    h('div', { class: 'field' }, h('label', { for: 'u' }, 'Username'), user),
    h('div', { class: 'field' }, h('label', { for: 'p' }, 'Password'), pass),
    err,
    h('button', { class: 'primary', type: 'submit' }, 'Sign in'),
  ));
}

function changePasswordDialog() {
  const cur = h('input', { type: 'password', autocomplete: 'current-password', required: true });
  const nw = h('input', { type: 'password', autocomplete: 'new-password', required: true, minlength: 8 });
  const err = h('div', { class: 'error' });
  const dlg = openDialog(h('form', { method: 'dialog', onsubmit: async (e) => {
    e.preventDefault(); err.textContent = '';
    try { await D.changePassword(cur.value, nw.value); dlg.close(); toast('Password changed'); }
    catch (ex) { err.textContent = ex.message; }
  } },
    h('h2', null, 'Change password'),
    h('div', { class: 'field' }, h('label', null, 'Current password'), cur),
    h('div', { class: 'field' }, h('label', null, 'New password (min 8)'), nw),
    err,
    h('div', { class: 'row' }, h('button', { class: 'primary', type: 'submit' }, 'Save'), h('button', { type: 'button', onclick: () => dlg.close() }, 'Cancel')),
  ));
}

// =====================================================================
// Project list
// =====================================================================
async function renderList() {
  const projects = await D.projects();
  const body = h('div');
  const draw = () => {
    const f = state.filters, q = f.q.toLowerCase();
    const rows = projects.filter((p) =>
      (!f.status || p.status === f.status) && (!f.priority || p.priority === f.priority) &&
      (!q || p.name.toLowerCase().includes(q) || p.description.toLowerCase().includes(q) || (p.owner_name || '').toLowerCase().includes(q)));
    const count = (s) => projects.filter((p) => p.status === s).length;
    body.replaceChildren(
      h('div', { class: 'stats' },
        h('div', { class: 'stat' }, h('b', null, projects.length), 'Total'),
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
      ) : h('p', { class: 'muted center' }, projects.length ? 'No projects match the filters.' : 'No projects yet.')),
    );
  };
  const search = h('input', { class: 'grow', placeholder: 'Search projects…', value: state.filters.q, oninput: (e) => { state.filters.q = e.target.value; draw(); } });
  const fs = h('select', { onchange: (e) => { state.filters.status = e.target.value; draw(); }, value: state.filters.status },
    h('option', { value: '' }, 'All statuses'), options(STATUS));
  const fp = h('select', { onchange: (e) => { state.filters.priority = e.target.value; draw(); }, value: state.filters.priority },
    h('option', { value: '' }, 'All priorities'), options(PRIO));
  draw();
  mount(
    h('div', { class: 'row spread' }, h('h1', null, 'Projects'),
      canCreate() ? h('button', { class: 'primary', onclick: () => projectDialog() }, '+ New project') : null),
    h('div', { class: 'row card' }, search, fs, fp),
    body,
  );
}

async function projectDialog(project) {
  const editing = !!project;
  let owners = [];
  if (state.user.role === 'admin') owners = (await D.users()).filter((u) => u.role !== 'reviewer');
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
    const payload = { name: f.name.value.trim(), description: f.description.value.trim(), status: f.status.value, priority: f.priority.value,
      start_date: f.start.value || null, due_date: f.due.value || null };
    if (payload.start_date && payload.due_date && payload.due_date < payload.start_date) { err.textContent = 'Due date cannot be before start date'; return; }
    if (f.owner) payload.owner_id = f.owner.value;
    try {
      if (editing) await D.updateProject(project.id, payload);
      else location.hash = '#/project/' + (await D.createProject(payload));
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

// =====================================================================
// Project detail (signed-in view and public shared view)
// =====================================================================
async function renderDetail(id, ctx = {}) {
  const shared = !!ctx.token;
  const data = shared ? await D.shared(ctx.token) : await D.project(id);
  const { project: p, topologies, comments, perms } = data;
  const reload = () => route();

  const quick = (field, map, cur) => h('select', { class: 'small', 'aria-label': field, value: cur,
    onchange: (e) => guard(async () => { await D.updateProject(p.id, { [field]: e.target.value }); toast('Updated'); reload(); }) }, options(map));

  // share panel (editors only)
  const shareBox = h('div');
  const drawShare = (token) => {
    shareBox.replaceChildren();
    if (!perms.canEdit || shared) return;
    const link = token ? `${location.origin}${location.pathname}#/share/${token}` : null;
    shareBox.append(
      h('h2', null, 'Share with a 3rd person'),
      h('p', { class: 'muted small' }, 'Anyone with the link can view this project and add comments, but cannot change anything. No account needed.'),
      h('div', { class: 'row' },
        h('button', { onclick: () => guard(async () => { drawShare(await D.setShare(p.id, true)); }) }, token ? 'Regenerate link' : 'Create share link'),
        token ? h('button', { onclick: () => guard(async () => { await navigator.clipboard.writeText(link); toast('Link copied'); }) }, 'Copy link') : null,
        token ? h('button', { class: 'danger', onclick: () => guard(async () => { await D.setShare(p.id, false); drawShare(null); toast('Sharing disabled'); }) }, 'Disable') : null),
      token ? h('div', { class: 'sharebox' }, link) : null);
  };
  drawShare(p.share_token);

  // topologies
  const fileInput = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/gif,image/webp', multiple: true, onchange: async (e) => {
    let n = topologies.length;
    for (const file of e.target.files) {
      await guard(async () => { await D.uploadTopology(p.id, file, n); n++; toast('Uploaded ' + file.name); });
    }
    reload();
  } });
  const gallery = topologies.length ? h('div', { class: 'gallery' }, topologies.map((t) => {
    const src = data.topoUrl(t.path);
    return h('div', { class: 'topo' },
      h('img', { src, alt: t.name, loading: 'lazy', onclick: () => lightbox(src, t.name) }),
      h('div', { class: 'cap' }, h('span', { title: t.name }, t.name),
        perms.canEdit ? h('button', { class: 'small danger', onclick: () => confirm('Delete this topology?') && guard(async () => { await D.deleteTopology(t); reload(); }) }, 'Delete') : null));
  })) : h('p', { class: 'muted' }, 'No topologies uploaded.');

  // comments
  const guestName = h('input', { placeholder: 'Your name', maxlength: 50, value: safeGet('guestName') || '', required: true });
  const text = h('textarea', { placeholder: 'Add a comment…', maxlength: 2000, required: true });
  const commentForm = h('form', { onsubmit: (e) => {
    e.preventDefault();
    guard(async () => {
      if (shared) { safeSet('guestName', guestName.value); await D.addGuestComment(ctx.token, guestName.value, text.value); }
      else await D.addComment(p.id, text.value.trim());
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
          h('button', { class: 'danger', onclick: () => confirm(`Delete "${p.name}" and all its comments and topologies?`) && guard(async () => { await D.deleteProject(p.id); location.hash = '#/'; toast('Deleted'); }) }, 'Delete')) : null),
      h('div', { class: 'meta' },
        h('div', null, h('span', null, 'Status'), perms.canEdit ? quick('status', STATUS, p.status) : statusBadge(p.status)),
        h('div', null, h('span', null, 'Priority'), perms.canEdit ? quick('priority', PRIO, p.priority) : prioBadge(p.priority)),
        h('div', null, h('span', null, 'Start date'), fmtDate(p.start_date)),
        h('div', { class: isOverdue(p) ? 'overdue' : '' }, h('span', null, 'Due date'), fmtDate(p.due_date), isOverdue(p) ? ' (overdue)' : ''),
        h('div', null, h('span', null, 'Owner'), p.owner_name || '—')),
      p.description ? h('p', { class: 'desc' }, p.description) : h('p', { class: 'muted' }, 'No description.')),
    h('div', { class: 'card' }, h('div', { class: 'row spread' }, h('h2', null, `Topologies (${topologies.length})`),
      perms.canEdit ? h('div', null, fileInput) : null), gallery),
    perms.canEdit && !shared ? h('div', { class: 'card' }, shareBox) : null,
    h('div', { class: 'card' }, h('h2', null, `Comments (${comments.length})`),
      comments.length ? comments.map((c) => h('div', { class: 'comment' },
        h('div', { class: 'row spread' },
          h('div', null, h('span', { class: 'who' }, c.author), c.is_guest ? ' ' : null, c.is_guest ? badge('role', 'guest') : null, ' ', h('span', { class: 'muted small' }, fmtTime(c.created_at))),
          !shared && (perms.isAdmin || c.user_id === perms.userId) ? h('button', { class: 'small danger', onclick: () => guard(async () => { await D.deleteComment(c.id); reload(); }) }, 'Delete') : null),
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

// Downscale / re-encode big images as JPEG so uploads stay small
async function prepareImage(file) {
  const allowed = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
  if (!allowed.includes(file.type)) throw new Error('Only PNG, JPEG, GIF or WebP images are supported');
  if (file.size <= MAX_IMG_BYTES) return { blob: file, mime: file.type };
  const bmp = await createImageBitmap(file);
  let scale = Math.min(1, 3000 / Math.max(bmp.width, bmp.height));
  for (let i = 0; i < 6; i++) {
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(bmp.width * scale)); c.height = Math.max(1, Math.round(bmp.height * scale));
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
    ctx.drawImage(bmp, 0, 0, c.width, c.height);
    const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.85));
    if (blob && blob.size <= MAX_IMG_BYTES) return { blob, mime: 'image/jpeg' };
    scale *= 0.75;
  }
  throw new Error('Image is too large even after compression');
}

// =====================================================================
// Users (admin)
// =====================================================================
async function renderUsers() {
  if (state.user.role !== 'admin') { location.hash = '#/'; return; }
  const users = await D.users();
  const nu = h('input', { required: true, placeholder: 'username', autocomplete: 'off' });
  const nn = h('input', { placeholder: 'display name', autocomplete: 'off' });
  const np = h('input', { type: 'password', required: true, placeholder: 'password (min 8)', minlength: 8, autocomplete: 'new-password' });
  const nr = h('select', { value: 'owner' }, options(ROLE, 'owner'));
  const err = h('div', { class: 'error' });
  mount(
    h('h1', null, 'Users'),
    h('form', { class: 'card', onsubmit: async (e) => {
      e.preventDefault(); err.textContent = '';
      try { await D.createUser({ username: nu.value.trim(), display_name: nn.value, password: np.value, role: nr.value }); toast('User added'); route(); }
      catch (ex) { err.textContent = ex.message; }
    } }, h('h2', null, 'Add user'), h('div', { class: 'row' }, nu, nn, np, nr, h('button', { class: 'primary', type: 'submit' }, 'Add')), err),
    h('div', { class: 'card table-wrap' }, h('table', null,
      h('thead', null, h('tr', null, ['Username', 'Name', 'Role', 'Actions'].map((t) => h('th', null, t)))),
      h('tbody', null, users.map((u) => h('tr', null,
        h('td', null, h('b', null, u.username), u.id === state.user.id ? ' (you)' : ''),
        h('td', null, u.display_name),
        h('td', null, h('select', { 'aria-label': 'Role', value: u.role, onchange: (e) => guard(async () => { await D.updateUser(u.id, { role: e.target.value }); toast('Role updated'); route(); }) }, options(ROLE))),
        h('td', { class: 'row' },
          h('button', { class: 'small', onclick: () => { const pw = prompt(`New password for ${u.username} (min 8 characters):`); if (pw) guard(async () => { await D.updateUser(u.id, { password: pw }); toast('Password reset'); }); } }, 'Reset password'),
          h('button', { class: 'small danger', disabled: u.id === state.user.id, onclick: () => confirm(`Delete user ${u.username}?`) && guard(async () => { await D.deleteUser(u.id); toast('User deleted'); route(); }) }, 'Delete')),
      )))),
    ),
  );
}

// =====================================================================
// Router
// =====================================================================
async function route() {
  try {
    if (!configured) {
      topbar.hidden = true;
      mount(h('div', { class: 'card' }, h('h2', null, 'Setup needed'),
        h('p', null, 'Edit docs/config.js and set SUPABASE_URL and SUPABASE_ANON_KEY (Supabase → Project Settings → API). See README.md.')));
      return;
    }
    const hash = location.hash || '#/';
    const share = hash.match(/^#\/share\/([a-f0-9]+)$/);
    if (share) { topbar.hidden = true; await renderDetail(null, { token: share[1] }); return; }

    if (state.user === undefined) state.user = await D.profile();
    renderTopbar();
    if (!state.user) { renderLogin(); return; }
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
