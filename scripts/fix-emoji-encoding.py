#!/usr/bin/env python3
"""
One-shot repair for docs/index.html + website/index.html after Windows-1252
round-trips destroyed emojis.

What this does:
  1. Reads docs/index.html as raw bytes.
  2. Replaces literal '?' / '??' / '???' placeholders left over from the
     cp1252 round-trip with the actual emoji that was there originally.
  3. Replaces any lingering 0x97 byte (cp1252 em-dash) with proper UTF-8 em-dash.
  4. Writes BOTH docs/index.html and website/index.html as UTF-8 *with BOM*.
     The BOM is intentional: it forces every editor (including PS5 Set-Content
     and Notepad) to detect UTF-8 on open, so a later round-trip cannot silently
     re-encode to cp1252 and re-destroy the emojis.

This is paired with .editorconfig + .gitattributes to make UTF-8 sticky
repo-wide.
"""
from __future__ import annotations
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
DOCS = ROOT / "docs" / "index.html"
WEB  = ROOT / "website" / "index.html"

# Replacements are keyed on the FULL line text (after stripping trailing
# whitespace) so we never accidentally rewrite a different occurrence of '??'.
# Left side: exact current line content (one line, no newline)
# Right side: replacement (one line, no newline)
LINE_FIXES: list[tuple[str, str]] = [
    # favicon SVG
    (
        "  <link rel=\"icon\" type=\"image/svg+xml\" href=\"data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>?</text></svg>\">",
        "  <link rel=\"icon\" type=\"image/svg+xml\" href=\"data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>\u2B21</text></svg>\">",
    ),
    # NAV brand: hexagon + MSG ARENA
    ("      <div class=\"nav-brand\"><span class=\"hex\">?</span> MSG ARENA</div>",
     "      <div class=\"nav-brand\"><span class=\"hex\">\u2B21</span> MSG ARENA</div>"),
    # Mobile menu toggle: hamburger
    ("      <button class=\"nav-mobile-toggle\" onclick=\"document.querySelector('.nav-links').classList.toggle('open')\" aria-label=\"Toggle menu\">?</button>",
     "      <button class=\"nav-mobile-toggle\" onclick=\"document.querySelector('.nav-links').classList.toggle('open')\" aria-label=\"Toggle menu\">\u2630</button>"),
    # Hero: Download MSG Arena
    ("            <span class=\"icon\">?</span> Download MSG Arena",
     "            <span class=\"icon\">\u2B07</span> Download MSG Arena"),
    # Hero: Try it Live
    ("            <span class=\"icon\">?</span> Try it Live",
     "            <span class=\"icon\">\u25B6</span> Try it Live"),
    # Community banner heading
    ("        <h2>?? Try MSG Arena &mdash; <span class=\"community-accent\">No Download Required</span></h2>",
     "        <h2>\U0001F310 Try MSG Arena &mdash; <span class=\"community-accent\">No Download Required</span></h2>"),
    # Join Community Server button
    ("            <span class=\"icon\">?</span> Join Community Server",
     "            <span class=\"icon\">\U0001F310</span> Join Community Server"),
    # Channel-code hint
    ("          <p style=\"font-size: 0.95rem; color: var(--text); margin-bottom: 8px; font-weight: 600;\">?? After signing up, enter this channel code to join:</p>",
     "          <p style=\"font-size: 0.95rem; color: var(--text); margin-bottom: 8px; font-weight: 600;\">\U0001F511 After signing up, enter this channel code to join:</p>"),
    # Discord import heading
    ("        <h2>?? NEW &mdash; Import your <span class=\"discord-blue\">Discord</span> history</h2>",
     "        <h2>\U0001F4E5 NEW &mdash; Import your <span class=\"discord-blue\">Discord</span> history</h2>"),
    # Discord feature pills
    ("          <span class=\"discord-feat\">?? Text channels</span>",
     "          <span class=\"discord-feat\">\U0001F4AC Text channels</span>"),
    ("          <span class=\"discord-feat\">?? Announcements</span>",
     "          <span class=\"discord-feat\">\U0001F4E2 Announcements</span>"),
    ("          <span class=\"discord-feat\">?? Forums &amp; tags</span>",
     "          <span class=\"discord-feat\">\U0001F5C2\uFE0F Forums &amp; tags</span>"),
    ("          <span class=\"discord-feat\">?? Threads</span>",
     "          <span class=\"discord-feat\">\U0001F9F5 Threads</span>"),
    ("          <span class=\"discord-feat\">?? Reactions</span>",
     "          <span class=\"discord-feat\">\U0001F60A Reactions</span>"),
    ("          <span class=\"discord-feat\">?? Pins</span>",
     "          <span class=\"discord-feat\">\U0001F4CC Pins</span>"),
    ("          <span class=\"discord-feat\">?? Attachments</span>",
     "          <span class=\"discord-feat\">\U0001F4CE Attachments</span>"),
    ("          <span class=\"discord-feat\">??? Avatars</span>",
     "          <span class=\"discord-feat\">\U0001F5BC\uFE0F Avatars</span>"),
    ("          <span class=\"discord-feat\">?? Replies</span>",
     "          <span class=\"discord-feat\">\u21A9\uFE0F Replies</span>"),
    # Desktop heading
    ("        <h2>??? NEW &mdash; <span class=\"desktop-accent\">MSG Arena Desktop</span> <span class=\"beta-badge-inline\">BETA</span></h2>",
     "        <h2>\U0001F5A5\uFE0F NEW &mdash; <span class=\"desktop-accent\">MSG Arena Desktop</span> <span class=\"beta-badge-inline\">BETA</span></h2>"),
    # Desktop feature pills
    ("          <span class=\"discord-feat\">?? Per-App Audio</span>",
     "          <span class=\"discord-feat\">\U0001F3A7 Per-App Audio</span>"),
    ("          <span class=\"discord-feat\">?? Device Switching</span>",
     "          <span class=\"discord-feat\">\U0001F500 Device Switching</span>"),
    ("          <span class=\"discord-feat\">?? Native Notifications</span>",
     "          <span class=\"discord-feat\">\U0001F514 Native Notifications</span>"),
    ("          <span class=\"discord-feat\">?? System Tray</span>",
     "          <span class=\"discord-feat\">\U0001F4CD System Tray</span>"),
    ("          <span class=\"discord-feat\">? One-Click Install</span>",
     "          <span class=\"discord-feat\">\u26A1 One-Click Install</span>"),
    ("          <span class=\"discord-feat\">??? Windows &amp; Linux</span>",
     "          <span class=\"discord-feat\">\U0001F5A5\uFE0F Windows &amp; Linux</span>"),
    # Desktop download buttons
    ("            <span class=\"icon\">?</span> Windows Installer",
     "            <span class=\"icon\">\U0001FA9F</span> Windows Installer"),
    ("            <span class=\"icon\">?</span> Linux AppImage",
     "            <span class=\"icon\">\U0001F427</span> Linux AppImage"),
    ("            <span class=\"icon\">?</span> Linux .deb",
     "            <span class=\"icon\">\U0001F4E6</span> Linux .deb"),
    # Desktop beta footnote (must include leading whitespace)
    ("          ?? Beta release &mdash; feedback &amp; bug reports are greatly appreciated. <strong>Requires a <a href=\"https://github.com/ancsemi/Haven\" style=\"color: var(--accent-bright);\">MSG Arena server</a></strong> to connect to.",
     "          \U0001F9EA Beta release &mdash; feedback &amp; bug reports are greatly appreciated. <strong>Requires a <a href=\"https://github.com/ancsemi/Haven\" style=\"color: var(--accent-bright);\">MSG Arena server</a></strong> to connect to."),
    # Android heading
    ("        <h2>?? <span class=\"android-accent\">MSG Arena</span> &mdash; Now on Google Play</h2>",
     "        <h2>\U0001F4F1 <span class=\"android-accent\">MSG Arena</span> &mdash; Now on Google Play</h2>"),
    # Android feature pills
    ("          <span class=\"discord-feat\">?? Native Android</span>",
     "          <span class=\"discord-feat\">\U0001F916 Native Android</span>"),
    ("          <span class=\"discord-feat\">?? Push Notifications</span>",
     "          <span class=\"discord-feat\">\U0001F514 Push Notifications</span>"),
    ("          <span class=\"discord-feat\">?? Full Chat Support</span>",
     "          <span class=\"discord-feat\">\U0001F4AC Full Chat Support</span>"),
    ("          <span class=\"discord-feat\">??? Voice Chat</span>",
     "          <span class=\"discord-feat\">\U0001F399\uFE0F Voice Chat</span>"),
    ("          <span class=\"discord-feat\">?? Built for MSG Arena</span>",
     "          <span class=\"discord-feat\">\u2B21 Built for MSG Arena</span>"),
    # Android credit ("Built with ?? by")
    ("        <p class=\"android-credit\">Built with ?? by <strong>Amnibro</strong> &mdash; thank you for your incredible work building the MSG Arena Android app from the ground up.</p>",
     "        <p class=\"android-credit\">Built with \u2764\uFE0F by <strong>Amnibro</strong> &mdash; thank you for your incredible work building the MSG Arena Android app from the ground up.</p>"),
    # Platform tags
    ("            <span class=\"platform-tag\"><span class=\"ptag-icon\">???</span> Windows</span>",
     "            <span class=\"platform-tag\"><span class=\"ptag-icon\">\U0001FA9F</span> Windows</span>"),
    ("            <span class=\"platform-tag\"><span class=\"ptag-icon\">??</span> macOS</span>",
     "            <span class=\"platform-tag\"><span class=\"ptag-icon\">\U0001F34F</span> macOS</span>"),
    ("            <span class=\"platform-tag\"><span class=\"ptag-icon\">??</span> Linux</span>",
     "            <span class=\"platform-tag\"><span class=\"ptag-icon\">\U0001F427</span> Linux</span>"),
    ("            <span class=\"platform-tag\"><span class=\"ptag-icon\">??</span> iOS Safari</span>",
     "            <span class=\"platform-tag\"><span class=\"ptag-icon\">\U0001F4F1</span> iOS Safari</span>"),
    ("            <span class=\"platform-tag\"><span class=\"ptag-icon\">??</span> Android</span>",
     "            <span class=\"platform-tag\"><span class=\"ptag-icon\">\U0001F916</span> Android</span>"),
    ("            <span class=\"platform-tag\"><span class=\"ptag-icon\">??</span> Any Browser</span>",
     "            <span class=\"platform-tag\"><span class=\"ptag-icon\">\U0001F310</span> Any Browser</span>"),
    # 3-step numbers
    ("          <div class=\"step-number\">??</div>",  # placeholder, will be replaced positionally below
     "          <div class=\"step-number\">__STEPNUM__</div>"),
    # FAQ s-num
    ("          <div class=\"s-num\">?</div>",
     "          <div class=\"s-num\">?</div>"),  # leave as literal ?  (FAQ "What's a self-hosted server?")
    ("          <div class=\"s-num\">??</div>",  # security
     "          <div class=\"s-num\">__SNUM__</div>"),
    # Selling-point cards
    ("          <span class=\"card-icon\">??</span>",  # placeholder, positional below
     "          <span class=\"card-icon\">__CARDICON__</span>"),
    ("          <span class=\"card-icon\">???</span>",  # screen sharing
     "          <span class=\"card-icon\">\U0001F5A5\uFE0F</span>"),
    # Feature cards
    ("          <span class=\"f-icon\">??</span>",  # positional
     "          <span class=\"f-icon\">__FICON__</span>"),
    ("          <span class=\"f-icon\">???</span>",  # positional - 3char
     "          <span class=\"f-icon\">__FICON3__</span>"),
    # Footer links
    ("            <a href=\"https://github.com/ancsemi/Haven/blob/main/GUIDE.md\" target=\"_blank\">?? Setup Guide</a>",
     "            <a href=\"https://github.com/ancsemi/Haven/blob/main/GUIDE.md\" target=\"_blank\">\U0001F4D6 Setup Guide</a>"),
    ("            <a href=\"https://github.com/ancsemi/Haven/blob/main/CHANGELOG.md\" target=\"_blank\">?? Full Changelog</a>",
     "            <a href=\"https://github.com/ancsemi/Haven/blob/main/CHANGELOG.md\" target=\"_blank\">\U0001F4CB Full Changelog</a>"),
    # Version history arrow
    ("            <span class=\"arrow\">?</span>",
     "            <span class=\"arrow\">\u25BC</span>"),
    # v1.0.0 "Release notes ?" arrow
    ("                <a href=\"https://github.com/ancsemi/Haven/releases/tag/v1.0.0\" target=\"_blank\">Release notes ?</a>",
     "                <a href=\"https://github.com/ancsemi/Haven/releases/tag/v1.0.0\" target=\"_blank\">Release notes \u2192</a>"),
    # Second Desktop card (heading + button + alt links + footnote)
    ("        <h2>??? MSG Arena Desktop <span class=\"beta-badge-inline\">BETA</span> &mdash; v1.4.15</h2>",
     "        <h2>\U0001F5A5\uFE0F MSG Arena Desktop <span class=\"beta-badge-inline\">BETA</span> &mdash; v1.4.15</h2>"),
    ("            <span class=\"icon\">?</span> Download Desktop v1.4.15",
     "            <span class=\"icon\">\u2B07</span> Download Desktop v1.4.15"),
    ("            <a href=\"https://github.com/ancsemi/Haven-Desktop/blob/main/README.md\" target=\"_blank\">?? README</a>",
     "            <a href=\"https://github.com/ancsemi/Haven-Desktop/blob/main/README.md\" target=\"_blank\">\U0001F4D8 README</a>"),
    ("            <a href=\"https://github.com/ancsemi/Haven-Desktop/issues\" target=\"_blank\">?? Report a Bug</a>",
     "            <a href=\"https://github.com/ancsemi/Haven-Desktop/issues\" target=\"_blank\">\U0001F41B Report a Bug</a>"),
    ("          ?? <strong>Beta software</strong> &mdash; feedback &amp; bug reports are greatly appreciated.<br>",
     "          \U0001F9EA <strong>Beta software</strong> &mdash; feedback &amp; bug reports are greatly appreciated.<br>"),
    # Second Android card heading + credit
    ("        <h2>?? MSG Arena Android App <span class=\"closed-beta-badge-inline\" style=\"background: #3ddc84; color: #1a1a2e;\">RELEASED</span></h2>",
     "        <h2>\U0001F4F1 MSG Arena Android App <span class=\"closed-beta-badge-inline\" style=\"background: #3ddc84; color: #1a1a2e;\">RELEASED</span></h2>"),
    ("          Built with ?? by <strong>Amnibro</strong> &mdash; thank you for your incredible work building the MSG Arena Android app from the ground up.",
     "          Built with \u2764\uFE0F by <strong>Amnibro</strong> &mdash; thank you for your incredible work building the MSG Arena Android app from the ground up."),
    # Support card
    ("        <span class=\"heart\">??</span>",
     "        <span class=\"heart\">\u2764\uFE0F</span>"),
    ("          ? Buy me a coffee on Ko-fi",
     "          \u2615 Buy me a coffee on Ko-fi"),
    # Footer brand
    ("      <div class=\"footer-brand\"><span class=\"hex\">?</span> MSG ARENA</div>",
     "      <div class=\"footer-brand\"><span class=\"hex\">\u2B21</span> MSG ARENA</div>"),
    # Changelog v3.15.0 entry: "new ?? button opens" → media-gallery icon (frames)
    ("              <div><span class=\"v-name\">v3.15.0</span> &mdash; Channel Media Gallery: new ?? button opens a five-tab modal (Photos, Videos, Audio, Files, Links) showing every shared media item in the channel. Personas: create up to 25 named alter-egos in your profile and send messages as one by typing <code>&gt;&gt;Name your message</code>, with persona badges and full moderation</div>",
     "              <div><span class=\"v-name\">v3.15.0</span> &mdash; Channel Media Gallery: new \U0001F5BC\uFE0F button opens a five-tab modal (Photos, Videos, Audio, Files, Links) showing every shared media item in the channel. Personas: create up to 25 named alter-egos in your profile and send messages as one by typing <code>&gt;&gt;Name your message</code>, with persona badges and full moderation</div>"),
]


