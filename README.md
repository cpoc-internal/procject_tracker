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
2. Supabase first asks you to create an **organization** (just a container for your projects). Enter any name, choose type **Personal**, plan **Free**, and click **Create organization**.
3. Click **New project** (or open https://supabase.com/dashboard/projects). Choose any name (e.g. `project-tracker`), set a database password (click *Generate a password* and save it somewhere), pick the region closest to you, keep the **Free** plan, click **Create new project**.
4. Wait 1-2 minutes until the project finishes setting up.

### Step 2. Disable public sign-ups
Users are created only by the admin inside the app.
1. In Supabase left menu: **Authentication → Sign In / Providers** (older UI: *Authentication → Providers → Email*).
2. Turn **OFF** "Allow new users to sign up" (this is on the main Sign In / Providers page). Click **Save**.
3. **Important:** do NOT turn off the **Email** provider itself. Click **Email** in the provider list and make sure **Enable email provider** stays **ON**. If it is off, every login fails with a 422 error. The other switches in that panel (secure email change, magic links, etc.) can stay off.

### Step 3. Create tables and the first admin account
Because the repository will be **public**, never type your real admin password into any file in the repo. Edit it only inside the Supabase editor box:
1. On your computer open `supabase-setup.sql` in a text editor, select ALL text and copy it.
2. In Supabase left menu: **SQL Editor → New query**, and paste the text into the query box.
3. Scroll to the **last line** in the Supabase box:
   ```sql
   select public.bootstrap_admin('admin', 'CHANGE-ME-to-a-strong-password', 'Administrator');
   ```
   Change `admin` (your admin username) and `CHANGE-ME-to-a-strong-password` (your password, minimum 8 characters). Keep the quotes. Do **not** save this change back into the file.
4. Click **Run**.
5. You should see **Success**. If you see a red error, copy the message and ask for help. Do not run the script twice: if it fails halfway, the simplest fix is to create a new Supabase project (Step 1) and start again.
6. Write down the admin username and password in your password manager. You will use them in Step 7.

### Step 4. Put the Supabase URL and key in the website
1. In Supabase click the **gear icon (Project Settings) → API Keys**. You will see this page:

   ![Supabase API Keys page](images/api-keys.png)

2. Under **Publishable key**, click the **copy icon** next to the `default` key (it starts with `sb_publishable_`). This is the key you need. It is designed to be public.
   **Do NOT use the "Secret keys" section** (`sb_secret_...`). That key gives full access to your database; never put it in `config.js` or on GitHub.
3. Get the **Project URL** (looks like `https://abcdxyz.supabase.co`): it is shown under **Project Settings → Data API** (top of the page), and also behind the **Connect** button at the top of the dashboard. If you only find the Project ID (Project Settings → General), the URL is `https://<project-id>.supabase.co`.
4. Open `docs/config.js` and replace the two placeholder values:
   ```js
   window.APP_CONFIG = {
     SUPABASE_URL: 'https://abcdxyz.supabase.co',
     SUPABASE_ANON_KEY: 'sb_publishable_xxxxxxxxxxxxxxxx',
   };
   ```
   (The variable is named `ANON_KEY` but it takes the publishable key.) Save the file.

### Step 5. Upload the code to GitHub
**Public repo checklist (do this before uploading):**
- `docs/config.js` contains only the Supabase **Project URL** and the **publishable** key. This is fine to publish.
- No `sb_secret_...` / `service_role` key anywhere in any file.
- `supabase-setup.sql` still has the placeholder `CHANGE-ME-to-a-strong-password` on its last line (no real password).

Option A: web page (no tools needed)
1. Go to https://github.com/new, name the repository (e.g. `project-tracker`), choose **Public** (GitHub Pages on the free plan needs a public repo), click **Create repository**.
2. Click **uploading an existing file**.
3. Drag the **contents** of the `project-tracker` folder into the page: the `docs` folder (with everything inside, including `vendor`), the `images` folder, `supabase-setup.sql`, `README.md`, `.gitignore`.
   - Tip: if folders do not upload by drag-and-drop, open the folder in Windows Explorer, select everything inside, and drag it into the browser.
   - Make sure the file `docs/.nojekyll` and `docs/vendor/supabase.js` were uploaded.
4. Click **Commit changes**.

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

### Step 6b. Protect the public repo (recommended, 2 minutes)
People can read and copy a public repo, but only you can change it. To keep it that way:
1. Turn on **two-factor authentication** for your GitHub account (GitHub → Settings → Password and authentication). This protects against the real risk: someone taking over your account.
2. Repo **Settings → Branches → Add branch ruleset** (or *Add rule*) for `main`, and enable **Require a pull request before merging**. Outsiders can only propose changes (pull requests); nothing is published unless you merge it.
3. Do not add collaborators you do not trust. Never commit passwords or secret keys.

Even if someone copies the code, your data is safe: it lives in your Supabase project and is protected by the login and the database rules.

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
| **"Invalid username or password"** | Use the username exactly as in the SQL (case does not matter). Admin password is the one you typed in the Supabase SQL editor in Step 3. Forgot the admin password? Run in the Supabase SQL Editor: `update auth.users set encrypted_password = extensions.crypt('NEW-PASSWORD', extensions.gen_salt('bf')) where email = 'admin@tracker.example.com';` (replace `admin` with your admin username). |
| "This account has no access" | The user exists in Supabase Auth but not in the app. Create users only from the app's Users page. |
| Sign in fails with "Email logins are disabled" (HTTP 422) | Supabase → Authentication → Sign In / Providers → **Email** → turn **Enable email provider** ON and Save. |
| Sign in works but page says "Could not read your profile" (HTTP 403) | Run the three `grant` lines from `supabase-setup.sql` (section "permissions for logged-in users") in the SQL Editor. |
| Network error / blank page on sign in | Your network may block `*.supabase.co`. Ask IT to allow it, or try another network to confirm. |
| Site is 404 on GitHub | Check Settings → Pages is set to `main` / `/docs`, and that `docs/index.html` exists in the repo. |
| Site worked, now errors after a long pause | Free Supabase projects pause after ~1 week of inactivity. Open the Supabase dashboard and click **Restore project**. |
| Upload of image fails | Only PNG, JPEG, GIF, WebP are accepted; max 20 images per project. |

## Security notes
- Passwords are stored hashed by Supabase Auth. Permissions are enforced by the database (Row Level Security), not just the page.
- Usernames are mapped internally to `username@tracker.example.com`; no real email is used or sent.
- Image links are random and unguessable but not password protected: anyone who has an image URL can open that image.
- Share links are secret URLs: anyone holding the link can view and comment on that one project.
