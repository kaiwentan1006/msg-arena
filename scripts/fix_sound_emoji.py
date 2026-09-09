"""One-shot script: fix garbled emoji in app-media.js _renderSoundList and
make built-in sounds deletable by removing the lock icon and adding a delete btn."""
import pathlib, re

target = pathlib.Path(__file__).parent.parent / 'public/js/modules/app-media.js'
content = target.read_bytes()

# ── 1. Fix garbled pencil emoji (✏️) ──────────────────────────────────────────
# These are the double-encoded UTF-8 bytes that render as âœï¸ in the browser
GARBLED_PENCIL = b'\xc3\xa2\xc5\x93\xc2\x8f\xc3\xaf\xc2\xb8\xc2\x8f'
content = content.replace(GARBLED_PENCIL, b'&#x270F;')

# ── 2. Fix garbled trash emoji (🗑️) ──────────────────────────────────────────
# These are the double-encoded UTF-8 bytes that render as ðŸ—'ï¸ in the browser
GARBLED_TRASH = b'\xc3\xb0\xc5\xb8\xe2\x80\x94\xe2\x80\x98\xc3\xaf\xc2\xb8\xc2\x8f'
content = content.replace(GARBLED_TRASH, b'&#x1F5D1;')

# ── 3. Replace the play-button + lock span with play-button + delete button ──
# The lock span: b'\xf0\x9f\x94\x92' is the 🔒 lock emoji (U+1F512)
# Find the exact section and replace
LOCK_SPAN = (
    b'<button class="btn-xs sound-preview-btn" data-url="${this._escapeHtml(s.url)}" '
    b'title="${t(\'modals.sound_manager.preview_btn\')}">&#x25B6;</button>'
)
# After the HTML entity fix for play btn, it may still be the UTF-8 triangle
PLAY_TRIANGLE_UTF8 = b'\xe2\x96\xb6'
LOCK_SPAN_ORIG = (
    b'<button class="btn-xs sound-preview-btn" data-url="${this._escapeHtml(s.url)}" '
    b'title="${t(\'modals.sound_manager.preview_btn\')}">' + PLAY_TRIANGLE_UTF8 + b'</button>\r\n'
    b'        <span class="muted-text" style="font-size:0.75em;margin-left:4px" '
    b'title="${t(\'modals.sound_manager.builtin_locked_title\')}">\xf0\x9f\x94\x92</span>'
)
LOCK_SPAN_REPLACEMENT = (
    b'<button class="btn-xs sound-preview-btn" data-url="${this._escapeHtml(s.url)}" '
    b'title="${t(\'modals.sound_manager.preview_btn\')}">&#x25B6;</button>\r\n'
    b'        <button class="btn-xs sound-delete-btn" data-name="${this._escapeHtml(s.name)}" '
    b'title="${t(\'modals.sound_manager.delete_btn\')}">&#x1F5D1;</button>'
)
if LOCK_SPAN_ORIG in content:
    content = content.replace(LOCK_SPAN_ORIG, LOCK_SPAN_REPLACEMENT)
    print('Replaced lock icon with delete button in builtin section')
else:
    print('WARNING: lock span not found (already patched?)')

target.write_bytes(content)
print('Done. File patched:', target)
