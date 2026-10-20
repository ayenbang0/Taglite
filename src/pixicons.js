/* =========================================================================
   PIXEL GLYPHS
   Tiny 7x7 bitmaps (role icons, host crown, ready tick) baked once into
   data-URLs, so the DOM HUD needs no extra font or image assets.
   ========================================================================= */
const BITS = {
  crown:    ['.......', '#..#..#', '##.#.##', '#######', '#######', '#######', '.......'],
  tick:     ['.......', '......#', '.....##', '#...##.', '##.##..', '.###...', '..#....'],
  tagger:   ['...#...', '..###..', '.#####.', '...#...', '...#...', '...#...', '...#...'],
  runner:   ['.......', '.#.....', '.###...', '.#####.', '.###...', '.#.....', '.......'],
  zombie:   ['.#####.', '#######', '#.###.#', '#######', '.#####.', '..#.#..', '..#.#..'],
  survivor: ['.##.##.', '#######', '#######', '#######', '.#####.', '..###..', '...#...'],
  carrier:  ['....#.#', '.....#.', '..####.', '.######', '.######', '.######', '..####.'],
  dot:      ['.......', '.......', '..###..', '..###..', '..###..', '.......', '.......'],
};

/** Role -> glyph + colour. Anything unknown falls back to a neutral dot. */
export const ROLE_ICON = {
  tagger:   { icon:'tagger',   color:'#ff5470' },
  runner:   { icon:'runner',   color:'#3fe0c5' },
  zombie:   { icon:'zombie',   color:'#a8e063' },
  survivor: { icon:'survivor', color:'#8fd6ff' },
  carrier:  { icon:'carrier',  color:'#ff9a3c' },
};

const cache = new Map();

/** data-URL of a named glyph in one colour. */
export function pixIcon(name, color){
  const key = name + '|' + color;
  let url = cache.get(key);
  if(url) return url;
  const rows = BITS[name] || BITS.dot;
  const c = document.createElement('canvas');
  c.width = 7; c.height = 7;
  const g = c.getContext('2d');
  g.fillStyle = color;
  for(let y = 0; y < 7; y++) for(let x = 0; x < 7; x++) if(rows[y][x] === '#') g.fillRect(x, y, 1, 1);
  url = c.toDataURL();
  cache.set(key, url);
  return url;
}

export function roleIcon(team){
  const r = ROLE_ICON[team];
  return r ? pixIcon(r.icon, r.color) : pixIcon('dot', '#7b83a1');
}

export function esc(s){
  return String(s == null ? '' : s).replace(/[&<>"']/g, ch => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[ch]));
}
