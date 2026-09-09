'use strict';
/**
 * Public, crawlable content pages (/about, /description, /download, /history).
 * The app itself is behind auth and noindex; these give search engines real,
 * keyword-relevant content to rank, and give visitors somewhere to land from a
 * search result. Each page renders a complete SEO <head> (title, description,
 * canonical, robots, Open Graph, Twitter, JSON-LD incl. breadcrumbs) plus a
 * shared, self-contained layout — no dependency on the 600KB app CSS, so the
 * pages load fast (which itself helps ranking).
 *
 * Visual language matches the app: CYAN-primary on a near-black ground. No
 * decorative emoji anywhere (hard product rule) — section/card glyphs are small
 * inline SVGs that stroke `currentColor` in cyan.
 *
 * All absolute URLs are built from the caller's `base` (baseUrl(req), which
 * honours PUBLIC_URL / X-Forwarded-Host) so canonicals are correct per-deploy.
 * The per-OS download buttons point at same-origin server routes
 * (/download/windows, /download/mac, /download/linux, /download/android) that
 * 302 to the newest matching release asset — see server.js.
 */

const esc = (v) => String(v == null ? '' : v)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

// ── Inline SVG glyphs (no emoji) ─────────────────────────────────────────
// Each value is the *inner* markup of a 24×24 viewBox icon. They inherit the
// cyan accent via `.ico { color: var(--cyan) }` and stroke `currentColor`.
const ICONS = {
  controller: '<path d="M6 12h4M8 10v4"/><circle cx="15" cy="11" r="1"/><circle cx="17.5" cy="13.5" r="1"/><rect x="2" y="6" width="20" height="12" rx="5"/>',
  server: '<rect x="3" y="4" width="18" height="7" rx="2"/><rect x="3" y="13" width="18" height="7" rx="2"/><path d="M7 7.5h.01M7 16.5h.01"/>',
  video: '<rect x="2" y="6" width="14" height="12" rx="2"/><path d="M16 10l6-3v10l-6-3z"/>',
  trend: '<path d="M3 3v18h18"/><path d="M7 14l4-4 3 3 5-6"/>',
  group: '<circle cx="9" cy="8" r="3"/><path d="M4 20c0-3 2.3-5 5-5s5 2 5 5"/><path d="M16 5.5a3 3 0 0 1 0 5"/><path d="M17 15c2 .6 3 2.3 3 5"/>',
  trophy: '<path d="M7 4h10v4a5 5 0 0 1-10 0z"/><path d="M7 5H4v1.5A3.5 3.5 0 0 0 7.5 10"/><path d="M17 5h3v1.5A3.5 3.5 0 0 1 16.5 10"/><path d="M12 13v4"/><path d="M9.5 21a2.5 2.5 0 0 1 5 0"/><path d="M8 21h8"/>',
  clip: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M10 9l5 3-5 3z"/>',
  mic: '<rect x="9" y="3" width="6" height="10" rx="3"/><path d="M6 11a6 6 0 0 0 12 0"/><path d="M12 17v3"/><path d="M9 20h6"/>',
  star: '<path d="M12 3l2.6 5.3 5.9.9-4.3 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8L3.5 9.2l5.9-.9z"/>',
  shield: '<path d="M12 3l7 3v5c0 4.5-3 7.6-7 9-4-1.4-7-4.5-7-9V6z"/>',
  chart: '<path d="M4 20V10"/><path d="M10 20V4"/><path d="M16 20v-8"/><path d="M22 20H2"/>',
  calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 9h18"/><path d="M8 3v4"/><path d="M16 3v4"/>',
  link: '<path d="M9 15a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1.5 1.5"/><path d="M15 9a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7L13.5 16"/>',
  lock: '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
  palette: '<path d="M12 3a9 9 0 1 0 0 18 2 2 0 0 0 1.7-3 2 2 0 0 1 1.7-3H18a3 3 0 0 0 3-3 9 9 0 0 0-9-9z"/><circle cx="7.5" cy="12" r="1"/><circle cx="10" cy="7.5" r="1"/><circle cx="15" cy="7.5" r="1"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3a15 15 0 0 1 0 18a15 15 0 0 1 0-18z"/>',
  windows: '<rect x="3" y="4" width="7.5" height="7.5" rx="1"/><rect x="13.5" y="4" width="7.5" height="7.5" rx="1"/><rect x="3" y="12.5" width="7.5" height="7.5" rx="1"/><rect x="13.5" y="12.5" width="7.5" height="7.5" rx="1"/>',
  laptop: '<rect x="5" y="5" width="14" height="10" rx="1"/><path d="M2 19h20l-2-3H4z"/>',
  terminal: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 9l3 3-3 3"/><path d="M12.5 15H16"/>',
  phone: '<rect x="6" y="2" width="12" height="20" rx="2"/><path d="M10 18.5h4"/>',
  share: '<path d="M12 3v11"/><path d="M8.5 6.5L12 3l3.5 3.5"/><path d="M6 12v6a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2v-6"/>',
  download: '<path d="M12 3v12"/><path d="M8 11l4 4 4-4"/><path d="M5 21h14"/>',
};

