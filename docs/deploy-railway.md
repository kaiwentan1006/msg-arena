# Deploy MSG Arena to Railway

MSG Arena runs on Railway as a single Node service. This guide gets you to a live
web app at `https://<your-project>.up.railway.app` (e.g. `msg-arena.up.railway.app`)
that everyone shares — same accounts and data across web, desktop and mobile.

Two things trip people up on any PaaS, so do them:

1. **Add a persistent Volume** — Railway's container filesystem is wiped on every
   redeploy. Without a volume your database and uploads vanish each deploy.
2. **Set `JWT_SECRET` yourself** — if you don't, the server generates a new one on
   each fresh container, which logs everyone out (and makes the E2E key backup
   unreadable) after every deploy.

## 1. Create the service

- **New Project → Deploy from GitHub repo** (push this repo to GitHub first), or
  run `railway up` from the `MSG-Arena-4.2.0` folder.
- This repo contains three folders. In the service's **Settings → Root Directory**,
  set it to **`MSG-Arena-4.2.0`** so Railway builds the web app (not the desktop or
  mobile projects).
- Build/start are configured in `railway.json`: it builds from the repo's
  **`Dockerfile`** (`builder: DOCKERFILE`), which pins Node 22 and compiles
  `better-sqlite3` for the container. The Dockerfile does **not** use a
  `VOLUME` instruction (Railway rejects it) — persistence comes from the
  Railway Volume you attach in the next step. If you'd rather build without
  Docker, set the service **Builder** to Nixpacks in Settings and Railway will
  use `.node-version` + `npm start` instead.

## 2. Add a Volume (persistent storage)

- Service → **Variables/Volumes → New Volume**, mount path **`/data`**.
- This holds `haven.db`, uploads (avatars, clips, backups) and the generated
  push/VAPID keys — everything that must survive a redeploy.

## 3. Set Variables

Service → **Variables**. Good news: **the app auto-detects Railway** and sets the
tricky ones for you, so a stock deploy works. `PORT` is injected by Railway — **do
not set it**.

**Set automatically on Railway (you don't need these — an explicit value still wins):**

| Variable | Auto value | Why it matters |
|---|---|---|
| `FORCE_HTTP` | `true` | Railway terminates TLS at its edge and forwards **plain HTTP** to the container. If the app served HTTPS you'd get a 502 ("Application failed to respond") — this is exactly that fix. |
| `TRUST_PROXY` | `1` | One proxy hop → correct client IPs for rate limits & IP bans. |
| `PUBLIC_URL` | `https://$RAILWAY_PUBLIC_DOMAIN` | Correct OAuth/redirect URLs, canonical tags & sitemap. Derived from the domain you generate in step 4. |
| `HAVEN_DATA_DIR` | `/data` | Set by the Dockerfile; stores DB + uploads on the volume. |

**You should still set these manually:**

| Variable | Value | Why |
|---|---|---|
| `JWT_SECRET` | a long random string | **Recommended.** Generate: `openssl rand -hex 32`. Without it the app generates one and stores it on the `/data` volume — fine *if* you added the volume (step 2). Setting it yourself guarantees sessions/E2E survive even without a volume. |
| `ADMIN_USERNAME` | `admin` | Optional. Register this username first to get the admin account. |
| `SERVER_NAME` | `MSG Arena` | Optional display name (already the default). |

> Deploying somewhere **other than Railway** (a VPS, Fly, Render behind a proxy)?
> Set `FORCE_HTTP=true`, `TRUST_PROXY=1` and `PUBLIC_URL` yourself — the auto-detect
> only triggers on Railway's own variables.

## 4. Networking / domain

- Settings → **Networking → Generate Domain** gives you
  `…up.railway.app` (or attach a custom domain). Railway serves it over HTTPS.

## 5. First run

- Open your Railway URL, click **Register**, and sign up as `admin`
  (the `ADMIN_USERNAME` you set) to get the admin account. Everyone else registers
  normally. One account works on web, desktop and the mobile app/PWA.

## Updating

- Push to the connected branch → Railway rebuilds and redeploys. Your **Volume
  keeps all data**. Because desktop/mobile load the UI from the server, every
  client updates at once.

## Voice on Railway — read this

- **Text, presence, and the whole gaming layer work fully.**
- **Voice is limited on Railway.** Railway exposes one HTTP(S) port and does not
  provide the arbitrary **UDP** ingress that real-time media needs, so:
  - The **in-process SFU will not work** on Railway — leave **SFU off** (it is off
    by default; don't enable it in Settings → Admin → Voice scaling).
  - **P2P mesh voice** connects via STUN (configured by default). Calls between
    people on friendly networks will work; **cross-NAT calls need a TURN server**,
    which Railway can't be. For reliable voice, run a small **coturn** on a cheap
    VPS and set `TURN_URL` + `TURN_SECRET` (see `.env.example`), or host MSG Arena
    on a VPS with a public IP instead of Railway if voice is central to your use.

## SEO / search-engine visibility

The public landing page (`/`) is built to rank: it serves a keyword-rich title
and description, canonical + Open Graph + Twitter Card tags, JSON-LD structured
data (`WebSite` + `SoftwareApplication`), a social share image (`/og-image.png`),
and `/robots.txt` + `/sitemap.xml`. All of the absolute URLs are built from
`PUBLIC_URL`, so **setting `PUBLIC_URL` is what makes SEO correct** — with it set
to `https://msg-arena.up.railway.app`, the canonical and sitemap point there.

- The app itself (`/app`) and the API are always excluded from search
  (`noindex` + robots `Disallow`), so private content is never indexed.
- To keep the **whole** site out of search engines (a private community), set
  `NOINDEX=true`; `/robots.txt` then disallows everything and the landing page is
  marked `noindex`.
- After deploying, submit `https://msg-arena.up.railway.app/sitemap.xml` in
  [Google Search Console](https://search.google.com/search-console) and Bing
  Webmaster Tools to get indexed faster.

## Backups

- Admin → **Backup** downloads the DB + uploads. Because they live on the `/data`
  volume, they also persist across deploys — but keep off-site backups anyway.

## Quick checklist

- [ ] Root Directory = `MSG-Arena-4.2.0`
- [ ] Volume mounted at `/data`  ← without this, data resets on every redeploy
- [ ] `JWT_SECRET` set (recommended)  ·  `ADMIN_USERNAME` set (optional)
- [ ] Domain generated (this is what auto-fills `PUBLIC_URL`)
- [ ] Redeploy after adding the volume/vars, then open the URL
- [ ] Registered the admin account
- [ ] (If voice matters) TURN configured, SFU left off

`FORCE_HTTP`, `TRUST_PROXY`, `PUBLIC_URL` and `HAVEN_DATA_DIR` are set for you on
Railway — you don't need to add them.
