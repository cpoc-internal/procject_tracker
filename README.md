# Project Tracker

Project tracker with logins, roles, topology image uploads, comments and read-only share links.

- **Front end:** static HTML/JS in `docs/`, hosted on **GitHub Pages** (`https://<you>.github.io/<repo>/`)
- **Back end:** **Supabase** (free tier): Postgres database, password login and file storage. All security rules live in the database (`supabase-setup.sql`), so the page itself holds no secrets.

## Features
- Add / edit / delete projects: status (Pending, In Progress, On Hold, Done), priority (Low/Medium/High), start & due dates, owner
- Upload topology images (PNG/JPEG/GIF/WebP, big ones auto-compressed), click to enlarge
- Comments on every project
- Share link per project: a 3rd person (no account) can view and comment, nothing else. Link can be regenerated or disabled
- Users with username/password login; the admin manages users
- Roles:

  | Role | Can do |
  |---|---|
  | **Admin** | Everything: all projects, add/modify/delete users, change roles, reset passwords |
  | **Project Owner** | Create projects; edit/delete/upload to their own projects; view all; comment |
  | **Reviewer** | View all projects; comment only |

## Setup (one time)

### 1. Create the Supabase project
1. Sign up at https://supabase.com and click **New project** (free plan, pick a region near you, save the database password).
2. **Authentication → Sign In / Providers** (or *Providers → Email*): turn **off "Allow new users to sign up"**. Users are created by the admin inside the app.

### 2. Create the tables and the first admin
1. Open `supabase-setup.sql`. **Edit the last line**: choose the admin username and a strong password.
2. Supabase → **SQL Editor → New query**, paste the whole file, click **Run**.
   It should end with "Success". (If you need to start over, delete the project's tables or create a fresh Supabase project, since the script is not re-runnable.)

### 3. Connect the page to Supabase
Supabase → **Project Settings → API**: copy the **Project URL** and the **anon / publishable key** and put them in `docs/config.js`.
(That key is meant to be public. Never put the `service_role` key anywhere in this repo.)

### 4. Publish on GitHub Pages
1. Create a GitHub repo and push this folder (or upload it via **Add file → Upload files**, keeping the `docs` folder structure).
2. Repo → **Settings → Pages → Build and deployment**: Source = **Deploy from a branch**, Branch = `main`, folder = **/docs** → Save.
3. After a minute the site is live at `https://<you>.github.io/<repo>/`.

### 5. Sign in
Open the site and sign in with the admin account from step 2. Go to **Users** to add project owners and reviewers.

## Notes
- Usernames are mapped internally to `username@tracker.example.com` (no real email is used or sent).
- Topology images are stored in a Supabase Storage bucket. Only editors can upload/delete; image URLs are random and unguessable, but anyone who has a URL can open that one image.
- Share links are secret URLs: anyone holding the link can view and comment on that project. Use "Disable" to revoke.
- Free-tier Supabase projects pause after a week of no activity; open the Supabase dashboard and click Restore if that happens.
- The site calls `*.supabase.co`. If your company network blocks it, ask IT to allow that domain.
