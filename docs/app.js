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
  progress_mode: r.progress_mode || 'auto',
  progress: Number(r.progress) || 0,
  task_total: Number(r.task_total) || 0,
  task_done: Number(r.task_done) || 0,
  task_pct: Number(r.task_pct) || 0,
});
const TASK_STATUS = { not_started: 'Not started', in_progress: 'In progress', completed: 'Completed' };
const taskPct = (k) => (k.status === 'completed' ? 100 : k.status === 'in_progress' ? Math.max(1, Math.min(99, k.percent || 50)) : 0);
// Progress shown on the bar: automatic = average of every task's own % (falls back to the manual % while there are no tasks)
const progressOf = (p) => (p.progress_mode === 'auto' && p.task_total > 0 ? Math.round(p.task_pct / p.task_total) : p.progress);
const withTasks = (project, tasks) => normProject({ ...project, task_total: tasks.length,
  task_done: tasks.filter((k) => k.status === 'completed').length, task_pct: tasks.reduce((s, k) => s + taskPct(k), 0) });
const randomHex =(n) => [...crypto.getRandomValues(new Uint8Array(n))].map((x) => x.toString(16).padStart(2, '0')).join('');

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
      .select('*, owner:profiles(username,display_name), comments(count), topologies(count), tasks(status,percent)')
      .order('created_at', { ascending: false }));
    return rows.map((r) => ({ ...withTasks(r, r.tasks),
      comment_count: r.comments?.[0]?.count ?? 0, topology_count: r.topologies?.[0]?.count ?? 0 }));
  },
  async project(id) {
    const [p, t, c, k] = await Promise.all([
      sb.from('projects').select('*, owner:profiles(username,display_name)').eq('id', id).maybeSingle(),
      sb.from('topologies').select('*').eq('project_id', id).order('id'),
      sb.from('comments').select('*').eq('project_id', id).order('id'),
      sb.from('tasks').select('id,title,done,status,percent').eq('project_id', id).order('id'),
    ]);
    const project = unwrap(p);
    if (!project) throw new Error('Project not found');
    const me = state.user;
    return {
      project: withTasks(project, unwrap(k)), tasks: unwrap(k), topologies: unwrap(t), comments: unwrap(c),
      perms: { canEdit: me.role === 'admin' || (me.role === 'owner' && project.owner_id === me.id), userId: me.id, isAdmin: me.role === 'admin' },
      topoUrl,
    };
  },
  async shared(token) {
    const res = unwrap(await sb.rpc('shared_project', { p_token: token }));
    if (!res) throw new Error('This link is invalid or has been disabled');
    return { project: withTasks(res.project, res.tasks || []), tasks: res.tasks || [], topologies: res.topologies, comments: res.comments, perms: { canEdit: false }, topoUrl };
  },
  async sharedDashboard(token) {
    const res = unwrap(await sb.rpc('shared_dashboard', { p_token: token }));
    if (!res) throw new Error('This link is invalid or has been disabled');
    return { projects: res.projects.map(normProject), who: res.who, all: res.all };
  },
  async sharedDashboardProject(token, id) {
    const res = unwrap(await sb.rpc('shared_dashboard_project', { p_token: token, p_id: id }));
    if (!res) throw new Error('This link is invalid or the project no longer exists');
    return { project: withTasks(res.project, res.tasks || []), tasks: res.tasks || [], topologies: res.topologies, comments: res.comments, perms: { canEdit: false }, topoUrl };
  },
  async addTask(projectId, title) { unwrap(await sb.from('tasks').insert({ project_id: projectId, title })); },
  async updateTask(id, patch) { // patch: any of { title, status, percent }
    const rows = unwrap(await sb.from('tasks').update(patch).eq('id', id).select('id'));
    if (!rows.length) throw new Error('Not allowed');
  },
  async deleteTask(id) { unwrap(await sb.from('tasks').delete().eq('id', id)); },
  async addDashboardComment(token, id, author, body) {
    unwrap(await sb.rpc('shared_dashboard_comment', { p_token: token, p_id: id, p_author: author, p_body: body }));
  },
  async getDashboardShare() { return unwrap(await sb.rpc('get_my_dashboard_share')); },
  async setDashboardShare(enabled) { return unwrap(await sb.rpc('set_my_dashboard_share', { p_enabled: enabled })); },
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
// Small built-in icon set (static SVG paths, no external files)
const ICONS = {
  back: ['M15 18l-6-6 6-6'],
  projects: ['M3 3h7v7H3z', 'M14 3h7v7h-7z', 'M3 14h7v7H3z', 'M14 14h7v7h-7z'],
  users: ['M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2', 'M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8', 'M23 21v-2a4 4 0 0 0-3-3.87', 'M16 3.13a4 4 0 0 1 0 7.75'],
  plus: ['M12 5v14', 'M5 12h14'],
  link: ['M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71', 'M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71'],
  logout: ['M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4', 'M16 17l5-5-5-5', 'M21 12H9'],
  key: ['M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.78 7.78 5.5 5.5 0 0 1 7.78-7.78z', 'M15.5 7.5l3 3L22 7l-3-3'],
  help: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z', 'M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3', 'M12 17h.01'],
  warn: ['M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z', 'M12 9v4', 'M12 17h.01'],
};
function icon(name) {
  const s = document.createElement('span');
  s.className = 'ico';
  s.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    ICONS[name].map((d) => `<path d="${d}"/>`).join('') + '</svg>';
  return s;
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
const badge = (cls, label) => h('span', { class: 'badge ' + cls }, label);

// ----- progress bar -----
function progressBar(p, big = false) {
  const auto = p.progress_mode === 'auto' && p.task_total > 0;
  return barEl(progressOf(p), big, auto ? `${p.task_done} of ${p.task_total} tasks completed` : 'Set manually');
}
function barEl(value, big, tip) {
  const pct = Math.max(0, Math.min(100, value));
  const fill = h('div', { class: 'pfill' + (pct >= 100 ? ' full' : '') });
  fill.style.width = pct + '%';
  return h('div', { class: 'progress' + (big ? ' big' : ''), title: tip },
    h('div', { class: 'ptrack', role: 'progressbar', 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': pct, 'aria-label': 'Progress' }, fill),
    h('span', { class: 'plabel' }, pct + '%'));
}

// ----- due date tracking -----
const DUE_SOON_DAYS = 7; // warn when a project is due within this many days
const daysUntil = (d) => Math.round((new Date(d + 'T00:00:00') - new Date(new Date().setHours(0, 0, 0, 0))) / 86400000);
function dueState(p) {
  if (!p.due_date || p.status === 'done') return null;
  const n = daysUntil(p.due_date);
  return n < 0 ? 'overdue' : n <= DUE_SOON_DAYS ? 'soon' : 'ok';
}
function dueLabel(p) {
  const n = daysUntil(p.due_date);
  if (n < 0) return `Overdue by ${-n} day${-n === 1 ? '' : 's'}`;
  if (n === 0) return 'Due today';
  return `Due in ${n} day${n === 1 ? '' : 's'}`;
}
const dueBadge = (p) => { const s = dueState(p); return s === 'overdue' || s === 'soon' ? badge(s === 'overdue' ? 'high' : 'hold', dueLabel(p)) : null; };
const fmtDue = (p) => (p.due_date ? fmtDate(p.due_date) : 'No due date');
const dueClass = (p) => 'due-' + (dueState(p) || 'none');
let alertShownThisLoad = false;

function dueAlertProjects(projects) {
  const me = state.user;
  return projects
    .filter((p) => ['overdue', 'soon'].includes(dueState(p)) && (me.role !== 'owner' || p.owner_id === me.id))
    .sort((a, b) => a.due_date.localeCompare(b.due_date));
}
function showDueAlert(list) {
  const dlg = openDialog(h('div', null,
    h('h2', null, `⚠ ${list.length} project${list.length === 1 ? '' : 's'} need attention`),
    h('p', { class: 'muted small' }, `Due within ${DUE_SOON_DAYS} days or already overdue.`),
    h('div', { class: 'alert-list' }, list.map((p) => h('div', { class: 'alert-item ' + dueState(p) },
      h('div', { class: 'row spread' }, h('b', null, p.name), dueBadge(p)),
      h('div', { class: 'row small' }, statusBadge(p.status), prioBadge(p.priority),
        h('span', { class: 'muted' }, `Due ${fmtDate(p.due_date)} · Owner: ${p.owner_name || '—'}`)),
      p.description ? h('p', { class: 'muted small clamp' }, p.description) : null,
      h('button', { class: 'small', onclick: () => { dlg.close(); location.hash = '#/project/' + p.id; } }, 'Open project')))),
    h('div', { class: 'row' }, h('button', { class: 'primary', onclick: () => dlg.close() }, 'Got it'))));
}
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
  const link = (href, label, ico) => h('a', { class: 'nav' + (here === href || (href === '#/' && here.startsWith('#/project')) ? ' active' : ''), href }, icon(ico), label);
  topbar.replaceChildren(...[
    h('span', { class: 'brand' }, 'Project Tracker'),
    link('#/', 'Projects', 'projects'),
    state.user.role === 'admin' ? link('#/users', 'Users', 'users') : null,
    link('#/help', 'How to use', 'help'),
    h('span', { class: 'muted small' }, `${state.user.display_name || state.user.username} · ${ROLE[state.user.role]}`),
    h('button', { class: 'small', onclick: changePasswordDialog }, icon('key'), 'Change password'),
    h('button', { class: 'small', onclick: async () => { await guard(() => D.logout()); state.user = null; location.hash = '#/'; route(); } }, icon('logout'), 'Sign out'),
  ].filter(Boolean));
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
// Filter bar + stats + project table. hrefFor(p) gives the link opened when a row is clicked.
function buildBoard(projects, hrefFor) {
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
        ...Object.keys(STATUS).map((s) => h('div', { class: 'stat' }, h('b', null, count(s)), STATUS[s])),
        h('div', { class: 'stat stat-soon' }, h('b', null, projects.filter((p) => dueState(p) === 'soon').length), 'Due soon'),
        h('div', { class: 'stat stat-overdue' }, h('b', null, projects.filter((p) => dueState(p) === 'overdue').length), 'Overdue')),
      h('div', { class: 'card table-wrap' }, rows.length ? h('table', null,
        h('thead', null, h('tr', null, ['Project', 'Status', 'Progress', 'Priority', 'Start', 'Due', 'Owner', '💬', '🖧'].map((t) => h('th', null, t)))),
        h('tbody', null, rows.map((p) => h('tr', { class: 'click' + (dueState(p) === 'overdue' ? ' row-overdue' : dueState(p) === 'soon' ? ' row-soon' : ''), tabindex: 0, onclick: () => (location.hash = hrefFor(p)),
          onkeydown: (e) => { if (e.key === 'Enter') location.hash = hrefFor(p); } },
          h('td', null, h('b', null, p.name)),
          h('td', null, statusBadge(p.status)),
          h('td', { class: 'pcell' }, progressBar(p)),
          h('td', null, prioBadge(p.priority)),
          h('td', null, fmtDate(p.start_date)),
          h('td', { class: dueClass(p) }, fmtDue(p), ' ', dueBadge(p)),
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
  return { controls: h('div', { class: 'row card' }, search, fs, fp), body };
}

async function renderList() {
  const projects = await D.projects();
  const { controls, body } = buildBoard(projects, (p) => '#/project/' + p.id);
  const alerts = dueAlertProjects(projects);
  mount(
    h('div', { class: 'row spread' }, h('h1', null, 'Projects'),
      h('div', { class: 'row' },
        alerts.length ? h('button', { class: 'alert-btn', onclick: () => showDueAlert(alerts) }, icon('warn'), `${alerts.length} due soon / overdue`) : null,
        canCreate() ? h('button', { onclick: dashboardShareDialog }, icon('link'), 'Share dashboard') : null,
        canCreate() ? h('button', { class: 'primary', onclick: () => projectDialog() }, icon('plus'), 'New project') : null)),
    controls,
    body,
  );
  // pop up once per day per browser (and once per page load) when something is due soon or overdue
  const key = 'dueAlertDay:' + state.user.id;
  if (alerts.length && !alertShownThisLoad && safeGet(key) !== todayStr()) {
    alertShownThisLoad = true;
    safeSet(key, todayStr());
    showDueAlert(alerts);
  }
}

// Admin / project owner: create / copy / regenerate / disable the read-only link to their dashboard
async function dashboardShareDialog() {
  const box = h('div');
  const isAdmin = state.user.role === 'admin';
  const dlg = openDialog(h('div', null,
    h('h2', null, isAdmin ? 'Share the whole dashboard' : 'Share my projects dashboard'),
    h('p', { class: 'muted small' }, (isAdmin ? 'Anyone with the link can see ALL projects' : 'Anyone with the link can see the projects you own') +
      ' (status, priority, dates, owner, topologies, comments) and add comments, without signing in. They cannot change anything.'),
    box,
    h('div', { class: 'row' }, h('button', { onclick: () => dlg.close() }, 'Close'))));
  const draw = (token) => {
    const link = token ? `${location.origin}${location.pathname}#/dash/${token}` : null;
    box.replaceChildren(
      h('div', { class: 'row' },
        h('button', { class: 'primary', onclick: () => guard(async () => { draw(await D.setDashboardShare(true)); }) }, token ? 'Regenerate link' : 'Create dashboard link'),
        token ? h('button', { onclick: () => guard(async () => { await navigator.clipboard.writeText(link); toast('Link copied'); }) }, 'Copy link') : null,
        token ? h('button', { class: 'danger', onclick: () => guard(async () => { await D.setDashboardShare(false); draw(null); toast('Dashboard sharing disabled'); }) }, 'Disable') : null),
      token ? h('div', { class: 'sharebox' }, link) : h('p', { class: 'muted small' }, 'Sharing is currently off.'));
  };
  try { draw(await D.getDashboardShare()); } catch (e) { box.textContent = e.message; }
}

// Public read-only dashboard (no login)
async function renderSharedDashboard(token) {
  const { projects, who, all } = await D.sharedDashboard(token);
  const { controls, body } = buildBoard(projects, (p) => `#/dash/${token}/project/${p.id}`);
  mount(
    h('div', { class: 'banner' }, `👁 Read-only shared dashboard${all ? ' (all projects)' : who ? ` (projects owned by ${who})` : ''}. Open a project to see details and add comments.`),
    h('h1', null, 'Projects'),
    controls,
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
    mode: h('select', { value: project?.progress_mode || 'auto' },
      h('option', { value: 'auto' }, 'Automatic (from the task list)'), h('option', { value: 'manual' }, 'Manual (I set the %)')),
    pct: h('input', { type: 'range', min: 0, max: 100, step: 5, value: project?.progress ?? 0 }),
    owner: owners.length ? h('select', { value: project?.owner_id || state.user.id },
      owners.map((u) => h('option', { value: u.id }, `${u.display_name || u.username} (${ROLE[u.role]})`))) : null,
  };
  const err = h('div', { class: 'error' });
  const field = (label, el) => h('div', { class: 'field' }, h('label', null, label), el);
  const syncDue = () => { f.due.disabled = noDue.checked; if (noDue.checked) f.due.value = ''; };
  const noDue = h('input', { type: 'checkbox', checked: editing && !project.due_date, onchange: syncDue });
  syncDue();
  const dueField = h('div', { class: 'field' }, h('label', null, 'Due date'), f.due,
    h('label', { class: 'check' }, noDue, 'No due date'));
  const pctOut = h('b', null, f.pct.value + '%');
  const syncPct = () => { pctOut.textContent = f.pct.value + '%'; };
  f.pct.addEventListener('input', syncPct);
  const progField = h('div', { class: 'field' }, h('label', null, 'Progress'), f.mode,
    h('div', { class: 'row', style: 'margin-top:8px' }, h('div', { class: 'grow' }, f.pct), pctOut),
    h('p', { class: 'muted small' }, 'Automatic: the bar fills as you tick tasks on the project page (the % above is used until you add a task). Manual: the bar always shows the % above.'));
  const dlg = openDialog(h('form', { method: 'dialog', onsubmit: async (e) => {
    e.preventDefault(); err.textContent = '';
    const payload = { name: f.name.value.trim(), description: f.description.value.trim(), status: f.status.value, priority: f.priority.value,
      progress_mode: f.mode.value, progress: Number(f.pct.value),
      start_date: f.start.value || null, due_date: noDue.checked ? null : (f.due.value || null) };
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
    h('div', { class: 'fields' }, field('Status', f.status), field('Priority', f.priority), field('Start date', f.start), dueField,
      f.owner ? field('Owner', f.owner) : null),
    progField,
    err,
    h('div', { class: 'row' }, h('button', { class: 'primary', type: 'submit' }, 'Save'), h('button', { type: 'button', onclick: () => dlg.close() }, 'Cancel')),
  ));
}

// =====================================================================
// Project detail (signed-in view and public shared view)
// =====================================================================
async function renderDetail(id, ctx = {}) {
  const shared = !!ctx.token;
  const data = ctx.dashId ? await D.sharedDashboardProject(ctx.token, ctx.dashId)
    : shared ? await D.shared(ctx.token) : await D.project(id);
  const { project: p, topologies, comments, perms } = data;
  const tasks = data.tasks || [];
  const reload = () => route();

  // task list: every task has a status and its own bar; the average of all task bars fills the project bar (automatic mode)
  const newTask = h('input', { placeholder: 'Add a task… (starts as Not started)', maxlength: 200, required: true });
  const statusPatch = (status, percent) => ({ status, percent: status === 'in_progress' ? (percent > 0 && percent < 100 ? percent : 50) : status === 'completed' ? 100 : 0 });
  const taskItem = (k) => {
    const li = h('li', { class: 'task st-' + k.status });
    const pct = taskPct(k);
    const view = () => li.replaceChildren(
      h('div', { class: 'task-main' },
        h('span', { class: 'task-title' }, k.title),
        barEl(pct, false, TASK_STATUS[k.status])),
      h('div', { class: 'row task-ctl' },
        perms.canEdit
          ? h('select', { class: 'small', 'aria-label': 'Task status', value: k.status,
              onchange: (e) => guard(async () => { await D.updateTask(k.id, statusPatch(e.target.value, k.percent)); reload(); }) }, options(TASK_STATUS))
          : h('span', { class: 'badge ' + (k.status === 'completed' ? 'done' : k.status === 'in_progress' ? 'in_progress' : 'pending') }, TASK_STATUS[k.status]),
        perms.canEdit ? h('button', { class: 'small', onclick: edit }, 'Edit') : null,
        perms.canEdit ? h('button', { class: 'small danger', 'aria-label': 'Delete task', onclick: () => guard(async () => { await D.deleteTask(k.id); reload(); }) }, 'Delete') : null));
    const edit = () => {
      const inp = h('input', { maxlength: 200, required: true, value: k.title });
      const st = h('select', { 'aria-label': 'Task status', value: k.status }, options(TASK_STATUS));
      const range = h('input', { type: 'range', min: 5, max: 95, step: 5, value: k.status === 'in_progress' ? k.percent : 50 });
      const out = h('b', null, range.value + '%');
      range.addEventListener('input', () => { out.textContent = range.value + '%'; });
      const pctRow = h('div', { class: 'row' }, h('label', { style: 'margin:0' }, 'Task progress'), h('div', { class: 'grow' }, range), out);
      const sync = () => { pctRow.hidden = st.value !== 'in_progress'; };
      st.addEventListener('change', sync); sync();
      li.replaceChildren(
        h('form', { class: 'task-edit', onsubmit: (e) => { e.preventDefault();
          guard(async () => { await D.updateTask(k.id, { title: inp.value.trim(), ...statusPatch(st.value, Number(range.value)) }); reload(); }); } },
          h('div', { class: 'row' }, h('div', { class: 'grow' }, inp), st),
          pctRow,
          h('div', { class: 'row' },
            h('button', { class: 'small primary', type: 'submit' }, 'Save'),
            h('button', { class: 'small', type: 'button', onclick: view }, 'Cancel'))));
      inp.focus(); inp.select();
    };
    view();
    return li;
  };
  const taskList = tasks.length ? h('ul', { class: 'tasks' }, tasks.map(taskItem)) : h('p', { class: 'muted' }, 'No tasks yet.');
  const taskCard = h('div', { class: 'card' },
    h('div', { class: 'row spread' }, h('h2', null, `Tasks (${p.task_done}/${p.task_total} completed)`),
      p.progress_mode === 'manual' ? h('span', { class: 'muted small' }, 'Progress is set manually (Edit to switch to automatic)') : null),
    taskList,
    perms.canEdit ? h('form', { class: 'row', onsubmit: (e) => { e.preventDefault(); guard(async () => { await D.addTask(p.id, newTask.value.trim()); reload(); }); } },
      h('div', { class: 'grow' }, newTask), h('button', { class: 'primary', type: 'submit' }, icon('plus'), 'Add task')) : null);

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
      token ? h('div', { class: 'sharebox' }, link) : '');
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
      protectedImage(src, t.name, () => lightbox(src, t.name)),
      h('div', { class: 'cap' }, h('span', { title: t.name }, t.name),
        perms.canEdit ? h('button', { class: 'small danger', onclick: () => confirm('Delete this topology?') && guard(async () => { await D.deleteTopology(t); reload(); }) }, 'Delete') : null));
  })) : h('p', { class: 'muted' }, 'No topologies uploaded.');

  // comments
  const guestName = h('input', { placeholder: 'Your name', maxlength: 50, value: safeGet('guestName') || '', required: true });
  const text = h('textarea', { placeholder: 'Add a comment…', maxlength: 2000, required: true });
  const commentForm = h('form', { onsubmit: (e) => {
    e.preventDefault();
    guard(async () => {
      if (shared) {
        safeSet('guestName', guestName.value);
        if (ctx.dashId) await D.addDashboardComment(ctx.token, ctx.dashId, guestName.value, text.value);
        else await D.addGuestComment(ctx.token, guestName.value, text.value);
      }
      else await D.addComment(p.id, text.value.trim());
      reload();
    });
  } },
    shared ? h('div', { class: 'field' }, guestName) : null,
    h('div', { class: 'field' }, text),
    h('button', { class: 'primary', type: 'submit' }, 'Post comment'));

  mount(
    ctx.dashId ? h('a', { class: 'back-link', href: `#/dash/${ctx.token}` }, icon('back'), icon('projects'), 'Back to dashboard') : null,
    shared ? h('div', { class: 'banner' }, '👁 You are viewing a read-only shared project. You can add comments below.')
      : h('a', { class: 'back-link', href: '#/' }, icon('back'), icon('projects'), 'All projects'),
    h('div', { class: 'card' },
      h('div', { class: 'row spread' }, h('h1', null, p.name),
        perms.canEdit ? h('div', { class: 'row' },
          h('button', { onclick: () => projectDialog(p) }, 'Edit'),
          h('button', { class: 'danger', onclick: () => confirm(`Delete "${p.name}" and all its comments and topologies?`) && guard(async () => { await D.deleteProject(p.id); location.hash = '#/'; toast('Deleted'); }) }, 'Delete')) : null),
      h('div', { class: 'meta' },
        h('div', null, h('span', null, 'Status'), perms.canEdit ? quick('status', STATUS, p.status) : statusBadge(p.status)),
        h('div', null, h('span', null, 'Priority'), perms.canEdit ? quick('priority', PRIO, p.priority) : prioBadge(p.priority)),
        h('div', null, h('span', null, 'Start date'), fmtDate(p.start_date)),
        h('div', { class: dueClass(p) }, h('span', null, 'Due date'), fmtDue(p), ' ', dueBadge(p)),
        h('div', null, h('span', null, 'Owner'), p.owner_name || '—')),
      h('div', { class: 'field' }, h('label', null, 'Progress'), progressBar(p, true)),
      p.description ? h('p', { class: 'desc' }, p.description) : h('p', { class: 'muted' }, 'No description.')),
    taskCard,
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

// ----- topology protection (deterrents only: a browser cannot truly stop screenshots) -----
function watermarkUrl() {
  const who = state.user ? (state.user.display_name || state.user.username) : (safeGet('guestName') || 'Shared view');
  const esc = (s) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const text = esc(`${who} · ${new Date().toLocaleDateString()} · CONFIDENTIAL`);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="340" height="150"><text x="170" y="75" text-anchor="middle" transform="rotate(-25 170 75)" font-family="sans-serif" font-size="14" font-weight="600" fill="rgba(110,110,110,0.45)" stroke="rgba(255,255,255,0.4)" stroke-width="0.6">${text}</text></svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
}
// image + transparent watermarked shield on top (right-click / drag / long-press hit the shield, not the image)
function protectedImage(src, alt, onclick, cls = '') {
  const img = h('img', { src, alt, draggable: 'false', loading: 'lazy' });
  const shield = h('div', { class: 'shield', onclick });
  shield.style.backgroundImage = watermarkUrl();
  return h('div', { class: 'protected ' + cls }, img, shield);
}
document.addEventListener('contextmenu', (e) => { if (e.target.closest && e.target.closest('.protected')) e.preventDefault(); });
document.addEventListener('dragstart', (e) => { if (e.target.closest && e.target.closest('.protected')) e.preventDefault(); });
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && ['s', 'p'].includes(e.key.toLowerCase()) && document.querySelector('.protected')) e.preventDefault();
});

function lightbox(src, name) {
  const wrap = protectedImage(src, name, () => wrap.querySelector('img').classList.toggle('zoom'), 'lb');
  const dlg = openDialog(h('div', null,
    h('div', { class: 'row spread' }, h('b', null, name), h('button', { onclick: () => dlg.close() }, 'Close')),
    h('p', { class: 'muted small' }, 'Click the image to toggle full size.'),
    h('div', { class: 'scroll' }, wrap)), 'wide');
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
// How to use (user guide)
// =====================================================================
function renderHelp() {
  const p = (...k) => h('p', null, ...k);
  const ul = (...items) => h('ul', null, items.map((i) => h('li', null, i)));
  const ol = (...items) => h('ol', null, items.map((i) => h('li', null, i)));
  const note = (...k) => h('p', { class: 'help-note' }, ...k);
  const b = (t) => h('b', null, t);
  const roleTag = (t) => h('span', { class: 'badge role' }, t);
  const role = state.user.role;

  const sections = [
    ['start', 'Getting started', [
      p('Project Tracker lets your team keep every project in one place: its status, priority, dates, progress, task list, network topologies and comments. You can also share a read-only link with someone who has no account.'),
      h('h3', null, 'Roles'),
      h('div', { class: 'table-wrap' }, h('table', null,
        h('thead', null, h('tr', null, ['Role', 'What you can do'].map((t) => h('th', null, t)))),
        h('tbody', null,
          h('tr', null, h('td', null, b('Admin')), h('td', null, 'Everything: all projects, users, roles and passwords.')),
          h('tr', null, h('td', null, b('Project Owner')), h('td', null, 'Create projects. Edit, delete and manage tasks and topologies of your own projects. View all projects and comment. Share your dashboard.')),
          h('tr', null, h('td', null, b('Reviewer')), h('td', null, 'View all projects, tasks and topologies, and add comments. Nothing else.'))))),
      note('You are signed in as ', b(ROLE[role]), '. Sections below that need a higher role are marked.'),
      h('h3', null, 'Signing in and your password'),
      ol('Open the site address you were given and enter the username and password your admin created for you.',
        ['To change your password click ', b('Change password'), ' in the top bar, type the current one and a new one (at least 8 characters).'],
        'Forgot it? Ask an admin to reset it from the Users page.',
        ['Click ', b('Sign out'), ' when you finish, especially on a shared computer.']),
    ]],
    ['list', 'The Projects page', [
      p('After signing in you see every project in a table. Click any row to open the project.'),
      ul(h('span', null, b('Counters'), ' at the top: how many projects there are in total, per status, how many are due soon and how many are overdue.'),
        h('span', null, b('Search'), ' by name, description or owner, and filter by status or priority.'),
        h('span', null, b('Progress'), ' column: the bar and percentage of each project.'),
        h('span', null, 'Rows with an orange stripe are due within 7 days; red means overdue.'),
        h('span', null, 'The 💬 and 🖧 columns count comments and topologies.'),
        h('span', null, 'A ', b('due soon / overdue'), ' button and a pop-up (once per day) list the projects that need attention.')),
    ]],
    ['create', 'Create a project', [
      p(roleTag('Admin / Project Owner')),
      ol(['On the Projects page click ', b('+ New project'), '.'],
        ['Enter a ', b('name'), ' and, optionally, a description.'],
        ['Choose the ', b('status'), ' (Pending, In Progress, On Hold, Done) and ', b('priority'), ' (Low, Medium, High).'],
        ['Pick the ', b('start date'), ' and ', b('due date'), '. If there is no deadline tick ', b('No due date'), '.'],
        'Choose how the progress is calculated (see Progress below). Admins can also choose the project owner.',
        ['Click ', b('Save'), '. The new project opens so you can add tasks and topologies.']),
      h('h3', null, 'Edit or delete a project'),
      ul('Open the project and click Edit to change any field, or use the Status and Priority drop-downs on the page for a quick change.',
        'Delete removes the project with all its tasks, comments and topologies. This cannot be undone.'),
    ]],
    ['progress', 'Progress bar', [
      p('Every project has a progress bar from 0% to 100%, visible in the list and on the project page. It works in one of two modes, chosen in ', b('Edit → Progress'), ':'),
      ul(h('span', null, b('Automatic'), ' (default): the bar is the average of the progress of all tasks (Not started = 0%, In progress = its own %, Completed = 100%). Example: 4 tasks, one Completed, one In progress at 50%, two Not started = (100 + 50 + 0 + 0) ÷ 4 = 38%. Until you add the first task, the bar shows the % from the slider.'),
        h('span', null, b('Manual'), ': you move the 0-100 slider yourself and the bar always shows that value, whatever the tasks say.')),
      p('The bar turns green at 100%. Hover over it to see how many tasks are done.'),
      note('The bar never changes status by itself. Set the status to Done yourself when the project is finished.'),
    ]],
    ['tasks', 'Tasks', [
      p(roleTag('Admin / Owner of the project'), ' can change tasks. Everyone else can see them.'),
      ol(['Open the project and find the ', b('Tasks'), ' card.'],
        ['Type the task in the box and click ', b('Add task'), '. New tasks always start unchecked.'],
        ['Every task has its own bar and a ', b('status'), ' drop-down: ', b('Not started'), ' (0%, the default), ', b('In progress'), ' (starts at 50%) and ', b('Completed'), ' (100%). Change the status yourself when the work changes; nothing is changed automatically.'],
        ['Click ', b('Edit'), ' on a task to rename it, change its status and, for In progress, set its own percentage with the slider. Then ', b('Save'), ' (or Cancel).'],
        ['Click ', b('Delete'), ' to remove a task.']),
      p('The title shows how many tasks are completed, for example ', b('Tasks (3/8 completed)'), ', and the project progress bar updates right away when the project is in Automatic mode.'),
    ]],
    ['topologies', 'Topologies (images)', [
      p(roleTag('Admin / Owner of the project'), ' can upload and delete. Everyone can view.'),
      ol(['Open the project and use the file picker in the ', b('Topologies'), ' card. You can select several images at once.'],
        'Accepted formats: PNG, JPEG, GIF, WebP. Up to 20 images per project. Big images are compressed automatically.',
        'Click an image to enlarge it. Click it again inside the viewer to switch between fit-to-screen and full size.',
        ['Use ', b('Delete'), ' under an image to remove it.']),
      note('Topologies are protected: they carry a watermark with your name, and right-click, drag, save and print are blocked. A screenshot cannot be fully prevented, so share them only with people who should see them.'),
    ]],
    ['comments', 'Comments', [
      p('Everyone, including reviewers, can comment.'),
      ol(['Scroll to the ', b('Comments'), ' card at the bottom of a project.'], ['Type your message and click ', b('Post comment'), '.'],
        'You can delete your own comments. Admins can delete any comment.'),
      p('People using a share link type their name before commenting, and their comments carry a ', badge('role', 'guest'), ' tag.'),
    ]],
    ['share', 'Sharing without an account', [
      p('Share links let a third person follow a project without a username. They can view and add comments only; they cannot change anything, and they do not see the Users page or other accounts.'),
      h('h3', null, 'Share one project'),
      p(roleTag('Admin / Owner of the project')),
      ol(['Open the project and scroll to ', b('Share with a 3rd person'), '.'],
        ['Click ', b('Create share link'), ', then ', b('Copy link'), ' and send it.'],
        [b('Regenerate link'), ' makes a new link and the old one stops working. ', b('Disable'), ' turns sharing off.']),
      h('h3', null, 'Share your dashboard'),
      p(roleTag('Admin / Project Owner')),
      ol(['On the Projects page click ', b('Share dashboard'), ', then ', b('Create dashboard link'), ' and ', b('Copy link'), '.'],
        'Whoever opens the link sees the project list with status, progress and dates, can open any project, see its tasks and topologies and add comments.',
        ['An ', b('admin'), ' link shows ', b('all'), ' projects. A ', b('project owner'), ' link shows only the projects that owner owns.'],
        'Use Regenerate or Disable at any time to cut off access.'),
      note('Anyone who has a link can use it, so send it only to the right people and disable it when it is no longer needed.'),
    ]],
    ['users', 'Managing users', [
      p(roleTag('Admin')),
      ol(['Click ', b('Users'), ' in the top bar.'], 'Add a user with a username, name, password (minimum 8 characters) and role.',
        ['Change a role from the drop-down. Use ', b('Reset password'), ' if someone forgot theirs, and ', b('Delete'), ' to remove an account.'],
        'The last admin cannot be deleted or demoted.'),
      p('Give each person their username and first password privately and ask them to change it after the first sign-in.'),
    ]],
    ['faq', 'Tips and common questions', [
      ul(h('span', null, b('I cannot see New project or Edit.'), ' Your role is Reviewer, or you are not the owner of that project. Ask an admin to change your role or the project owner.'),
        h('span', null, b('A change does not appear.'), ' Reload the page (Ctrl+F5).'),
        h('span', null, b('The progress is 0% although I did work.'), ' In Automatic mode set the status of your tasks (In progress or Completed), or switch the project to Manual in Edit.'),
        h('span', null, b('A share link says it is invalid.'), ' The link was disabled or regenerated. Ask the person who shared it for a new one.'),
        h('span', null, b('Upload fails.'), ' Only PNG, JPEG, GIF and WebP are accepted, up to 20 images per project.')),
    ]],
  ];

  const jump = (id) => document.getElementById('help-' + id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  mount(
    h('h1', null, 'How to use'),
    h('p', { class: 'muted' }, 'A step-by-step guide to the Project Tracker.'),
    h('div', { class: 'card' }, h('h2', null, 'Contents'),
      h('div', { class: 'row' }, sections.map(([id, title]) => h('button', { class: 'small', onclick: () => jump(id) }, title)))),
    sections.map(([id, title, body]) => h('div', { class: 'card help', id: 'help-' + id }, h('h2', null, title), body)),
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
    const dash = hash.match(/^#\/dash\/([a-f0-9]+)(?:\/project\/(\d+))?$/);
    if (dash) {
      topbar.hidden = true;
      if (dash[2]) await renderDetail(null, { token: dash[1], dashId: Number(dash[2]) });
      else await renderSharedDashboard(dash[1]);
      return;
    }
    const share = hash.match(/^#\/share\/([a-f0-9]+)$/);
    if (share) { topbar.hidden = true; await renderDetail(null, { token: share[1] }); return; }

    if (state.user === undefined) state.user = await D.profile();
    renderTopbar();
    if (!state.user) { renderLogin(); return; }
    const proj = hash.match(/^#\/project\/(\d+)$/);
    if (proj) await renderDetail(Number(proj[1]));
    else if (hash === '#/users') await renderUsers();
    else if (hash === '#/help') renderHelp();
    else await renderList();
    renderTopbar();
  } catch (e) {
    mount(h('div', { class: 'card' }, h('h2', null, 'Something went wrong'), h('p', null, e.message), h('a', { href: '#/' }, 'Back to projects')));
  }
}
window.addEventListener('hashchange', route);
route();
