# Security & Performance Audit — findings and status

Deep audit run on 4.3.4. Two focused passes (server-side security; performance),
each verified against the source. This records what was fixed and what remains.

## Security — all findings FIXED ✅

| # | Sev | Finding | Fix (commit) |
|---|---|---|---|
| H1 | **Critical** | 2FA bypass: `/recovery-codes/status` + `/generate` used raw `jwt.verify`, accepting a pre-2FA `totp_challenge` token → generate recovery codes → reset password + clear TOTP → account takeover. | Both now use `verifyToken()` (session-only; enforces pwv). Verified: challenge token → 401, session → 200. |
| H2 | **High** | REST privilege escalation: `server.js` had its own `userHasPermission` (+3 inline `upload_files` queries) with no channel-scope, no `user_role_perms` denies, no thresholds — a channel-scoped grant acted server-wide, and per-user denies were ignored. | Delegates to the shared `permissions.js` check. Verified: normal user → 403 on server-wide manage endpoints. |
| M1 | Medium | SSRF: `/api/media-proxy` validated only the first URL, then `redirect:'follow'` → a 302 to `169.254.169.254`/`127.0.0.1` was fetched unchecked. | Manual redirects (max 5) + `validateUrlSafe` on every hop. Verified: 302→internal blocked. |
| — | Moderate | 3 `qs` transitive CVEs (array-limit bypass, DoS) via express/body-parser. | Pinned `qs@6.16.0` via npm override. `npm audit` → 0 vulnerabilities. |
| — | Low | `/sitemap.xml` `<loc>` built from the `Host` header wasn't XML-escaped. | XML-escaped. Verified. |
| L1 | Low | `POST /api/high-scores` had no rate limiter. | Added `scoreLimiter` (30/min). |

**Verified clean** (no action): `verifyToken` scope/pwv enforcement, socket handshake auth (re-reads is_admin/ban from DB), the shared `permissions.js` (honors denies/thresholds/scope), all new gaming socket handlers (properly permission-gated, two-party-confirmed results, no client-trusted ids), SQL parameterization, XSS in the new UIs (`_escapeHtml` throughout) + my face-to-face additions, path traversal (clip/media confined), OIDC verification, admin REST gating, info disclosure, and the auth/upload/mod rate limiters.

## Performance

### Fixed ✅
- **M3 (keystone)** — `getPermissionThresholds()` re-read `server_settings` + `JSON.parse`d on *every* `userHasPermission` call (thousands per broadcast). Now module-scoped TTL cache (5s). Drains a query + parse from the hottest permission path.
- **M4** — added `idx_messages_user` on `messages(user_id)` (ban/kick purge + bulk-remove preview were full scans).
- **L5** — `get-leaderboards` name lookups memoized per request.
- **L7** — `/app` HTML (332 KB read + `?v=` regex) cached per process; landing raw file cached (SEO templating still per-request).
- **HIGH 1 (broadcast N+1, unread)** — `getEnrichedChannels` did a per-channel unread `COUNT(*)` (one query per channel, every channel-list rebuild, from ~24 call-sites). Now **one grouped query** (`WHERE user_id != ? AND thread_id IS NULL AND ((channel_id=? AND id>?) OR …) GROUP BY channel_id`) for exactly the channels with unread. Proven output-equivalent (`test/perfBroadcastEquivalence.test.js`: every read position incl. 0/mid/latest/beyond + 50 randomized mixes) and verified live (real server: unread=2 with the viewer's own message and a thread reply correctly excluded).
- **HIGH 2 (presence scan)** — `emitOnlineUsers` scanned the **entire** `users` table on every presence broadcast. Now scoped to the rendered set — this channel's members — via `WHERE id IN (…)` (the id order is unchanged; both `all` and `online` modes only ever read member rows). Equivalence-tested (scoped scan == full scan filtered to members; non-members provably absent) and verified live (member-scoped `statusMap` returns full profile/status for rendered members; a non-member never appears).

### Verified clean (no action)
Message history/send/push batching (`IN(...)`), all other indexes, memory (every cache evicts; intervals are singletons with sweepers), async bcrypt, and — confirmed by the audit — the face-to-face client timers all self-terminate/stop on leave (no leaks). L6 (voice-UI reconciler `setInterval`) is guarded against stacking and idle-ticks early-return, so it's negligible — left as-is to avoid churning working voice code.

### The big scans are fixed; the rest is deliberately left, with reasons ✅/⚠️
The two full/N-per-broadcast **scans** the audit flagged as the biggest wins are done (see HIGH 1 unread-batch and HIGH 2 presence-scan above) — both as **guaranteed-equivalent** query rewrites (batch a set of identical queries into one; scope a full scan to the rows the code already used), each backed by an output-equivalence test and a live smoke. The remaining sub-items are **not** guaranteed-equivalent, and each would rewrite the hottest fan-out paths where a subtle bug degrades the app for every connected user, so they stay out on purpose:

- **HIGH 1 residual — "compute the permission set once per `getEnrichedChannels`."** Not done, and it would be **wrong**: every `userHasPermission` call in that function is **channel-scoped** (it passes `ch.id`) — `read_only_override`, `kick_user`, `manage_channel_settings`, `manage_sub_channels` — because a grant can exist in one channel and not another. A single server-wide permission set would leak a channel-scoped grant into every channel (the exact `#5467`/`#5468` class of bug these checks were added to fix). The per-channel checks must stay per-channel. The M3 threshold cache already drained the heaviest per-call cost from them.
- **HIGH 2 residual — batch `getUserHighestRole` for the rendered set.** Left as-is. `getUserAllRoles` has **no `ORDER BY`**, so when a user holds two roles at the same effective level, "highest" is decided by incidental row order. A parallel batched query (`user_id IN (…)`) can order those rows differently than the per-user `user_id = ?` query, so a batched presence role could disagree with the `getUserHighestRole` used everywhere else (tooltips, chat hover, player card) for the same user — a visible cross-surface inconsistency. Keeping the shared `getUserHighestRole` as the single source of truth is worth more than removing N tiny indexed lookups (already cheap after M3). Hoisting only `getChannelRoleChain` (a single PK lookup) was judged not worth threading a memo param through the permission API.
- **HIGH 2 residual — don't fan out to all channels for a scoped change.** Left as-is: correct today, just not minimal. Narrowing which channels re-broadcast risks a stale member list for someone (under-scoping), which is precisely the "subtle bug for every user" this section warns about; it needs the realistic multi-user load test that can't be run here.
- **LOW 8** — thread-messages query (`messages.js:1917`) has no `LIMIT` (bounded in practice; add a cap if threads can grow large).

A natural companion would be a short-TTL, explicitly-invalidated **per-user permission memo** — but it carries a revocation-staleness (security) dimension and must invalidate on every role / `user_role_perms` / threshold / channel-assignment change, so it stays out for the same reason.
