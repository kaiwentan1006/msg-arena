/**
 * @name Message Timestamps
 * @description Adds relative timestamps (e.g. "2m ago") next to every message
 * @author MSG Arena
 * @version 1.0.0
 */
class MessageTimestamps {
  start() {
    this._interval = setInterval(() => this._updateTimestamps(), 30000);
    this._updateTimestamps();
    HavenApi.DOM.addStyle('MessageTimestamps', `
      .msg-relative-time {
        font-size: 10px;
        color: var(--text-muted);
        margin-left: 6px;
        opacity: 0.7;
      }
    `);
    console.log('[MessageTimestamps] Started');
  }

  stop() {
    clearInterval(this._interval);
    document.querySelectorAll('.msg-relative-time').forEach(el => el.remove());
    HavenApi.DOM.removeStyle('MessageTimestamps');
    console.log('[MessageTimestamps] Stopped');
  }

  _updateTimestamps() {
    document.querySelectorAll('.message').forEach(msg => {
      const timeEl = msg.querySelector('.msg-time');
      if (!timeEl) return;
      // Don't duplicate
      let badge = msg.querySelector('.msg-relative-time');
      if (!badge) {
        badge = document.createElement('span');
        badge.className = 'msg-relative-time';
        timeEl.parentNode.insertBefore(badge, timeEl.nextSibling);
      }
      // Parse the timestamp text (format varies, try ISO or displayed text)
      const raw = timeEl.getAttribute('title') || timeEl.textContent;
      const date = new Date(raw);
      if (isNaN(date)) return;
      badge.textContent = this._relative(date);
    });
  }

  _relative(date) {
    const secs = Math.floor((Date.now() - date.getTime()) / 1000);
    if (secs < 60) return 'just now';
    const mins = Math.floor(secs / 60);
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    const days = Math.floor(hrs / 24);
    return `${days}d ago`;
  }
}

// Register with the plugin loader's _win scope
if (typeof _win !== 'undefined') _win.MessageTimestamps = MessageTimestamps;
