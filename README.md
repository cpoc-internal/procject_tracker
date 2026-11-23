# Project Tracker

Project tracker with logins, roles, topology image uploads, comments and read-only share links.

- **Website:** static HTML/JS in the `docs/` folder, hosted free on **GitHub Pages** (`https://<your-github-user>.github.io/<repo-name>/`)
- **Back end:** **Supabase** (free): database, password login and image storage. All security rules are in `supabase-setup.sql`, so the website itself holds no secrets.

## Features
- Add / edit / delete projects: status (Pending, In Progress, On Hold, Done), priority (Low, Medium, High), start date, due date, owner
- Upload topology images (PNG/JPEG/GIF/WebP; big ones are compressed automatically), click to enlarge
- Comments on every project
- Share link per project: a 3rd person (no account) can view and comment only. The link can be regenerated or disabled
- Users with username + password; the admin adds, edits, deletes users and changes roles
- Roles:

  | Role | Can do |
  |---|---|
  | **Admin** | Everything: all projects, add/modify/delete users, change roles, reset passwords |
  | **Project Owner** | Create projects; edit/delete/upload to their own projects; view all; comment |
  | **Reviewer** | View all projects; comment only |

---

## Setup: follow these steps in order (about 20 minutes)

You need: a GitHub account and an email address for a Supabase account. Nothing needs to be installed on your computer.

### Step 1. Create the Supabase project
1. Go to https://supabase.com and sign up / sign in.
2. Click **New project**. Choose any name (e.g. `project-tracker`), set a database password (save it somewhere), pick the region closest to you, keep the **Free** plan, click **Create new project**.
3. Wait 1-2 minutes until the project finishes setting up.

### Step 2. Disable public sign-ups
Users are created only by the admin inside the app.
1. In Supabase left menu: **Authentication → Sign In / Providers** (older UI: *Authentication → Providers → Email*).
2. Turn **OFF** "Allow new users to sign up". Click **Save**.

### Step 3. Create tables and the first admin account
1. On your computer open the file `supabase-setup.sql` in a text editor (VS Code is fine).
2. Go to the **last line** of the file:
   ```sql
   select public.bootstrap_admin('admin', 'CHANGE-ME-to-a-strong-password', 'Administrator');
   ```
   Change `admin` (username) and `CHANGE-ME-to-a-strong-password` (password, minimum 8 characters). Keep the quotes. Save the file.
3. In Supabase left menu: **SQL Editor → New query**.
4. Select ALL text of `supabase-setup.sql`, copy, paste into the query box, click **Run**.
5. You should see **Success** (the last statement returns an empty row). If you see a red error, copy the message and ask for help. Do not run the file twice: if it fails halfway, the simplest fix is to create a new Supabase project (Step 1) and start again.

### Step 4. Put the Supabase URL and key in the website
1. In Supabase: **Project Settings (gear icon) → API** (or *API Keys*).
2. Copy the **Project URL** (looks like `https://abcdxyz.supabase.co`).
3. Copy the **anon public** key (a long text starting with `eyJ...`) or the **Publishable key** (starts with `sb_publishable_`). This key is designed to be public. **Never** use or share the `service_role` / secret key.
4. Open `docs/config.js` and replace the two placeholder values:
   ```js
   window.APP_CONFIG = {
     SUPABASE_URL: 'https://abcdxyz.supabase.co',
     SUPABASE_ANON_KEY: 'eyJ...your key...',
   };
   ```
   Save the file.

### Step 5. Upload the code to GitHub
Option A: web page (no tools needed)
1. Go to https://github.com/new, name the repository (e.g. `project-tracker`), choose **Public** (GitHub Pages on the free plan needs a public repo; private repos need a paid plan), click **Create repository**.
2. Click **uploading an existing file**.
3. Drag the **contents** of the `project-tracker` folder into the page: the `docs` folder (with everything inside, including `vendor`), `supabase-setup.sql`, `README.md`, `.gitignore`.
   - Tip: if folders do not upload by drag-and-drop, open the folder in Windows Explorer, select everything inside, and drag it into the browser.
   - Make sure the file `docs/.nojekyll` and `docs/vendor/supabase.js` were uploaded.
4. Click **Commit changes**.

Note: the repo is public, and `supabase-setup.sql` contains your admin password. **Before uploading, set that last line back to a placeholder** (or do not upload that file). Your real admin password only needs to exist in Supabase.

Option B: Git on the command line
```
cd project-tracker
git init
git add .
git commit -m "Project tracker"
git branch -M main
git remote add origin https://github.com/<your-user>/project-tracker.git
git push -u origin main
```

### Step 6. Turn on GitHub Pages
1. In your repo: **Settings → Pages**.
2. Under **Build and deployment → Source**, choose **Deploy from a branch**.
3. Branch: **main**, folder: **/docs**, click **Save**.
4. Wait 1-2 minutes and refresh the page. A banner shows your site address: `https://<your-github-user>.github.io/<repo-name>/`.

### Step 7. Sign in
1. Open the site address from Step 6.
2. Sign in with the admin username and password from Step 3.
3. Click **Users** in the top bar and add your project owners and reviewers (username, name, password, role). Give them their credentials. They can change their own password with **Change password**.
4. Click **Projects → + New project** to start.

---

## How to use

- **Create project:** Projects → + New project (admins and project owners).
- **Change status / priority:** open the project, use the drop-downs at the top (owner of the project or admin).
- **Topologies:** open the project, use the file picker in the Topologies card, click an image to enlarge.
- **Comments:** type at the bottom of the project page and click Post comment (any signed-in user).
- **Share with someone without an account:** open the project → *Share with a 3rd person* → **Create share link** → **Copy link** and send it. They can view and comment only. **Disable** stops the link working; **Regenerate** replaces it.
- **Manage users (admin):** Users page. Change the role from the drop-down, **Reset password**, or **Delete**. The last admin cannot be deleted or demoted.

## Updating the site later
Edit the files and upload/push them again to GitHub; GitHub Pages republishes automatically in about a minute. Database changes are made in the Supabase SQL Editor.

## Troubleshooting
| Problem | Fix |
|---|---|
| Page says **"Setup needed"** | `docs/config.js` still has the placeholders. Fill in URL and key (Step 4) and re-upload. |
| **"Invalid username or password"** | Use the username exactly as in the SQL (case does not matter). Admin password is the one set in the last line of `supabase-setup.sql`. |
| "This account has no access" | The user exists in Supabase Auth but not in the app. Create users only from the app's Users page. |
| Network error / blank page on sign in | Your network may block `*.supabase.co`. Ask IT to allow it, or try another network to confirm. |
| Site is 404 on GitHub | Check Settings → Pages is set to `main` / `/docs`, and that `docs/index.html` exists in the repo. |
| Site worked, now errors after a long pause | Free Supabase projects pause after ~1 week of inactivity. Open the Supabase dashboard and click **Restore project**. |
| Upload of image fails | Only PNG, JPEG, GIF, WebP are accepted; max 20 images per project. |

## Security notes
- Passwords are stored hashed by Supabase Auth. Permissions are enforced by the database (Row Level Security), not just the page.
- Usernames are mapped internally to `username@tracker.example.com`; no real email is used or sent.
- Image links are random and unguessable but not password protected: anyone who has an image URL can open that image.
- Share links are secret URLs: anyone holding the link can view and comment on that one project.
