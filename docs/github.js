'use strict';
// GitHub: link repositories to a project and browse / preview their files (also from private repositories).
//
// SECURITY MODEL
//  * The database stores only the REFERENCE to a repository (server, owner/name, branch, folder). Never a token.
//  * Each person keeps their own access token in THEIR OWN browser (this device), and the browser talks to GitHub directly.
//    The token is never sent to Supabase, never written to the page, the repository or the activity log.
//  * By default the token is kept only until the tab is closed (sessionStorage). "Remember on this device" keeps it in localStorage.
//  * A repository linked by one person is only readable by another person if THEY also have access on GitHub (their own token).
// Uses h(), icon(), toast(), openDialog(), guard(), D, state from app.js and renderPreview() from preview.js (only when called).

const GH_API_DEFAULT = 'https://api.github.com';

// ----- the token of this browser -----
const ghKey = (api) => 'ghtoken:' + api;
function ghGetToken(api) { try { return sessionStorage.getItem(ghKey(api)) || localStorage.getItem(ghKey(api)) || ''; } catch { return ''; } }
function ghRemembered(api) { try { return !!localStorage.getItem(ghKey(api)); } catch { return false; } }
function ghClearToken(api) { try { sessionStorage.removeItem(ghKey(api)); localStorage.removeItem(ghKey(api)); } catch { /* ignore */ } }
function ghSetToken(api, token, remember) {
  ghClearToken(api);
  try { (remember ? localStorage : sessionStorage).setItem(ghKey(api), token); } catch { /* ignore */ }
}

