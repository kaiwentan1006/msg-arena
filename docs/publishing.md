# Publishing updates — the complete guide

There are **three** clients, and they update in **two different ways**. Get this
distinction right and everything else is simple.

| Client | How it updates | What you upload |
|---|---|---|
| **Web app** | Redeploy the server (Railway). Done. | Nothing — the browser just loads the new server. |
| **Desktop app** (native shell) | **electron-updater** pulls from a **GitHub Release**. | The installer **+ its `.yml` files** to a GitHub Release. |
| **Android app** (native shell) | Users download the new **APK** from a GitHub Release (or Play Store). | The `.apk` to a GitHub Release. |

> 99% of your changes (UI, features, fixes, the DB) are **web** changes — you just
> **redeploy Railway** and every client gets them on next open. You only do the
> GitHub-Release dance when the **native shell** itself changes (rare).

---

## A. Web app (Railway) — the everyday path

1. `git push` your changes.
2. Railway redeploys automatically (or click **Deploy**).
3. Every web/desktop/mobile client loads the new UI on next open. No upload.

That's it. Bump the web version with `npm version` / your `npm run bump` so the
`?v=` cache-busting query strings update and returning users don't get stale JS.

---

## B. Desktop app — GitHub Releases + electron-updater

### One-time repo setup

1. Create a **public GitHub repo** to hold desktop releases, e.g.
   `your-username/MSG-Arena-Desktop`.
2. In **`MSG-Arena-Desktop-main/electron-builder.yml`**, set the `publish` block to
   that repo:
   ```yaml
   publish:
     - provider: github
       owner: your-username        # ← your GitHub account or org
       repo: MSG-Arena-Desktop     # ← the release repo
       releaseType: release
   ```
   While `owner` is left as `your-org`, update checks simply 404 (no-op) — they
   never pull from a stranger's repo.
3. On the **server**, set the env var **`UPDATE_REPO=your-username/MSG-Arena-Desktop`**
   (Railway → Variables). This is what powers the in-app "Download desktop app"
   link and the update banner.

### Version numbers (this is the important part)

electron-updater compares the **`version` in the desktop `package.json`** against
the newest GitHub Release. Higher = update offered. So **every release must bump
the version**:

```
Currently installed:  1.5.1     (LAST)
New release:          1.5.2     (LATEST)   ← must be higher
```

Use plain **semver** (`MAJOR.MINOR.PATCH`, e.g. `1.5.2`). The git **tag** must be
that version prefixed with `v`: **`v1.5.2`**. (You can *label* the release "MSG
Arena v1.5.2" in its title, but the tag + package.json version drive the update —
keep them identical: tag `v1.5.2` ↔ `"version": "1.5.2"`.)

### Build + release (each update)

1. Bump `"version"` in `MSG-Arena-Desktop-main/package.json` (e.g. `1.5.1` → `1.5.2`).
2. Build:
   ```bash
   cd MSG-Arena-Desktop-main
   npm install
   npm run build:win        # NSIS build → dist/
   # (or npm run make:squirrel for the Squirrel installer)
   ```
3. In `dist/` you'll get, for the NSIS/electron-updater path:
   - `MSG Arena Setup 1.5.2.exe`  ← the installer
   - **`latest.yml`**             ← **electron-updater's manifest (Windows)** — REQUIRED
   - `MSG Arena Setup 1.5.2.exe.blockmap`
   - (Linux: `latest-linux.yml` + the `.AppImage`/`.deb`)
4. Create the GitHub Release:
   - **Releases → Draft a new release**.
   - **Tag:** `v1.5.2` (create it on publish).
   - **Title:** `MSG Arena v1.5.2`.
   - **Attach ALL of:** the `.exe`, **`latest.yml`**, and the `.blockmap` (and the
     Linux `latest-linux.yml` + AppImage/deb if you ship Linux).
   - **Publish** the release (not a draft — electron-updater ignores drafts).

   > The **`latest.yml` is mandatory.** It's the tiny manifest that tells installed
   > apps "1.5.2 exists, here's the file + hash." Without it, auto-update silently
   > does nothing. It must sit in the **same release** as the `.exe`.

5. Installed apps now detect 1.5.2 within an hour (the app re-checks hourly and on
   launch), show the update prompt, and install on approval.

**Shortcut:** `electron-builder` can upload the release for you — set
`GH_TOKEN=<a GitHub token with repo scope>` and run `npm run build:win -- --publish always`.
It creates the release and attaches the `.exe` + `latest.yml` automatically.

---

## C. Android app — APK on GitHub Releases

1. Bump `versionCode` **and** `versionName` in
   `MSG-Arena-Mobile/app/build.gradle.kts` (versionCode must increase or Android
   refuses the update).
2. Build a signed APK (Android Studio → Build → Generate Signed Bundle/APK, or
   `./gradlew assembleRelease`).
3. Attach the `.apk` to the **same GitHub Release** (or the Play Store for true
   auto-update). The `/download` page links users to it.

---

## D. "Even if others host my content, updates stay mine"

Two separate things keep authorship yours:

1. **Auto-update source.** Installed desktop apps update **only** from the
   `owner/repo` in *their* `electron-builder.yml` (baked in at build time) and the
   server's `UPDATE_REPO`. If someone else re-hosts the server, their users' apps
   still point at **your** repo unless that someone rebuilds the desktop app with
   their own repo. So the releases you publish are what real users receive.
2. **Licence + attribution (AGPL-3.0).** MSG Arena is AGPL, based on Haven. The
   `LICENSE` + the "based on Haven" copyright line stay intact, and the product is
   branded MSG Arena with your author details in `package.json`
   (`yevgen.slyudikov@proton.me`). Anyone who modifies and network-hosts it must
   publish their source too — but your published builds and branding remain
   attributed to you.

If you want hard guarantees a fork can't silently push updates to *your* users:
keep the release repo private-to-you (you're the only one who can publish to it),
and never share a `GH_TOKEN`.

---

## Quick checklist per release

- [ ] Web change only? → just `git push` + redeploy Railway. Stop here.
- [ ] Native shell changed?
  - [ ] Bump `package.json` version (desktop) / `versionCode`+`versionName` (mobile).
  - [ ] Build (`npm run build:win` / signed APK).
  - [ ] GitHub Release, tag `vX.Y.Z`, attach the installer **+ `latest.yml`** (desktop) / `.apk` (mobile).
  - [ ] Publish the release (not a draft).
