/* =========================================================================
   ICONS
   Every UI icon is generated from voxel art, never from fonts or images:
     ability / passive  an isometric 3x3x1 voxel slab in the rarity colour with a
                        12x12 bitmap glyph (category) floating above it
     artifact           the CRYSTAL prop sprite from voxelmodels.js
     class              the class's baked idle sprite
     sys                HUD-only glyphs (dash)
   Baked canvases are cached; iconCanvas() hands out a fresh <canvas> copy each
   call because one DOM node cannot live in two places at once.
   ========================================================================= */
import { drawCubePx, shade, mix } from './voxel.js';
import { getPropSprite, previewSprite } from './voxelmodels.js';
import { ABILITY_BY_ID } from './abilities.js';
import { PASSIVE_BY_ID } from './passives.js';
import { RARE_BY_ID } from './pickups.js';
import { CLASSES } from './config.js';
import { RARITY } from './rarity.js';

const LOGICAL = 18;                 // slab icons are authored on an 18x18 grid
const OUTLINE = '#05060c';
const GLYPH_INK = '#f4f6fb';        // '#' pixels
const GLYPH_DARK = '#232a42';       // 'o' pixels (detail)

/* ---------------- 12x12 glyph bitmaps ('#' ink, 'o' dark detail) ---------------- */
const G = {
  arrow: [
    '............',
    '......#.....',
    '......##....',
    '......###...',
    '......####..',
    '###########.',
    '###########.',
    '......####..',
    '......###...',
    '......##....',
    '......#.....',
    '............',
  ],
  dash: [
    '............',
    '##....##....',
    '.##....##...',
    '..##....##..',
    '...##....##.',
    '....##....##',
    '....##....##',
    '...##....##.',
    '..##....##..',
    '.##....##...',
    '##....##....',
    '............',
  ],
  ring: [
    '...######...',
    '.##......##.',
    '.#........#.',
    '#..........#',
    '#..........#',
    '#....oo....#',
    '#....oo....#',
    '#..........#',
    '.#........#.',
    '.##......##.',
    '...######...',
    '............',
  ],
  hand: [
    '.##.##.##...',
    '.##.##.##...',
    '.#########..',
    '.##########.',
    '..##########',
    '..#########.',
    '..#########.',
    '...#######..',
    '....#####...',
    '....#####...',
    '............',
    '............',
  ],
  spiral: [
    '###########.',
    '..........#.',
    '..#######.#.',
    '..#.....#.#.',
    '..#.###.#.#.',
    '..#.#...#.#.',
    '..#.#...#.#.',
    '..#.#...#.#.',
    '..#.#####.#.',
    '..#.......#.',
    '..#########.',
    '............',
  ],
  bolt: [
    '......####..',
    '.....####...',
    '....####....',
    '...#######..',
    '..#######...',
    '......###...',
    '.....###....',
    '....###.....',
    '...###......',
    '..##........',
    '..#.........',
    '............',
  ],
  shield: [
    '############',
    '############',
    '#####oo#####',
    '####oooo####',
    '#####oo#####',
    '#####oo#####',
    '.####oo####.',
    '.####oo####.',
    '..###oo###..',
    '...######...',
    '....####....',
    '.....##.....',
  ],
  star: [
    '.....##.....',
    '.....##.....',
    '....####....',
    '....####....',
    '############',
    '############',
    '....####....',
    '....####....',
    '.....##.....',
    '.....##.....',
    '............',
    '............',
  ],
  boot: [
    '..####......',
    '..####......',
    '..####......',
    '..####......',
    '..####......',
    '..#####.....',
    '..#######...',
    '..#########.',
    '..#########.',
    '.oooooooooo.',
    '............',
    '............',
  ],
  lungs: [
    '.....##.....',
    '.....##.....',
    '..##.##.##..',
    '.###.##.###.',
    '.###.##.###.',
    '.####..####.',
    '.####..####.',
    '.####..####.',
    '..###..###..',
    '...##..##...',
    '............',
    '............',
  ],
  reach: [
    '............',
    '............',
    '...#....#...',
    '..##....##..',
    '.###....###.',
    '############',
    '############',
    '.###....###.',
    '..##....##..',
    '...#....#...',
    '............',
    '............',
  ],
  eye: [
    '............',
    '............',
    '...######...',
    '.##......##.',
    '#...####...#',
    '#...#oo#...#',
    '.##......##.',
    '...######...',
    '............',
    '............',
    '............',
    '............',
  ],
  die: [
    '............',
    '.##########.',
    '.##########.',
    '.#oo####oo#.',
    '.#oo####oo#.',
    '.####oo####.',
    '.####oo####.',
    '.#oo####oo#.',
    '.#oo####oo#.',
    '.##########.',
    '.##########.',
    '............',
  ],
  crown: [
    '............',
    '.#...##...#.',
    '.##..##..##.',
    '.###.##.###.',
    '.##########.',
    '.##########.',
    '.####oo####.',
    '.##########.',
    '.oooooooooo.',
    '............',
    '............',
    '............',
  ],
};

