// MSG Arena — .io Games Browser
const IO_GAMES = [
  { name: 'Agar.io', url: 'https://agar.io', icon: '\u{1F7E2}', desc: 'Eat cells, grow bigger', genre: 'Classic' },
  { name: 'Slither.io', url: 'https://slither.io', icon: '\u{1F40D}', desc: 'Snake battle royale', genre: 'Classic' },
  { name: 'Diep.io', url: 'https://diep.io', icon: '\u{1F52B}', desc: 'Tank shooter with upgrades', genre: 'Shooter' },
  { name: 'Krunker.io', url: 'https://krunker.io', icon: '\u{1F3AF}', desc: 'Fast-paced FPS', genre: 'FPS' },
  { name: 'Surviv.io', url: 'https://surviv.io', icon: '\u{1F3DD}\uFE0F', desc: '2D battle royale', genre: 'Battle Royale' },
  { name: 'Shell Shockers', url: 'https://shellshock.io', icon: '\u{1F95A}', desc: 'Egg FPS shooter', genre: 'FPS' },
  { name: 'Zombs Royale', url: 'https://zombsroyale.io', icon: '\u{1F9DF}', desc: '2D battle royale', genre: 'Battle Royale' },
  { name: 'Paper.io 2', url: 'https://paper-io.com/2/', icon: '\u{1F4C4}', desc: 'Claim territory', genre: 'Territory' },
  { name: 'Hole.io', url: 'https://hole-io.com', icon: '\u{1F573}\uFE0F', desc: 'Consume everything', genre: 'Casual' },
  { name: 'Skribbl.io', url: 'https://skribbl.io', icon: '\u{1F3A8}', desc: 'Draw and guess words', genre: 'Party' },
  { name: 'Mope.io', url: 'https://mope.io', icon: '\u{1F98A}', desc: 'Animal evolution game', genre: 'Survival' },
  { name: 'Defly.io', url: 'https://defly.io', icon: '\u{1F681}', desc: 'Helicopter territory', genre: 'Territory' },
  { name: 'Florr.io', url: 'https://florr.io', icon: '\u{1F338}', desc: 'Flower survival', genre: 'Survival' },
  { name: 'Ev.io', url: 'https://ev.io', icon: '\u26A1', desc: '3D arena shooter', genre: 'FPS' },
  { name: 'Gulper.io', url: 'https://gulper.io', icon: '\u{1F41B}', desc: 'Snake-like multiplayer', genre: 'Classic' },
  { name: 'Taming.io', url: 'https://taming.io', icon: '\u{1F43A}', desc: 'Tame pets, build bases', genre: 'Survival' },
  { name: 'Territorial.io', url: 'https://territorial.io', icon: '\u{1F5FA}\uFE0F', desc: 'Conquer the map', genre: 'Strategy' },
  { name: 'Yohoho.io', url: 'https://yohoho.io', icon: '\u{1F3F4}\u200D\u2620\uFE0F', desc: 'Pirate battle royale', genre: 'Battle Royale' },
  { name: 'Narrow One', url: 'https://narrow.one', icon: '\u{1F3F9}', desc: 'Medieval archery', genre: 'FPS' },
  { name: 'Bloxd.io', url: 'https://bloxd.io', icon: '\u{1F9F1}', desc: 'Block-based multiplayer', genre: 'Sandbox' },
  { name: 'Venge.io', url: 'https://venge.io', icon: '\u{1F4A5}', desc: '3D team shooter', genre: 'FPS' },
  { name: 'Bonk.io', url: 'https://bonk.io', icon: '\u26AA', desc: 'Physics multiplayer', genre: 'Party' },
  { name: 'Stabfish.io', url: 'https://stabfish.io', icon: '\u{1F41F}', desc: 'Underwater combat', genre: 'Casual' },
  { name: 'Wormax.io', url: 'https://wormax.io', icon: '\u{1FAB1}', desc: 'Worm battle arena', genre: 'Classic' },
];

const grid = document.getElementById('io-grid');
const searchInput = document.getElementById('io-search');

function renderGames(filter) {
  filter = filter || '';
  grid.innerHTML = '';
  const f = filter.toLowerCase();
  const filtered = IO_GAMES.filter(function(g) {
    return g.name.toLowerCase().includes(f) ||
      g.desc.toLowerCase().includes(f) ||
      g.genre.toLowerCase().includes(f);
  });

  for (const game of filtered) {
    const card = document.createElement('div');
    card.className = 'io-card';
    card.innerHTML =
      '<div class="io-card-icon">' + game.icon + '</div>' +
      '<div class="io-card-name">' + game.name + '</div>' +
      '<div class="io-card-desc">' + game.desc + '</div>' +
      '<span class="io-card-genre">' + game.genre + '</span>';
    card.addEventListener('click', function() {
      window.open(game.url, '_blank');
    });
    grid.appendChild(card);
  }

  if (filtered.length === 0) {
    grid.innerHTML = '<div style="grid-column:1/-1;text-align:center;color:#8b949e;padding:40px;">No games match your search</div>';
  }
}

searchInput.addEventListener('input', function() {
  renderGames(searchInput.value);
});

renderGames();
