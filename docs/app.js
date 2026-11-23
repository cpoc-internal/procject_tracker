'use strict';

const STATUS = { pending: 'Pending', in_progress: 'In Progress', hold: 'On Hold', done: 'Done' };
const PRIO = { low: 'Low', medium: 'Medium', high: 'High' };
const ROLE = { admin: 'Admin', owner: 'Project Owner', reviewer: 'Reviewer' };
const MAX_IMG_BYTES = 4_000_000;
const MAX_TOPOLOGIES = 20;
const MAX_DOCS = 20;
const MAX_VISIBLE_MSGS = 6; // the comment box grows up to this many messages, then scrolls
const MAX_DOC_BYTES = 20 * 1024 * 1024;
const DOC_KINDS = {
  pdf: { kind: 'pdf', ext: 'pdf', mime: 'application/pdf', label: 'PDF' },
  docx: { kind: 'docx', ext: 'docx', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', label: 'Word' },
  html: { kind: 'html', ext: 'html', mime: 'text/html', label: 'HTML' },
  htm: { kind: 'html', ext: 'html', mime: 'text/html', label: 'HTML' },
};
const DOC_LABEL = { pdf: 'PDF', docx: 'Word', html: 'HTML' };
const EMAIL_DOMAIN = 'tracker.example.com';

const state = { user: undefined, filters: { q: '', status: '', priority: '', sort: 'newest' } };
const app = document.getElementById('app');
const topbar = document.getElementById('topbar');
const sidebar = document.getElementById('sidebar');

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
const docUrl = (path) => sb.storage.from('documents').getPublicUrl(path).data.publicUrl;
const fmtBytes = (n) => (n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB');
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
    await D.logEvent('login');
    return me;
  },
  async logout() { await D.logEvent('logout'); return sb.auth.signOut(); },
  async changePassword(current, next) {
    if (next.length < 8) throw new Error('Password must be at least 8 characters');
    const { error } = await sb.auth.signInWithPassword({ email: toEmail(state.user.username), password: current });
    if (error) throw new Error('Current password is incorrect');
    unwrap(await sb.auth.updateUser({ password: next }));
    await D.logEvent('password.change');
  },
  // activity log: the database records every change by itself; these are the events only the browser knows about
  // (it never blocks the app: errors are ignored, e.g. before the logs SQL update has been run)
  async logEvent(action, target = '', details = '') {
    try { await sb.rpc('log_event', { p_action: action, p_target: target, p_details: details }); } catch { /* ignore */ }
  },
  async logs() {
    return unwrap(await sb.from('activity_logs').select('id,created_at,actor,action,target,details').order('created_at', { ascending: false }).limit(1000));
  },

  async projectCount(ownerId) {
    const { count, error } = await sb.from('projects').select('id', { count: 'exact', head: true }).eq('owner_id', ownerId);
    if (error) throw new Error(error.message);
    return count || 0;
  },
  async projects(ownerId = null) {
    let q = sb.from('projects').select('*, owner:profiles(username,display_name), comments(count), topologies(count), tasks(status,percent)');
    if (ownerId) q = q.eq('owner_id', ownerId);
    const rows = unwrap(await q.order('created_at', { ascending: false }));
    return rows.map((r) => ({ ...withTasks(r, r.tasks),
      comment_count: r.comments?.[0]?.count ?? 0, topology_count: r.topologies?.[0]?.count ?? 0 }));
  },
  async project(id) {
    const [p, t, c, k, dq] = await Promise.all([
      sb.from('projects').select('*, owner:profiles(username,display_name)').eq('id', id).maybeSingle(),
      sb.from('topologies').select('*').eq('project_id', id).order('id'),
      sb.from('comments').select('*').eq('project_id', id).order('id'),
      sb.from('tasks').select('id,title,done,status,percent').eq('project_id', id).order('id'),
      sb.from('documents').select('id,name,path,kind,size,created_at').eq('project_id', id).order('id'),
    ]);
    const project = unwrap(p);
    if (!project) throw new Error('Project not found');
    const me = state.user;
    return {
      project: withTasks(project, unwrap(k)), tasks: unwrap(k), documents: unwrap(dq), topologies: unwrap(t), comments: unwrap(c),
      perms: { canEdit: me.role === 'admin' || (me.role === 'owner' && project.owner_id === me.id), userId: me.id, isAdmin: me.role === 'admin' },
      topoUrl,
    };
  },
  async shared(token) {
    const res = unwrap(await sb.rpc('shared_project', { p_token: token }));
    if (!res) throw new Error('This link is invalid or has been disabled');
    return { project: withTasks(res.project, res.tasks || []), tasks: res.tasks || [], documents: res.documents || [], topologies: res.topologies, comments: res.comments, perms: { canEdit: false }, topoUrl };
  },
  async sharedDashboard(token) {
    const res = unwrap(await sb.rpc('shared_dashboard', { p_token: token }));
    if (!res) throw new Error('This link is invalid or has been disabled');
    return { projects: res.projects.map(normProject), who: res.who, all: res.all, owners: res.owners || (res.who && !res.all ? [res.who] : []), label: res.label || '' };
  },
  async sharedDashboardProject(token, id) {
    const res = unwrap(await sb.rpc('shared_dashboard_project', { p_token: token, p_id: id }));
    if (!res) throw new Error('This link is invalid or the project no longer exists');
    return { project: withTasks(res.project, res.tasks || []), tasks: res.tasks || [], documents: res.documents || [], topologies: res.topologies, comments: res.comments, perms: { canEdit: false }, topoUrl };
  },
  async uploadDocument(projectId, file, count) {
    if (count >= MAX_DOCS) throw new Error(`Maximum of ${MAX_DOCS} documents per project`);
    const ext = (file.name.split('.').pop() || '').toLowerCase();
    const kind = DOC_KINDS[ext];
    if (!kind) throw new Error('Only PDF, Word (.docx) and HTML files are supported');
    if (file.size > MAX_DOC_BYTES) throw new Error('A document can be at most 20 MB');
    const path = `${projectId}/${crypto.randomUUID()}.${kind.ext}`;
    const up = await sb.storage.from('documents').upload(path, file, { contentType: kind.mime, upsert: false });
    if (up.error) throw new Error(up.error.message);
    const ins = await sb.from('documents').insert({ project_id: projectId, name: file.name.slice(0, 200), path, kind: kind.kind, size: file.size, uploaded_by: state.user.id });
    if (ins.error) { await sb.storage.from('documents').remove([path]); throw new Error(ins.error.message); }
  },
  async deleteDocument(d) {
    unwrap(await sb.from('documents').delete().eq('id', d.id));
    await sb.storage.from('documents').remove([d.path]);
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
  // admin: several dashboard links, each for all users or for the chosen users
  async adminShareLinks() { return unwrap(await sb.rpc('admin_list_share_links')); },
  async createAdminShareLink(label, all, ids) { return unwrap(await sb.rpc('admin_create_share_link', { p_label: label, p_all: all, p_owner_ids: ids })); },
  async updateAdminShareLink(id, label, all, ids) { unwrap(await sb.rpc('admin_update_share_link', { p_id: id, p_label: label, p_all: all, p_owner_ids: ids })); },
  async regenerateAdminShareLink(id) { return unwrap(await sb.rpc('admin_regenerate_share_link', { p_id: id })); },
  async deleteAdminShareLink(id) { unwrap(await sb.rpc('admin_delete_share_link', { p_id: id })); },
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
    const docs = await sb.from('documents').select('path').eq('project_id', id);
    if (docs.data?.length) await sb.storage.from('documents').remove(docs.data.map((d) => d.path));
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
  async updateComment(id, body) {
    const rows = unwrap(await sb.from('comments').update({ body }).eq('id', id).select('id'));
    if (!rows.length) throw new Error('Edit refused by the database. Ask the admin to run supabase-update-comments.sql in Supabase (see README, "The SQL files").');
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
  eye: ['M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z', 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z'],
  'task-completed': ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z', 'M8 12l3 3 5-6'],
  'task-in_progress': ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z', 'M12 7v5l3 2'],
  'task-not_started': ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z'],
  up: ['M18 15l-6-6-6 6'],
  down: ['M6 9l6 6 6-6'],
  log: ['M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2', 'M9 3h6v4H9z', 'M9 12h6', 'M9 16h6'],
  reset: ['M23 4v6h-6', 'M1 20v-6h6', 'M3.5 9a9 9 0 0 1 14.9-3.4L23 10', 'M1 14l4.6 4.4A9 9 0 0 0 20.5 15'],
  folder: ['M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z'],
  'eye-off': ['M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94', 'M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19', 'M1 1l22 22', 'M14.12 14.12a3 3 0 1 1-4.24-4.24'],
  edit: ['M12 20h9', 'M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z'],
  close: ['M18 6L6 18', 'M6 6l12 12'],
  upload: ['M12 16V4', 'M7 9l5-5 5 5', 'M5 20h14'],
  info: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z', 'M12 16v-5', 'M12 8h.01'],
  comment: ['M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z'],
  image: ['M3 3h18v18H3z', 'M8.5 10a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3z', 'M21 15l-5-5L5 21'],
  trash: ['M3 6h18', 'M8 6V4h8v2', 'M19 6l-1 14H6L5 6', 'M10 11v6', 'M14 11v6'],
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
function barEl(value, big, tip, cls = '') {
  const pct = Math.max(0, Math.min(100, value));
  const fill = h('div', { class: 'pfill' + (pct >= 100 ? ' full' : '') });
  fill.style.width = pct + '%';
  return h('div', { class: 'progress' + (big ? ' big' : '') + (cls ? ' ' + cls : ''), title: tip },
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
const canCreate = () => !!state.user && state.user.role === 'owner';        // only Project Owners create projects (admins and reviewers do not)
const canShare = () => !!state.user && ['admin', 'owner'].includes(state.user.role);

function openDialog(content, cls = '') {
  const dlg = h('dialog', { class: cls }, content);
  dlg.addEventListener('close', () => dlg.remove());
  document.body.append(dlg);
  dlg.showModal();
  return dlg;
}
function safeGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
function safeSet(k, v) { try { localStorage.setItem(k, v); } catch { /* ignore */ } }

// closes the admin dropdown when clicking elsewhere, pressing Escape or choosing an item
function closeUserMenus() {
  document.querySelectorAll('.user-dropdown').forEach((d) => { d.hidden = true; });
  document.querySelectorAll('.who-pill[aria-expanded]').forEach((b) => b.setAttribute('aria-expanded', 'false'));
}
document.addEventListener('click', closeUserMenus);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeUserMenus(); });
const initialsOf = (n) => (n || '?').trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase();
function renderTopbar() {
  if (!state.user) { topbar.hidden = true; return; }
  topbar.hidden = false;
  const here = location.hash || '#/';
  const link = (href, label, ico) => h('a', { class: 'nav' + (here === href || (href === '#/' && here.startsWith('#/project')) ? ' active' : ''), href }, icon(ico), label);
  const brand = h('span', { class: 'brand' }, '');
  brand.innerHTML = '<svg viewBox="0 0 44 26" width="34" height="20" aria-hidden="true" fill="#fff">' +
    [2, 7, 12, 17, 22, 27, 32, 37, 42].map((x, i) => { const hh = [10, 16, 20, 14, 24, 14, 20, 16, 10][i]; return `<rect x="${x - 1.5}" y="${13 - hh / 2}" width="3" height="${hh}" rx="1.5"/>`; }).join('') + '</svg>';
  brand.append(document.createTextNode('Project Tracker'));
  // the signed-in user's pill; for the admin it opens a small menu with the Projects page (admins have no Projects tab in the side menu)
  const who = [icon('users'), state.user.display_name || state.user.username, h('small', null, ROLE[state.user.role])];
  let whoMenu;
  if (state.user.role === 'admin') {
    const dd = h('div', { class: 'user-dropdown', role: 'menu', hidden: true },
      h('a', { class: 'dd-item' + (here === '#/' || here.startsWith('#/project') ? ' active' : ''), href: '#/', role: 'menuitem' }, icon('projects'), 'Projects'));
    const btn = h('button', { class: 'who-pill', 'aria-haspopup': 'menu', 'aria-expanded': 'false', title: 'Open the admin menu',
      onclick: (e) => { e.stopPropagation(); const open = dd.hidden; closeUserMenus(); dd.hidden = !open; btn.setAttribute('aria-expanded', String(open)); } }, ...who, icon('down'));
    whoMenu = h('div', { class: 'user-menu' }, btn, dd);
  } else {
    whoMenu = h('span', { class: 'who-pill', title: ROLE[state.user.role] }, ...who);
  }
  topbar.replaceChildren(...[
    brand,
    whoMenu,
    h('button', { class: 'icon-btn', title: 'Change password', 'aria-label': 'Change password', onclick: changePasswordDialog }, icon('key')),
    h('button', { class: 'icon-btn', title: 'Sign out', 'aria-label': 'Sign out', onclick: async () => { await guard(() => D.logout()); state.user = null; state.userList = null; state.revealAll = false; revealed.clear(); location.hash = '#/'; route(); } }, icon('logout')),
  ]);
  // admin: Users with a sub-menu listing every user (their projects stay hidden until you open the user and click Show projects)
  let usersMenu = null;
  if (state.user.role === 'admin') {
    const onUsers = here === '#/users' || here.startsWith('#/user/');
    const open = state.usersOpen ?? onUsers;
    usersMenu = h('div', { class: 'nav-group' },
      h('div', { class: 'nav-parent' }, link('#/users', 'Users', 'users'),
        h('button', { class: 'nav-toggle', 'aria-expanded': String(open), title: open ? 'Hide the user list' : 'Show the user list', 'aria-label': 'Toggle user list',
          onclick: () => { state.usersOpen = !open; renderTopbar(); } }, icon(open ? 'up' : 'down'))),
      h('div', { class: 'subnav', hidden: !open },
        (state.userList || []).filter((u) => u.role !== 'admin').length ? state.userList.filter((u) => u.role !== 'admin').map((u) => h('a', { class: 'nav sub' + (here === '#/user/' + u.id ? ' active' : ''), href: '#/user/' + u.id, title: ROLE[u.role] },
          h('span', { class: 'mini-av', 'aria-hidden': 'true' }, initialsOf(u.display_name || u.username)), u.display_name || u.username))
          : h('span', { class: 'muted small', style: 'padding:6px 10px' }, 'No users')));
  }
  sidebar.replaceChildren(...[
    state.user.role === 'admin' ? null : link('#/', 'Projects', 'projects'),
    usersMenu,
    state.user.role === 'admin' ? link('#/logs', 'Activity log', 'log') : null,
    link('#/help', 'How to use', 'help'),
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
// Sort + filter bar, counters and the project cards. hrefFor(p) gives the link opened by the View button.
const SORTS = { newest: 'Newest first', oldest: 'Oldest first', name: 'Name (A-Z)', due: 'Due date (soonest)', status: 'Project status', priority: 'Priority (high first)', progress: 'Progress (highest first)' };
const PRIO_ORDER = { high: 0, medium: 1, low: 2 };
const STATUS_ORDER = { in_progress: 0, hold: 1, pending: 2, done: 3 };
const sortProjects = (list, how) => {
  const c = [...list];
  const byDue = (a, b) => (a.due_date || '9999').localeCompare(b.due_date || '9999');
  const fn = {
    newest: (a, b) => (b.created_at || '').localeCompare(a.created_at || ''),
    oldest: (a, b) => (a.created_at || '').localeCompare(b.created_at || ''),
    name: (a, b) => a.name.localeCompare(b.name),
    due: byDue,
    status: (a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || byDue(a, b),
    priority: (a, b) => PRIO_ORDER[a.priority] - PRIO_ORDER[b.priority] || byDue(a, b),
    progress: (a, b) => progressOf(b) - progressOf(a),
  }[how] || (() => 0);
  c.sort(fn);
  // finished projects always sink to the bottom of the list, whatever the sort order is
  return [...c.filter((p) => p.status !== 'done'), ...c.filter((p) => p.status === 'done')];
};
const canEditProject = (p) => !!state.user && (state.user.role === 'admin' || (state.user.role === 'owner' && p.owner_id === state.user.id));

function projectCard(p, hrefFor) {
  const ds = dueState(p);
  const chip = (label, pill) => h('span', { class: 'chip' }, label + ':', pill);
  const dueText = p.due_date ? fmtDate(p.due_date) + (ds === 'overdue' || ds === 'soon' ? ' · ' + dueLabel(p) : '') : 'No due date';
  return h('div', { class: 'pcard' + (ds === 'overdue' ? ' row-overdue' : ds === 'soon' ? ' row-soon' : '') },
    h('h3', null, p.name),
    h('div', { class: 'chips' },
      chip('Status', h('span', { class: 'pill ' + p.status }, STATUS[p.status])),
      chip('Priority', h('span', { class: 'pill ' + p.priority }, PRIO[p.priority])),
      chip('Progress', h('span', { class: 'pill' }, progressBar(p))),
      chip('Start', h('span', { class: 'pill' }, fmtDate(p.start_date))),
      chip('Due', h('span', { class: 'pill ' + (ds === 'overdue' ? 'due-overdue' : ds === 'soon' ? 'due-soon' : '') }, dueText)),
      chip('Owner', h('span', { class: 'pill' }, p.owner_name || '—'))),
    h('div', { class: 'actions' },
      canEditProject(p) ? h('button', { class: 'action', onclick: () => projectDialog(p) }, icon('edit'), 'Edit') : null,
      h('span', { class: 'muted-count' }, icon('comment'), `${p.comment_count} comments`),
      h('span', { class: 'muted-count' }, icon('image'), `${p.topology_count} topologies`)),
    h('button', { class: 'solid view-btn', onclick: () => (location.hash = hrefFor(p)) }, 'View'));
}

function buildBoard(projects, hrefFor) {
  const body = h('div');
  const draw = () => {
    const f = state.filters, q = f.q.toLowerCase();
    const rows = sortProjects(projects.filter((p) =>
      (!f.status || p.status === f.status) && (!f.priority || p.priority === f.priority) &&
      (!q || p.name.toLowerCase().includes(q) || p.description.toLowerCase().includes(q) || (p.owner_name || '').toLowerCase().includes(q))), f.sort);
    const count = (s) => projects.filter((p) => p.status === s).length;
    body.replaceChildren(
      h('div', { class: 'stats' },
        h('div', { class: 'stat' }, h('b', null, projects.length), 'Total'),
        ...Object.keys(STATUS).map((s) => h('div', { class: 'stat' }, h('b', null, count(s)), STATUS[s])),
        h('div', { class: 'stat stat-soon' }, h('b', null, projects.filter((p) => dueState(p) === 'soon').length), 'Due soon'),
        h('div', { class: 'stat stat-overdue' }, h('b', null, projects.filter((p) => dueState(p) === 'overdue').length), 'Overdue')),
      rows.length ? h('div', { class: 'cards' }, rows.map((p) => projectCard(p, hrefFor)))
        : h('p', { class: 'muted center' }, projects.length ? 'No projects match the filters.' : 'No projects yet.'));
  };
  const grp = (label, el) => h('div', { class: 'grp' }, h('label', null, label), el);
  const sort = h('select', { 'aria-label': 'Sort by', onchange: (e) => { state.filters.sort = e.target.value; draw(); }, value: state.filters.sort }, options(SORTS));
  const search = h('input', { placeholder: 'Search projects…', value: state.filters.q, oninput: (e) => { state.filters.q = e.target.value; draw(); } });
  const fs = h('select', { 'aria-label': 'Status', onchange: (e) => { state.filters.status = e.target.value; draw(); }, value: state.filters.status },
    h('option', { value: '' }, 'All statuses'), options(STATUS));
  const fp = h('select', { 'aria-label': 'Priority', onchange: (e) => { state.filters.priority = e.target.value; draw(); }, value: state.filters.priority },
    h('option', { value: '' }, 'All priorities'), options(PRIO));
  draw();
  return { controls: h('div', { class: 'sortbar' }, grp('Sort By', sort), grp('Search', search), grp('Status', fs), grp('Priority', fp)), body };
}
// Admin view: projects stay hidden until the admin chooses to show them (resets on every page load)
const adminHidden = () => state.user.role === 'admin' && !state.revealAll;
async function renderList() {
  if (adminHidden()) {
    mount(
      h('div', { class: 'page-head' }, h('h1', null, 'Projects'),
        h('div', { class: 'btns' },
          h('button', { class: 'solid', onclick: dashboardShareDialog }, icon('link'), 'Share dashboard'))),
      h('div', { class: 'card hidden-note' },
        h('div', { class: 'big-ico' }, icon('eye-off')),
        h('h2', null, 'Projects are hidden on the admin view'),
        h('p', { class: 'muted' }, 'To keep other people\'s projects private, they are not displayed here. Open ', h('b', null, 'Users'), ' in the menu, pick a user and click ', h('b', null, 'Show projects'), ' to see only that person\'s projects, or show everything.'),
        h('div', { class: 'row', style: 'justify-content:center' },
          h('a', { class: 'btn-link solid', href: '#/users' }, icon('users'), 'Users'),
          h('button', { onclick: () => { state.revealAll = true; route(); } }, icon('eye'), 'Show all projects'))));
    return;
  }
  const projects = await D.projects();
  const { controls, body } = buildBoard(projects, (p) => '#/project/' + p.id);
  const alerts = dueAlertProjects(projects);
  mount(
    h('div', { class: 'page-head' }, h('h1', null, 'Projects'),
      h('div', { class: 'btns' },
        state.user.role === 'admin' ? h('button', { onclick: () => { state.revealAll = false; route(); } }, icon('eye-off'), 'Hide projects') : null,
        alerts.length ? h('button', { class: 'alert-btn', onclick: () => showDueAlert(alerts) }, icon('warn'), `${alerts.length} due soon / overdue`) : null,
        canShare() ? h('button', { class: 'solid', onclick: dashboardShareDialog }, icon('link'), 'Share dashboard') : null,
        canCreate() ? h('button', { class: 'solid', onclick: () => projectDialog() }, icon('plus'), 'New project') : null)),
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

// Admin only: one page per user (opened from the Users sub-menu). The user's projects stay hidden until you click "Show projects".
const revealed = new Set(); // user ids whose projects are currently shown (cleared on reload / sign-out)
async function renderUserPage(id) {
  const users = await D.users();
  state.userList = users;
  const u = users.find((x) => x.id === id);
  if (!u) throw new Error('User not found');
  const name = u.display_name || u.username;
  const count = await D.projectCount(id); // only the number, no project details
  const panel = h('div');
  const btnBox = h('div');
  const drawPanel = async () => {
    const open = revealed.has(id);
    btnBox.replaceChildren(h('button', { class: open ? '' : 'solid', 'aria-expanded': String(open), disabled: count === 0 ? true : null,
      onclick: () => { if (open) revealed.delete(id); else revealed.add(id); drawPanel(); } }, icon(open ? 'eye-off' : 'eye'), open ? 'Hide projects' : 'Show projects'));
    if (!open) {
      panel.replaceChildren(h('div', { class: 'card hidden-note' },
        h('div', { class: 'big-ico' }, icon('eye-off')),
        h('h2', null, count ? 'Projects are hidden' : u.role === 'reviewer' ? 'Reviewers do not own projects' : 'No projects yet'),
        count ? h('p', { class: 'muted' }, `${name} has ${count} project${count === 1 ? '' : 's'}. Click `, h('b', null, 'Show projects'), ' only if you really need to see them.') : null));
      return;
    }
    panel.replaceChildren(h('p', { class: 'muted center' }, 'Loading…'));
    try {
      const list = sortProjects(await D.projects(id), 'newest');
      if (!revealed.has(id)) return; // hidden again while loading
      panel.replaceChildren(list.length ? h('div', { class: 'cards' }, list.map((p) => projectCard(p, (x) => '#/project/' + x.id))) : h('p', { class: 'muted center' }, 'This user has no projects.'));
    } catch (e) { panel.replaceChildren(h('p', { class: 'error' }, e.message)); }
  };
  mount(
    h('a', { class: 'back-link', href: '#/users' }, icon('back'), icon('users'), 'Users'),
    h('div', { class: 'card owner-card' },
      h('div', { class: 'owner-row' },
        h('div', { class: 'avatar', 'aria-hidden': 'true' }, initialsOf(name)),
        h('div', { class: 'owner-name' }, h('h1', { style: 'margin:0;font-size:1.4rem' }, name), h('span', { class: 'muted small' }, `@${u.username}`)),
        h('span', { class: 'badge role' }, ROLE[u.role]),
        h('span', { class: 'pill' }, `${count} project${count === 1 ? '' : 's'}`),
        btnBox)),
    panel);
  drawPanel();
}
// Admin only: activity log (recorded by the database, deleted automatically after 72 hours)
const LOG_LABELS = {
  login: 'Signed in', logout: 'Signed out', 'password.change': 'Changed password', 'user.password_reset': 'Reset a password',
  'project.view': 'Opened project', 'project.create': 'Created project', 'project.update': 'Edited project', 'project.delete': 'Deleted project',
  'task.create': 'Added task', 'task.update': 'Updated task', 'task.delete': 'Deleted task',
  'document.upload': 'Uploaded document', 'document.view': 'Viewed document', 'document.delete': 'Deleted document',
  'topology.upload': 'Added topology', 'topology.delete': 'Deleted topology',
  'comment.add': 'Added comment', 'comment.edit': 'Edited comment', 'comment.delete': 'Deleted comment',
  'user.create': 'Created user', 'user.update': 'Changed user', 'user.delete': 'Deleted user',
  'dashboard.share.enable': 'Dashboard link created', 'dashboard.share.regenerate': 'Dashboard link regenerated', 'dashboard.share.update': 'Dashboard link users changed', 'dashboard.share.disable': 'Dashboard link disabled',
};
const LOG_GROUPS = { session: 'Sign in / out', project: 'Projects', task: 'Tasks', document: 'Documents', topology: 'Topologies', comment: 'Comments', user: 'Users', dashboard: 'Sharing' };
const logGroup = (a) => (['login', 'logout', 'password.change'].includes(a) ? 'session' : a.split('.')[0]);
const logTone = (a) => (/delete|disable/.test(a) ? 'high' : /create|upload|add|enable/.test(a) ? 'low' : /update|edit|change|reset|regenerate/.test(a) ? 'medium' : '');
async function renderLogs() {
  let rows = await D.logs();
  let shown = 200;
  const f = { q: '', group: '', actor: '' };
  const hoursLeft = (iso) => Math.max(0, Math.round(72 - (Date.now() - new Date(iso)) / 3600000));
  const body = h('div');
  const filtered = () => rows.filter((r) => (!f.group || logGroup(r.action) === f.group) && (!f.actor || r.actor === f.actor) &&
    (!f.q || `${r.actor} ${r.action} ${LOG_LABELS[r.action] || ''} ${r.target} ${r.details}`.toLowerCase().includes(f.q.toLowerCase())));
  const draw = () => {
    const list = filtered();
    body.replaceChildren(...[
      h('p', { class: 'muted small' }, `${list.length} entr${list.length === 1 ? 'y' : 'ies'} (newest first). Each entry is deleted automatically 72 hours after it was recorded.`),
      list.length ? h('div', { class: 'card table-wrap' }, h('table', { class: 'logtable' },
        h('thead', null, h('tr', null, ['When', 'User', 'Action', 'Project / target', 'Details', 'Deleted in'].map((t) => h('th', null, t)))),
        h('tbody', null, list.slice(0, shown).map((r) => h('tr', null,
          h('td', { class: 'nowrap', title: new Date(r.created_at).toISOString() }, fmtTime(r.created_at)),
          h('td', null, h('b', null, r.actor)),
          h('td', null, h('span', { class: 'pill ' + logTone(r.action) }, LOG_LABELS[r.action] || r.action)),
          h('td', null, r.target || '—'),
          h('td', { class: 'logdetails' }, r.details || ''),
          h('td', { class: 'muted small nowrap' }, hoursLeft(r.created_at) + ' h'))))))
        : h('div', { class: 'card' }, h('p', { class: 'muted center' }, rows.length ? 'No entries match the filters.' : 'No activity recorded yet.')),
      list.length > shown ? h('div', { class: 'row', style: 'justify-content:center' }, h('button', { onclick: () => { shown += 200; draw(); } }, `Show more (${list.length - shown} left)`)) : null,
    ].filter(Boolean));
  };
  const actors = [...new Set(rows.map((r) => r.actor))].sort();
  const grp = (label, el) => h('div', { class: 'grp' }, h('label', null, label), el);
  const exportCsv = () => {
    const q = (s) => `"${String(s ?? '').replace(/"/g, '""')}"`;
    const csv = ['time,user,action,target,details', ...filtered().map((r) => [new Date(r.created_at).toISOString(), r.actor, LOG_LABELS[r.action] || r.action, r.target, r.details].map(q).join(','))].join('\r\n');
    const a = h('a', { href: URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv' })), download: 'activity-log.csv' });
    document.body.append(a); a.click(); a.remove();
  };
  mount(
    h('div', { class: 'page-head' }, h('h1', null, 'Activity log'),
      h('div', { class: 'btns' },
        h('button', { onclick: () => guard(async () => { rows = await D.logs(); draw(); toast('Refreshed'); }) }, icon('reset'), 'Refresh'),
        h('button', { onclick: exportCsv }, icon('upload'), 'Export CSV'))),
    h('div', { class: 'banner' }, 'Only admins can see this log. It records sign-ins, project, task, document, topology and comment changes, user changes and sharing links. Entries are removed automatically after 72 hours.'),
    h('div', { class: 'sortbar' },
      grp('Search', h('input', { placeholder: 'Search the log…', oninput: (e) => { f.q = e.target.value; shown = 200; draw(); } })),
      grp('Category', h('select', { onchange: (e) => { f.group = e.target.value; shown = 200; draw(); } }, h('option', { value: '' }, 'All activity'), options(LOG_GROUPS))),
      grp('User', h('select', { onchange: (e) => { f.actor = e.target.value; shown = 200; draw(); } }, h('option', { value: '' }, 'Everyone'), actors.map((a) => h('option', { value: a }, a))))),
    body);
  draw();
}

// Dropdown with the user list: "All users" or a hand-picked set (used by the admin share links)
function userPicker(users, initial = { all: true, ids: [] }) {
  const all = h('input', { type: 'checkbox', checked: initial.all });
  const boxes = users.map((u) => ({ u, el: h('input', { type: 'checkbox', checked: initial.ids.includes(u.id) }) }));
  const summary = h('summary', null, '');
  const sync = () => {
    boxes.forEach((b) => { b.el.disabled = all.checked; });
    const n = boxes.filter((b) => b.el.checked).length;
    summary.textContent = all.checked ? 'All users' : n ? `${n} user${n === 1 ? '' : 's'} selected` : 'Choose users…';
  };
  all.addEventListener('change', sync);
  boxes.forEach((b) => b.el.addEventListener('change', sync));
  const el = h('details', { class: 'picker' }, summary,
    h('div', { class: 'picker-list' },
      h('label', { class: 'check strong' }, all, 'All users'),
      ...boxes.map((b) => h('label', { class: 'check' }, b.el, h('span', null, b.u.display_name || b.u.username, h('small', { class: 'muted' }, ` @${b.u.username} · ${ROLE[b.u.role]}`))))));
  sync();
  return { el, value: () => ({ all: all.checked, ids: boxes.filter((b) => b.el.checked).map((b) => b.u.id) }) };
}

// Admin: any number of dashboard links, each for all users or only the users chosen in the dropdown
async function adminShareDialog() {
  const users = (await D.users()).filter((u) => u.role === 'owner'); // admins do not own projects
  const nameOf = (id) => { const u = users.find((x) => x.id === id); return u ? (u.display_name || u.username) : 'removed user'; };
  const scopeText = (l) => (l.scope_all ? 'All users' : l.owner_ids.map(nameOf).join(', ') || '—');
  const listBox = h('div', { class: 'links' });
  let links = [];
  const refresh = async () => { links = await D.adminShareLinks(); drawList(); };
  const act = (fn, msg) => guard(async () => { await fn(); if (msg) toast(msg); await refresh(); });

  const row = (l) => {
    const url = `${location.origin}${location.pathname}#/dash/${l.token}`;
    const editBox = h('div');
    const edit = () => {
      const label = h('input', { maxlength: 80, value: l.label, placeholder: 'Name of the link (optional)' });
      const picker = userPicker(users, { all: l.scope_all, ids: l.owner_ids });
      editBox.replaceChildren(h('div', { class: 'linkedit' }, label, picker.el,
        h('div', { class: 'row' },
          h('button', { class: 'small primary', onclick: () => { const v = picker.value(); act(() => D.updateAdminShareLink(l.id, label.value, v.all, v.ids), 'Link updated'); } }, 'Save'),
          h('button', { class: 'small', onclick: () => editBox.replaceChildren() }, 'Cancel'))));
    };
    return h('div', { class: 'linkrow' },
      h('div', { class: 'row spread' }, h('b', null, l.label || 'Dashboard link'), h('span', { class: 'pill' }, icon('users'), scopeText(l))),
      h('div', { class: 'sharebox' }, url),
      h('div', { class: 'row' },
        h('button', { class: 'small', onclick: () => guard(async () => { await navigator.clipboard.writeText(url); toast('Link copied'); }) }, 'Copy link'),
        h('button', { class: 'small', onclick: edit }, 'Change users'),
        h('button', { class: 'small', onclick: () => confirm('Create a new address? The old link stops working.') && act(() => D.regenerateAdminShareLink(l.id), 'Link regenerated') }, 'Regenerate'),
        h('button', { class: 'small danger', onclick: () => confirm('Delete this link? Anyone using it loses access.') && act(() => D.deleteAdminShareLink(l.id), 'Link deleted') }, 'Delete')),
      editBox);
  };
  const drawList = () => listBox.replaceChildren(...(links.length ? links.map(row) : [h('p', { class: 'muted small' }, 'No dashboard links yet.')]));

  const newLabel = h('input', { maxlength: 80, placeholder: 'Name of the link, e.g. "Customer review" (optional)' });
  const newPicker = userPicker(users);
  const dlg = openDialog(h('div', null,
    h('h2', null, 'Share the dashboard'),
    h('p', { class: 'muted small' }, 'Anyone with a link sees the projects of the users you choose (status, progress, tasks, documents, topologies, comments) and can add comments, without signing in. They cannot change anything. Create a different link for each audience.'),
    h('h3', { class: 'sub' }, 'Your links'), listBox,
    h('h3', { class: 'sub' }, 'Create a new link'),
    h('div', { class: 'linkedit' },
      h('div', { class: 'field' }, h('label', null, 'Name'), newLabel),
      h('div', { class: 'field' }, h('label', null, 'Whose projects? (dropdown)'), newPicker.el),
      h('div', { class: 'row' }, h('button', { class: 'primary', onclick: () => { const v = newPicker.value(); act(async () => { await D.createAdminShareLink(newLabel.value, v.all, v.ids); newLabel.value = ''; }, 'Link created'); } }, icon('plus'), 'Create link'))),
    h('div', { class: 'row', style: 'margin-top:14px' }, h('button', { onclick: () => dlg.close() }, 'Close'))), 'mid');
  try { await refresh(); } catch (e) { listBox.textContent = e.message + ' (has supabase-update-privacy.sql been run?)'; }
}

// Project owner: create / copy / regenerate / disable the read-only link to their own projects
async function dashboardShareDialog() {
  if (state.user.role === 'admin') return adminShareDialog();
  const box = h('div');
  const dlg = openDialog(h('div', null,
    h('h2', null, 'Share my projects dashboard'),
    h('p', { class: 'muted small' }, 'Anyone with the link can see the projects you own (status, priority, dates, owner, topologies, comments) and add comments, without signing in. They cannot change anything.'),
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
  const { projects, who, all, owners } = await D.sharedDashboard(token);
  const { controls, body } = buildBoard(projects, (p) => `#/dash/${token}/project/${p.id}`);
  const pill = (n) => h('span', { class: 'pill' }, icon('users'), n);
  mount(
    h('div', { class: 'banner' }, '👁 Read-only shared dashboard. Open a project to see details and add comments.'),
    h('h1', null, 'Projects'),
    all ? (who ? h('p', { class: 'owner-line' }, 'Dashboard shared by ', pill(who), ' (all projects)') : null)
      : owners.length ? h('p', { class: 'owner-line' }, owners.length === 1 ? 'These projects belong to ' : 'These projects belong to: ', owners.map(pill)) : null,
    controls,
    body,
  );
}
async function projectDialog(project) {
  const editing = !!project;
  let owners = [];
  if (state.user.role === 'admin') owners = (await D.users()).filter((u) => u.role === 'owner'); // admins and reviewers cannot own projects
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
    owner: state.user.role === 'admin' ? h('select', { required: true, value: owners.some((u) => u.id === project?.owner_id) ? project.owner_id : '' },
      h('option', { value: '' }, owners.length ? 'Choose a Project Owner…' : 'No Project Owner exists yet'),
      owners.map((u) => h('option', { value: u.id }, `${u.display_name || u.username} (@${u.username})`))) : null,
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
      f.owner ? field('Owner (a Project Owner)', f.owner) : null),
    f.owner && !owners.length ? h('p', { class: 'error' }, 'Create a user with the role Project Owner first (Users page): projects must belong to a Project Owner, not to an admin.') : null,
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
  const documents = data.documents || [];
  const reload = () => route();
  // log that a signed-in user opened this project (not again for the same project within 5 minutes, so edits/reloads do not flood the log)
  if (!shared && state.user && !(lastProjectView.id === p.id && Date.now() - lastProjectView.t < 300000)) {
    lastProjectView = { id: p.id, t: Date.now() };
    D.logEvent('project.view', p.name);
  }

  // documents (PDF / Word / HTML) with an in-page web view
  const docInput = h('input', { type: 'file', accept: '.pdf,.docx,.html,.htm', multiple: true, onchange: async (e) => {
    let n = documents.length;
    for (const file of e.target.files) {
      await guard(async () => { await D.uploadDocument(p.id, file, n); n++; toast('Uploaded ' + file.name); });
    }
    reload();
  } });
  const docList = documents.length ? h('ul', { class: 'docs' }, documents.map((d) => h('li', null,
    h('span', { class: 'badge role' }, DOC_LABEL[d.kind] || d.kind),
    h('span', { class: 'doc-name', title: d.name }, d.name),
    h('span', { class: 'muted small' }, fmtBytes(d.size)),
    h('div', { class: 'row' },
      h('button', { class: 'small primary', onclick: () => { if (!shared) D.logEvent('document.view', p.name, d.name); viewDocument(d, docUrl(d.path)); } }, icon('eye'), 'View'),
      perms.canEdit ? h('button', { class: 'small action danger', onclick: () => confirm(`Delete "${d.name}"?`) && guard(async () => { await D.deleteDocument(d); reload(); }) }, 'Delete') : null))))
    : h('p', { class: 'muted' }, 'No documents uploaded.');
  const docCard = h('div', { class: 'card' },
    h('h2', null, `Documents (${documents.length})`),
    perms.canEdit ? h('div', { class: 'row' }, docInput) : null,
    perms.canEdit ? h('p', { class: 'muted small' }, 'PDF, Word (.docx) or HTML, up to 20 MB. Click View to read here.') : null,
    docList);

  // task list: every task has a status and its own bar; the average of all task bars fills the project bar (automatic mode)
  const newTask = h('input', { placeholder: 'Add a task… (starts as Not started)', maxlength: 200, required: true });
  const statusPatch = (status, percent) => ({ status, percent: status === 'in_progress' ? (percent > 0 && percent < 100 ? percent : 50) : status === 'completed' ? 100 : 0 });
  const taskItem = (k, idx) => {
    const li = h('li', { class: 'task st-' + k.status });
    const pct = taskPct(k);
    const view = () => li.replaceChildren(
      h('div', { class: 'task-main' },
        h('span', { class: 'task-title' },
          h('span', { class: 'task-state', title: TASK_STATUS[k.status] }, icon('task-' + k.status)),
          h('span', { class: 'task-num' }, (idx + 1) + '.'), k.title),
        barEl(pct, false, TASK_STATUS[k.status], 't-' + k.status)),
      h('div', { class: 'row task-ctl' },
        perms.canEdit
          ? h('select', { class: 'small', 'aria-label': 'Task status', value: k.status,
              onchange: (e) => guard(async () => { await D.updateTask(k.id, statusPatch(e.target.value, k.percent)); reload(); }) }, options(TASK_STATUS))
          : h('span', { class: 'badge ' + (k.status === 'completed' ? 'done' : k.status === 'in_progress' ? 'in_progress' : 'pending') }, TASK_STATUS[k.status]),
        perms.canEdit ? h('button', { class: 'small', onclick: edit }, 'Edit') : null,
        perms.canEdit ? h('button', { class: 'small danger', 'aria-label': 'Delete task', onclick: () => guard(async () => { await D.deleteTask(k.id); reload(); }) }, 'Delete') : null));
    const edit = () => {
      const inp = h('input', { maxlength: 200, required: true, value: k.title, 'aria-label': `Task ${idx + 1}` });
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
  // paste screenshots (Ctrl+V anywhere on this page, or the Paste button)
  let pasting = false;
  const uploadPasted = async (files) => {
    if (pasting || !files.length) return;
    pasting = true;
    let n = topologies.length;
    for (const f of files) {
      const ext = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' }[f.type] || 'png';
      const file = new File([f], `screenshot-${new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-')}-${n + 1}.${ext}`, { type: f.type });
      await guard(async () => { await D.uploadTopology(p.id, file, n); n++; toast('Pasted ' + file.name); });
    }
    pasting = false;
    reload();
  };
  const pasteBtn = h('button', { onclick: () => guard(async () => {
    if (!navigator.clipboard?.read) throw new Error('Your browser cannot read the clipboard here: press Ctrl+V on this page instead');
    const files = [];
    for (const item of await navigator.clipboard.read()) {
      const type = item.types.find((t) => t.startsWith('image/'));
      if (type) files.push(new File([await item.getType(type)], 'clip', { type }));
    }
    if (!files.length) throw new Error('No image in the clipboard. Take a screenshot first (Win+Shift+S)');
    await uploadPasted(files);
  }) }, 'Paste screenshot');
  document.removeEventListener('paste', pasteHandler);
  pasteHandler = null;
  if (perms.canEdit && !shared) {
    pasteHandler = (e) => {
      if (document.querySelector('dialog[open]')) return;
      const files = [...(e.clipboardData?.items || [])].filter((i) => i.kind === 'file' && /^image\/(png|jpeg|gif|webp)$/.test(i.type)).map((i) => i.getAsFile()).filter(Boolean);
      if (!files.length) return; // plain text pastes (comments etc.) are left alone
      e.preventDefault();
      uploadPasted(files);
    };
    document.addEventListener('paste', pasteHandler);
  }
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

  // chat-style thread: your own messages on the right, everybody else's on the left
  const initials = (n) => (n || '?').trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase();
  const message = (c) => {
    const mine = !shared && c.user_id === perms.userId;
    const bubble = h('div', { class: 'bubble' });
    const viewMsg = () => bubble.replaceChildren(...[
      h('div', { class: 'msg-head' },
        h('span', { class: 'who' }, mine ? 'You' : c.author), c.is_guest ? badge('role', 'guest') : null,
        h('span', { class: 'muted small' }, fmtTime(c.created_at)), c.edited_at ? h('span', { class: 'muted small', title: fmtTime(c.edited_at) }, '(edited)') : null),
      h('div', { class: 'body' }, c.body),
      !shared && (mine || perms.isAdmin) ? h('div', { class: 'msg-actions' },
        mine ? h('button', { class: 'linkish', onclick: editMsg }, 'Edit') : null,
        h('button', { class: 'linkish danger', onclick: () => confirm('Delete this comment?') && guard(async () => { await D.deleteComment(c.id); reload(); }) }, 'Delete')) : null,
    ].filter(Boolean));
    const editMsg = () => {
      const ta = h('textarea', { maxlength: 2000, required: true, value: c.body });
      bubble.replaceChildren(h('form', { class: 'msg-edit', onsubmit: (e) => { e.preventDefault(); guard(async () => { await D.updateComment(c.id, ta.value.trim()); reload(); }); } },
        ta, h('div', { class: 'row' }, h('button', { class: 'small primary', type: 'submit' }, 'Save'), h('button', { class: 'small', type: 'button', onclick: viewMsg }, 'Cancel'))));
      ta.focus();
    };
    viewMsg();
    const avatar = h('div', { class: 'avatar', 'aria-hidden': 'true' }, initials(c.author));
    return h('div', { class: 'msg' + (mine ? ' mine' : '') }, avatar, bubble);
  };
  const scrollBy = (dir) => thread.scrollBy({ top: dir * Math.max(120, thread.clientHeight * 0.8), behavior: 'smooth' });
  const scrollCtl = h('div', { class: 'row', hidden: true, title: 'Scroll through the messages' },
    h('button', { class: 'small action', 'aria-label': 'Scroll up', onclick: () => scrollBy(-1) }, icon('up'), 'Up'),
    h('button', { class: 'small action', 'aria-label': 'Scroll down', onclick: () => scrollBy(1) }, icon('down'), 'Down'));
  const thread = h('div', { class: 'chat' }, comments.length ? comments.map(message) : h('p', { class: 'muted center' }, 'No comments yet. Start the conversation below.'));

  mount(
    ctx.dashId ? h('a', { class: 'back-link', href: `#/dash/${ctx.token}` }, icon('back'), icon('projects'), 'Back to dashboard') : null,
    shared ? h('div', { class: 'banner' }, '👁 You are viewing a read-only shared project. You can add comments below.')
      : adminHidden() ? h('a', { class: 'back-link', href: p.owner_id ? '#/user/' + p.owner_id : '#/users' }, icon('back'), icon('users'), p.owner_id ? 'Back to ' + (p.owner_name || 'user') : 'Users')
        : h('a', { class: 'back-link', href: '#/' }, icon('back'), icon('projects'), 'All projects'),
    h('div', { class: 'card hdr' },
      h('div', { class: 'row spread' }, h('h1', null, p.name),
        perms.canEdit ? h('div', { class: 'row' },
          h('button', { class: 'action', onclick: () => projectDialog(p) }, icon('edit'), 'Edit'),
          h('button', { class: 'action danger', onclick: () => confirm(`Delete "${p.name}" and all its tasks, documents, comments and topologies?`) && guard(async () => { await D.deleteProject(p.id); location.hash = '#/'; toast('Deleted'); }) }, icon('close'), 'Delete')) : null),
      h('div', { class: 'meta' },
        h('div', null, h('span', null, 'Status'), perms.canEdit ? quick('status', STATUS, p.status) : statusBadge(p.status)),
        h('div', null, h('span', null, 'Priority'), perms.canEdit ? quick('priority', PRIO, p.priority) : prioBadge(p.priority)),
        h('div', null, h('span', null, 'Start date'), fmtDate(p.start_date)),
        h('div', { class: dueClass(p) }, h('span', null, 'Due date'), fmtDue(p), ' ', dueBadge(p)),
        h('div', null, h('span', null, 'Owner'), p.owner_name || '—'),
        h('div', { class: 'meta-progress' }, h('span', null, 'Progress'), progressBar(p, true))),
      p.description ? h('p', { class: 'desc' }, p.description) : h('p', { class: 'muted' }, 'No description.')),
    taskCard,
    h('div', { class: 'detail-grid' },
      h('div', { class: 'side' },
        docCard,
        h('div', { class: 'card' }, h('h2', null, `Topologies (${topologies.length})`),
          perms.canEdit ? h('div', { class: 'row' }, pasteBtn, fileInput) : null,
          perms.canEdit ? h('p', { class: 'muted small' }, 'Tip: take a screenshot (Win+Shift+S), then press Ctrl+V anywhere on this page.') : null,
          gallery),
        perms.canEdit && !shared ? h('div', { class: 'card' }, shareBox) : null),
      h('div', { class: 'card comments-card' },
        h('div', { class: 'row spread' }, h('h2', null, `Comments (${comments.length})`), scrollCtl), thread, commentForm)),
  );
  // the chat box starts small, grows with the messages, and stops growing after MAX_VISIBLE_MSGS (then it scrolls)
  const fitThread = () => {
    const msgs = [...thread.querySelectorAll('.msg')];
    thread.style.maxHeight = '';
    if (msgs.length > MAX_VISIBLE_MSGS && thread.isConnected) {
      const last = msgs.slice(-MAX_VISIBLE_MSGS);
      thread.style.maxHeight = (last.reduce((s, m) => s + m.offsetHeight, 0) + 12 * (MAX_VISIBLE_MSGS - 1) + 30) + 'px';
    }
    scrollCtl.hidden = thread.scrollHeight <= thread.clientHeight + 2;
  };
  fitThread();
  window.onresize = fitThread;
  thread.scrollTo({ top: thread.scrollHeight, behavior: 'instant' }); // newest message in view, like a chat
  if (shared) topbar.hidden = true;
}

let pasteHandler = null; // Ctrl+V screenshot handler of the project page currently shown
let lastProjectView = { id: null, t: 0 };

// ----- document web view -----
// PDF: browser PDF viewer. HTML and Word: rendered inside a locked-down iframe (no scripts, no forms, no external frames).
let mammothLoad;
const loadMammoth = () => (window.mammoth ? Promise.resolve() : (mammothLoad ||= new Promise((ok, bad) => {
  const s = document.createElement('script');
  s.src = 'vendor/mammoth.js'; s.onload = ok; s.onerror = () => { mammothLoad = null; bad(new Error('Could not load the Word viewer')); };
  document.head.append(s);
})));
const SAFE_CSP = '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; img-src data: https:; style-src \'unsafe-inline\'; font-src data: https:">';
// HTML documents may run their own scripts (tabs, menus), but only in an isolated frame: no access to this site,
// your login, other pages, the network, forms or navigation.
const HTML_CSP = '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'unsafe-inline\'; style-src \'unsafe-inline\'; img-src data: https:; font-src data: https:; media-src data: https:; connect-src \'none\'; form-action \'none\'">';
const DOC_STYLE ='<style>body{font:15px/1.6 "Segoe UI",system-ui,sans-serif;color:#1b2a3b;background:#fff;max-width:860px;margin:0 auto;padding:24px}' +
  'img{max-width:100%;height:auto}table{border-collapse:collapse}td,th{border:1px solid #ccd;padding:4px 8px}h1,h2,h3{color:#0d274d}a{color:#0067a0}</style>';

async function viewDocument(d, url) {
  const body = h('div', { class: 'docview' }, h('p', { class: 'muted center' }, 'Loading…'));
  const dlg = openDialog(h('div', null,
    h('div', { class: 'row spread' }, h('b', null, d.name), h('button', { onclick: () => dlg.close() }, 'Close')),
    body), 'wide xl');
  let blobUrl;
  dlg.addEventListener('close', () => { if (blobUrl) URL.revokeObjectURL(blobUrl); });
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error('Could not load the document (' + res.status + ')');
    let frame;
    if (d.kind === 'pdf') {
      blobUrl = URL.createObjectURL(new Blob([await res.arrayBuffer()], { type: 'application/pdf' }));
      frame = h('iframe', { class: 'docframe', src: blobUrl + '#toolbar=0&navpanes=0', title: d.name });
    } else if (d.kind === 'html') {
      frame = h('iframe', { class: 'docframe', sandbox: 'allow-scripts', srcdoc: HTML_CSP + (await res.text()), title: d.name });
    } else {
      await loadMammoth();
      const out = await window.mammoth.convertToHtml({ arrayBuffer: await res.arrayBuffer() });
      frame = h('iframe', { class: 'docframe', sandbox: '', srcdoc: SAFE_CSP + DOC_STYLE + out.value, title: d.name });
    }
    body.replaceChildren(frame);
  } catch (e) {
    body.replaceChildren(h('p', { class: 'error' }, e.message));
  }
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
  state.userList = users; // keeps the Users sub-menu in the sidebar up to date
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
          h('button', { class: 'small', onclick: () => { const pw = prompt(`New password for ${u.username} (min 8 characters):`); if (pw) guard(async () => { await D.updateUser(u.id, { password: pw }); D.logEvent('user.password_reset', u.username); toast('Password reset'); }); } }, 'Reset password'),
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
    ['new', "What's new", [
      ul(h('span', null, b('New project page layout'), ': title, status and progress in one bar on top, the task list under it, small boxes for Documents, Topologies and Sharing on the left, and the comment chat on the right. It uses the full width of your screen and stacks into one column on phones.'),
        h('span', null, b('Progress bar'), ' on every project, filled automatically from its tasks or set by hand (see Progress bar).'),
        h('span', null, b('Task list with statuses'), ': Not started, In progress (with its own % bar) and Completed; the average feeds the project bar (see Tasks).'),
        h('span', null, b('Documents'), ': upload PDF, Word (.docx) and HTML files and read them in a large built-in viewer, even HTML pages with tabs (see Documents).'),
        h('span', null, b('Chat-style comments'), ' that you can edit after posting (see Comments).'),
        h('span', null, b('Activity log'), ' for admins: who did what and when, kept for 72 hours (see Activity log).'),
        h('span', null, b('Paste screenshots'), ' into Topologies with Ctrl+V (see Topologies).'),
        h('span', null, b('Due dates'), ': "No due date" option, warning colours and a daily pop-up (see Due dates).'),
        h('span', null, b('Share links'), ' for one project or for your whole dashboard; visitors also see progress, tasks and documents (see Sharing).')),
    ]],
    ['start', 'Getting started', [
      p('Project Tracker lets your team keep every project in one place: its status, priority, dates, progress, task list, documents, network topologies and comments. You can also share a read-only link with someone who has no account.'),
      h('h3', null, 'Quick start'),
      ol(['Sign in as a Project Owner, then click ', b('+ New project'), '. (Admins do not create projects: they create the Project Owner users and share dashboards.)'],
        'Fill in the name, status, priority and dates, and save.',
        ['On the project page add your ', b('tasks'), ', upload ', b('documents'), ' and ', b('topologies'), '.'],
        'Update the status of each task as work moves forward; the progress bar follows.',
        ['Share the project or your dashboard with a link if someone without an account needs to follow it, and use ', b('Comments'), ' to talk about it.']),
      h('h3', null, 'Roles'),
      h('div', { class: 'table-wrap' }, h('table', null,
        h('thead', null, h('tr', null, ['Role', 'What you can do'].map((t) => h('th', null, t)))),
        h('tbody', null,
          h('tr', null, h('td', null, b('Admin')), h('td', null, 'Everything: sees all projects, manages users, roles and passwords and creates share links. An admin does not own projects: every project belongs to a Project Owner.')),
          h('tr', null, h('td', null, b('Project Owner')), h('td', null, 'Create projects. See, edit, delete and manage ONLY their own projects (they cannot see other owners\' projects). Comment on their own projects. Share their own projects and their own dashboard.')),
          h('tr', null, h('td', null, b('Reviewer')), h('td', null, 'View all projects, tasks, documents and topologies, and add comments. Nothing else. (Reviewers are meant to review, so they see every project.)'))))),
      note('You are signed in as ', b(ROLE[role]), '. Sections below that need a higher role are marked.'),
      h('h3', null, 'Signing in and your password'),
      ol('Open the site address you were given and enter the username and password your admin created for you.',
        ['To change your password click the ', b('key icon'), ' at the top right, type the current one and a new one (at least 8 characters).'],
        'Forgot it? Ask an admin to reset it from the Users page.',
        ['Click ', b('Sign out'), ' when you finish, especially on a shared computer.']),
    ]],
    ['list', 'The Projects page', [
      p('After signing in you see every project as a card, like a list of sessions. Click ', b('View'), ' on a card to open the project.'),
      ul(h('span', null, b('Counters'), ' at the top: how many projects there are in total, per status, how many are due soon and how many are overdue.'),
        h('span', null, b('Sort By'), ' (newest, oldest, name, due date, status, priority or progress), plus search by name, description or owner, and filters for status and priority.'),
        h('span', null, 'Each card shows the status, priority, progress bar, start and due dates and owner as blue pills, with the number of comments and topologies. Admins and owners also get an ', b('Edit'), ' action on the card.'),
        h('span', null, 'Cards with an orange stripe on the left are due within 7 days; red means overdue.'),
        h('span', null, 'The menu on the left (Projects, Users for admins, How to use) takes you around the app; the key and arrow icons at the top right change your password and sign out.'),
        h('span', null, 'A ', b('due soon / overdue'), ' button and a pop-up (once per day) list the projects that need attention.')),
    ]],
    ['due', 'Due dates and warnings', [
      ul('Every project can have a start date and a due date. If a project has no deadline, tick ' + '"No due date" when you create or edit it.',
        'A project due within 7 days is marked orange ("due soon"); one past its due date is marked red ("overdue"). You see this in the list rows, the counters and on the project page.',
        'When something is due soon or overdue, a pop-up lists those projects the first time you open the Projects page each day. The orange button at the top of the page opens the same list at any time.',
        'Projects with status Done or without a due date never raise a warning.'),
    ]],
    ['create', 'Create a project', [
      p(roleTag('Project Owner')),
      ol(['On the Projects page click ', b('+ New project'), '.'],
        ['Enter a ', b('name'), ' and, optionally, a description.'],
        ['Choose the ', b('status'), ' (Pending, In Progress, On Hold, Done) and ', b('priority'), ' (Low, Medium, High).'],
        ['Pick the ', b('start date'), ' and ', b('due date'), '. If there is no deadline tick ', b('No due date'), '.'],
        'Choose how the progress is calculated (see Progress below). The new project automatically belongs to you.',
        ['Click ', b('Save'), '. The new project opens so you can add tasks and topologies.']),
      h('h3', null, 'Edit or delete a project'),
      ul('Open the project and click Edit to change any field, or use the Status and Priority drop-downs on the page for a quick change.',
        'Delete removes the project with all its tasks, documents, comments and topologies. This cannot be undone.'),
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
        ['Type the task in the box and click ', b('Add task'), '. A new task starts as Not started (0%).'],
        ['Every task has its own bar and a ', b('status'), ' drop-down: ', b('Not started'), ' (0%, the default), ', b('In progress'), ' (starts at 50%) and ', b('Completed'), ' (100%). Change the status yourself when the work changes; nothing is changed automatically.'],
        ['Click ', b('Edit'), ' on a task to rename it, change its status and, for In progress, set its own percentage with the slider. Then ', b('Save'), ' (or Cancel).'],
        ['Click ', b('Delete'), ' to remove a task.']),
      p(b('Colours:'), ' a task is ', h('span', { style: 'color:var(--done);font-weight:700' }, 'green with a check sign'), ' when Completed, ', h('span', { style: 'color:var(--hold);font-weight:700' }, 'orange with a clock'), ' when In progress and ', h('span', { style: 'color:var(--muted);font-weight:700' }, 'grey with an empty circle'), ' when Not started. Its bar uses the same colour.'),
      p('Tasks are numbered 1, 2, 3 … in the order you added them, so you can refer to them (\ for example ', b('Tasks (3/8 completed)'), ', and the project progress bar updates right away when the project is in Automatic mode.'),
    ]],
    ['documents', 'Documents', [
      p(roleTag('Admin / Owner of the project'), ' can upload and delete. Everyone, including people with a share link, can read them.'),
      ol(['Open the project and find the ', b('Documents'), ' card.'],
        ['Click the file picker and choose one or more files: ', b('PDF'), ', ', b('Word (.docx)'), ' or ', b('HTML'), ', up to 20 MB each and 20 documents per project.'],
        ['Click ', b('View'), ' next to a document to read it here in the browser, without downloading or installing anything.'],
        ['Use ', b('Delete'), ' to remove a document.']),
      ul('PDFs open in the browser PDF viewer.',
        'Word files are converted to a web page. Simple formatting, tables and pictures are kept; complex layouts (text boxes, some fonts) may look different from Word. Old .doc files are not supported: save them as .docx first.',
        'HTML files run inside a protected frame: tabs, menus and other built-in scripts work, but the page cannot reach this site, your login or the internet (no forms, no data sent out). Pictures, styles and fonts must be inside the file itself (or load from https).'),
    ]],
    ['topologies', 'Topologies (images)', [
      p(roleTag('Admin / Owner of the project'), ' can upload and delete. Everyone can view.'),
      ol(['Open the project and use the file picker in the ', b('Topologies'), ' card. You can select several images at once.'],
        'Accepted formats: PNG, JPEG, GIF, WebP. Up to 20 images per project. Big images are compressed automatically.',
        [b('Paste a screenshot:'), ' take it (Windows: Win+Shift+S), open the project and press ', b('Ctrl+V'), ' anywhere on the page, or click ', b('Paste screenshot'), '. It is added to the gallery straight away; no need to save a file first.'],
        'Click an image to enlarge it. Click it again inside the viewer to switch between fit-to-screen and full size.',
        ['Use ', b('Delete'), ' under an image to remove it.']),
      note('Topologies are protected: they carry a watermark with your name, and right-click, drag, save and print are blocked. A screenshot cannot be fully prevented, so share them only with people who should see them.'),
    ]],
    ['comments', 'Comments', [
      p('Everyone, including reviewers, can comment. Comments look like a chat: your messages are on the right, everyone else\'s on the left with their initials, and the newest message is at the bottom. The box starts small and grows as messages are added, up to 6 messages; after that it scrolls. Use the mouse wheel or the Up and Down buttons next to the title to see older messages.'),
      ol(['Scroll to the ', b('Comments'), ' card at the bottom of a project.'], ['Type your message and click ', b('Post comment'), '.'],
        ['To change something you wrote, click ', b('Edit'), ' under your message, change the text and click ', b('Save'), '. The message then shows ', b('(edited)'), '. You can only edit your own messages.'],
        'You can delete your own comments with Delete. Admins can delete any comment.'),
      p('People using a share link type their name before commenting, and their comments carry a ', badge('role', 'guest'), ' tag.'),
    ]],
    ['share', 'Sharing without an account', [
      p('Share links let a third person follow a project without a username. They see the status, progress bar, tasks, documents (with the viewer) and topologies, and can add comments only; they cannot change anything, and they do not see the Users page or other accounts.'),
      h('h3', null, 'Share one project'),
      p(roleTag('Admin / Owner of the project')),
      ol(['Open the project and scroll to ', b('Share with a 3rd person'), '.'],
        ['Click ', b('Create share link'), ', then ', b('Copy link'), ' and send it.'],
        [b('Regenerate link'), ' makes a new link and the old one stops working. ', b('Disable'), ' turns sharing off.']),
      h('h3', null, 'Share your dashboard (project owners)'),
      p(roleTag('Project Owner')),
      ol(['On the Projects page click ', b('Share dashboard'), ', then ', b('Create dashboard link'), ' and ', b('Copy link'), '.'],
        'Whoever opens the link sees the list of YOUR projects with status, progress and dates, can open any of them, see its tasks, documents and topologies and add comments. They never see other owners\' projects.',
        'Use Regenerate or Disable at any time to cut off access.'),
      h('h3', null, 'Share the dashboard (admin): all users or only some'),
      p(roleTag('Admin')),
      ol(['Click ', b('Share dashboard'), ' on the Projects page.'],
        ['In ', b('Create a new link'), ' type an optional name (for example "Customer review") and open the ', b('Whose projects?'), ' dropdown.'],
        ['Tick ', b('All users'), ' to include every project, or untick it and tick only the Project Owners whose projects you want to share (the list shows Project Owners only; admins do not own projects).'],
        ['Click ', b('Create link'), ', then ', b('Copy link'), ' and send it.'],
        'You can create as many links as you like, each for a different audience. In the list use Change users to add or remove users, Regenerate to make a new address (the old one stops working) or Delete to remove the link. The page the visitor sees says whose projects they are looking at.'),
      note('Anyone who has a link can use it, so send it only to the right people and disable it when it is no longer needed.'),
    ]],
    ['owners', 'Users and their projects (admin view)', [
      p(roleTag('Admin')),
      ul(['Admins have no Projects tab in the left menu. Click your ', b('name at the top left'), ' (the pill with the small arrow) and choose ', b('Projects'), '. For privacy this page does not list other people\'s projects; it shows a notice with two options.'],
        [b('Users'), ' in the menu on the left has a small arrow: open it to see a sub-menu with every user. Click a user to open their page, which shows their name, role and how many projects they have, but ', b('keeps the projects hidden'), '. Click ', b('Show projects'), ' only if you really need to see them, and ', b('Hide projects'), ' to hide them again.'],
        [b('Show all projects'), ' on the Projects page displays everything at once. Use ', b('Hide projects'), ' at the top to hide them again.'],
        'Click the word Users (not the arrow) to manage accounts: add users, change roles, reset passwords and delete users.',
        'The projects are hidden again every time the page is reloaded or you sign in again. The due-soon pop-up is not shown to the admin while projects are hidden.'),
      note('This hides projects on screen only. An admin account can still open any project and, like always, has full rights in the database.'),
    ]],    ['logs', 'Activity log (admin)', [
      p(roleTag('Admin')),
      ul(['Click ', b('Activity log'), ' in the menu on the left. Only admins can see it.'],
        'It records what happens in the app: sign-ins and sign-outs, password changes, opening projects and documents, creating, editing and deleting projects, tasks, documents, topologies and comments, user changes (new users, role changes, password resets, deletions) and sharing links. Comments from share-link visitors are recorded as Guest.',
        'Each line shows when it happened, who did it, the action, the project it concerns and the details (for example status: pending -> done).',
        'Use the search box, the Category list and the User list to find something. Refresh loads the newest entries and Export CSV saves the filtered list as a file.',
        b('Every entry is deleted automatically 72 hours (3 days) after it was recorded.'), ' The last column shows how many hours each entry has left. Export the CSV first if you need to keep a record.'),
      note('Secrets are never written to the log: passwords and share-link addresses are not recorded, only that a link was created, regenerated or disabled.'),
    ]],
    ['users', 'Managing users', [
      p(roleTag('Admin')),
      ol(['Click ', b('Users'), ' in the menu on the left.'], 'Add a user with a username, name, password (minimum 8 characters) and role.',
        ['Change a role from the drop-down. Use ', b('Reset password'), ' if someone forgot theirs, and ', b('Delete'), ' to remove an account.'],
        'The last admin cannot be deleted or demoted.'),
      p('Give each person their username and first password privately and ask them to change it after the first sign-in.'),
    ]],
    ['faq', 'Tips and common questions', [
      ul(h('span', null, b('I cannot see my colleague\'s project.'), ' That is intended: project owners only see their own projects. Ask the owner to share a link, or ask an admin.')),
      ul(h('span', null, b('I cannot see New project or Edit.'), ' Only Project Owners create projects, and only the owner of a project (or an admin, for Edit) can change it. Reviewers and admins do not see New project.'),
        h('span', null, b('A change does not appear.'), ' Reload the page (Ctrl+F5).'),
        h('span', null, b('The progress is 0% although I did work.'), ' In Automatic mode set the status of your tasks (In progress or Completed), or switch the project to Manual in Edit.'),
        h('span', null, b('A share link says it is invalid.'), ' The link was disabled or regenerated. Ask the person who shared it for a new one.'),
        h('span', null, b('An image upload fails.'), ' Only PNG, JPEG, GIF and WebP are accepted, up to 20 images per project.'),
        h('span', null, b('A document will not upload or open.'), ' Only PDF, .docx and HTML, up to 20 MB each. Save old .doc files as .docx. If a Word file looks different, that is the converter: open the original in Word for exact layout.'),
        h('span', null, b('The tabs of my HTML file do not work.'), ' They need scripts that are inside the file itself. Scripts loaded from a web link (a CDN) and anything that needs the internet are blocked on purpose.'),
        h('span', null, b('Ctrl+V does not add my screenshot.'), ' Open the project page first (not a pop-up), make sure the clipboard holds an image (Win+Shift+S) and that you are an admin or the project owner. You can also use the Paste screenshot button.')),
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
    document.removeEventListener('paste', pasteHandler);
    pasteHandler = null;
    window.onresize = null;
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
    if (state.user && state.user.role === 'admin' && !state.userList) { try { state.userList = await D.users(); } catch { state.userList = []; } }
    renderTopbar();
    if (!state.user) { renderLogin(); return; }
    const proj = hash.match(/^#\/project\/(\d+)$/);
    if (proj) await renderDetail(Number(proj[1]));
    else if (hash === '#/users') await renderUsers();
    else if (/^#\/user\/[0-9a-f-]{36}$/.test(hash) && state.user.role === 'admin') await renderUserPage(hash.slice(7));
    else if (hash === '#/logs' && state.user.role === 'admin') await renderLogs();
    else if (hash === '#/help') renderHelp();
    else await renderList();
    renderTopbar();
  } catch (e) {
    mount(h('div', { class: 'card' }, h('h2', null, 'Something went wrong'), h('p', null, e.message), h('a', { href: '#/' }, 'Back to projects')));
  }
}
window.addEventListener('hashchange', route);
route();