/** eye + diagonal slash = stealth */
G.eyeslash = (() => {
  const rows = G.eye.map(r => r.split(''));
  for(let k=0;k<11;k++){
    const y = k, x = k;
    if(rows[y]){
      if(rows[y][x-1] !== undefined) rows[y][x-1] = 'o';
      if(rows[y][x+2] !== undefined) rows[y][x+2] = 'o';
    }
  }
  for(let k=0;k<11;k++){
    rows[k][k] = '#';
    if(rows[k][k+1] !== undefined) rows[k][k+1] = '#';
  }
  return rows.map(r => r.join(''));
})();

const ABILITY_GLYPH = {
  movement:'arrow', zone:'ring', taginteraction:'hand', physics:'spiral',
  buff:'bolt', defense:'shield', utility:'star',
};
const PASSIVE_GLYPH = {
  mobility:'boot', stamina:'lungs', tagrange:'reach', defense:'shield',
  utility:'star', zone:'ring', stealth:'eyeslash', antistealth:'eye',
  random:'die', identity:'crown',
};

/* ---------------- baking ---------------- */
function mk(w, h){
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  return { c, ctx };
}

/** Add a 1px dark outline (4-neighbourhood) around every opaque pixel. */
function addOutline(src){
  const { c, ctx } = mk(src.width, src.height);
  const w = src.width, h = src.height;
  const data = src.getContext('2d').getImageData(0, 0, w, h).data;
  const solid = (x, y) => x>=0 && y>=0 && x<w && y<h && data[(y*w+x)*4+3] > 0;
  ctx.fillStyle = OUTLINE;
  for(let y=0;y<h;y++) for(let x=0;x<w;x++){
    if(solid(x,y)) continue;
    if(solid(x-1,y) || solid(x+1,y) || solid(x,y-1) || solid(x,y+1)) ctx.fillRect(x, y, 1, 1);
  }
  ctx.drawImage(src, 0, 0);
  return c;
}

function drawGlyph(ctx, rows, ox, oy){
  for(let y=0;y<rows.length;y++){
    for(let x=0;x<rows[y].length;x++){
      const ch = rows[y][x];
      if(ch === '.') continue;
      ctx.fillStyle = ch === 'o' ? GLYPH_DARK : GLYPH_INK;
      ctx.fillRect(ox+x, oy+y, 1, 1);
    }
  }
}

/** 3x3x1 voxel slab (painter order) with the glyph floating above it. */
function bakeSlab(color, glyphRows){
  const { c, ctx } = mk(LOGICAL, LOGICAL);
  const top = shade(color, 1.2), left = shade(color, 0.78), right = shade(color, 0.58);
  const offX = 9, offY = 10;
  for(let i=0;i<3;i++) for(let j=0;j<3;j++){
    drawCubePx(ctx, (i-j-1)*2 + offX, (i+j) + offY, top, left, right);
  }
  // glyph: dark 1px shadow-outline first so it pops from the slab
  const gx = 3, gy = 0;
  const g = mk(LOGICAL, LOGICAL);
  drawGlyph(g.ctx, glyphRows, gx, gy);
  ctx.drawImage(addOutline(g.c), 0, 0);
  return addOutline(c);
}

