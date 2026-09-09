# Getting MSG Arena into Google (Search Console)

This is the exact, no-guesswork way to verify your deployment in **Google Search
Console (GSC)** and get the public pages indexed. It takes ~5 minutes plus a
redeploy.

> **What actually gets indexed.** The **app is `noindex` by design** — only the
> public marketing surface is crawlable: the landing page `/` and the SEO pages
> `/about`, `/description`, `/download`, `/history` (plus `/sitemap.xml` and
> `/robots.txt`). This is controlled by `seoIndexingAllowed()` — see
> [Why verification / indexing fails](#why-it-fails) below.

---

## 1. Add the property — pick the right type

In Search Console click **Add property** and choose **URL prefix** (NOT "Domain",
unless you can edit DNS TXT records and want *all* subdomains).

Enter the **exact address people actually reach**, including the scheme and no
trailing junk. On Railway that is your Railway domain, e.g.:

```
https://msg-arena-production.up.railway.app/
```

or, if you set `PUBLIC_URL` / a custom domain, that exact `https://…` host. This
**must match** the address the site serves as its canonical (`baseUrl(req)` →
`PUBLIC_URL` / `X-Forwarded-Host`). `http://` vs `https://`, `www.` vs bare, and
a different domain are all treated by Google as **different properties** — that
is the #1 reason verification "mysteriously" fails.

---

## 2. Verify — two ways, pick one

### Method A — Meta tag (recommended, one env var)

1. In GSC, under **HTML tag**, Google shows something like:
   ```html
   <meta name="google-site-verification" content="AbCdEf123_XXXXXXXXXXXXXXXXXXXXXXXXXXXX" />
   ```
   Copy **only the `content` value** (`AbCdEf123_XXXX…`).
2. On the server set the environment variable (Railway → your service →
   **Variables**):
   ```
   GOOGLE_SITE_VERIFICATION=AbCdEf123_XXXXXXXXXXXXXXXXXXXXXXXXXXXX
   ```
3. **Redeploy** (Railway redeploys on a variable change; otherwise click Deploy).
4. Back in GSC click **Verify**.

The tag is injected into the `<head>` of **both** the landing page `/` **and**
every SEO page (`/about`, etc.). You can confirm it shipped with:

```bash
curl -s https://YOUR-DOMAIN/ | grep google-site-verification
```

Leaving `GOOGLE_SITE_VERIFICATION` unset injects nothing (no empty tag).

### Method B — HTML file

1. In GSC, under **HTML file**, download the `googleXXXXXXXXXXXX.html` file.
2. Drop that file into the app's **`public/`** folder (same folder as
   `robots.txt`'s content, `favicon.ico`, etc.). It is served as-is by
   `express.static`, so `https://YOUR-DOMAIN/googleXXXXXXXXXXXX.html` will return
   Google's token verbatim — no code change needed.
3. Commit + **redeploy**, then click **Verify** in GSC.
   ```bash
   curl -s https://YOUR-DOMAIN/googleXXXXXXXXXXXX.html   # should print: google-site-verification: googleXXXX...
   ```

Either method is sufficient. Keep whichever you used in place — Google
re-checks periodically and will **un-verify** you if the tag/file disappears.

---

## 3. Submit the sitemap

Once verified, in GSC open **Sitemaps** and submit:

```
sitemap.xml
```

(the full URL is `https://YOUR-DOMAIN/sitemap.xml`). It is generated on the fly
and lists `/` plus the four SEO pages with priorities. `robots.txt`
(`https://YOUR-DOMAIN/robots.txt`) also advertises the sitemap automatically.

---

## <a name="why-it-fails"></a>4. Why verification / indexing commonly fails

| Symptom | Cause | Fix |
|---|---|---|
| "Verification failed" right away | Wrong **property type/URL** — `http` vs `https`, `www` vs bare, or a different domain than the one that serves the token. | Add the property as **URL prefix** with the **exact** `https://…` address the site serves. |
| Verified, then loses verification | Tag/file removed, or env var dropped on redeploy. | Keep `GOOGLE_SITE_VERIFICATION` set (or the file in `public/`) permanently. |
| Verifies, but pages won't index | `NOINDEX` is on. When `NOINDEX=true` (or the `search_indexing` server setting is off), `robots.txt` returns `Disallow: /` and every page is `noindex, nofollow`. | For a public site, **do not set `NOINDEX`** (and leave `search_indexing` enabled). Verification can still succeed under `NOINDEX`, but nothing will be indexed. |
| "Page with redirect" / can't fetch | The verified URL **redirects to another domain**. Google verifies the URL you entered; if it 301/302s elsewhere, verification and indexing break. | **Do not** put a redirect in front of the verified address. The earlier idea of *redirecting Railway → an AWS domain* would **break GSC verification** — verify (and canonicalise via `PUBLIC_URL`) the domain you actually serve from, and register **that** exact domain in GSC. If you must move domains, verify the new domain as its own property. |
| App pages missing from index | By design — `/app` and `/api/` are disallowed in `robots.txt`; only the marketing pages are indexable. | Nothing to fix; this is intended. |

**Sanity checks (run these against your live domain):**

```bash
curl -s https://YOUR-DOMAIN/robots.txt      # must NOT be "Disallow: /" for a public site
curl -s https://YOUR-DOMAIN/sitemap.xml      # must list / and the SEO pages
curl -sI https://YOUR-DOMAIN/                # must be 200 (not a 30x to another domain)
curl -s https://YOUR-DOMAIN/ | grep -E 'canonical|robots'   # canonical == your GSC URL; robots == index,follow
```

If `robots.txt` shows `User-agent: *` / `Disallow: /` and you want to be
indexed, unset `NOINDEX` (and ensure the `search_indexing` server setting is not
disabled), then redeploy.

---

## 5. How long indexing takes

- **Verification:** instant once the tag/file is live and the URL matches.
- **First crawl of the sitemap:** usually hours to a few days.
- **Pages appearing in results:** typically a few days to ~2 weeks for a new
  site; there is no way to force it. Use **URL Inspection → Request indexing** in
  GSC to nudge an individual important page (e.g. `/` or `/about`).

Indexing is Google's call, not a setting — a correctly verified, crawlable,
sitemap-submitted site is all you can do from this side.

---

## Reference — what the app already provides

- `robots.txt` — served dynamically at `/robots.txt`; allows the public pages,
  disallows `/app`, `/api/`, `/uploads/`, `/connect/`, `/invite/`, and points to
  the sitemap. Returns `Disallow: /` only when `NOINDEX`/`search_indexing` say so.
- `sitemap.xml` — served dynamically at `/sitemap.xml`; lists `/` + the four SEO
  pages. (Both are routes, not static files — do not add `public/robots.txt` or
  `public/sitemap.xml`, they would be shadowed by the routes.)
- Per-deploy canonical/OG URLs come from `PUBLIC_URL` / `X-Forwarded-Host` — set
  `PUBLIC_URL` to your public `https://…` address so canonicals match GSC.
- `GOOGLE_SITE_VERIFICATION` — env var; when set, injects the verification
  `<meta>` into `/` and all SEO pages.
