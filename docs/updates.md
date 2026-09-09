# Updating MSG Arena — web, desktop & mobile

There are **two kinds of update**, and they work very differently. Knowing which
one you're doing is the whole thing.

## 1. Feature / UI / bug-fix updates — automatic for everyone

This covers almost everything: the UI refresh, the gaming layer, new features, and
fixes like the launcher-bar fix. **All of it lives on the server.** The desktop and
mobile apps are *thin clients* that load the interface from your server, so:

> **Redeploy the server → web, desktop and mobile all update automatically.**
> Nothing to rebuild, reinstall, or re-download.

- **Web:** users just refresh. The `?v=` cache markers bump with each release
  (`npm run bump`), so returning browsers refetch the new files.
- **Desktop app:** its WebView loads `<your-server>/app.html` and revalidates
  against the server, so it shows the new UI on next launch/refresh.
- **Mobile app:** its WebView loads `<your-server>/app`, same story.

To ship one: push to the branch Railway builds → it redeploys. Done. **You do not
rebuild the desktop or Android app for a UI or feature change.**

## 2. Native-shell updates — only when the wrapper's own code changes

You only rebuild an app binary when you change the **native wrapper itself** — its
permissions, WebView flags, native modules, icons, or splash. That's rare. When you
do, here's how each one updates.

### Desktop (Electron) — real auto-update is built in

The desktop app uses **electron-updater**: on launch it checks a GitHub release
feed and, if a newer version exists, offers to download and install it (the app
shows an "update available" banner, downloads on your click, and installs on
restart). It's already wired — it just needs a release repo.

**One-time setup**
1. Create a GitHub repo to hold desktop releases, e.g. `your-name/MSG-Arena-Desktop`.
2. In `MSG-Arena-Desktop-main/electron-builder.yml`, set the `publish` block's
   `owner` and `repo` to that repo (they're `your-org` placeholders today — while
   they stay that way, update checks harmlessly 404 and nothing auto-installs).
3. On the **server**, set `UPDATE_REPO=your-name/MSG-Arena-Desktop` (Railway →
   Variables). This turns on the web app's **"Get the Desktop App"** download
   banner and the in-app "update available" notice, both pointing at your repo's
   releases page. (Leave `UPDATE_REPO` empty and those stay off — the server never
   contacts anyone.)

**Each release**
1. Bump `version` in `MSG-Arena-Desktop-main/package.json` (must go **up** every
   time — electron-updater compares versions).
2. Build the installer: run **`Build Installer.bat`** (Windows) or
   `npm run build:win` / `npm run build:linux`. Output lands in `dist/`.
3. Publish it to a **GitHub Release** in your desktop repo, tagged `v<version>`:
   - Easiest: set a `GH_TOKEN` env var and build with publish on —
     `npx electron-builder --win --publish always` — it uploads the installer **and
     the `latest.yml`** for you.
   - Or manually: create the release and upload everything from `dist/` — the
     installer (`.exe` / `.AppImage` / `.deb`) **and `latest.yml`** (and
     `latest-linux.yml`). `latest.yml` is the file electron-updater reads, so it
     must be attached.
4. Installed apps pick it up on their next launch and offer the update. First-time
   users get it from the "Get the Desktop App" banner / your releases page.

> AGPL note: your builds are based on Haven (AGPL-3.0). Keep the `LICENSE` and the
> upstream attribution intact and offer your source — see the repo's LICENSE.

### Mobile (Android) — UI auto-updates; the APK is a download

The Android app is a thin WebView, so **its UI updates automatically** with every
server redeploy — you almost never need a new APK. You only rebuild the APK when
its *native* side changes (permissions, WebView config, `versionName`).

A sideloaded APK **cannot silently auto-update itself** (only the Play Store does
that). So distribute a new native build one of two ways:

- **Download link (simple):** build the APK
  (`cd MSG-Arena-Mobile && ./gradlew assembleRelease`, signed with your key),
  attach it to a **GitHub Release**, and share the link. Users install it over the
  old one (same signing key = in-place upgrade, data kept). You can point people to
  the same releases page as the desktop app.
- **Google Play (true auto-update):** publish `com.msgarena.app` to the Play
  Store; Play then updates users automatically. Requires a Play Developer account.

> Building the APK needs the Android SDK/Gradle (not set up in this repo's dev
> box). `versionCode`/`versionName` in `app/build.gradle.kts` track the web-app
> version and are already bumped for you each release.

## Quick reference

| You changed… | Rebuild an app? | How users get it |
|---|---|---|
| UI, a feature, a bug fix (e.g. the bar fix, the redesign) | **No** | Redeploy the server; everyone refreshes |
| Desktop native wrapper (permissions, native modules, icon) | Yes — Electron | Auto-update via electron-updater once `publish` + `UPDATE_REPO` are set |
| Android native wrapper (permissions, WebView, versionName) | Yes — APK | New APK from your releases page, or Play Store |

## What this current release (v4.4.5) is

The UI overhaul and the launcher-bar fix are **category 1** — pure server-side web
changes. **Just redeploy your Railway server**; web, desktop and mobile all show
them on next load. No desktop or APK rebuild is needed for these.