// Inline glyph used inside a heading (~20px, cyan).
const ico = (name) =>
  `<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ''}</svg>`;
// Smaller glyph used inline in a button.
const bico = (name) =>
  `<svg class="bico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ''}</svg>`;

// Ordered — this order also drives the nav and the sitemap.
const PAGES = [
  {
    slug: 'about',
    nav: 'About',
    title: 'About — the self-hosted messenger for gamers',
    description: 'MSG Arena is a free, open-source, self-hosted chat platform built for gaming communities: LFG matchmaking, tournaments, clips, voice, leveling and more — your server, your data.',
    priority: '0.9',
    body: (c) => `
      <section class="hero">
        <p class="eyebrow">Self-hosted · Open source · Built for gamers</p>
        <h1>A messenger your <span class="grad">squad actually owns</span></h1>
        <p class="lede">${esc(c.siteName)} is a free, self-hosted chat platform made for gaming communities. Run it on your own server and get matchmaking, tournaments, clips, voice and a full progression system — with none of your conversations living on someone else's cloud.</p>
        <div class="cta-row">
          <a class="btn btn-primary" href="/app">Open the app</a>
          <a class="btn" href="${esc(c.rel('description'))}">See all features</a>
        </div>
      </section>
      <section>
        <h2>What makes it different</h2>
        <div class="grid">
          <div class="card"><h3>${ico('controller')}Built for play, not just chat</h3><p>LFG matchmaking, tournaments and ladders, game clips, squads and leaderboards are first-class — not bolted-on bots.</p></div>
          <div class="card"><h3>${ico('server')}Truly self-hosted</h3><p>You host it. Messages, uploads and accounts live on your machine. End-to-end-encrypted DMs mean even the server can't read them.</p></div>
          <div class="card"><h3>${ico('video')}Real face-to-face</h3><p>Low-latency voice and a redesigned webcam stage with active-speaker cues — the room feels present, not laggy.</p></div>
          <div class="card"><h3>${ico('trend')}Progression that sticks</h3><p>Activity XP, levels, daily streaks and automatic level-role rewards keep your community coming back.</p></div>
        </div>
      </section>
      <section class="split">
        <div>
          <h2>Who it's for</h2>
          <p>Clans, LAN groups, esports teams, streamer communities and friend groups who want one place to line up games, run brackets, share highlights and hang out in voice — without renting it from a platform that mines the data.</p>
          <p>Because it's <strong>self-hosted and AGPL-licensed</strong>, you can read the code, change it, and keep it forever.</p>
        </div>
        <div>
          <h2>One account, every device</h2>
          <p>The web app, desktop app and Android app are all thin clients of your one server, so everyone converses together and every feature updates everywhere at once. <a href="${esc(c.rel('download'))}">Get the apps &rarr;</a></p>
        </div>
      </section>`,
  },
  {
    slug: 'description',
    nav: 'Features',
    title: 'Features — LFG, tournaments, clips, voice & leveling',
    description: 'Every feature of MSG Arena: LFG matchmaking with auto voice rooms, tournaments & ELO ladders, game clips, low-latency voice & webcam, XP leveling with role rewards, squads, leaderboards, achievements and events.',
    priority: '0.9',
    body: (c) => `
      <section class="hero">
        <p class="eyebrow">Everything in the box</p>
        <h1>Every feature, <span class="grad">made for gamers</span></h1>
        <p class="lede">${esc(c.siteName)} bundles the tools a gaming community actually uses into one self-hosted server.</p>
        <div class="cta-row"><a class="btn btn-primary" href="/app">Open the app</a></div>
      </section>
      <section>
        <div class="grid">
          <div class="card"><h3>${ico('group')}LFG / party finder</h3><p>Post "need 1 for ranked", fill the slots, and the app drops everyone into a fresh voice room automatically.</p></div>
          <div class="card"><h3>${ico('trophy')}Tournaments &amp; ladders</h3><p>Single-elimination brackets and ELO ladders with two-party-confirmed results — no client-faked scores.</p></div>
          <div class="card"><h3>${ico('clip')}Clips &amp; highlights</h3><p>Upload plays, capture a poster frame client-side, stream with seek support, and vote them up.</p></div>
          <div class="card"><h3>${ico('mic')}Voice &amp; face-to-face</h3><p>Low-latency mesh voice (optional SFU), screen share, and a webcam stage with live active-speaker rings.</p></div>
          <div class="card"><h3>${ico('star')}Leveling &amp; rewards</h3><p>Earn XP by chatting and in voice, keep a daily streak alive, and unlock roles automatically as you level up.</p></div>
          <div class="card"><h3>${ico('shield')}Squads / teams</h3><p>Persistent teams with invites, roles and their own voice — your roster in one place.</p></div>
          <div class="card"><h3>${ico('chart')}Leaderboards &amp; achievements</h3><p>Ranked boards for levels, clips and ladders, plus achievements to chase.</p></div>
          <div class="card"><h3>${ico('calendar')}Events</h3><p>Schedule game nights and scrims with RSVPs and capacity limits.</p></div>
          <div class="card"><h3>${ico('controller')}Game identity &amp; presence</h3><p>Link your games, show "playing now", and find others who play what you do.</p></div>
          <div class="card"><h3>${ico('link')}One-click invites</h3><p>Share a link; opening it joins the server and adds it to the rail — no URLs to type.</p></div>
          <div class="card"><h3>${ico('lock')}Privacy by design</h3><p>Self-hosted, end-to-end-encrypted DMs, and a strict content policy so hostile links can't leak your members' IPs.</p></div>
          <div class="card"><h3>${ico('palette')}Themes &amp; a gamer UI</h3><p>A dark, duotone interface with 25+ themes, built to feel like a place for players.</p></div>
        </div>
      </section>`,
  },
  {
    slug: 'download',
    nav: 'Download',
    title: 'Download the apps — Windows, macOS, Linux, Android & Web',
    description: 'Get MSG Arena on Windows, macOS, Linux, Android, iOS and the web. Download the desktop installer, grab the Android APK, or install the PWA in one tap — every client connects to your self-hosted server.',
    priority: '0.8',
    body: (c) => `
      <section class="hero">
        <p class="eyebrow">Same account, every screen</p>
        <h1>Get <span class="grad">${esc(c.siteName)}</span></h1>
        <p class="lede">Every client is a thin window onto your one server, so features and messages stay in sync everywhere. Pick your platform below — each button grabs the latest build.</p>
      </section>
      <section>
        <div class="grid">

          <div class="card">
            <h3>${ico('windows')}Windows</h3>
            <p>Native desktop app for Windows 10 &amp; 11 with a unified dark window.</p>
            <ul class="feat">
              <li>Auto-updates its shell when a new build ships</li>
              <li>Global shortcuts and tray presence</li>
              <li>Installs like any <code>.exe</code> — no store account</li>
            </ul>
            <p class="usage">Run the downloaded installer and follow the wizard. It keeps itself up to date from then on.</p>
            <a class="btn btn-primary" href="/download/windows">${bico('download')}Download for Windows</a>
          </div>

          <div class="card">
            <h3>${ico('laptop')}macOS</h3>
            <p>The desktop app packaged as a <code>.dmg</code> disk image for macOS.</p>
            <ul class="feat">
              <li>Same features as the Windows build</li>
              <li>Drag-to-Applications install</li>
              <li>Universal desktop shell</li>
            </ul>
            <p class="usage">Open the <code>.dmg</code> and drag MSG Arena into Applications. If macOS warns about an unidentified developer, right-click the app &rarr; Open the first time.</p>
            <a class="btn btn-primary" href="/download/mac">${bico('download')}Download for macOS</a>
          </div>

          <div class="card">
            <h3>${ico('terminal')}Linux</h3>
            <p>A portable <code>.AppImage</code> that runs on most modern distributions.</p>
            <ul class="feat">
              <li>No package manager or root needed</li>
              <li>Self-contained single file</li>
              <li>Same shell and auto-update path</li>
            </ul>
            <p class="usage">Download the <code>.AppImage</code>, then <code>chmod +x</code> it and run it (or mark it executable in your file manager).</p>
            <a class="btn btn-primary" href="/download/linux">${bico('download')}Download for Linux</a>
          </div>

          <div class="card">
            <h3>${ico('phone')}Android</h3>
            <p>A native Android build delivered as an installable <code>.apk</code>.</p>
            <ul class="feat">
              <li>Full-screen native shell</li>
              <li>Push-style notifications</li>
              <li>Or install the PWA straight from the browser</li>
            </ul>
            <p class="usage">Download the APK, then allow "install from this source" if Android prompts you, and open it to install.</p>
            <a class="btn btn-primary" href="/download/android">${bico('download')}Download the APK</a>
          </div>

          <div class="card">
            <h3>${ico('share')}iOS / iPadOS</h3>
            <p>No sideloading on iOS — install the web app to your Home Screen instead.</p>
            <ul class="feat">
              <li>Runs full-screen like a native app</li>
              <li>Works offline-first for the shell</li>
              <li>A true App Store build is planned</li>
            </ul>
            <p class="usage">Open the web app in <strong>Safari</strong>, tap <strong>Share</strong>, then <strong>Add to Home Screen</strong>.</p>
            <a class="btn" href="/app">Open the web app</a>
          </div>

          <div class="card">
            <h3>${ico('globe')}Web &amp; PWA</h3>
            <p>Nothing to install — open it in any modern browser and sign in.</p>
            <ul class="feat">
              <li>Always the newest version</li>
              <li>Installable as a desktop/mobile PWA</li>
              <li>Identical to the native clients</li>
            </ul>
            <p class="usage">Click below to open it. To install, choose <em>Install app</em> in the address bar (desktop) or <em>Add to Home Screen</em> (mobile).</p>
            <a class="btn btn-primary" href="/app">Open in browser</a>
          </div>

        </div>
        ${c.releaseUrl ? `<p class="muted" style="margin-top:20px">Looking for a specific build, an older version or checksums? <a href="${esc(c.releaseUrl)}" rel="noopener">Browse all releases &rarr;</a></p>` : `<p class="muted" style="margin-top:20px">Native builds are published on the operator's release page once <code>UPDATE_REPO</code> is configured.</p>`}
      </section>
      <section class="split">
        <div><h2>How updates work</h2><p>Because the apps load their interface from the server, features and fixes reach web, desktop and mobile the moment the server updates — you rarely reinstall anything. The desktop app also auto-updates its native shell when a new build is published.</p></div>
        <div><h2>Need an account?</h2><p>Accounts are created on the server you connect to. Open the app and register, or use an invite link from a friend. <a href="${esc(c.rel('about'))}">Learn more &rarr;</a></p></div>
      </section>`,
  },
  {
    slug: 'history',
    nav: 'History',
    title: 'History — the story & release timeline',
    description: 'How MSG Arena grew from a self-hosted chat app into a full gaming messenger: matchmaking, tournaments, clips, voice, leveling and role rewards — a timeline of what shipped.',
    priority: '0.6',
    body: (c) => `
      <section class="hero">
        <p class="eyebrow">The story so far</p>
        <h1>Built in the open, <span class="grad">for players</span></h1>
        <p class="lede">${esc(c.siteName)} started as a private, self-hosted chat server and grew into a messenger designed around how gaming communities actually play together.</p>
      </section>
      <section>
        <ol class="timeline">
          <li><span class="t-tag">Foundation</span><h3>A private place to talk</h3><p>Channels, threads, search, roles &amp; permissions, moderation, end-to-end-encrypted DMs and low-latency voice — a solid, self-hosted core.</p></li>
          <li><span class="t-tag">The gaming layer</span><h3>From chat to arena</h3><p>LFG matchmaking with automatic voice rooms, game identity &amp; "playing now" presence, clips, and tournaments with ELO ladders.</p></li>
          <li><span class="t-tag">Face-to-face</span><h3>Making the room feel present</h3><p>A redesigned webcam stage with gallery/spotlight layouts, live active-speaker rings, connection-quality cues and accessibility.</p></li>
          <li><span class="t-tag">Progression</span><h3>Reasons to come back</h3><p>Activity XP and levels, daily streaks, and automatic level-role rewards — plus squads, leaderboards and achievements.</p></li>
          <li><span class="t-tag">Everywhere</span><h3>One server, every device</h3><p>Web, installable PWA, desktop and Android clients, all in sync, with one-click invite links to bring friends in.</p></li>
        </ol>
        <p class="muted">A detailed, versioned changelog ships inside the app and the source repository.</p>
      </section>`,
  },
];

const NAV = PAGES.map(p => ({ slug: p.slug, nav: p.nav }));

function head(ctx, page) {
  const url = ctx.base + '/' + page.slug;
  const robots = ctx.indexable ? 'index, follow' : 'noindex, nofollow';
  const jsonld = JSON.stringify({
    '@context': 'https://schema.org',
    '@graph': [
      { '@type': 'WebPage', '@id': url + '#webpage', url, name: page.title,
        description: page.description, isPartOf: { '@id': ctx.base + '/#website' }, inLanguage: 'en' },
      { '@type': 'BreadcrumbList', itemListElement: [
        { '@type': 'ListItem', position: 1, name: ctx.siteName, item: ctx.base + '/' },
        { '@type': 'ListItem', position: 2, name: page.nav, item: url },
      ] },
    ],
  }).replace(/</g, '\\u003c');
  return [
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${esc(page.title)} · ${esc(ctx.siteName)}</title>`,
    `<meta name="description" content="${esc(page.description)}">`,
    `<link rel="canonical" href="${esc(url)}">`,
    `<meta name="robots" content="${robots}">`,
    // Google Search Console meta-tag verification — injected only when the
    // operator sets GOOGLE_SITE_VERIFICATION (see docs/google-search-console.md).
    ctx.googleVerify ? `<meta name="google-site-verification" content="${esc(ctx.googleVerify)}">` : '',
    `<meta property="og:type" content="website">`,
    `<meta property="og:site_name" content="${esc(ctx.siteName)}">`,
    `<meta property="og:title" content="${esc(page.title)}">`,
    `<meta property="og:description" content="${esc(page.description)}">`,
    `<meta property="og:url" content="${esc(url)}">`,
    `<meta property="og:image" content="${esc(ctx.ogImage)}">`,
    `<meta name="twitter:card" content="summary_large_image">`,
    `<meta name="twitter:title" content="${esc(page.title)}">`,
    `<meta name="twitter:description" content="${esc(page.description)}">`,
    `<meta name="twitter:image" content="${esc(ctx.ogImage)}">`,
    `<link rel="icon" type="image/svg+xml" href="/favicon.svg">`,
    `<script type="application/ld+json">${jsonld}</script>`,
  ].filter(Boolean).join('\n  ');
}