# Positional fixes (in document order): list of (placeholder, replacement_emoji)
STEP_NUMS = ["1\uFE0F\u20E3", "2\uFE0F\u20E3", "3\uFE0F\u20E3"]
SNUMS     = ["\U0001F512", "\U0001F4BB"]  # secure (lock), what do you need (laptop)
CARDICONS = [
    "\U0001F30D",  # globe (host downloads, friends join from anywhere)
    "\U0001F399\uFE0F",  # mic for voice
    "\U0001F512",  # lock for private/E2E DMs
    "\U0001F4F1",  # mobile
]
FICONS_2CHAR = [
    "\U0001F4E5",  # Discord Import - inbox
    "\U0001F3B5",  # Music streaming - musical note
    "\U0001F4AC",  # Rich Chat - speech bubble
    "\U0001F512",  # Encrypted DMs - lock
    "\U0001F3A8",  # Themes - palette
    "\U0001F4C1",  # File Sharing - folder
    "\U0001F517",  # Link Previews - link
    "\u26A1",      # Slash Commands - lightning
    "\U0001F50D",  # Message Search - magnifying glass
    "\U0001F4CC",  # Pinned - pushpin
    "\U0001F310",  # Multi-Server - globe
    "\U0001F514",  # Notification Sounds - bell
    "\U0001F3AE",  # Games - game controller
]
FICONS_3CHAR = [
    "\U0001F399\uFE0F",  # Voice Chat - mic
    "\U0001F5A5\uFE0F",  # Screen Sharing - desktop
    "\U0001F39E\uFE0F",  # GIF Search - film frames
    "\U0001F6E1\uFE0F",  # Moderation - shield
]


