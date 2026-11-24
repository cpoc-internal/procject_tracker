// Supabase Edge Function: github-proxy
//
// Lets a project owner store a GitHub token ONCE on the server, so that people who open the project (signed in, or through a
// share link that the owner switched on for that repository) can read the repository's files WITHOUT ever receiving the token.
//
// What it does (and only this):
//   action "set_token"   (signed-in owner/admin of the project)  -> tests the token on GitHub, encrypts it, stores it
//   action "clear_token" (signed-in owner/admin of the project)  -> deletes the stored token
//   action "get"         (signed-in user who can see the project, or a valid share link for a repository that is "on share links")
//                         -> reads ONE path of the LINKED repository (inside the linked folder) from GitHub and returns it
//
// Safety rules enforced here:
//   * the token is encrypted with AES-GCM; the key comes from the function secret GH_TOKEN_KEY (never stored in the database)
//   * a request can never name a repository or server: they come from the database row of the linked repository
//   * only GET on /repos/<owner>/<name>/contents/<path> is ever sent to GitHub; ".." paths and paths outside the linked folder are refused
//   * only hosts listed in GH_ALLOWED_HOSTS (default: api.github.com) are contacted
//   * file bodies over 25 MB are refused; GitHub's temporary download links are removed from the answers
//
// Deploy: see README ("Private repositories on share links"). Turn OFF "Verify JWT" for this function (the site uses a publishable key).

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';

const CORS: any = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (obj: any, status = 200) => new Response(JSON.stringify(obj), { status, headers: { ...CORS, 'content-type': 'application/json', 'cache-control': 'no-store' } });

const db: any = createClient(Deno.env.get('SUPABASE_URL'), Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'), { auth: { persistSession: false } });
const KEY_SECRET: string = Deno.env.get('GH_TOKEN_KEY') || '';
const ALLOWED_HOSTS: string[] = ['api.github.com', ...(Deno.env.get('GH_ALLOWED_HOSTS') || '').split(',').map((s: string) => s.trim().toLowerCase()).filter(Boolean)];
const MAX_BYTES = 25 * 1024 * 1024;

// ----- encryption of the stored token -----
async function aesKey(): Promise<any> {
  if (KEY_SECRET.length < 16) throw new Error('The function secret GH_TOKEN_KEY is missing or too short (use at least 32 random characters).');
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(KEY_SECRET));
  return crypto.subtle.importKey('raw', hash, 'AES-GCM', false, ['encrypt', 'decrypt']);
}
const toB64 = (u8: any) => { let s = ''; u8.forEach((b: number) => { s += String.fromCharCode(b); }); return btoa(s); };
const fromB64 = (b64: string) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
async function encryptToken(plain: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await aesKey(), new TextEncoder().encode(plain)));
  const out = new Uint8Array(12 + ct.length); out.set(iv); out.set(ct, 12);
  return toB64(out);
}
async function decryptToken(b64: string): Promise<string> {
  const all = fromB64(b64);
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: all.slice(0, 12) }, await aesKey(), all.slice(12));
  return new TextDecoder().decode(plain);
}