/** Fit a baked sprite {canvas,ax,ay} into a square logical canvas, with a ground disc. */
function bakeSprite(spr, groundColor){
  const sc = spr.canvas;
  const size = Math.max(sc.width, sc.height) + 4;
  const { c, ctx } = mk(size, size);
  const cx = Math.round(size/2);
  // ground ellipse under the model's footprint centre
  const gy = Math.min(size-3, Math.round(size/2 + (sc.height - spr.ay)/2));
  ctx.fillStyle = groundColor;
  const rx = Math.max(6, Math.round(sc.width*0.35));
  for(let k=-2;k<=2;k++){
    const w = Math.round(rx*Math.sqrt(1 - (k*k)/9));
    ctx.fillRect(cx-w, gy+k, w*2, 1);
  }
  ctx.drawImage(sc, Math.round(cx - spr.ax), Math.round((size - sc.height)/2 - 1));
  return c;
}

function glyphFor(kind, id){
  if(kind === 'ability'){
    const a = ABILITY_BY_ID[id];
    return { rows:G[ABILITY_GLYPH[a && a.cat] || 'star'], rarity:(a && a.rarity) || 'common' };
  }
  if(kind === 'passive'){
    const p = PASSIVE_BY_ID[id];
    return { rows:G[PASSIVE_GLYPH[p && p.cat] || 'star'], rarity:(p && p.rarity) || 'common' };
  }
  return { rows:G[id] || G.star, rarity:'uncommon' };   // 'sys'
}

function bake(kind, id){
  if(kind === 'artifact'){
    const a = RARE_BY_ID[id];
    return bakeSprite(getPropSprite('crystal', { color:(a && a.color) || '#ffd23f', frame:0 }), '#232a42');
  }
  if(kind === 'class'){
    const cls = CLASSES[id];
    return bakeSprite(previewSprite(id, 0, 'idle0'), mix(cls ? cls.color : '#7b83a1', '#0f1220', 0.55));
  }
  const { rows, rarity } = glyphFor(kind, id);
  return bakeSlab(RARITY[rarity].color, rows);
}

const bakeCache = new Map();
const copyCache = new Map();

/** A fresh <canvas> (px x px, integer-scaled, nearest neighbour) holding the icon. */
export function iconCanvas(kind, id, px = 32){
  const key = `${kind}|${id}|${px}`;
  let src = bakeCache.get(key);
  if(!src){
    const base = bake(kind, id);
    const { c, ctx } = mk(px, px);
    const maxDim = Math.max(base.width, base.height);
    const f = px / maxDim;
    const s = f >= 1 ? Math.floor(f) : f;
    const w = Math.round(base.width*s), h = Math.round(base.height*s);
    ctx.drawImage(base, Math.round((px-w)/2), Math.round((px-h)/2), w, h);
    src = c;
    bakeCache.set(key, src);
  }
  const out = document.createElement('canvas');
  out.width = px; out.height = px;
  out.className = 'icon';
  out.getContext('2d').drawImage(src, 0, 0);
  return out;
}

/** A single shaded voxel cube (HUD status pips): 4x4 logical, scaled to px. */
export function cubeIcon(color, px = 12){
  const key = `cube|${color}|${px}`;
  let src = copyCache.get(key);
  if(!src){
    const { c, ctx } = mk(6, 6);
    drawCubePx(ctx, 1, 1, shade(color, 1.2), shade(color, 0.78), shade(color, 0.58));
    const big = mk(px, px);
    big.ctx.drawImage(addOutline(c), 0, 0, px, px);
    src = big.c;
    copyCache.set(key, src);
  }
  const out = document.createElement('canvas');
  out.width = px; out.height = px;
  out.className = 'icon';
  out.getContext('2d').drawImage(src, 0, 0);
  return out;
}

/** Dev helper: every glyph row must be exactly 12 chars, 12 rows. */
export function validateGlyphs(){
  const bad = [];
  for(const [k, rows] of Object.entries(G)){
    if(rows.length !== 12 || rows.some(r => r.length !== 12)) bad.push(k);
  }
  return bad;
}
