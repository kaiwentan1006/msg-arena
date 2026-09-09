# One server, all clients — how MSG Arena stays in sync

MSG Arena is **one self-hosted server**. The web app, the desktop app, the mobile
PWA and the Android APK are **all thin clients of that same server** — none of
them has its own backend or database. So they are *not* separate messengers: they
are windows onto the same server.

If you deploy to, say, `https://msg-arena.com`, then **everyone converses together
there**, and an account works on every client — because there is exactly **one
user database on that one server**.

## How each client connects to your server

| Client | How it reaches your server |
|---|---|
| **Web (browser)** | Served directly by the server. Anyone opens `https://msg-arena.com` and signs up / logs in. |
| **Installable PWA** | The web app installed to the home screen from `https://msg-arena.com` (Chrome "Install app" / iOS "Add to Home Screen"). Same code, same server. |
| **Desktop app** | You enter your server's URL once; it loads that server's web client. |
| **Android APK** | You enter your server's URL once; a native WebView loads that server's web client. |

Every client speaks to the same HTTP + Socket.IO endpoints, so there is a single
source of truth.

## What is shared across every client (automatically)

Because it all lives in the server's database and is delivered over the same
realtime Socket.IO connection, **everything is shared**:

- **Accounts** — register on any client (mobile, web, desktop); log in with the
  same credentials on any other. One account, everywhere. You can be signed in on
  several devices at once.
- **Messages, channels, threads, DMs, reactions, search** — created on one
  client, delivered live to all others.
- **The whole gaming layer** — LFG, clips, tournaments & ladders, leaderboards,
  achievements, scheduled events, and your Player Card — all stored server-side
  and broadcast to every connected client in real time.
- **Voice** — everyone in a voice channel is in the same room (P2P mesh, or the
  optional SFU); a phone, a laptop and the desktop app can all be in the same call.
- **Profile, bio, status, nicknames, roles, permissions, server settings** — all
  server-authoritative, so they look the same on every device.

## Encrypted DMs across devices

End-to-end-encrypted DMs are the one thing that is device-local *by design* — the
server must never see the keys. MSG Arena still keeps them in sync by storing an
**encrypted key backup** on the server, unlocked with your E2E passphrase. So:

- Your normal channels and everything above sync with no extra step.
- For E2E DM history on a **brand-new device**, you enter your E2E passphrase once
  and the device pulls the encrypted key backup (`e2e-key-sync`). After that, DMs
  follow you across devices.

## Every feature updates on every client together

This is a guarantee, not a hope, and it is worth being precise about **why**:

- The **web app** is served by the server.
- The **desktop app** (Electron) bundles only its local welcome/connect and splash
  screens; the actual app is loaded with `loadURL(<your server>/app.html)`. It
  ships **no** copy of the app's HTML/CSS/JS.
- The **Android app** loads `<your server>/app` in a WebView. It ships no app UI
  either.

So a change to any feature — messaging, the gaming layer, or a **face-to-face /
webcam component** — is made **once, on the server**, and all three clients render
it the next time they load. There is nothing to rebuild or re-release per client
for a UI/feature change, and the clients cannot drift out of sync because none of
them owns a second copy of the UI. Returning browsers are refreshed by the `?v=`
cache-busting that ships with each release; the desktop/Android WebViews always
revalidate against the server.

**Face-to-face works identically on all three** because each grants the camera and
microphone the web code asks for: the browser prompts directly; the desktop app
allows the `media` permission in Electron's permission handler; the Android app
grants `RECORD_AUDIO` / `CAMERA` in `onPermissionRequest`. The live active-speaker
ring, name pills and controls are the same web code everywhere.

### About the version numbers

There are two *kinds* of version, and they are meant to differ:

- The **web-app / feature version** (e.g. `4.3.1`, in the server's `package.json`)
  is the one that matters for features. Every client shows it because every client
  loads that UI. Bump it + `npm run bump` after any web change.
- The **native-shell versions** are separate release artifacts: the desktop
  Electron binary has its own lineage (used by its auto-updater) and the Android
  APK has its own `versionName`/`versionCode` (for the Play Store). The Android
  wrapper tracks the web-app version (it is `4.3.1` too); the desktop shell is
  versioned on its own cadence because a new *binary* is only cut when the native
  wrapper itself changes (permissions, WebView flags), not when the web app does.

In practice: **to update what people see and use, update the server** — that
updates web, desktop and Android at once. Only rebuild a native wrapper when you
change that wrapper's own native code.

## In short

There is **one server, one database, one account system, one realtime bus**. The
apps are different doors into the same room.