// ----- GitHub -----
const hostAllowed = (apiBase: string): boolean => { try { const u = new URL(apiBase); return u.protocol === 'https:' && ALLOWED_HOSTS.includes(u.host.toLowerCase()); } catch { return false; } };
const encPath = (p: string) => p.split('/').filter(Boolean).map(encodeURIComponent).join('/');
function ghHeaders(token: string, raw: boolean): any {
  const h: any = { Accept: raw ? 'application/vnd.github.raw+json' : 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'project-tracker-github-proxy' };
  if (token) h.Authorization = 'Bearer ' + token;
  return h;
}
// a path that stays inside the linked folder (no "..", no backslashes)
function safePath(requested: string, base: string): string | null {
  const clean = (s: string) => String(s || '').replace(/^\/+|\/+$/g, '');
  const p = clean(requested), b = clean(base);
  if (p.includes('\\') || p.split('/').some((s: string) => s === '..' || s === '.')) return null;
  const full = p || b;
  if (b && !(full === b || full.startsWith(b + '/'))) return null;
  return full;
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);
  let body: any;
  try { body = await req.json(); } catch { return json({ error: 'Bad request' }, 400); }
  const action = String(body.action || '');
  const repoId = Number(body.repo_id);
  if (!Number.isInteger(repoId) || repoId < 1) return json({ error: 'Bad repository' }, 400);

  // who is calling: a signed-in user (their access token), or nobody (a share-link visitor)
  let userId: string | null = null;
  const authHeader = req.headers.get('authorization') || '';
  const jwt = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  if (jwt && !jwt.startsWith('sb_')) {
    const { data } = await db.auth.getUser(jwt);
    userId = (data && data.user && data.user.id) || null;
  }

  try {
    // ----- store / remove the token (owner or admin only) -----
    if (action === 'set_token' || action === 'clear_token') {
      if (!userId) return json({ error: 'Sign in first.' }, 401);
      const { data: canEdit } = await db.rpc('gh_proxy_can_edit', { p_repo_id: repoId, p_user_id: userId });
      if (canEdit !== true) return json({ error: 'Only the project owner or an admin can do this.' }, 403);
      if (action === 'clear_token') {
        await db.from('repo_secrets').delete().eq('repo_id', repoId);
        await db.from('project_repos').update({ has_server_token: false }).eq('id', repoId);
        await db.rpc('gh_proxy_audit', { p_repo_id: repoId, p_user_id: userId, p_action: 'clear' });
        return json({ ok: true });
      }
      const token = String(body.token || '').trim();
      if (token.length < 20 || token.length > 400) return json({ error: 'That does not look like a GitHub token.' }, 400);
      const { data: row } = await db.rpc('gh_proxy_repo', { p_repo_id: repoId });
      if (!row || !hostAllowed(row.api_base)) return json({ error: 'This GitHub server is not allowed. The administrator must list it in the function secret GH_ALLOWED_HOSTS.' }, 400);
      const test = await fetch(`${row.api_base}/repos/${row.repo}`, { headers: ghHeaders(token, false) });
      if (!test.ok) return json({ error: test.status === 401 ? 'GitHub rejected the token.' : test.status === 404 ? 'This token cannot see that repository (check the repository and the token permissions).' : 'GitHub answered ' + test.status + '.' }, 400);
      const meta: any = await test.json();
      const saved = await db.from('repo_secrets').upsert({ repo_id: repoId, token_enc: await encryptToken(token), saved_by: userId, saved_at: new Date().toISOString() });
      if (saved.error) return json({ error: 'Could not store the token (has supabase-update-github.sql been run?): ' + saved.error.message }, 500);
      const flagged = await db.from('project_repos').update({ has_server_token: true }).eq('id', repoId);
      if (flagged.error) return json({ error: 'Could not update the repository: ' + flagged.error.message }, 500);
      await db.rpc('gh_proxy_audit', { p_repo_id: repoId, p_user_id: userId, p_action: 'set' });
      return json({ ok: true, private: !!meta.private, full_name: meta.full_name });
    }

    // ----- read one path (signed-in user who sees the project, or a valid share link) -----
    if (action === 'get') {
      const { data: row } = await db.rpc('gh_proxy_authorize', { p_repo_id: repoId, p_share_token: body.share_token || null, p_user_id: userId });
      if (!row) return json({ error: 'Not available', status: 403 }, 403);
      if (!hostAllowed(row.api_base)) return json({ error: 'Not available', status: 403 }, 403);
      const path = safePath(String(body.path || ''), row.path);
      if (path === null) return json({ error: 'Not available', status: 403 }, 403);
      let token = '';
      if (row.has_server_token) {
        const { data: sec } = await db.from('repo_secrets').select('token_enc').eq('repo_id', repoId).maybeSingle();
        if (sec) token = await decryptToken(sec.token_enc);
      }
      const raw = body.raw === true;
      const url = `${row.api_base}/repos/${row.repo}/contents${path ? '/' + encPath(path) : ''}${row.branch ? '?ref=' + encodeURIComponent(row.branch) : ''}`;
      const gh = await fetch(url, { headers: ghHeaders(token, raw) });
      if (!gh.ok) {
        const rate = gh.headers.get('x-ratelimit-remaining') === '0';
        const msg = gh.status === 401 ? 'The stored token was rejected by GitHub. The project owner must save a new one.' : rate ? 'GitHub rate limit reached. Try again later.' : gh.status === 404 ? 'Not found.' : 'GitHub answered ' + gh.status + '.';
        return json({ error: msg, status: gh.status === 401 ? 502 : gh.status, rate }, gh.status === 401 ? 502 : (gh.status === 404 ? 404 : (rate ? 429 : 502)));
      }
      if (raw) {
        const len = Number(gh.headers.get('content-length') || 0);
        if (len > MAX_BYTES) return json({ error: 'File too large', status: 413 }, 413);
        return new Response(gh.body, { status: 200, headers: { ...CORS, 'content-type': 'application/octet-stream', 'cache-control': 'no-store' } });
      }
      // directory listing or one file's details: keep only what the viewer needs (no temporary download links)
      const data: any = await gh.json();
      const slim = (e: any) => ({ name: e.name, path: e.path, type: e.type, size: e.size || 0, html_url: userId ? e.html_url : undefined });
      return json(Array.isArray(data) ? data.map(slim) : slim(data));
    }
    return json({ error: 'Unknown action' }, 400);
  } catch (e: any) {
    return json({ error: String((e && e.message) || e) }, 500);
  }
});
