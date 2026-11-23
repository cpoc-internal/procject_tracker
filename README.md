# Project Tracker

Project tracker with logins, roles, topology image uploads, comments and read-only share links.
Static front end (`public/`) + API (`functions/api/[[path]].js`, wired up by `src/worker.js`) deployed as a **Cloudflare Worker with static assets**, data in **Cloudflare D1**, code on **GitHub**.

## Features
- Add / edit / delete projects: status (Pending, In Progress, On Hold, Done), priority (Low/Medium/High), start & due dates, owner
- Upload topology images (PNG/JPEG/GIF/WebP, auto-compressed), click to enlarge
- Comments on every project
- Share link per project: a 3rd person (no account) can view and comment, nothing else. Link can be regenerated or disabled
- Users with username/password login (PBKDF2-hashed, 7-day sessions, lockout after 5 bad attempts)
- Roles:
  | Role | Can do |
  |---|---|
  | **Admin** | Everything: all projects, add/modify/delete users, change roles, reset passwords |
  | **Project Owner** | Create projects; edit/delete/upload to their own projects; view all; comment |
  | **Reviewer** | View all projects; comment only |

## Deploy (one time)

### 1. Put the code on GitHub
Create an empty repo on github.com, then either upload this folder through the web UI ("Add file → Upload files"), or with git:
```
git init
git add .
git commit -m "Project tracker"
git branch -M main
git remote add origin https://github.com/<you>/project-tracker.git
git push -u origin main
```

### 2. Create the D1 database
In the Cloudflare dashboard: **Storage & Databases → D1 → Create database** named `project-tracker`.
Open it → **Console** tab → paste the full contents of `schema-console.sql` → Execute.
(Use `schema-console.sql`, not `schema.sql`: the console fails with "No SQL statements detected" or "incomplete input" when the SQL contains `--` comments. If it still errors, run one `CREATE ...;` statement at a time, tables first, then indexes.)
Verify with `SELECT name FROM sqlite_master WHERE type='table';` (expect users, sessions, projects, topologies, comments).
Copy the **Database ID** and paste it into `wrangler.toml` (`database_id = "..."`), commit and push.

### 3. Deploy as a Worker from GitHub
1. **Compute → Workers & Pages → Create application → Import a repository**, connect GitHub, pick the repo.
2. Project name: `project-tracker` (must match `name` in `wrangler.toml`).
3. Build command: *(leave empty)*. Deploy command: `npx wrangler deploy` (the default).
4. **Save and Deploy**.

`wrangler.toml` already defines everything: the entry point (`src/worker.js`), the static files (`public/`) and the D1 binding `DB` (name must stay `DB`).
Note: a previously created *Pages*-style project with the same name must be deleted first (its logs show "you have run wrangler deploy on a Pages project").

### 4. First login
Open your `*.workers.dev` URL (shown on the project page). The first screen is **Create admin account**; that becomes the admin.
Do this immediately after deploying, since whoever gets there first creates the admin.
Then go to **Users** to add project owners and reviewers.

Optional: attach your own domain under the Worker → **Settings → Domains & Routes**. Protect it further with Cloudflare Access if you want SSO in front.

## Notes
- Every push to `main` redeploys automatically.
- Topology images are stored in D1 (limit ~1.3 MB each after compression, 20 per project). For larger or many images, move them to R2.
- Share links are secret URLs: anyone holding the link can view and comment. Use "Disable" to revoke.
- Local testing: `npm i -g wrangler`, then `wrangler d1 execute project-tracker --local --file=schema-console.sql` and `wrangler dev`.
