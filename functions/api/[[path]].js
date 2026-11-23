// Cloudflare Pages Function: the whole backend API (/api/*), backed by D1 (binding name: DB)

const STATUSES = ['pending', 'in_progress', 'hold', 'done'];
const PRIORITIES = ['low', 'medium', 'high'];
const ROLES = ['admin', 'owner', 'reviewer'];
const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
const MAX_IMAGE_B64 = 1_800_000; // D1 rows are limited to ~2MB
const SESSION_SECONDS = 7 * 24 * 3600;
const enc = new TextEncoder();

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const bad = (m) => new HttpError(400, m);
const forbidden = (m = 'Not allowed') => new HttpError(403, m);
const notFound = (m = 'Not found') => new HttpError(404, m);

const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers },
  });
const now = () => Math.floor(Date.now() / 1000);

// ---------- crypto ----------
const bytesToB64 = (b) => { let s = ''; for (const x of b) s += String.fromCharCode(x); return btoa(s); };
const b64ToBytes = (s) => { const bin = atob(s); const o = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) o[i] = bin.charCodeAt(i); return o; };
const hex = (b) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');

async function pbkdf2(pw, salt) {
  const key = await crypto.subtle.importKey('raw', enc.encode(pw), 'PBKDF2', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 100000 }, key, 256));
}
async function hashPassword(pw) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return bytesToB64(salt) + ':' + bytesToB64(await pbkdf2(pw, salt));
}
async function verifyPassword(pw, stored) {
  const [s, h] = stored.split(':');
  const got = await pbkdf2(pw, b64ToBytes(s));
  const want = b64ToBytes(h);
  let d = got.length ^ want.length;
  for (let i = 0; i < got.length; i++) d |= got[i] ^ want[i];
  return d === 0;
}
async function sha256Hex(s) {
  return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(s))));
}
const randomToken = (n = 32) => hex(crypto.getRandomValues(new Uint8Array(n)));
const DUMMY_HASH = bytesToB64(new Uint8Array(16)) + ':' + bytesToB64(new Uint8Array(32));

// ---------- helpers ----------
function getCookie(request, name) {
  const c = request.headers.get('cookie') || '';
  for (const part of c.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return null;
}
const sessionCookie = (token, maxAge) =>
  `session=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${maxAge}`;

async function readJson(request) {
  try { return (await request.json()) || {}; } catch { throw bad('Invalid JSON body'); }
}
const str = (v, max, field, { required = false } = {}) => {
  const s = typeof v === 'string' ? v.trim() : '';
  if (required && !s) throw bad(`${field} is required`);
  if (s.length > max) throw bad(`${field} is too long (max ${max})`);
  return s;
};
const dateStr = (v, field) => {
  if (v === undefined || v === null || v === '') return '';
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v) || isNaN(Date.parse(v))) throw bad(`${field} must be YYYY-MM-DD`);
  return v;
};
const oneOf = (v, list, field) => { if (!list.includes(v)) throw bad(`Invalid ${field}`); return v; };
const toId = (s) => { const n = Number(s); if (!Number.isInteger(n) || n < 1) throw notFound(); return n; };

async function currentUser(request, env) {
  const token = getCookie(request, 'session');
  if (!token) return null;
  const row = await env.DB.prepare(
    `SELECT u.id, u.username, u.display_name, u.role FROM sessions s
     JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ?`
  ).bind(await sha256Hex(token), now()).first();
  return row || null;
}
async function requireUser(request, env) {
  const u = await currentUser(request, env);
  if (!u) throw new HttpError(401, 'Not signed in');
  return u;
}
const canEditProject = (u, p) => u.role === 'admin' || (u.role === 'owner' && p.owner_id === u.id);

async function startSession(env, userId) {
  const token = randomToken();
  await env.DB.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?,?,?)')
    .bind(await sha256Hex(token), userId, now() + SESSION_SECONDS).run();
  return token;
}

function checkPassword(pw) {
  if (typeof pw !== 'string' || pw.length < 8) throw bad('Password must be at least 8 characters');
  if (pw.length > 200) throw bad('Password is too long');
  return pw;
}
function checkUsername(u) {
  if (typeof u !== 'string' || !/^[a-zA-Z0-9._-]{3,32}$/.test(u.trim())) throw bad('Username must be 3-32 characters: letters, numbers, . _ -');
  return u.trim();
}