// CYAN-primary palette to match the dark app (no violet).
const STYLE = `
  :root{--bg:#0a0e17;--surface:#121826;--surface2:#171f2f;--line:rgba(120,160,220,.16);
    --text:#e9eef8;--dim:#9fb0cc;--cyan:#22d3ee;
    --grad:linear-gradient(135deg,#22d3ee,#0ea5e9);
    --font:'Inter',ui-sans-serif,system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;}
  *{box-sizing:border-box}
  body{margin:0;background:
    radial-gradient(900px 520px at 8% -10%,rgba(34,211,238,.12),transparent 60%),
    radial-gradient(820px 640px at 106% 2%,rgba(14,165,233,.10),transparent 58%),var(--bg);
    color:var(--text);font-family:var(--font);line-height:1.65;-webkit-font-smoothing:antialiased}
  a{color:var(--cyan);text-decoration:none}a:hover{text-decoration:underline}
  .wrap{max-width:1040px;margin:0 auto;padding:0 22px}
  header.site{position:sticky;top:0;z-index:5;backdrop-filter:blur(10px);
    background:color-mix(in srgb,var(--bg) 78%,transparent);border-bottom:1px solid var(--line)}
  header.site .wrap{display:flex;align-items:center;gap:18px;height:60px}
  .brand{display:flex;align-items:center;gap:9px;font-weight:800;letter-spacing:.4px;font-size:1.05rem}
  .brand .mark{width:26px;height:26px;display:block;flex:none}
  .brand b{background:var(--grad);-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent}
  nav.top{display:flex;gap:16px;margin-left:auto;flex-wrap:wrap}
  nav.top a{color:var(--dim);font-size:.9rem;font-weight:600}nav.top a.active,nav.top a:hover{color:var(--text);text-decoration:none}
  nav.top a.app{color:#06121a;background:var(--grad);padding:7px 14px;border-radius:999px}
  .eyebrow{color:var(--dim);font-size:.72rem;letter-spacing:.22em;text-transform:uppercase;font-weight:700;margin:0 0 10px}
  h1{font-size:clamp(2rem,5vw,3.2rem);line-height:1.05;letter-spacing:-.01em;margin:.1em 0 .3em;text-wrap:balance}
  .grad{background:var(--grad);-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent}
  .lede{font-size:1.12rem;color:var(--dim);max-width:64ch}
  section{padding:40px 0;border-top:1px solid var(--line)}
  section.hero{border-top:none;padding-top:56px}
  h2{font-size:1.5rem;margin:0 0 18px;letter-spacing:-.01em}
  h3{font-size:1.06rem;margin:0 0 6px;display:flex;align-items:center;gap:9px}
  .ico{width:20px;height:20px;color:var(--cyan);flex:none}
  .bico{width:16px;height:16px;flex:none;vertical-align:-3px;margin-right:7px}
  .cta-row{display:flex;gap:12px;flex-wrap:wrap;margin-top:22px}
  .btn{display:inline-flex;align-items:center;padding:11px 20px;border-radius:12px;border:1px solid var(--line);color:var(--text);font-weight:700;background:var(--surface2)}
  .btn:hover{text-decoration:none;border-color:color-mix(in srgb,var(--cyan) 50%,var(--line))}
  .btn-primary{background:var(--grad);color:#06121a;border:none;box-shadow:0 8px 24px -8px rgba(34,211,238,.6)}
  .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:16px}
  .card{background:linear-gradient(180deg,var(--surface2),var(--surface));border:1px solid var(--line);border-radius:16px;padding:20px;display:flex;flex-direction:column}
  .card p{color:var(--dim);margin:.2em 0 0;font-size:.95rem}
  .card .btn{margin-top:auto;align-self:flex-start}
  .card ul.feat{margin:12px 0 0;padding-left:18px;color:var(--dim);font-size:.9rem}
  .card ul.feat li{margin:3px 0}
  .card .usage{font-size:.86rem;color:var(--dim);margin:12px 0 14px}
  .card code{background:var(--surface);border:1px solid var(--line);border-radius:6px;padding:1px 6px;font-size:.85em}
  .split{display:grid;grid-template-columns:1fr 1fr;gap:34px}
  .split p{color:var(--dim)}
  .muted{color:var(--dim);font-size:.9rem}
  ol.timeline{list-style:none;padding:0;margin:0;display:grid;gap:14px}
  ol.timeline li{position:relative;padding:18px 20px;background:var(--surface);border:1px solid var(--line);border-radius:14px}
  ol.timeline h3{display:block}
  .t-tag{display:inline-block;font-size:.66rem;letter-spacing:.14em;text-transform:uppercase;font-weight:700;color:var(--cyan);margin-bottom:6px}
  ol.timeline p{color:var(--dim);margin:.2em 0 0}
  footer.site{border-top:1px solid var(--line);padding:28px 0;color:var(--dim);font-size:.88rem}
  footer.site .wrap{display:flex;gap:16px;flex-wrap:wrap;align-items:center}
  footer.site nav{display:flex;gap:14px;flex-wrap:wrap}footer.site a{color:var(--dim)}
  @media(max-width:720px){.split{grid-template-columns:1fr}}
  @media(prefers-reduced-motion:reduce){*{scroll-behavior:auto}}
`;

