# Auto-updates & data persistence — the complete picture

Two things people mix up. This explains both, plainly.

---

## Part A — Why your data "kept getting wiped" (and the real fix)

**It was not SQLite, and it was not a size limit.** SQLite happily stores hundreds
of GB in a single file; capacity was never the problem.

The data disappeared because of **how Railway works**, not the database:

- Railway runs your app in a **container with a throwaway disk**. Every time you
  deploy (push a change), Railway builds a **brand-new container** and **throws the
  old one away** — including anything written to its disk. Your `haven.db` file and
  all uploads lived on that throwaway disk, so they vanished on each deploy.
- **Postgres would NOT have fixed this by itself.** If you ran Postgres inside the
  same container, its data files would sit on the same throwaway disk and be wiped
  too. (Railway's *managed* Postgres add-on survives because it's a **separate
  service with its own persistent storage** — that persistence is the point, not
  the engine.)

**The real fix — a Railway Volume (persistent disk):**

1. Railway → your service → **Volumes → New Volume**, mount path **`/data`**.
2. Redeploy.

That's it. The app **auto-detects** the volume: on Railway it sets
`HAVEN_DATA_DIR` to the volume mount, so `haven.db`, **all uploads (avatars,
clips, images, backups)**, and the encryption keys are written to the persistent
volume and **survive every deploy**.

**Confirm it's working** — the boot log prints:
```
💾 Persistent data on Railway Volume at /data — safe across redeploys.
```
If instead you see a big `NO RAILWAY VOLUME ATTACHED` warning, the volume isn't
attached yet and data will still reset.

**Also set `JWT_SECRET`** (Railway → Variables, value from `openssl rand -hex 32`).
Without it the login-signing key is regenerated each deploy, which logs everyone
out even if the database survived.

> Bonus: a Volume also solves your **uploaded files** (images, clips). Postgres
> only stores rows — it would *not* have kept your uploaded files, so you'd have
> needed a volume or object storage anyway. The Volume is the complete solution.

---

## Part B — How automatic updates work, start to finish

### The mental model (read this first)

MSG Arena is **one server + thin clients**. Every client shows a UI that is
**loaded from your server**. That means:

| Client | UI / features update… | The native app shell updates… |
|---|---|---|
| **Web** | instantly, when you redeploy the server | (n/a) |
| **Desktop** | on next launch (loads UI from server) | via electron-updater (this doc) |
| **Mobile** | on next open (WebView loads server) | via the app store / a prompt (below) |

So **95% of "updates" = just redeploy your server** — new features, fixes, and UI
changes reach web, desktop, and mobile automatically because they all render the
server's web app. You only need the machinery below for the **native shells** (the
desktop `.exe`/`.dmg` and the mobile `.apk`/`.ipa` themselves), which change rarely.

---

### B1. Desktop app — true automatic self-update

The desktop app already has the auto-updater wired in (`electron-updater`): on
launch and every hour it checks your GitHub Releases, downloads a newer build in
the background, and installs it on restart. You just have to point it at your repo
and publish releases.

#### One-time setup

1. **Create a GitHub repo** for the desktop app, e.g. `yourname/MSG-Arena-Desktop`,
   and push the `MSG-Arena-Desktop-main` folder to it.
2. **Tell the app where to check.** In `MSG-Arena-Desktop-main/electron-builder.yml`,
   set the `publish:` block to that repo:
   ```yaml
   publish:
     - provider: github
       owner: yourname            # your GitHub username/org
       repo: MSG-Arena-Desktop    # the repo from step 1
       releaseType: release
   ```
   (This is baked into the build, so installed apps know where to look.)
3. **Keep the CI file** `.github/workflows/build.yml` (already in the repo). On a
   version tag it builds Windows + macOS + Linux and publishes them to a GitHub
   Release with `--publish always`, which also uploads `latest.yml` /
   `latest-mac.yml` / `latest-linux.yml` — the little manifest the updater reads.
4. **(Optional) Point the web server at the same repo:** on Railway set
   `UPDATE_REPO=yourname/MSG-Arena-Desktop`. This makes the web **/download** page
   and the in-app "update available" banner use your repo.

#### Every time you ship a new version

1. Bump the version in `MSG-Arena-Desktop-main/package.json`, e.g. `1.5.1` → `1.5.2`
   (must be **higher** than the last, plain **semver** `X.Y.Z`).
2. `git commit -am "release 1.5.2"`
3. `git tag v1.5.2`   ← the tag **must start with `v`**
4. `git push origin v1.5.2`
5. Wait ~10 min for the GitHub Action to finish. Done.

The pretty name in the GitHub Release (e.g. "MSG ARENA V2.4.9") can be anything;
only the **tag/`package.json` version must be plain semver** like `v2.4.9`.

#### What the installed user sees

Nothing to do on their end. Their app checks on launch + hourly; when it finds a
higher version it downloads it and, per the current wiring, notifies them and
applies it on the next restart. **No reinstall.**

#### Requirements & gotchas

- Version must be **higher** than the installed one; tag starts with **`v`**; the
  Release must **not be a draft**; `latest.yml` must be present (CI does this).
- **macOS** self-update needs the app to be **code-signed + notarized** (Apple
  requirement). Unsigned macOS builds install fine but won't silently auto-update.
  Windows and Linux auto-update **unsigned** (Windows shows a one-time SmartScreen
  warning without a code-signing cert).
- Use a **public** releases repo (simplest). A private repo means embedding a token
  in the app — avoid unless you must.

---

### B2. Mobile app — the honest reality

There are two layers, and they update differently:

**1. The app's UI and features → already automatic.** The mobile app is a WebView
of your server, so **every server redeploy updates the whole mobile app** the next
time it's opened. This covers almost everything you'll ever change.

**2. The native APK/IPA shell** (the connect screen, permissions, native bridges)
changes rarely, and updating the *installed binary* depends on how it's distributed:

- **Google Play (recommended for real distribution):** upload the new `.aab` to
  Play Console once set up, and Play delivers automatic updates to users like any
  app. This is the only *fully silent* native auto-update on Android.
- **Sideloaded APK (what you do now — sharing the `.apk` file directly):** Android
  **does not allow an app to silently replace itself** — that's an OS security rule.
  Options:
  - Add an **in-app "new version available" prompt** (I can build this): the app
    checks your GitHub Releases for a newer `versionCode`, and if found shows a
    banner that downloads the new APK and opens Android's installer for the user to
    tap "Update". One tap, but not fully silent.
  - Or users **manually reinstall** the new APK.
- **iOS:** updates only through the **App Store** (or TestFlight for testers). No
  sideload auto-update exists on iOS.

**Bottom line for mobile:** redeploy the server and the app is "updated" for
almost every change. Only rebuild + redistribute the APK/IPA when you change the
*native* shell — and use Play Store/App Store for automatic native updates, or ask
me to add the in-app APK update-check for sideloaded Android.

---

## Quick reference

| I changed… | To ship it to everyone |
|---|---|
| A feature / fix / UI (server code) | **Redeploy the server** (push to Railway). Web + desktop + mobile all get it automatically. |
| The desktop native shell | Bump version → `git tag vX.Y.Z` → push. CI builds + publishes; apps self-update. |
| The mobile native shell | Rebuild APK/AAB → upload to Play Store (auto), or share the APK / use the in-app update prompt. |
