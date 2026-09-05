"""Patch _renderSoundList: custom above built-in, collapsible <details>."""
import pathlib

target = pathlib.Path(__file__).parent.parent / 'public/js/modules/app-media.js'
c = target.read_bytes()

# ─── Old built-in block ───────────────────────────────────────────────────────
old_builtin = (
    b"  const builtinHtml = builtins.length === 0 ? '' : `\r\n"
    b'    <p class="muted-text" style="margin:4px 0 2px;font-size:0.78em;text-transform:uppercase;letter-spacing:.06em">${t(\'modals.sound_manager.group_builtin\')}</p>\r\n'
    b'    ${builtins.map(s => `\r\n'
    b'      <div class="custom-sound-item" data-name="${this._escapeHtml(s.name)}">\r\n'
    b'        <span class="custom-sound-name">${this._escapeHtml(s.name)}</span>\r\n'
    b'        <button class="btn-xs sound-preview-btn" data-url="${this._escapeHtml(s.url)}" title="${t(\'modals.sound_manager.preview_btn\')}">&#x25B6;</button>\r\n'
    b'        <button class="btn-xs sound-delete-btn" data-name="${this._escapeHtml(s.name)}" title="${t(\'modals.sound_manager.delete_btn\')}">&#x1F5D1;</button>\r\n'
    b'      </div>\r\n'
    b"    `).join('')}\r\n"
    b"  `;\r\n"
)
new_builtin = (
    b"  const builtinHtml = builtins.length === 0 ? '' : `\r\n"
    b'    <details class="sound-section">\r\n'
    b'      <summary class="sound-section-label">${t(\'modals.sound_manager.group_builtin\')}</summary>\r\n'
    b'      ${builtins.map(s => `\r\n'
    b'        <div class="custom-sound-item" data-name="${this._escapeHtml(s.name)}">\r\n'
    b'          <span class="custom-sound-name">${this._escapeHtml(s.name)}</span>\r\n'
    b'          <button class="btn-xs sound-preview-btn" data-url="${this._escapeHtml(s.url)}" title="${t(\'modals.sound_manager.preview_btn\')}">&#x25B6;</button>\r\n'
    b'          <button class="btn-xs sound-delete-btn" data-name="${this._escapeHtml(s.name)}" title="${t(\'modals.sound_manager.delete_btn\')}">&#x1F5D1;</button>\r\n'
    b'        </div>\r\n'
    b"      `).join('')}\r\n"
    b'    </details>\r\n'
    b"  `;\r\n"
)
print('builtin old found:', old_builtin in c)
c = c.replace(old_builtin, new_builtin, 1)

# ─── Old custom block + innerHTML line ───────────────────────────────────────
idx_cust = c.find(b"  const customHtml = custom.length === 0 ? '' : `")
idx_end = c.find(b'  list.innerHTML = builtinHtml + customHtml;')
old_custom_plus_render = c[idx_cust : idx_end + len(b'  list.innerHTML = builtinHtml + customHtml;')]
print('custom block found, len=', len(old_custom_plus_render))

# ─── New custom block  (put custom FIRST) ────────────────────────────────────
PLAY = b'\xe2\x96\xb6'
new_custom_plus_render = (
    b"  const customHtml = custom.length === 0 ? '' : `\r\n"
    b'    <details class="sound-section" open>\r\n'
    b'      <summary class="sound-section-label">${t(\'modals.sound_manager.group_custom\')}</summary>\r\n'
    b'      ${custom.map(s => `\r\n'
    b'        <div class="custom-sound-item" data-name="${this._escapeHtml(s.name)}">\r\n'
    b'          <span class="custom-sound-name">${this._escapeHtml(s.name)}</span>\r\n'
    b'          <button class="btn-xs sound-preview-btn" data-url="${this._escapeHtml(s.url)}" title="${t(\'modals.sound_manager.preview_btn\')}">&#x25B6;</button>\r\n'
    b'          <button class="btn-xs sound-rename-btn" data-name="${this._escapeHtml(s.name)}" title="${t(\'modals.sound_manager.rename_btn\')}">&#x270F;</button>\r\n'
    b'          <button class="btn-xs sound-delete-btn" data-name="${this._escapeHtml(s.name)}" title="${t(\'modals.sound_manager.delete_btn\')}">&#x1F5D1;</button>\r\n'
    b'        </div>\r\n'
    b"      `).join('')}\r\n"
    b'    </details>\r\n'
    b"  `;\r\n"
    b'\r\n'
    b'  // Custom first, then built-in\r\n'
    b'  list.innerHTML = customHtml + builtinHtml;\r\n'
)

c = c.replace(old_custom_plus_render, new_custom_plus_render, 1)

target.write_bytes(c)
print('Done.')