function renderPage(ctx, page) {
  const rel = (slug) => ctx.base + '/' + slug;
  const topNav = NAV.map(n =>
    `<a href="${esc(rel(n.slug))}"${n.slug === page.slug ? ' class="active" aria-current="page"' : ''}>${esc(n.nav)}</a>`
  ).join('\n        ');
  const footNav = NAV.map(n => `<a href="${esc(rel(n.slug))}">${esc(n.nav)}</a>`).join('\n          ');
  const bodyCtx = { siteName: ctx.siteName, releaseUrl: ctx.releaseUrl, rel };
  // Real brand mark (transparent hexagon "play" logo) + gradient wordmark.
  const brand = `<a class="brand" href="${esc(ctx.base)}/"><img class="mark" src="/logo-mark.png" width="26" height="26" alt=""><b>${esc(ctx.siteName)}</b></a>`;
  return `<!doctype html>
<html lang="en">
<head>
  ${head(ctx, page)}
  <style>${STYLE}</style>
</head>
<body>
  <header class="site">
    <div class="wrap">
      ${brand}
      <nav class="top">
        ${topNav}
        <a class="app" href="/app">Open app</a>
      </nav>
    </div>
  </header>
  <main class="wrap">
    ${page.body(bodyCtx)}
  </main>
  <footer class="site">
    <div class="wrap">
      ${brand}
      <nav>
          ${footNav}
      </nav>
      <span style="margin-left:auto">Self-hosted · Open source · Built for gamers</span>
    </div>
  </footer>
</body>
</html>`;
}

module.exports = { PAGES, NAV, renderPage, slugs: () => PAGES.map(p => ({ slug: p.slug, priority: p.priority })) };