// ---------- entry ----------
export async function onRequest({ request, env, params }) {
  try {
    if (!env.DB) throw new HttpError(500, 'D1 binding "DB" is not configured');
    const url = new URL(request.url);
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      const origin = request.headers.get('origin');
      if (origin && origin !== url.origin) throw forbidden('Bad origin');
    }
    const segs = [].concat(params.path || []);
    return await route(request, env, url, segs);
  } catch (e) {
    if (e instanceof HttpError) return json({ error: e.message }, e.status);
    console.error(e);
    return json({ error: 'Server error' }, 500);
  }
}

async function route(request, env, url, segs) {
  const m = request.method;
  const [a, b, c] = segs;

  if (a === 'setup-status' && m === 'GET') {
    const r = await env.DB.prepare('SELECT COUNT(*) AS n FROM users').first();
    return json({ needsSetup: r.n === 0 });
  }
  if (a === 'setup' && m === 'POST') return setup(request, env);
  if (a === 'login' && m === 'POST') return login(request, env);
  if (a === 'logout' && m === 'POST') return logout(request, env);
  if (a === 'me' && m === 'GET') return json({ user: await currentUser(request, env) });

  if (a === 'shared') return shared(request, env, b, c, m);
  if (a === 'topologies' && b && m === 'GET') return getTopology(request, env, url, toId(b));

  const user = await requireUser(request, env);

  if (a === 'users') return users(request, env, user, b, m);
  if (a === 'projects') return projects(request, env, user, b, c, segs[3], m);
  if (a === 'topologies' && b && m === 'DELETE') return deleteTopology(env, user, toId(b));
  if (a === 'comments' && b && m === 'DELETE') return deleteComment(env, user, toId(b));
  if (a === 'change-password' && m === 'POST') return changeOwnPassword(request, env, user);

  throw notFound();
}

// ---------- auth ----------
async function setup(request, env) {
  const { username, password, display_name } = await readJson(request);
  const r = await env.DB.prepare('SELECT COUNT(*) AS n FROM users').first();
  if (r.n !== 0) throw forbidden('Setup already completed');
  const u = checkUsername(username);
  const res = await env.DB.prepare(
    `INSERT INTO users (username, display_name, password_hash, role, created_at)
     SELECT ?,?,?, 'admin', ? WHERE NOT EXISTS (SELECT 1 FROM users)`
  ).bind(u, str(display_name, 60, 'Name') || u, await hashPassword(checkPassword(password)), now()).run();
  if (!res.meta.changes) throw forbidden('Setup already completed');
  const row = await env.DB.prepare('SELECT id FROM users WHERE username = ?').bind(u).first();
  const token = await startSession(env, row.id);
  return json({ ok: true }, 200, { 'set-cookie': sessionCookie(token, SESSION_SECONDS) });
}

async function login(request, env) {
  const { username, password } = await readJson(request);
  const row = typeof username === 'string'
    ? await env.DB.prepare('SELECT * FROM users WHERE username = ?').bind(username.trim()).first()
    : null;
  if (row && row.locked_until > now()) throw new HttpError(429, 'Too many failed attempts. Try again in a few minutes.');
  const ok = await verifyPassword(typeof password === 'string' ? password : '', row ? row.password_hash : DUMMY_HASH);
  if (!row || !ok) {
    if (row) {
      const fails = row.failed_count + 1;
      await env.DB.prepare('UPDATE users SET failed_count = ?, locked_until = ? WHERE id = ?')
        .bind(fails >= 5 ? 0 : fails, fails >= 5 ? now() + 900 : 0, row.id).run();
    }
    throw new HttpError(401, 'Invalid username or password');
  }
  await env.DB.prepare('UPDATE users SET failed_count = 0, locked_until = 0 WHERE id = ?').bind(row.id).run();
  await env.DB.prepare('DELETE FROM sessions WHERE expires_at < ?').bind(now()).run();
  const token = await startSession(env, row.id);
  return json({ user: { id: row.id, username: row.username, display_name: row.display_name, role: row.role } },
    200, { 'set-cookie': sessionCookie(token, SESSION_SECONDS) });
}

async function logout(request, env) {
  const token = getCookie(request, 'session');
  if (token) await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(await sha256Hex(token)).run();
  return json({ ok: true }, 200, { 'set-cookie': sessionCookie('', 0) });
}

