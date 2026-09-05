// MSG Arena — Flash Game Loader (Ruffle)
// Parse game info from URL params: ?swf=URL&title=NAME
const params = new URLSearchParams(window.location.search);
const swfUrl = params.get('swf');
const title = params.get('title') || 'Flash Game';

document.getElementById('game-title').textContent = title;
document.title = `${title} — MSG Arena`;

// Volume control
const volSlider = document.getElementById('volume-slider');
const volPct = document.getElementById('volume-pct');
let ruffleInstance = null;

volSlider.addEventListener('input', () => {
  const val = parseInt(volSlider.value);
  volPct.textContent = val + '%';
  applyVolume(val);
});

function applyVolume(val) {
  try {
    if (ruffleInstance && ruffleInstance.volume !== undefined) {
      ruffleInstance.volume = val / 100;
    }
  } catch {}
}

function initRuffle() {
  const container = document.getElementById('ruffle-container');
  const loadingMsg = document.getElementById('loading-msg');

  try {
    const ruffle = window.RufflePlayer.newest();
    const player = ruffle.createPlayer();

    player.style.width = '100%';
    player.style.height = '100%';

    loadingMsg.remove();
    container.appendChild(player);

    ruffleInstance = player;

    player.load(swfUrl).then(() => {
      applyVolume(parseInt(volSlider.value));
    }).catch((err) => {
      container.innerHTML = `<div class="error-msg">Failed to load SWF: ${err.message}<br><br>Make sure the .swf file exists in <code>/games/roms/</code></div>`;
    });

    setTimeout(() => {
      if (loadingMsg.parentNode) {
        loadingMsg.innerHTML = '<div class="error-msg">Ruffle took too long to initialize. Try refreshing.</div>';
      }
    }, 20000);
  } catch (err) {
    const loadingMsg = document.getElementById('loading-msg');
    if (loadingMsg) loadingMsg.innerHTML = `<div class="error-msg">Ruffle init error: ${err.message}</div>`;
  }
}

function loadGame() {
  if (!swfUrl) {
    document.getElementById('loading-msg').innerHTML = '<div class="error-msg">No SWF file specified</div>';
    return;
  }

  // Load Ruffle from CDN
  const script = document.createElement('script');
  script.src = 'https://unpkg.com/@ruffle-rs/ruffle';
  script.onload = () => initRuffle();
  script.onerror = () => {
    document.getElementById('loading-msg').innerHTML =
      '<div class="error-msg">Failed to load Ruffle Flash emulator.<br>Check your internet connection.</div>';
  };
  document.head.appendChild(script);
}

loadGame();

// Listen for volume messages from parent (MSG Arena game iframe header)
window.addEventListener('message', (e) => {
  if (e.data && e.data.type === 'set-volume' && typeof e.data.volume === 'number') {
    const vol = Math.round(e.data.volume * 100);
    volSlider.value = vol;
    volPct.textContent = vol + '%';
    applyVolume(vol);
  }
});
