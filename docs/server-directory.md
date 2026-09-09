# Server directory (central registry)

A **directory** where self-hosted MSG Arena servers list themselves so others can
find and join them — the Discord-style "find a server", but opt-in and still fully
self-hosted (each server stays independent).

Users open it from the sidebar **+ (Add Server) → "Browse public servers"**.

## How it works

Every deploy is either a **hub** or a **member**, decided by two env vars:

| Role | Env | Behaviour |
|---|---|---|
| **Hub** | `DIRECTORY_LISTING=true` (and **no** `REGISTRY_URL`) | Stores announcements + serves the list. Lists **itself** too. This is the central registry everyone else points at. |
| **Member** | `REGISTRY_URL=https://your-hub` (+ `PUBLIC_URL`) | Announces itself to that hub every ~30 min, and proxies the browse list from the hub so its own web client can show it. |

`PUBLIC_URL` must be set on any server that wants to be listed — it's the address
others use to reach it.

### To run YOUR server as the public hub (recommended)

On your main server (e.g. Railway):
```
PUBLIC_URL=https://msg-arena.up.railway.app
DIRECTORY_LISTING=true
```
Now `https://msg-arena.up.railway.app` is the registry. Anyone browsing on your
server sees the directory, and your own server is listed in it.

### To let a friend's self-hosted server appear in your directory

On **their** server:
```
PUBLIC_URL=https://their-domain.com     # their real public address
REGISTRY_URL=https://msg-arena.up.railway.app   # your hub
```
Within a minute their server announces itself to your hub, is verified reachable,
and shows up in **Browse public servers** for everyone.

## Safety

- Only **public** origins are accepted — `localhost`, private ranges (`10.*`,
  `192.168.*`, `172.16–31.*`, `169.254.*`), `.local`/`.internal` are rejected, so
  the hub never scans internal networks (SSRF-safe).
- Each announced server is **verified reachable** (`/api/health`) before listing.
- Announcements are **rate-limited**; stale servers (silent 48h) drop off the list
  automatically.
- To block a bad entry, set `blocked=1` on its row in the hub's `registry_servers`
  table (a one-click admin control can be added on request).

## Endpoints (for reference)

- `POST /api/registry/announce` `{ url, name, description }` — a server registers.
- `GET  /api/registry/servers?q=` — the public list (proxied to the hub on members).