async function changeOwnPassword(request, env, user) {
  const { current, password } = await readJson(request);
  const row = await env.DB.prepare('SELECT password_hash FROM users WHERE id = ?').bind(user.id).first();
  if (!(await verifyPassword(String(current || ''), row.password_hash))) throw bad('Current password is incorrect');
  await env.DB.prepare('UPDATE users SET password_hash = ? WHERE id = ?')
    .bind(await hashPassword(checkPassword(password)), user.id).run();
  return json({ ok: true });
}

// ---------- users (admin) ----------
async function users(request, env, me, idSeg, m) {
  if (me.role !== 'admin') throw forbidden('Admin only');
  if (!idSeg && m === 'GET') {
    const { results } = await env.DB.prepare(
      'SELECT id, username, display_name, role, created_at FROM users ORDER BY username COLLATE NOCASE').all();
    return json({ users: results });
  }
  if (!idSeg && m === 'POST') {
    const b = await readJson(request);
    const username = checkUsername(b.username);
    const role = oneOf(b.role, ROLES, 'role');
    const dup = await env.DB.prepare('SELECT 1 FROM users WHERE username = ?').bind(username).first();
    if (dup) throw bad('Username already exists');
    await env.DB.prepare('INSERT INTO users (username, display_name, password_hash, role, created_at) VALUES (?,?,?,?,?)')
      .bind(username, str(b.display_name, 60, 'Name') || username, await hashPassword(checkPassword(b.password)), role, now()).run();
    return json({ ok: true }, 201);
  }
  const id = toId(idSeg);
  const target = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(id).first();
  if (!target) throw notFound('User not found');
  const adminCount = async () => (await env.DB.prepare("SELECT COUNT(*) AS n FROM users WHERE role='admin'").first()).n;

  if (m === 'PUT') {
    const b = await readJson(request);
    const role = b.role !== undefined ? oneOf(b.role, ROLES, 'role') : target.role;
    if (target.role === 'admin' && role !== 'admin' && (await adminCount()) <= 1) throw bad('Cannot demote the last admin');
    const display = b.display_name !== undefined ? (str(b.display_name, 60, 'Name') || target.username) : target.display_name;
    const hash = b.password ? await hashPassword(checkPassword(b.password)) : target.password_hash;
    await env.DB.prepare('UPDATE users SET role = ?, display_name = ?, password_hash = ?, failed_count = 0, locked_until = 0 WHERE id = ?')
      .bind(role, display, hash, id).run();
    if (b.password || role !== target.role) await env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(id).run();
    return json({ ok: true });
  }
  if (m === 'DELETE') {
    if (id === me.id) throw bad('You cannot delete your own account');
    if (target.role === 'admin' && (await adminCount()) <= 1) throw bad('Cannot delete the last admin');
    await env.DB.batch([
      env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(id),
      env.DB.prepare('DELETE FROM users WHERE id = ?').bind(id),
    ]);
    return json({ ok: true });
  }
  throw notFound();
}

// ---------- projects ----------
const PROJECT_LIST_SQL = `
  SELECT p.id, p.name, p.description, p.status, p.priority, p.start_date, p.due_date,
         p.owner_id, u.username AS owner_name, p.created_at, p.updated_at,
         (SELECT COUNT(*) FROM comments c WHERE c.project_id = p.id) AS comment_count,
         (SELECT COUNT(*) FROM topologies t WHERE t.project_id = p.id) AS topology_count
  FROM projects p LEFT JOIN users u ON u.id = p.owner_id`;

async function loadDetail(env, projectId, { includeToken }) {
  const p = await env.DB.prepare(PROJECT_LIST_SQL + ' WHERE p.id = ?').bind(projectId).first();
  if (!p) throw notFound('Project not found');
  const topologies = (await env.DB.prepare(
    'SELECT id, name, mime, size, created_at FROM topologies WHERE project_id = ? ORDER BY id').bind(projectId).all()).results;
  const comments = (await env.DB.prepare(
    'SELECT id, user_id, author, is_guest, body, created_at FROM comments WHERE project_id = ? ORDER BY id').bind(projectId).all()).results;
  if (includeToken) {
    const t = await env.DB.prepare('SELECT share_token FROM projects WHERE id = ?').bind(projectId).first();
    p.share_token = t.share_token;
  }
  return { project: p, topologies, comments };
}