// ----- talking to GitHub -----
class GhError extends Error { constructor(message, status) { super(message); this.status = status; } }
async function ghRequest(api, path, { raw = false, token } = {}) {
  const tok = token !== undefined ? token : ghGetToken(api);
  const headers = { Accept: raw ? 'application/vnd.github.raw+json' : 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
  if (tok) headers.Authorization = 'Bearer ' + tok;
  let res;
  try { res = await fetch(api + path, { headers, cache: 'no-store' }); }
  catch { throw new GhError('Cannot reach GitHub from this browser (network, firewall or blocked by the server). For GitHub Enterprise, ask IT to allow this site to call its API.', 0); }
  if (res.ok) return res;
  if (res.status === 401) throw new GhError(tok ? 'GitHub rejected the token (wrong, expired or revoked). Open Credentials and enter a new one.' : 'GitHub needs credentials for this. Open Credentials and add a token.', 401);
  if (res.status === 403) {
    if (res.headers.get('x-ratelimit-remaining') === '0') throw new GhError('GitHub rate limit reached' + (tok ? '.' : ' (anonymous access is limited). Add credentials in Credentials to get a much higher limit.') + ' Try again in a while.', 403);
    throw new GhError('GitHub refused access (403). The token may lack permission for this repository, or your organisation requires the token to be authorised for SAML SSO.', 403);
  }
  if (res.status === 404) throw new GhError(tok ? 'Not found, or this token has no access to it. Check the name, and that the token can read this repository (Contents: read).' : 'Not found, or it is a private repository. Private repositories need credentials: open Credentials and add a token.', 404);
  throw new GhError('GitHub answered with an error (' + res.status + ').', res.status);
}
const ghEncodePath = (p) => String(p || '').split('/').filter(Boolean).map(encodeURIComponent).join('/');
const ghContentsUrl = (link, path) => `/repos/${link.repo}/contents${path ? '/' + ghEncodePath(path) : ''}${link.branch ? '?ref=' + encodeURIComponent(link.branch) : ''}`;
async function ghList(link, path) {
  const data = await (await ghRequest(link.api_base, ghContentsUrl(link, path))).json();
  if (Array.isArray(data)) {
    const entries = data.map((e) => ({ name: e.name, path: e.path, type: e.type, size: e.size || 0, html_url: e.html_url }))
      .sort((a, b) => (a.type === 'dir' ? 0 : 1) - (b.type === 'dir' ? 0 : 1) || a.name.localeCompare(b.name));
    return { entries };
  }
  return { file: { name: data.name, path: data.path, type: 'file', size: data.size || 0, html_url: data.html_url } };
}
async function ghFileBytes(link, path) { return (await ghRequest(link.api_base, ghContentsUrl(link, path), { raw: true })).arrayBuffer(); }

// "owner/name" or a pasted web address (github.com or an enterprise server), optionally with /tree/<branch>/<folder>
function parseRepoInput(text) {
  const s = String(text || '').trim().replace(/\/+$/, '').replace(/\.git$/, '');
  if (!s) return null;
  const short = s.match(/^([A-Za-z0-9._-]{1,100})\/([A-Za-z0-9._-]{1,100})$/);
  if (short) return { api: GH_API_DEFAULT, repo: `${short[1]}/${short[2]}`, branch: '', path: '' };
  try {
    const u = new URL(s);
    if (u.protocol !== 'https:') return null;
    const parts = u.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    if (parts.length < 2) return null;
    const api = /^(www\.)?github\.com$/i.test(u.hostname) ? GH_API_DEFAULT : `https://${u.host}/api/v3`;
    const out = { api, repo: `${parts[0]}/${parts[1].replace(/\.git$/, '')}`, branch: '', path: '' };
    if ((parts[2] === 'tree' || parts[2] === 'blob') && parts[3]) { out.branch = parts[3]; out.path = parts.slice(4).join('/'); }
    return /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(out.repo) ? out : null;
  } catch { return null; }
}

// ----- Credentials dialog -----
function ghCredentialsDialog(apiHint, done) {
  const api = h('input', { value: apiHint || GH_API_DEFAULT, 'aria-label': 'GitHub API address', autocomplete: 'off' });
  const tokenInput = h('input', { type: 'password', autocomplete: 'off', spellcheck: 'false', placeholder: 'Paste a personal access token (github_pat_… or ghp_…)' });
  const remember = h('input', { type: 'checkbox' });
  const status = h('div', { class: 'muted small' });
  const result = h('div', { class: 'gh-result' });
  const showState = () => {
    const a = api.value.trim().replace(/\/+$/, '');
    const has = !!ghGetToken(a);
    status.textContent = has ? (ghRemembered(a) ? 'A token is saved on this device for this server.' : 'A token is kept in this tab until you close it.') : 'No token saved in this browser for this server (public repositories still work).';
    remember.checked = ghRemembered(a);
  };
  api.addEventListener('input', showState);
  const say = (ok, text) => result.replaceChildren(h('p', { class: ok ? 'gh-ok' : 'error' }, text));
  const save = async () => {
    const a = api.value.trim().replace(/\/+$/, '');
    if (!/^https:\/\/[A-Za-z0-9.-]+(:\d+)?(\/[A-Za-z0-9._~/-]*)?$/.test(a)) return say(false, 'The server must be a https:// address, for example https://api.github.com');
    const tok = tokenInput.value.trim();
    if (!tok) return say(false, 'Paste a token first (or use Remove to delete the saved one).');
    say(true, 'Testing access…');
    try {
      const me = await (await ghRequest(a, '/user', { token: tok })).json();   // proves the token works; nothing else is read
      ghSetToken(a, tok, remember.checked);
      tokenInput.value = '';
      say(true, `Connected as ${me.login}. The token is stored only in this browser${remember.checked ? ' (remembered on this device)' : ' (until you close this tab)'}.`);
      showState();
      if (done) done();
    } catch (e) { say(false, e.message); }
  };
  const dlg = openDialog(h('div', null,
    h('h2', null, 'GitHub credentials'),
    h('p', { class: 'muted small' }, 'Needed only for private repositories (or to avoid GitHub\'s low limit for anonymous access). Your token stays in THIS browser and is sent only to GitHub: it is never saved in the project database, the website files or the activity log. Each person adds their own token.'),
    h('div', { class: 'field' }, h('label', null, 'GitHub server (API address)'), api,
      h('p', { class: 'muted small' }, 'github.com: https://api.github.com. GitHub Enterprise: https://your-server/api/v3')),
    h('div', { class: 'field' }, h('label', null, 'Access token'), tokenInput),
    h('label', { class: 'check' }, remember, 'Remember on this device (otherwise it is forgotten when you close the tab)'),
    status, result,
    h('details', { class: 'gh-help' }, h('summary', null, 'How do I create a token?'),
      h('ol', null,
        h('li', null, 'On GitHub open ', h('b', null, 'Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token'), '.'),
        h('li', null, 'Under ', h('b', null, 'Repository access'), ' choose the repositories you need (or all).'),
        h('li', null, 'Under ', h('b', null, 'Permissions → Repository permissions'), ' set ', h('b', null, 'Contents: Read-only'), ' (Metadata: Read-only is added automatically). Nothing else is needed.'),
        h('li', null, 'Copy the token and paste it above. Give it a short expiry date.'),
        h('li', null, 'If the repository belongs to an organisation that uses SSO, also click ', h('b', null, 'Authorize'), ' for that organisation next to the token.'),
        h('li', null, 'A classic token with the ', h('b', null, 'repo'), ' scope also works, but gives much wider access: prefer a fine-grained, read-only token.'))),
    h('div', { class: 'row', style: 'margin-top:12px' },
      h('button', { class: 'primary', onclick: save }, icon('key'), 'Save and test access'),
      h('button', { class: 'danger', onclick: () => { ghClearToken(api.value.trim().replace(/\/+$/, '')); tokenInput.value = ''; say(true, 'Token removed from this browser.'); showState(); if (done) done(); } }, 'Remove from this browser'),
      h('button', { onclick: () => dlg.close() }, 'Close'))));
  showState();
  tokenInput.focus();
}

// ----- Link a repository to the project -----
function ghLinkDialog(project, done) {
  const repoIn = h('input', { required: true, placeholder: 'owner/name  or  https://github.com/owner/name/tree/main/docs', autocomplete: 'off' });
  const branchIn = h('input', { placeholder: 'default branch', autocomplete: 'off', maxlength: 200 });
  const pathIn = h('input', { placeholder: 'whole repository (or a folder / file, e.g. docs/design.pptx)', autocomplete: 'off', maxlength: 500 });
  const labelIn = h('input', { placeholder: 'optional name shown on the project', maxlength: 80 });
  const sharePub = h('input', { type: 'checkbox' });
  const info = h('div', { class: 'muted small' });
  const result = h('div', { class: 'gh-result' });
  let parsed = null;
  const reparse = () => {
    parsed = parseRepoInput(repoIn.value);
    if (parsed) {
      if (parsed.branch && !branchIn.value) branchIn.value = parsed.branch;
      if (parsed.path && !pathIn.value) pathIn.value = parsed.path;
      const tok = ghGetToken(parsed.api);
      info.textContent = `Server: ${parsed.api}. ${tok ? 'Your saved token will be used.' : 'No token saved in this browser: only public repositories can be read.'}`;
    } else info.textContent = repoIn.value.trim() ? 'This does not look like a GitHub repository address.' : '';
  };
  repoIn.addEventListener('input', reparse);
  const current = () => parsed && { api_base: parsed.api, repo: parsed.repo, branch: branchIn.value.trim() || parsed.branch, path: pathIn.value.trim().replace(/^\/+|\/+$/g, '') };
  const say = (ok, text) => result.replaceChildren(h('p', { class: ok ? 'gh-ok' : 'error' }, text));
  const test = async () => {
    reparse();
    const l = current();
    if (!l) return say(false, 'Enter a repository first, for example owner/name.');
    say(true, 'Checking access…');
    try {
      const meta = await (await ghRequest(l.api_base, `/repos/${l.repo}`)).json();
      let what = `${meta.private ? 'Private' : 'Public'} repository ${meta.full_name}, default branch ${meta.default_branch}.`;
      if (l.path) {
        const r = await ghList({ ...l }, l.path);
        what += r.file ? ` "${l.path}" is a file.` : ` "${l.path}" is a folder with ${r.entries.length} item(s).`;
      }
      say(true, 'Access confirmed. ' + what);
      return true;
    } catch (e) { say(false, e.message); return false; }
  };
  const save = async (e) => {
    e.preventDefault();
    reparse();
    const l = current();
    if (!l) return say(false, 'Enter a repository first, for example owner/name.');
    try {
      await D.addRepo(project.id, { ...l, label: labelIn.value.trim(), share_public: sharePub.checked });
      dlg.close(); toast('Repository linked'); if (done) done();
    } catch (ex) { say(false, ex.message); }
  };
  const dlg = openDialog(h('form', { method: 'dialog', onsubmit: save },
    h('h2', null, 'Link a GitHub repository'),
    h('p', { class: 'muted small' }, 'Only the repository reference is saved with the project. Everyone who opens the project reads the files with their own GitHub access (public repositories need none).'),
    h('div', { class: 'field' }, h('label', null, 'Repository'), repoIn),
    h('div', { class: 'fields' },
      h('div', { class: 'field' }, h('label', null, 'Branch (optional)'), branchIn),
      h('div', { class: 'field' }, h('label', null, 'Folder or file (optional)'), pathIn)),
    h('div', { class: 'field' }, h('label', null, 'Name (optional)'), labelIn),
    h('label', { class: 'check' }, sharePub, 'Also show this repository to people who open a share link (dashboard or project link)'),
    h('p', { class: 'muted small' }, 'Visitors only see the files (not the repository name, branch or any credentials) and never get your token, so only PUBLIC repositories can be opened by them. Leave this off for private repositories.'),
    info, result,
    h('div', { class: 'row', style: 'margin-top:12px' },
      h('button', { type: 'button', onclick: test }, icon('check'), 'Test access'),
      h('button', { type: 'button', onclick: () => { reparse(); ghCredentialsDialog(parsed ? parsed.api : GH_API_DEFAULT, reparse); } }, icon('key'), 'Credentials'),
      h('button', { class: 'primary', type: 'submit' }, 'Link repository'),
      h('button', { type: 'button', onclick: () => dlg.close() }, 'Cancel'))));
  repoIn.focus();
}

// ----- Browse a linked repository -----
function ghBrowserDialog(link, guest = false) {
  // share-link visitors only see the files: no repository name, branch, GitHub address or credentials, and neutral messages
  const friendly = (e) => !guest ? e.message
    : (e.status === 0 && /too large|No preview/.test(e.message)) ? e.message.replace(' Use "Open on GitHub" to see it there.', '')
    : /rate limit/i.test(e.message) ? 'Many people are looking at these files right now. Please try again in a few minutes.'
    : 'These files are not available at the moment.';
  const base = (link.path || '').replace(/^\/+|\/+$/g, '');
  const crumbs = h('div', { class: 'gh-crumbs' });
  const list = h('div', { class: 'gh-list' });
  const view = h('div', { class: 'gh-preview' }, h('p', { class: 'muted center' }, 'Choose a file on the left to preview it.'));
  let preview = null, loadId = 0, selected = null;
  const disposePreview = () => { if (preview) { preview.dispose(); preview = null; } };
  const parentOf = (p) => p.split('/').slice(0, -1).join('/');
  const failure = (target, e) => {
    const needsCreds = !guest && (e.status === 401 || e.status === 404 || e.status === 403);
    target.replaceChildren(h('div', { class: 'gh-error' }, h('p', { class: 'error' }, friendly(e)),
      needsCreds ? h('button', { class: 'small', onclick: () => ghCredentialsDialog(link.api_base, () => loadDir(currentDir)) }, icon('key'), 'Credentials') : null));
  };
  let currentDir = base;

  const drawCrumbs = (dir) => {
    const rel = dir.slice(base.length).replace(/^\/+/, '');
    const segs = rel ? rel.split('/') : [];
    const root = guest ? (link.label || 'Files') : (link.label || link.repo);
    const parts = [h('button', { class: 'linkish', onclick: () => loadDir(base) }, root)];
    let acc = base;
    segs.forEach((s) => { acc = acc ? acc + '/' + s : s; const target = acc; parts.push(h('span', { class: 'muted' }, ' / '), h('button', { class: 'linkish', onclick: () => loadDir(target) }, s)); });
    crumbs.replaceChildren(...parts);
  };

  async function loadDir(dir) {
    const id = ++loadId;
    currentDir = dir; drawCrumbs(dir);
    list.replaceChildren(h('p', { class: 'muted center' }, 'Loading…'));
    try {
      const r = await ghList(link, dir);
      if (id !== loadId) return;
      if (r.file) { return loadDir(parentOf(dir)).then(() => loadFile(r.file)); }   // the linked path is a single file
      const rows = r.entries.map((e) => h('button', { class: 'gh-row' + (e.type === 'dir' ? ' dir' : ''), title: e.path,
        onclick: () => (e.type === 'dir' ? loadDir(e.path) : loadFile(e)) },
        icon(e.type === 'dir' ? 'folder' : 'file'), h('span', { class: 'gh-name' }, e.name), e.type === 'file' ? h('span', { class: 'muted small' }, fmtFileSize(e.size)) : null));
      const up = dir !== base ? [h('button', { class: 'gh-row dir', onclick: () => loadDir(parentOf(dir)) }, icon('back'), h('span', { class: 'gh-name' }, '.. (up)'))] : [];
      list.replaceChildren(...up, ...(rows.length ? rows : [h('p', { class: 'muted center' }, 'This folder is empty.')]));
    } catch (e) { if (id === loadId) failure(list, e); }
  }

  async function loadFile(entry) {
    const id = ++loadId;
    selected = entry.path;
    [...list.querySelectorAll('.gh-row')].forEach((b) => b.classList.toggle('active', b.title === entry.path));
    disposePreview();
    const head = h('div', { class: 'gh-filehead' }, h('b', null, entry.name), h('span', { class: 'muted small' }, fmtFileSize(entry.size)),
      (!guest && entry.html_url && /^https:\/\//.test(entry.html_url)) ? h('a', { href: entry.html_url, target: '_blank', rel: 'noopener noreferrer', class: 'small' }, icon('external'), 'Open on GitHub') : null);
    view.replaceChildren(head, h('p', { class: 'muted center' }, 'Loading…'));
    try {
      if (!fileKindOf(entry.name)) throw new GhError(guest ? 'No preview for this type of file.' : 'No preview for this type of file. Use "Open on GitHub" to see it there.', 0);
      if (entry.size > PREVIEW_MAX_BYTES) throw new GhError('This file is too large to preview (' + fmtFileSize(entry.size) + ').', 0);
      const buf = await ghFileBytes(link, entry.path);
      if (id !== loadId) return;
      preview = await renderPreview(entry.name, buf);
      if (id !== loadId) { disposePreview(); return; }
      view.replaceChildren(head, preview.el);
    } catch (e) { if (id === loadId) view.replaceChildren(head, h('p', { class: 'error' }, friendly(e)), !guest && (e.status === 401 || e.status === 403 || e.status === 404) ? h('button', { class: 'small', onclick: () => ghCredentialsDialog(link.api_base, () => loadFile(entry)) }, icon('key'), 'Credentials') : null); }
  }

  const dlg = openDialog(h('div', null,
    h('div', { class: 'row spread' },
      guest ? h('div', { class: 'gh-title' }, icon('folder'), h('b', null, link.label || 'Files'))
        : h('div', { class: 'gh-title' }, icon('git'), h('b', null, link.label || link.repo), link.label ? h('span', { class: 'muted small' }, link.repo) : null, link.branch ? h('span', { class: 'pill' }, link.branch) : null),
      h('div', { class: 'row' },
        guest ? null : h('button', { class: 'small', onclick: () => ghCredentialsDialog(link.api_base, () => loadDir(currentDir)) }, icon('key'), 'Credentials'),
        h('button', { class: 'small', onclick: () => loadDir(currentDir) }, icon('reset'), 'Refresh'),
        h('button', { class: 'small', onclick: () => dlg.close() }, 'Close'))),
    crumbs,
    h('div', { class: 'gh-split' }, list, view)), 'wide xl');
  dlg.addEventListener('close', () => { loadId++; disposePreview(); });
  loadDir(base);
}

// ----- The GitHub card on a project page (also shown to share-link visitors for the repositories the owner switched on) -----
function ghCard(project, repos, canEdit, reload, guest = false) {
  const apiOf = () => (repos[0] ? repos[0].api_base : GH_API_DEFAULT);
  return h('div', { class: 'card' },
    h('div', { class: 'row spread' }, h('h2', null, guest ? `Files (${repos.length})` : `GitHub (${repos.length})`),
      guest ? null : h('button', { class: 'small', title: 'Your own GitHub token, kept in this browser only', onclick: () => ghCredentialsDialog(apiOf()) }, icon('key'), 'Credentials')),
    repos.length ? h('ul', { class: 'gh-links' }, repos.map((r, i) => h('li', null,
      // share-link visitors see only a name chosen by the owner (or "Files"), never the repository, branch or folder
      guest ? h('div', { class: 'gh-linkinfo' }, h('b', null, r.label || (repos.length > 1 ? 'Files ' + (i + 1) : 'Files')))
        : h('div', { class: 'gh-linkinfo' }, h('b', null, r.label || r.repo),
          h('span', { class: 'muted small' }, `${r.label ? r.repo + ' · ' : ''}${r.branch || 'default branch'}${r.path ? ' · ' + r.path : ''}`)),
      h('div', { class: 'row' },
        h('button', { class: 'small primary', onclick: () => ghBrowserDialog(r, guest) }, icon('eye'), guest ? 'Open files' : 'Browse'),
        canEdit && !guest ? h('button', { class: 'small' + (r.share_public ? ' on' : ''), 'aria-pressed': String(!!r.share_public),
          title: r.share_public ? 'Visible to people with a share link. Click to hide it from them.' : 'Hidden from share links. Click to show it to people with a share link.',
          onclick: () => guard(async () => { await D.setRepoShared(r.id, !r.share_public); toast(r.share_public ? 'Hidden from share links' : 'Now visible on share links'); reload(); }) },
          icon(r.share_public ? 'eye' : 'eye-off'), r.share_public ? 'On share links' : 'Not on share links') : null,
        canEdit && !guest ? h('button', { class: 'small action danger', title: 'Unlink this repository from the project', onclick: () => confirm('Unlink this repository from the project? The repository itself is not touched.') && guard(async () => { await D.deleteRepo(r.id); toast('Repository unlinked'); reload(); }) }, 'Unlink') : null))))
      : h('p', { class: 'muted' }, 'No repository linked.'),
    canEdit && !guest ? h('button', { class: 'small', style: 'margin-top:8px', onclick: () => ghLinkDialog(project, reload) }, icon('plus'), 'Link a repository') : null,
    h('p', { class: 'muted small', style: 'margin-top:8px' }, guest
      ? 'Click Open files to read the documents. They open here in the page.'
      : 'Files open in a viewer here (PDF, Word, Excel, PowerPoint, HTML, SVG and images, text). Private repositories use your own token. Use the eye button to show or hide a repository on share links.'));
}