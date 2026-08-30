# LabInventory Backend — Setup Guide

Follow these steps exactly, in order. This turns a blank Google Sheet into the
live LabInventory server. It takes about 15 minutes the first time.

You will do this once fully, then repeat a much shorter "re-deploy" step
(Step 10) every time you edit `Code.gs` later.

---

## 1. Create the Google Sheet

1. Go to [sheets.google.com](https://sheets.google.com) and click **Blank** to create a new spreadsheet.
2. Rename it (click "Untitled spreadsheet" top-left) to `LabInventory Data`.
3. Leave `Sheet1` alone — the setup script creates its own tabs and ignores it. You may delete `Sheet1` later if you want, but it's not required.

## 2. Open the Apps Script editor

1. In the Sheet, click the menu **Extensions > Apps Script**. A new tab opens with a code editor.
2. Rename the project (click "Untitled project" top-left) to `LabInventory Backend`.
3. You'll see a file called `Code.gs` with some placeholder content (`function myFunction() {}`). Select **all** of that text and delete it.

## 3. Paste in the real code

1. Open `backend/Code.gs` from this repo on your computer, select all, copy.
2. Paste it into the empty `Code.gs` file in the Apps Script editor.
3. Click the save icon (or `Ctrl+S` / `Cmd+S`).

## 4. Add the manifest file

1. In the Apps Script editor, click the **gear icon** (Project Settings) on the left sidebar.
2. Check the box **"Show 'appsscript.json' manifest file in editor"**.
3. Click the **editor icon** (`< >`, top of the left sidebar) to go back to the file list. You'll now see `appsscript.json` in the file list — click it.
4. Delete everything in it, then open `backend/appsscript.json` from this repo, copy its contents, and paste them in.
5. Save (`Ctrl+S` / `Cmd+S`).

## 5. Run `setup()`

1. At the top of the editor, there's a dropdown next to the "Debug" button that lists function names. Click it and choose **`setup`**.
2. Click **Run** (the play-button icon).
3. The first time you run anything, Google will show **"Authorization required"**. Click **Review permissions**.
4. Pick your Google account. You'll likely see a warning screen that says "Google hasn't verified this app" — this is normal for a script you wrote yourself. Click **Advanced**, then click **Go to LabInventory Backend (unsafe)**, then **Allow**.
5. Run `setup` again (same dropdown, same Run button) now that you're authorized.
6. Click **Execution log** (or **View > Logs**) at the bottom. You should see `=== LabInventory setup complete ===` and a list of next steps. If you see a red error instead, re-check Steps 3–4 (the code and manifest must be pasted in completely).
7. Go back to the Google Sheet tab — you should now see 5 tabs at the bottom: `Parts`, `Requests`, `Categories`, `Log`, `Config`.

`setup()` is safe to run again any time — it will never erase existing data.

## 6. Set the admin password

The Apps Script "Run" button can only run functions that take **no arguments**,
but `setAdminPassword(pw)` needs one. So we temporarily add a small helper
function that calls it for us.

1. In `Code.gs`, scroll to the very bottom and add this (replace `YourPasswordHere` with a real password — 6+ characters):

   ```js
   function TEMP_SET_PASSWORD() {
     setAdminPassword("YourPasswordHere");
   }
   ```

2. Save. Select **`TEMP_SET_PASSWORD`** from the function dropdown. Click **Run**.
3. Check the Execution log — you should see `Admin password set successfully.`
4. **Delete the `TEMP_SET_PASSWORD` function you just added** (all 3 lines) and save again. This is important: don't leave your plaintext password sitting in the code. The password is never stored anywhere except a scrambled (hashed) form inside Apps Script's private "Script Properties" — never in the Sheet, never in this repo.
5. If you ever want to change the password later, repeat this whole step with a new password.

## 7. Deploy as a Web App

1. Click the blue **Deploy** button (top-right) > **New deployment**.
2. Click the gear icon next to "Select type" and choose **Web app**.
3. Fill in:
   - **Description**: `v1` (or anything)
   - **Execute as**: `Me (your email)`
   - **Who has access**: `Anyone`
4. Click **Deploy**.
5. You'll be asked to authorize again — same as Step 5 (Review permissions > Advanced > Go to... unsafe > Allow).
6. A box appears with a **Web app URL** ending in `/exec`. Copy this entire URL — this is your `API_URL`.

## 8. Wire the URL into the frontend

1. Open `docs/assets/js/config.js` in this repo.
2. Set it to:

   ```js
   export const API_URL = "PASTE_YOUR_EXEC_URL_HERE";
   ```

3. Save. That file only ever holds this public URL — never a password or token, so it's safe to commit to the repo.

## 9. Verify everything works

1. Back in the Apps Script editor, select **`selfTest`** from the function dropdown and click **Run**.
2. Open the Execution log. You should see a `PASS:` line for each step (create temp part, submit checkout, approve checkout, over-limit rejection, submit return, approve return, cleanup) and finally `=== LabInventory selfTest PASS ===`.
3. If anything says `FAIL:`, read the message next to it — it tells you exactly which step broke and why. Common causes: `Code.gs` wasn't pasted in completely, or `setup()` was never run first.
4. As a second check, visit `YOUR_EXEC_URL?action=ping` in a browser. You should see something like `{"ok":true,"data":{"version":"1.0.0","time":"..."}}`.

## 10. Re-deploying after you edit `Code.gs`

**This is the step everyone gets wrong.** If you edit the code later and want
the live site to see your changes, you must **update the existing
deployment** — creating a *new* deployment gives you a *different* `/exec`
URL, which breaks the site until you update `config.js` again.

1. Save your edits in `Code.gs`.
2. Click **Deploy > Manage deployments**.
3. Click the **pencil (edit) icon** next to your existing deployment.
4. Under **Version**, change the dropdown from "..." to **New version**.
5. Click **Deploy**.
6. The `/exec` URL stays exactly the same. Nothing to update in `config.js`.

Do **not** click "New deployment" for routine edits — save that only for the
very first deployment.

## 11. Load real inventory data

Once the backend is live and `docs/assets/js/config.js` has the right URL,
run the seeder from a terminal in this repo to push the crawled goBILDA
catalog into your Sheet:

```
python tools/seed_sheet.py --api-url "YOUR_EXEC_URL"
```

It will ask for the admin password (the one you set in Step 6) and push
`docs/data/catalog.json` into the `Parts` tab in batches. See
`tools/seed_sheet.py --help` for all options (`--dry-run`, resuming a
partial run, etc).

Real part **counts** are *not* set by the seeder — they always start at 0.
Fill in real `QtyTotal` numbers and shelf `Location` for each part yourself
in the admin page (`docs/admin.html`) once it's built and deployed.

---

## Troubleshooting

- **"Invalid credentials" on login**: you typed the wrong password, or the
  password was never set (redo Step 6), or you're locked out for 15 minutes
  after 5 wrong attempts.
- **`SERVER` error mentioning "Admin not configured"**: `setAdminPassword`
  was never run, or `setup()` was never run. Redo Steps 5–6.
- **Catalog looks stale after an edit**: the catalog is cached for up to 6
  hours per version, but any admin write (add/edit/delete a part, approve a
  request) bumps the version automatically, so the cache should refresh on
  the next page load. If it doesn't, hard-refresh the page.
- **"Google hasn't verified this app" screen won't go away**: this is normal
  for a script only you use. Click Advanced > Go to (project name) unsafe.
  This does not mean the app is actually unsafe — it just means you haven't
  submitted it to Google for a public app review, which you don't need to do
  for a private lab tool.
