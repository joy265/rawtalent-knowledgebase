# RawTalent Knowledge Base — Setup Guide

## Step 1 — Install Node.js

Download and install Node.js (LTS version) from:
https://nodejs.org/en/download

After installing, open **Terminal** and verify:
```
node --version   # should show v18 or higher
npm --version
```

---

## Step 2 — Install App Dependencies

In Terminal, navigate to this folder and install:
```bash
cd ~/Downloads/RawTalent
npm install
```

---

## Step 3 — Configure Your Password

Open the `.env` file (it's in the RawTalent folder) and set your admin password:

```
ADMIN_EMAIL=joy@rawtalent.com.au
ADMIN_PASSWORD=YourSecurePasswordHere
SESSION_SECRET=any-long-random-string-here
```

**Important:** Change `SESSION_SECRET` to something random (e.g. `rt-kb-2024-xk92mz4p`).

---

## Step 4 — Run the App

```bash
npm start
```

Then open your browser to: **http://localhost:3000**

Sign in with `joy@rawtalent.com.au` and your password from Step 3.

---

## Step 5 (Optional) — Google Sign-In for Users

If you want users to sign in with their Google accounts (instead of setting passwords manually):

1. Go to https://console.cloud.google.com and create a new project
2. Enable **Google OAuth** under APIs & Services → OAuth consent screen
   - Set "User type" to **Internal** (restricts to your Google Workspace)
   - Add your app name and email
3. Go to APIs & Services → Credentials → Create Credentials → OAuth Client ID
   - Application type: **Web application**
   - Authorised redirect URI: `http://localhost:3000/auth/google/callback`
     (or your hosted URL, e.g. `https://kb.rawtalent.com.au/auth/google/callback`)
4. Copy the **Client ID** and **Client Secret** into `.env`:
   ```
   GOOGLE_CLIENT_ID=your-client-id.apps.googleusercontent.com
   GOOGLE_CLIENT_SECRET=your-client-secret
   APP_URL=http://localhost:3000
   ```
5. Restart the app — a "Sign in with Google" button will appear on the login page

---

## Step 6 (Optional) — Google Drive Backup

This stores all articles as JSON files in a Google Drive folder so you have a cloud backup.

### Create a Service Account:
1. In Google Cloud Console → IAM & Admin → Service Accounts
2. Click **Create Service Account** → name it `rawtalent-kb`
3. Click the account → Keys tab → Add Key → JSON
4. Download the JSON key file
5. Encode it for the `.env`:
   ```bash
   base64 -i your-key.json | tr -d '\n'
   ```
   Paste the output as `GOOGLE_SERVICE_ACCOUNT_KEY=...` in `.env`

### Create a Drive folder:
1. In Google Drive, create a folder named "RawTalent KB Articles"
2. Right-click → Share → paste the service account email (ends in `@...gserviceaccount.com`)
3. Give it **Editor** access
4. Copy the folder ID from the URL: `drive.google.com/drive/folders/THIS_PART`
5. Add to `.env`:
   ```
   DRIVE_FOLDER_ID=paste-folder-id-here
   ```
6. Restart the app — articles will now sync to/from Drive

---

## Step 7 (Optional) — Host Online So Your Team Can Access It

To make the Knowledge Base available to your whole team (not just your laptop), deploy it to a hosting service.

### Easiest option — Railway.app (free tier available):
1. Push the RawTalent folder to a GitHub repository
2. Go to https://railway.app and connect your GitHub
3. Deploy the repo — Railway auto-detects Node.js
4. Add all your `.env` variables in Railway's "Variables" tab
5. Railway gives you a URL like `rawtalent-kb.up.railway.app`
6. Update `APP_URL` in Railway's variables to that URL
7. Update the Google OAuth redirect URI to match

### Alternative: Render.com, Fly.io, or any VPS

---

## Adding Users (after setup)

1. Sign in as admin at http://localhost:3000
2. Click **⚙ Admin** in the top right
3. Go to **Users** → **+ Add User**
4. Enter their name, `name@rawtalent.com.au` email, and a temporary password
5. They sign in at http://localhost:3000 with those credentials
6. If Google Sign-In is configured, they can also use that instead

---

## Adding Knowledge Base Articles

1. Sign in as admin
2. Click **⚙ Admin** → **New Article**
3. Write using Markdown:
   - `## Heading` for sections
   - `**bold**`, `*italic*`
   - `- item` for bullet lists
   - `| col | col |` for tables
   - `> Note` for callout boxes
4. Set a category and tags so articles are easy to find
5. Link related articles using the "Link Related Articles" search
6. Click **Save Article** — it's instantly searchable

---

## Markdown Quick Reference

| Format | Markdown |
|--------|----------|
| **Bold** | `**text**` |
| *Italic* | `*text*` |
| Heading | `## Heading` |
| Bullet list | `- item` |
| Numbered list | `1. item` |
| Link | `[text](url)` |
| Code | `` `code` `` |
| Blockquote | `> note` |
| Table | `\| col \| col \|` |
| Horizontal rule | `---` |

---

## Troubleshooting

**"Cannot find module" error on npm start**
→ Run `npm install` again

**Login not working**
→ Check your `ADMIN_PASSWORD` in `.env` and restart the app

**Google sign-in not showing**
→ Make sure `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` are set in `.env`

**Drive sync not working**
→ Confirm the service account email has Editor access to your Drive folder