async function projects(request, env, user, idSeg, sub, subId, m) {
  if (!idSeg) {
    if (m === 'GET') {
      const { results } = await env.DB.prepare(PROJECT_LIST_SQL + ' ORDER BY p.created_at DESC').all();
      return json({ projects: results });
    }
    if (m === 'POST') {
      if (user.role === 'reviewer') throw forbidden('Reviewers cannot create projects');
      const b = await readJson(request);
      const f = projectFields(b, {});
      const ownerId = user.role === 'admin' && b.owner_id ? await validOwner(env, b.owner_id) : user.id;
      const t = now();
      const r = await env.DB.prepare(
        `INSERT INTO projects (name, description, status, priority, start_date, due_date, owner_id, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?)`
      ).bind(f.name, f.description, f.status, f.priority, f.start_date, f.due_date, ownerId, t, t).run();
      return json({ id: r.meta.last_row_id }, 201);
    }
    throw notFound();
  }

  const id = toId(idSeg);
  const p = await env.DB.prepare('SELECT * FROM projects WHERE id = ?').bind(id).first();
  if (!p) throw notFound('Project not found');
  const editable = canEditProject(user, p);

  if (!sub) {
    if (m === 'GET') {
      const d = await loadDetail(env, id, { includeToken: editable });
      return json({ ...d, perms: { canEdit: editable, canComment: true, userId: user.id, isAdmin: user.role === 'admin' } });
    }
    if (m === 'PUT') {
      if (!editable) throw forbidden();
      const b = await readJson(request);
      const f = projectFields(b, p);
      const ownerId = user.role === 'admin' && b.owner_id ? await validOwner(env, b.owner_id) : p.owner_id;
      await env.DB.prepare(
        `UPDATE projects SET name=?, description=?, status=?, priority=?, start_date=?, due_date=?, owner_id=?, updated_at=? WHERE id=?`
      ).bind(f.name, f.description, f.status, f.priority, f.start_date, f.due_date, ownerId, now(), id).run();
      return json({ ok: true });
    }
    if (m === 'DELETE') {
      if (!editable) throw forbidden();
      await env.DB.batch([
        env.DB.prepare('DELETE FROM comments WHERE project_id = ?').bind(id),
        env.DB.prepare('DELETE FROM topologies WHERE project_id = ?').bind(id),
        env.DB.prepare('DELETE FROM projects WHERE id = ?').bind(id),
      ]);
      return json({ ok: true });
    }
    throw notFound();
  }

  if (sub === 'comments' && m === 'POST') {
    const b = await readJson(request);
    const body = str(b.body, 2000, 'Comment', { required: true });
    await env.DB.prepare('INSERT INTO comments (project_id, user_id, author, is_guest, body, created_at) VALUES (?,?,?,0,?,?)')
      .bind(id, user.id, user.display_name || user.username, body, now()).run();
    return json({ ok: true }, 201);
  }

  if (sub === 'topologies' && m === 'POST') {
    if (!editable) throw forbidden();
    const b = await readJson(request);
    const mime = oneOf(b.mime, IMAGE_TYPES, 'image type');
    const name = str(b.name, 120, 'Name', { required: true });
    if (typeof b.data !== 'string' || !/^[A-Za-z0-9+/]+=*$/.test(b.data)) throw bad('Invalid image data');
    if (b.data.length > MAX_IMAGE_B64) throw bad('Image is too large (max ~1.3 MB after compression)');
    const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM topologies WHERE project_id = ?').bind(id).first();
    if (count.n >= 20) throw bad('Maximum of 20 topologies per project');
    await env.DB.prepare('INSERT INTO topologies (project_id, name, mime, size, data, uploaded_by, created_at) VALUES (?,?,?,?,?,?,?)')
      .bind(id, name, mime, Math.floor(b.data.length * 0.75), b.data, user.id, now()).run();
    await env.DB.prepare('UPDATE projects SET updated_at = ? WHERE id = ?').bind(now(), id).run();
    return json({ ok: true }, 201);
  }

  if (sub === 'share') {
    if (!editable) throw forbidden();
    if (m === 'POST') {
      const token = randomToken(24);
      await env.DB.prepare('UPDATE projects SET share_token = ? WHERE id = ?').bind(token, id).run();
      return json({ share_token: token });
    }
    if (m === 'DELETE') {
      await env.DB.prepare('UPDATE projects SET share_token = NULL WHERE id = ?').bind(id).run();
      return json({ ok: true });
    }
  }
  throw notFound();
}