def apply_line_fixes(text: str) -> str:
    """Apply per-line substitutions. Lines are processed once each."""
    lines = text.split("\n")
    # Strip trailing \r so we can compare line content cleanly
    had_cr = [ln.endswith("\r") for ln in lines]
    bare   = [ln[:-1] if cr else ln for ln, cr in zip(lines, had_cr)]

    step_idx  = 0
    snum_idx  = 0
    card_idx  = 0
    f2_idx    = 0
    f3_idx    = 0

    out = []
    for ln in bare:
        # Try the explicit table first
        matched = False
        for old, new in LINE_FIXES:
            if ln == old:
                ln = new
                matched = True
                break

        # Resolve positional placeholders
        if "__STEPNUM__" in ln:
            ln = ln.replace("__STEPNUM__", STEP_NUMS[step_idx])
            step_idx += 1
        if "__SNUM__" in ln:
            ln = ln.replace("__SNUM__", SNUMS[snum_idx])
            snum_idx += 1
        if "__CARDICON__" in ln:
            ln = ln.replace("__CARDICON__", CARDICONS[card_idx])
            card_idx += 1
        if "__FICON__" in ln:
            ln = ln.replace("__FICON__", FICONS_2CHAR[f2_idx])
            f2_idx += 1
        if "__FICON3__" in ln:
            ln = ln.replace("__FICON3__", FICONS_3CHAR[f3_idx])
            f3_idx += 1

        out.append(ln)

    # Re-attach \r where originals had it
    out = [ln + "\r" if cr else ln for ln, cr in zip(out, had_cr)]
    return "\n".join(out), step_idx, snum_idx, card_idx, f2_idx, f3_idx


def main() -> int:
    raw = DOCS.read_bytes()
    if raw.startswith(b"\xEF\xBB\xBF"):
        text = raw[3:].decode("utf-8")
    else:
        # Original file had stray 0x97 (cp1252 em-dash) bytes; decode that way.
        text = raw.decode("cp1252")

    fixed, step_n, snum_n, card_n, f2_n, f3_n = apply_line_fixes(text)

    print(f"step numbers replaced: {step_n}/3")
    print(f"s-nums replaced:       {snum_n}/{len(SNUMS)}")
    print(f"card icons replaced:   {card_n}/{len(CARDICONS)}")
    print(f"f-icons (2ch):         {f2_n}/{len(FICONS_2CHAR)}")
    print(f"f-icons (3ch):         {f3_n}/{len(FICONS_3CHAR)}")

    # Write UTF-8 WITH BOM so future editor saves do not silently downgrade.
    out_bytes = b"\xEF\xBB\xBF" + fixed.encode("utf-8")
    DOCS.write_bytes(out_bytes)
    WEB.write_bytes(out_bytes)
    print(f"wrote {DOCS} ({len(out_bytes)} bytes)")
    print(f"wrote {WEB}  ({len(out_bytes)} bytes)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