function projectFields(b, base) {
  const name = str(b.name !== undefined ? b.name : base.name, 120, 'Name', { required: true });
  const description = str(b.description !== undefined ? b.description : base.description, 5000, 'Description');
  const status = oneOf(b.status !== undefined ? b.status : base.status || 'pending', STATUSES, 'status');
  const priority = oneOf(b.priority !== undefined ? b.priority : base.priority || 'medium', PRIORITIES, 'priority');
  const start_date = dateStr(b.start_date !== undefined ? b.start_date : base.start_date, 'Start date');
  const due_date = dateStr(b.due_date !== undefined ? b.due_date : base.due_date, 'Due date');
  if (start_date && due_date && due_date < start_date) throw bad('Due date cannot be before start date');
  return { name, description, status, priority, start_date, due_date };
}
async function validOwner(env, v) {
  const id = toId(v);
  const r = await env.DB.prepare("SELECT id, role FROM users WHERE id = ?").bind(id).first();
  if (!r || r.role === 'reviewer') throw bad('Owner must be an admin or project owner user');
  return id;
}

// ---------- topologies / comments ----------
async function getTopology(request, env, url, id) {
  const t = await env.DB.prepare(
    'SELECT t.mime, t.data, p.share_token FROM topologies t JOIN projects p ON p.id = t.project_id WHERE t.id = ?').bind(id).first();
  if (!t) throw notFound();
  const shareToken = url.searchParams.get('t');
  const viaShare = shareToken && t.share_token && shareToken === t.share_token;
  if (!viaShare && !(await currentUser(request, env))) throw new HttpError(401, 'Not signed in');
  return new Response(b64ToBytes(t.data), {
    headers: {
      'content-type': t.mime,
      'cache-control': 'private, max-age=3600',
      'x-content-type-options': 'nosniff',
      'content-security-policy': "sandbox; default-src 'none'",
    },
  });
}
async function deleteTopology(env, user, id) {
  const t = await env.DB.prepare('SELECT p.owner_id FROM topologies t JOIN projects p ON p.id = t.project_id WHERE t.id = ?').bind(id).first();
  if (!t) throw notFound();
  if (!canEditProject(user, t)) throw forbidden();
  await env.DB.prepare('DELETE FROM topologies WHERE id = ?').bind(id).run();
  return json({ ok: true });
}
async function deleteComment(env, user, id) {
  const c = await env.DB.prepare('SELECT user_id FROM comments WHERE id = ?').bind(id).first();
  if (!c) throw notFound();
  if (user.role !== 'admin' && c.user_id !== user.id) throw forbidden();
  await env.DB.prepare('DELETE FROM comments WHERE id = ?').bind(id).run();
  return json({ ok: true });
}

// ---------- public read-only share link (view + comment only) ----------
async function shared(request, env, token, sub, m) {
  if (!token || !/^[a-f0-9]{20,}$/.test(token)) throw notFound();
  const p = await env.DB.prepare('SELECT id FROM projects WHERE share_token = ?').bind(token).first();
  if (!p) throw notFound('This link is invalid or has been disabled');
  if (!sub && m === 'GET') {
    const d = await loadDetail(env, p.id, { includeToken: false });
    return json({ ...d, perms: { canEdit: false, canComment: true, shared: true } });
  }
  if (sub === 'comments' && m === 'POST') {
    const b = await readJson(request);
    const author = str(b.author, 50, 'Name', { required: true });
    const body = str(b.body, 2000, 'Comment', { required: true });
    const n = await env.DB.prepare('SELECT COUNT(*) AS n FROM comments WHERE project_id = ? AND is_guest = 1 AND created_at > ?')
      .bind(p.id, now() - 3600).first();
    if (n.n >= 30) throw new HttpError(429, 'Too many guest comments, try again later');
    await env.DB.prepare('INSERT INTO comments (project_id, user_id, author, is_guest, body, created_at) VALUES (?,NULL,?,1,?,?)')
      .bind(p.id, author, body, now()).run();
    return json({ ok: true }, 201);
  }
  throw notFound();
}
