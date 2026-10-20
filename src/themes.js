import { hash3, cached } from './voxel.js';
import { project } from './iso.js';
import {
  VoxGrid, bakeVox, TilePainter, baseCells, slowTile, speedTile, iceTile,
  mulberry32, seedOf, rgb32, shade32, mix32,
} from './themeart.js';

/* =========================================================================
   MAP THEMES
   Six voxel-built themes. Everything here is presentation only:
     - floor tiles: 120x60 iso diamonds painted from 30x30 one-unit "tops"
     - wall chunks: every wall rect is split into <=16x16 footprints (see
       chunkRects); each chunk bakes a themed motif on top of a continuous
       low base so a wall still reads as one barrier
     - decor: non-colliding floor details scattered by buildDecor
     - ambient: world-anchored drifting particles
   All bakes are lazy + cached (keyed by theme/kind/variant/frame) and the
   animation frame is derived from the `t` (seconds) the renderer passes in.
   ========================================================================= */

const CH = 16;          // chunk footprint (world units)
const GH = 30;          // chunk grid height (voxels)
const MARGIN = 3;       // overhang margin around a chunk footprint
const VARIANTS = 4;

/* ---------------------------------------------------------------- API --- */

/** Split a wall rect into <=16x16 chunks. Chunk origin = rect.x + ci*16; the last chunk may be shorter. */
export function chunkRects(rect){
  const nx = Math.ceil(rect.w / CH), ny = Math.ceil(rect.h / CH);
  const out = [];
  for(let cj = 0; cj < ny; cj++){
    for(let ci = 0; ci < nx; ci++){
      out.push({
        x: rect.x + ci*CH, y: rect.y + cj*CH,
        w: Math.min(CH, rect.w - ci*CH), h: Math.min(CH, rect.h - cj*CH),
        ci, cj,
      });
    }
  }
  return out;
}

/** Duel 1 is always the first theme; later duels roll one that differs from the previous. */
export function themeForDuel(duel, previousId){
  if(duel <= 1 || !THEMES.length) return THEMES[0];
  const pool = THEMES.filter(t => t.id !== previousId);
  return pool[Math.floor(Math.random() * pool.length)];
}

const frameOf = (t, fps, n, phase = 0) => {
  if(n <= 1) return 0;
  const f = Math.floor(t*fps + phase*n) % n;
  return f < 0 ? f + n : f;
};

/** 120x60 diamond tile for one 30x30 cell. */
export function getFloorTile(theme, kind, t){
  const gameplay = kind === 'slow' || kind === 'speed' || kind === 'ice';
  const anim = theme.floorFrames > 1 && (gameplay || theme.animFloor);
  const frame = anim ? frameOf(t, theme.floorFps, theme.floorFrames) : 0;
  if(gameplay){
    return cached(`gt|${kind}|${frame}`, () => kind === 'slow' ? slowTile(frame) : kind === 'speed' ? speedTile(frame) : iceTile(frame));
  }
  return cached(`${theme.id}|f|${kind}|${frame}`, () => {
    const P = new TilePainter();
    theme.floor(P, kind === 'floorB' ? 'floorB' : 'floorA', frame);
    return P.finish();
  });
}

const PLAIN = { id:'plain', w:1, frames:1, build(){} };

function pickWeighted(pool, h){
  let total = 0;
  for(const m of pool) total += m.w;
  let x = h * total;
  for(const m of pool){ x -= m.w; if(x < 0) return m; }
  return pool[pool.length - 1];
}

/**
 * Obstacle art for chunk (ci,cj) of `rect` ({x,y,w,h,kind?}). Blit at
 * project(chunkCentreX, chunkCentreY) - (ax,ay); `h` = sprite height in voxels.
 */
export function getWallPiece(theme, rect, ci, cj, t){
  const W = Math.min(CH, rect.w - ci*CH), D = Math.min(CH, rect.h - cj*CH);
  const border = rect.kind === 'border';
  const hs = (rect.x | 0)*7 + 13, hy = (rect.y | 0)*13 + 5, hc = ci*131 + cj*7;
  const pool = border ? theme.border : theme.walls;
  const small = Math.min(W, D) < 8;
  const motif = small ? PLAIN : pickWeighted(pool, hash3(hs, hy, hc + 1));
  const variant = small ? 0 : Math.floor(hash3(hs, hy, hc + 2) * VARIANTS);
  const frames = motif.frames || 1;
  const frame = frames > 1 ? frameOf(t, motif.fps || theme.wallFps, frames, hash3(hs, hy, hc + 3)) : 0;
  const along = rect.w >= rect.h ? 'x' : 'y';
  const key = `${theme.id}|w${border ? 'b' : 'i'}|${motif.id}|${variant}|${W}x${D}|${along}|${frame}`;
  return cached(key, () => bakeChunk(theme, motif, pool.indexOf(motif), W, D, variant, frame, border, along));
}

function bakeChunk(theme, motif, mi, W, D, variant, frame, border, along){
  const g = new VoxGrid(W, D, GH, MARGIN);
  const pal = Object.assign({}, theme.pal);
  const zb = border ? theme.baseH + 3 : theme.baseH;
  const c = { W, D, cx: W/2, cy: D/2, zb, pal, border, variant, theme, along };
  theme.base(g, c);
  motif.build(g, frame, mulberry32(seedOf(theme.id, mi, variant, W, D, border ? 1 : 0)), c);
  return bakeVox(g, pal, { outline: theme.outline });
}

/** Non-colliding floor decor; 60..140 items kept clear of every wall (expanded by 8). */
export function buildDecor(theme, walls, worldW, worldH, seed){
  const r = mulberry32(seedOf(seed | 0, theme.id));
  const count = Math.max(60, Math.min(140, Math.round(worldW*worldH / 11000)));
  const centres = [];
  for(let i = 0; i < 7; i++) centres.push({ x: 40 + r()*(worldW - 80), y: 40 + r()*(worldH - 80) });
  const ws = walls || [];
  const near = (x, y, m) => {
    for(const w of ws) if(x > w.x - m && x < w.x + w.w + m && y > w.y - m && y < w.y + w.h + m) return true;
    return false;
  };
  const items = [];
  let tries = 0;
  while(items.length < count && tries < count*40){
    tries++;
    let x, y;
    if(r() < 0.45){
      const c = centres[(r()*centres.length) | 0];
      x = c.x + (r() + r() + r() - 1.5)*55; y = c.y + (r() + r() + r() - 1.5)*55;
    } else { x = 24 + r()*(worldW - 48); y = 24 + r()*(worldH - 48); }
    if(x < 24 || y < 24 || x > worldW - 24 || y > worldH - 24) continue;
    const d = pickWeighted(theme.decor, r());
    if(near(x, y, d.tall ? 26 : 8)) continue;
    items.push({ x: Math.round(x), y: Math.round(y), kind: d.kind, seed: (r()*2147483647) | 0 });
  }
  items.sort((a, b) => (a.x + a.y) - (b.x + b.y));
  return items;
}

/** Decor sprite, blit at project(d.x,d.y) - (ax,ay). */
export function getDecorSprite(theme, decor, t){
  const def = theme.decor.find(d => d.kind === decor.kind) || theme.decor[0];
  const variant = Math.abs(decor.seed) % VARIANTS;
  const frames = def.frames || 1;
  const frame = frames > 1 ? frameOf(t, def.fps || 4, frames, hash3(decor.seed, 3, 1)) : 0;
  return cached(`${theme.id}|d|${def.kind}|${variant}|${frame}`, () => {
    const W = def.W || 8, D = def.D || 8;
    const g = new VoxGrid(W, D, def.H || 8, 2);
    const pal = Object.assign({}, theme.pal);
    const c = { W, D, cx: W/2, cy: D/2, pal, variant, theme };
    def.build(g, frame, mulberry32(seedOf(theme.id, def.kind, variant)), c);
    return bakeVox(g, pal, { outline: def.tall ? theme.outline : false, noise: 0.1 });
  });
}

/* ------------------------------------------------------------ ambient --- */

const AMB = { id: null, list: [], t: 0 };
const BOX = 215;     // half extent (world units) of the area kept populated around the camera
const Z_MAX = 56;

function spawnAmb(theme, p, r, cam, wW, wH, first){
  const kinds = theme.ambient.kinds;
  let total = 0; for(const k of kinds) total += k.w;
  let x = r()*total, ki = 0;
  for(; ki < kinds.length - 1; ki++){ x -= kinds[ki].w; if(x < 0) break; }
  const k = kinds[ki];
  p.k = ki;
  p.x = Math.max(0, Math.min(wW, cam.x + (r()*2 - 1)*BOX));
  p.y = Math.max(0, Math.min(wH, cam.y + (r()*2 - 1)*BOX));
  const zr = (first && k.zInit) ? k.zInit : k.z;
  p.z = zr[0] + r()*(zr[1] - zr[0]);
  p.vx = k.v[0] + (r() - 0.5)*2*(k.j?.[0] ?? 0);
  p.vy = k.v[1] + (r() - 0.5)*2*(k.j?.[1] ?? 0);
  p.vz = k.v[2] + (r() - 0.5)*2*(k.j?.[2] ?? 0);
  p.ph = r()*6.2832;
  p.life = k.life[0] + r()*(k.life[1] - k.life[0]);
  p.col = k.cols[(r()*k.cols.length) | 0];
  p.front = r() < (k.front ?? 0.3);
  p.sz = (typeof k.sz === 'number') ? k.sz : (r() < k.sz[2] ? k.sz[1] : k.sz[0]);
}

/** Advance world-anchored ambient particles; they respawn inside a box around the camera. */
export function updateAmbient(theme, dt, camera, worldW, worldH){
  if(!theme || !theme.ambient) return;
  const r = Math.random;
  if(AMB.id !== theme.id){
    AMB.id = theme.id; AMB.list.length = 0; AMB.t = 0;
    for(let i = 0; i < theme.ambient.count; i++){
      const p = {}; spawnAmb(theme, p, r, camera, worldW, worldH, true);
      p.life *= r();
      AMB.list.push(p);
    }
  }
  AMB.t += dt;
  const kinds = theme.ambient.kinds;
  for(const p of AMB.list){
    const k = kinds[p.k];
    p.life -= dt;
    p.vz += (k.grav || 0)*dt;
    p.x += (p.vx + (k.wob ? Math.sin(AMB.t*(k.wf || 1.3) + p.ph)*k.wob : 0))*dt;
    p.y += (p.vy + (k.wob ? Math.cos(AMB.t*(k.wf || 1.3)*0.83 + p.ph)*k.wob : 0))*dt;
    p.z += p.vz*dt;
    if(p.life <= 0 || p.z < 0 || p.z > Z_MAX
      || Math.abs(p.x - camera.x) > BOX || Math.abs(p.y - camera.y) > BOX
      || p.x < 0 || p.y < 0 || p.x > worldW || p.y > worldH){
      spawnAmb(theme, p, r, camera, worldW, worldH, false);
    }
  }
}

/** Draw one layer ('back' | 'front') of ambient particles. Integer pixel squares only. */
export function drawAmbient(ctx, theme, camera, t, layer){
  if(!theme || !theme.ambient || AMB.id !== theme.id) return;
  const kinds = theme.ambient.kinds;
  const front = layer === 'front';
  for(const p of AMB.list){
    if(p.front !== front) continue;
    const k = kinds[p.k];
    const s = project(p.x, p.y, p.z);
    const sx = Math.round(s.x), sy = Math.round(s.y);
    if(sx < -4 || sy < -4 || sx > 644 || sy > 404) continue;
    let a = k.a ?? 1;
    if(k.tw) a *= 0.5 + 0.5*Math.sin(t*k.tw + p.ph);
    if(p.life < 0.5 && k.fade) a *= p.life*2;
    a = Math.round(a*4)/4;
    if(a <= 0) continue;
    ctx.fillStyle = p.col;
    if(k.halo && a > 0.5){
      ctx.globalAlpha = 0.22;
      ctx.fillRect(sx - 1, sy - 1, p.sz + 2, p.sz + 2);
    }
    ctx.globalAlpha = a;
    ctx.fillRect(sx, sy, p.sz, p.sz);
  }
  ctx.globalAlpha = 1;
}

/* ------------------------------------------------- shared builder bits --- */

const sway = f => [0, 1, 0, -1][f & 3];
const sway2 = f => [0, 0, 1, 0][f & 3];
const minWD = c => Math.min(c.W, c.D);

function leafChar(keys, x, y, z, lo, hi){
  const t = (z - lo) / Math.max(1, hi - lo) + (hash3(x, y, z) - 0.5)*0.6;
  return t > 0.62 ? keys[2] : t > 0.3 ? keys[1] : keys[0];
}

/** Round-canopy tree: trunk + a main blob and several side blobs that sway. */
function tree(g, f, r, c, o){
  const cx = c.cx + (o.ox || 0), cy = c.cy + (o.oy || 0);
  const k = Math.min(1, minWD(c) / 16);
  const R = o.R * k, tr = o.tr ?? 1.8;
  g.cyl(cx, cy, c.zb - 1, o.zt, tr, o.trunk);
  g.cyl(cx, cy, c.zb - 1, c.zb, tr + 0.9, o.trunkD ?? o.trunk);
  const lo = o.zt - 2, hi = o.zt + R*1.9 + 2;
  const sx = sway(f), sy = sway2(f);
  const ctr = o.zt + R*0.8;
  g.ell(cx + sx*0.6, cy + sy*0.6, ctr, R, R*0.95, R*0.85, (x, y, z) => leafChar(o.leaves, x, y, z, lo, hi));
  const n = o.blobs ?? 5;
  for(let i = 0; i < n; i++){
    const a = r()*6.2832, d = R*(0.45 + 0.4*r()), dz = (r() - 0.2)*R*0.9, rr = R*(0.45 + 0.25*r());
    const hf = 0.4 + 0.6*Math.max(0, Math.min(1, (dz + R*0.5) / (R*1.4)));
    g.ell(cx + Math.cos(a)*d + sx*hf, cy + Math.sin(a)*d + sy*hf, ctr + dz, rr, rr, rr*0.85,
      (x, y, z) => leafChar(o.leaves, x, y, z, lo, hi));
  }
  if(o.accent){
    const ac = o.accent, p = o.accentP ?? 0.07;
    g.cap((x, y, z, code) => (code !== o.trunk.charCodeAt(0) && hash3(x, y, z + 91) < p) ? ac : null);
  }
}

/** Layered conifer. */
function pine(g, f, r, c, o){
  const cx = c.cx, cy = c.cy;
  const k = Math.min(1, minWD(c) / 16);
  const tiers = o.tiers ?? 4, step = o.step ?? 4;
  g.cyl(cx, cy, c.zb - 1, c.zb + 3, 1.5, o.trunk);
  for(let t = 0; t < tiers; t++){
    const z0 = c.zb + 1 + t*step, rad = o.R*k*(1 - t*0.2);
    const s = t >= 2 ? (t - 1)*0.5 : 0;
    g.cone(cx + sway(f)*s, cy + sway2(f)*s, z0, z0 + step, rad, rad*0.3,
      (x, y, z) => hash3(x, y, z) > 0.5 ? o.needles[0] : o.needles[1]);
  }
  const zt = c.zb + 1 + tiers*step;
  const s = (tiers - 1)*0.5;
  g.cone(cx + sway(f)*s, cy + sway2(f)*s, zt, zt + 3, 1.3, 0.3, o.needles[1]);
  if(o.snow){
    const nc = o.needles.map(ch => ch.charCodeAt(0));
    g.cap((x, y, z, code) => (nc.includes(code) && hash3(x, y, z + 3) > 0.42) ? (hash3(x, y, z) > 0.25 ? o.snow[0] : o.snow[1]) : null);
  }
}

/** Boulder with an optional top cap (moss / snow). */
function boulder(g, f, r, c, o){
  const rz = o.rz ?? 7;
  const bc = (x, y, z) => hash3(x, y, z) > 0.55 + (z - c.zb)*0.01 ? o.rock[0] : o.rock[1];
  g.ell(c.cx, c.cy, c.zb + rz*0.35, c.W/2 + 0.8, c.D/2 + 0.8, rz, bc);
  const a = r()*6.28;
  g.ell(c.cx + Math.cos(a)*3, c.cy + Math.sin(a)*3, c.zb + rz*0.55, c.W/3, c.D/3, rz*0.9, bc);
  if(o.cap){
    const lim = c.zb + (o.capZ ?? 3);
    g.cap((x, y, z) => (z >= lim && hash3(x, y, z + 5) > (o.capT ?? 0.3)) ? o.cap : null);
  }
}

/** Vertical crystal / ice / obsidian shards with glowing veins and tips. */
function shards(g, f, r, c, o){
  const { W, D } = c;
  const zs = c.zb - 1;
  for(let i = 0; i < o.n; i++){
    const x = 2.5 + r()*(W - 5), y = 2.5 + r()*(D - 5);
    const h = o.h0 + r()*(o.h1 - o.h0), rad = o.r0*(0.75 + 0.5*r());
    const lx = (r() - 0.5)*o.lean, ly = (r() - 0.5)*o.lean;
    const key = o.keys[(r()*o.keys.length) | 0];
    const phase = (r()*11) | 0;
    g.cone(x, y, zs, zs + h, rad, rad*0.18, (vx, vy, vz) => {
      const t = (vz - zs) / h;
      const tip = o.glowOf ? o.glowOf[key] : o.tip, vein = o.glowOf ? o.glowOf[key] : o.vein;
      if(t > 0.88 && tip) return tip;
      if(vein && t > 0.2 && ((vx*2 + vy*3 + vz*3 + phase + 2000) % 11) < 1) return vein;
      if(o.sparkle && hash3(vx, vy, vz + f*57) > 0.989) return o.sparkle;
      return key;
    }, false, lx, ly);
  }
}

/** Flame cluster standing at (cx,cy) from z0. keys: [low, mid, tip]. */
function flame(g, f, cx, cy, z0, h, keys, seed = 0){
  const ix = Math.floor(cx), iy = Math.floor(cy);
  for(let dx = -1; dx <= 1; dx++){
    for(let dy = -1; dy <= 1; dy++){
      const d = Math.abs(dx) + Math.abs(dy);
      const hh = Math.max(1, Math.round(h*(d === 0 ? 1 : d === 1 ? 0.66 : 0.38)*(0.65 + 0.7*hash3(dx + seed, dy, f*5 + 1))));
      for(let z = 0; z < hh; z++) g.set(ix + dx, iy + dy, z0 + z, z < hh*0.34 ? keys[0] : z < hh*0.72 ? keys[1] : keys[2]);
    }
  }
}

/** Stone pedestal + iron bowl + flames. */
function brazier(g, f, r, c, o){
  const ix = Math.floor(c.cx), iy = Math.floor(c.cy), zb = c.zb;
  g.box(ix - 2, iy - 2, zb - 1, ix + 1, iy + 1, zb + 2, (x, y, z) => hash3(x, y, z) > 0.5 ? o.stone[0] : o.stone[1]);
  g.box(ix - 1, iy - 1, zb + 3, ix, iy, zb + 4, o.stone[1]);
  g.cyl(c.cx, c.cy, zb + 5, zb + 5, 3.2, o.iron);
  g.cyl(c.cx, c.cy, zb + 6, zb + 6, 3.2, o.iron);
  g.cyl(c.cx, c.cy, zb + 6, zb + 6, 2.2, o.coal);
  flame(g, f, c.cx, c.cy, zb + 7, o.h ?? 7, o.flame, c.variant);
}

/** Column / pillar with optional broken top and fallen drum. */
function pillar(g, f, r, c, o){
  const zb = c.zb, rad = Math.min(3.4, minWD(c)/2 - 1.6);
  const broken = c.variant & 1;
  const h = o.h ?? 11;
  g.cyl(c.cx, c.cy, zb - 1, zb, rad + 0.9, o.base);
  g.cyl(c.cx, c.cy, zb + 1, zb + h, rad, (x, y, z) => {
    if(broken && z > zb + h - 5 && hash3(x, y, 4) < (z - (zb + h - 5))*0.22) return null;
    const ang = Math.atan2(y + 0.5 - c.cy, x + 0.5 - c.cx);
    return (Math.round(ang*3.2) & 1) ? o.shaft[1] : o.shaft[0];
  });
  if(!broken){
    g.box(Math.floor(c.cx - rad - 0.5), Math.floor(c.cy - rad - 0.5), zb + h + 1,
      Math.ceil(c.cx + rad - 0.5), Math.ceil(c.cy + rad - 0.5), zb + h + 2, o.base);
  } else {
    const dx = (c.variant & 2) ? 1 : -1;
    g.ell(c.cx + dx*(rad + 2.4), c.cy + 1.5, zb + 1.4, 2.8, 1.8, 1.7, o.shaft[1]);
  }
  if(o.moss) g.cap((x, y, z) => (z > zb && hash3(x, y, z + 3) > 0.8) ? o.moss : null);
}

/** Stacked carved blocks / crates. */
function blocks(g, f, r, c, o){
  const { W, D, zb } = c;
  const hh = 4 + (c.variant & 1);
  g.box(1, 1, zb - 1, W - 2, D - 2, zb + hh, (x, y, z) => hash3(x, y, z) > 0.5 ? o.body[0] : o.body[1]);
  const x0 = 3 + (c.variant & 1), y0 = 3, x1 = W - 4, y1 = D - 4 - (c.variant >> 1 & 1);
  g.box(x0, y0, zb + hh + 1, x1, y1, zb + hh + 4, (x, y, z) => hash3(x, y, z + 1) > 0.5 ? o.body[0] : o.body[1]);
  // carved glyphs on the two visible faces
  const gz = zb + hh + 2;
  for(let i = 0; i < 4; i++){
    const gy = y0 + 1 + i*2, gx = x0 + 1 + i*2;
    if(gy <= y1) g.set(x1, gy, gz + (i & 1), o.glyph);
    if(gx <= x1) g.set(gx, y1, gz + ((i + 1) & 1), o.glyph);
  }
  if(o.cap) g.cap((x, y, z) => (z > zb + 2 && hash3(x, y, z + 8) > 0.86) ? o.cap : null);
}

/** Tall jagged cliff built from noisy column heights. */
function crag(g, f, r, c, o){
  const seed = c.variant*17 + 3;
  for(let y = 0; y < c.D; y++){
    for(let x = 0; x < c.W; x++){
      const n = hash3(x >> 2, y >> 2, seed)*0.6 + hash3(x >> 1, y >> 1, seed + 1)*0.4;
      const q = o.q || 1;
      const h = c.zb + o.h0 + Math.floor(n*(o.h1 - o.h0)/q)*q;
      for(let z = c.zb - 1; z < h; z++) g.set(x, y, z, o.fn(x, y, z, h, f));
    }
  }
}

/** Simple hash-driven rounded bump on the base (hedge, snow mound). */
function mound(g, c, rz, fn){
  g.ell(c.cx, c.cy, c.zb - 0.5, c.W/2 + 0.7, c.D/2 + 0.7, rz, fn);
}

/** common: flat base slab with textured top, per-theme char function */
function slab(g, c, fn, rough = 0.12){
  const { W, D, zb } = c;
  for(let y = 0; y < D; y++)
    for(let x = 0; x < W; x++)
      for(let z = 0; z < zb; z++) g.set(x, y, z, fn(x, y, z, zb));
  for(let y = 0; y < D; y++)
    for(let x = 0; x < W; x++)
      if(hash3(x, y, 77 + c.variant) < rough) g.clear(x, y, zb - 1);
}

/** 3 flower/leaf char picker */
const pick = (arr, x, y, z, s = 0) => arr[Math.floor(hash3(x, y, z + s)*arr.length) % arr.length];

/* ===================================================================== */
/* THEME: GLADE                                                          */
/* ===================================================================== */

const FLOWERS = ['p', 'y', 'w', 'b'];

const GLADE = {
  id: 'glade', name: 'GLADE', bg: '#08130d',
  floorFrames: 4, floorFps: 5, wallFrames: 4, wallFps: 3, animFloor: false,
  outline: '#07130a', baseH: 6,
  tintOverlay: { color: '#ffe7a0', alpha: 0.05 },
  minimap: { floor: '#264f2d', wall: '#58b04f', border: '#2d7a3a' },
  palette: { floor: '#2d5934', wall: '#3f8a3f', accent: '#ffd23f', glow: '#e8ff7a' },
  pal: {
    h: '#2c6431', H: '#3b823b', j: '#53a049', l: '#74c85c', g: '#46944a', L: '#2a6b34',
    t: '#6e4b2e', T: '#4a3220', m: '#82a34f', r: '#8a9399', R: '#5d6871',
    p: '#ff7eb6', y: '#ffd23f', w: '#f6f7ff', b: '#d94a5e', B: '#e6e2d4', k: '#232c1c',
    d: '#5b4126', n: '#355f3a',
  },
  base(g, c){
    slab(g, c, (x, y, z, zb) => {
      if(z >= zb - 1){ const n = hash3(x, y, 9); return n < 0.4 ? 'j' : n < 0.8 ? 'H' : 'l'; }
      return hash3(x, y, z) > 0.5 ? 'h' : 'H';
    }, 0.1);
    // flower and tuft specks on the hedge top
    g.cap((x, y, z) => (z === c.zb - 1 && hash3(x, y, 55) < 0.06) ? FLOWERS[(hash3(x, y, 56)*4) | 0] : null);
  },
  floor(P, kind, f){
    const A = kind === 'floorA';
    const hex = A ? '#2d5934' : '#295330';
    baseCells(P, hex, A ? 1 : 2, 0.1);
    const r = mulberry32(A ? 101 : 202), bc = rgb32(hex);
    for(let n = 0; n < 2; n++){
      const cu = 4 + r()*22, cv = 4 + r()*22, rad = 3 + r()*2.5;
      for(let u = 0; u < 30; u++) for(let v = 0; v < 30; v++){
        const d = Math.hypot(u - cu, v - cv);
        if(d < rad && hash3(u, v, 12) > 0.15) P.cell(u, v, shade32(bc, 1.13 - d/rad*0.07));
      }
    }
    const tuftC = ['#4f9446', '#3f8a40', '#5aa24c'];
    for(let n = 0; n < (A ? 10 : 7); n++){
      const u = 1 + ((r()*28) | 0), v = 1 + ((r()*28) | 0);
      const c = rgb32(tuftC[(r()*3) | 0]);
      P.bump(u, v, shade32(c, 1.15), shade32(c, 0.7), shade32(c, 0.52));
    }
    const fc = ['#ff9ec7', '#ffe36b', '#f6f7ff'];
    for(let n = 0; n < (A ? 2 : 3); n++){
      const u = 2 + ((r()*26) | 0), v = 2 + ((r()*26) | 0);
      P.bump(u, v, rgb32(fc[(r()*3) | 0]), rgb32('#3a7a3a'), rgb32('#2c5d2e'));
    }
  },
  walls: [
    { id: 'oak', w: 3, frames: 4, build(g, f, r, c){
      const acc = ['p', 'b', null, 'y'][c.variant];
      tree(g, f, r, c, { R: 7, zt: c.zb + 7, trunk: 't', trunkD: 'T', leaves: ['L', 'g', 'l'], blobs: 5, accent: acc, accentP: 0.06 });
    } },
    { id: 'hedge', w: 3, frames: 1, build(g, f, r, c){
      mound(g, c, 6, (x, y, z) => leafChar(['h', 'H', 'j'], x, y, z, c.zb - 1, c.zb + 6));
      const fl = FLOWERS[c.variant];
      g.cap((x, y, z) => (z > c.zb + 1 && hash3(x, y, z + 21) < 0.12) ? fl : null);
    } },
    { id: 'boulder', w: 2, frames: 1, build(g, f, r, c){
      boulder(g, f, r, c, { rock: ['r', 'R'], cap: 'm', capZ: 4, capT: 0.28, rz: 7 });
    } },
    { id: 'flowerbed', w: 2, frames: 2, fps: 2, build(g, f, r, c){
      mound(g, c, 4.2, (x, y, z) => { const n = hash3(x, y, z + (f & 1 ? 0 : 0)); return n < 0.4 ? 'l' : FLOWERS[(hash3(x, y, 3)*4) | 0]; });
      g.cap((x, y, z) => hash3(x + f, y, z) > 0.93 ? 'w' : null);
    } },
    { id: 'birch', w: 1, frames: 4, build(g, f, r, c){
      tree(g, f, r, c, { R: 5.2, zt: c.zb + 10, tr: 1.2, trunk: 'B', trunkD: 'k', leaves: ['g', 'l', 'l'], blobs: 4 });
      g.recolor('B', (x, y, z) => hash3(x, y, z) > 0.8 ? 'k' : null);
    } },
    { id: 'topiary', w: 1, frames: 1, build(g, f, r, c){
      g.cone(c.cx, c.cy, c.zb - 1, c.zb + 13, minWD(c)/2 + 0.6, 1, (x, y, z) => leafChar(['h', 'H', 'j'], x, y, z, c.zb, c.zb + 14));
      g.ell(c.cx, c.cy, c.zb + 14.5, 1.8, 1.8, 1.8, 'l');
    } },
  ],
  border: [
    { id: 'bigoak', w: 3, frames: 4, build(g, f, r, c){
      tree(g, f, r, c, { R: 8, zt: c.zb + 5, tr: 2.2, trunk: 't', trunkD: 'T', leaves: ['L', 'g', 'l'], blobs: 6, accent: c.variant === 2 ? 'p' : null, accentP: 0.05 });
    } },
    { id: 'pines', w: 2, frames: 4, build(g, f, r, c){
      pine(g, f, r, c, { R: 7.6, tiers: 5, step: 4, trunk: 'T', needles: ['L', 'g'] });
    } },
    { id: 'thicket', w: 3, frames: 4, build(g, f, r, c){
      const sx = sway(f), lo = c.zb - 1, hi = c.zb + 14;
      for(let i = 0; i < 6; i++){
        const x = 2 + r()*(c.W - 4), y = 2 + r()*(c.D - 4), rr = 4 + r()*3, z = c.zb + 3 + r()*6;
        g.ell(x + sx*(z - c.zb)/10, y, z, rr, rr, rr*0.9, (vx, vy, vz) => leafChar(['L', 'g', 'l'], vx, vy, vz, lo, hi));
      }
      g.cap((x, y, z) => hash3(x, y, z + 40) < 0.05 ? 'y' : null);
    } },
    { id: 'twinoak', w: 2, frames: 4, build(g, f, r, c){
      tree(g, f, r, c, { R: 5.6, zt: c.zb + 5, tr: 1.4, trunk: 't', trunkD: 'T', leaves: ['L', 'g', 'l'], blobs: 3, ox: -3.5, oy: -2 });
      tree(g, f + 2, r, c, { R: 6.2, zt: c.zb + 8, tr: 1.5, trunk: 't', trunkD: 'T', leaves: ['L', 'g', 'l'], blobs: 3, ox: 3.5, oy: 2.5 });
    } },
  ],
  decor: [
    { kind: 'tuft', w: 6, frames: 4, fps: 3, H: 6, build(g, f, r, c){
      for(let i = 0; i < 8; i++){
        const x = 1 + (r()*6 | 0), y = 1 + (r()*6 | 0), h = 3 + (r()*2.5 | 0);
        for(let z = 0; z < h; z++) g.set(x, y, z, z === h - 1 ? 'l' : 'j');
        g.set(x + (i & 1 ? sway(f) : 0), y, h, 'l');
      }
    } },
    { kind: 'flower', w: 4, frames: 2, fps: 2, H: 5, build(g, f, r, c){
      for(let i = 0; i < 3; i++){
        const x = 2 + (r()*4 | 0), y = 2 + (r()*4 | 0), col = FLOWERS[(r()*4 | 0)];
        g.set(x, y, 0, 'g'); g.set(x, y, 1, 'g'); g.set(x, y, 2, col);
        if(f & 1){ g.set(x + 1, y, 2, col); g.set(x - 1, y, 2, col); }
      }
    } },
    { kind: 'pebbles', w: 3, H: 3, build(g, f, r, c){
      for(let i = 0; i < 3; i++) g.box(1 + (r()*5 | 0), 1 + (r()*5 | 0), 0, 1 + (r()*5 | 0), 1 + (r()*5 | 0), r() < 0.4 ? 1 : 0, 'r');
    } },
    { kind: 'fern', w: 3, H: 3, build(g, f, r, c){
      for(let i = 0; i < 12; i++){
        const a = (i/12)*6.28, d = 1 + (i & 1)*1.5;
        g.set(Math.round(4 + Math.cos(a)*d), Math.round(4 + Math.sin(a)*d), (i & 1), 'g');
      }
      g.set(4, 4, 1, 'l'); g.set(4, 4, 2, 'l');
    } },
    { kind: 'shroom', w: 2, H: 5, build(g, f, r, c){
      g.cyl(4, 4, 0, 1, 0.9, 'w'); g.ell(4, 4, 2.2, 2.3, 2.3, 1.3, 'b');
      g.set(3, 3, 3, 'w'); g.set(5, 4, 3, 'w');
    } },
    { kind: 'stump', w: 1, tall: true, H: 8, build(g, f, r, c){
      g.cyl(4, 4, 0, 5, 2.4, 'T'); g.cyl(4, 4, 6, 6, 2.2, 'B'); g.set(4, 4, 6, 't');
      g.set(1, 4, 0, 'm'); g.set(2, 6, 1, 'm');
    } },
  ],
  ambient: {
    count: 76,
    kinds: [
      { w: 4, z: [3, 13], v: [0, 0, 0], j: [3, 3, 0.8], wob: 5, wf: 1.1, life: [6, 14], cols: ['#f4ff8a', '#d9ff6a'], sz: 2, tw: 3.2, halo: true, front: 0.3, fade: true },
      { w: 5, z: [4, 22], v: [4, -2, 0.6], j: [2, 2, 0.8], wob: 3, wf: 0.7, life: [8, 18], cols: ['#fff6c8', '#ffffff', '#ffe49a'], sz: 1, tw: 0.9, a: 0.85, front: 0.4, fade: true },
    ],
  },
};

/* ===================================================================== */
/* THEME: CRYSTAL CAVERNS                                                */
/* ===================================================================== */

function crystalGlow(c, f){
  c.pal.g = '*' + ['#9a63ff', '#b283ff', '#cdaaff', '#b283ff'][f & 3];
  c.pal.G = '*' + ['#ff6fd8', '#ff8ce0', '#ffb0ec', '#ff8ce0'][f & 3];
  c.pal.e = '*' + ['#6f9dff', '#8fb4ff', '#b5ceff', '#8fb4ff'][f & 3];
}
const CRY_GLOW = { c: 'g', C: 'G', u: 'e' };

const CRYSTAL = {
  id: 'crystal', name: 'CRYSTAL CAVERNS', bg: '#07050f',
  floorFrames: 4, floorFps: 4, wallFrames: 4, wallFps: 3, animFloor: true,
  outline: '#06040f', baseH: 6,
  tintOverlay: { color: '#4a2a9a', alpha: 0.11 },
  minimap: { floor: '#241c3e', wall: '#8a5cf0', border: '#5a3fb0' },
  palette: { floor: '#241c3e', wall: '#5d509a', accent: '#c05bf0', glow: '#b283ff' },
  pal: {
    r: '#2e2650', q: '#42386f', Q: '#6154a3', d: '#1f1a38',
    c: '#8a50f0', C: '#c05bf0', u: '#5a85f0', k: '#cdb8ff', w: '*#ffffff',
    g: '*#b283ff', G: '*#ff8ce0', e: '*#8fb4ff',
  },
  base(g, c){
    slab(g, c, (x, y, z, zb) => {
      const n = hash3(x, y, z);
      if(z >= zb - 1) return n < 0.5 ? 'Q' : n < 0.86 ? 'q' : 'g';
      return n < 0.12 ? 'd' : n < 0.58 ? 'r' : 'q';
    }, 0.15);
    g.cap((x, y, z) => (z === c.zb - 1 && hash3(x, y, 61) < 0.05) ? 'g' : null);
  },
  floor(P, kind, f){
    const A = kind === 'floorA';
    const hex = A ? '#241c3e' : '#211a39';
    baseCells(P, hex, A ? 3 : 4, 0.12);
    const r = mulberry32(A ? 311 : 422), bc = rgb32(hex);
    // faint violet veins (random walks)
    for(let n = 0; n < 2; n++){
      let u = (r()*26 | 0) + 2, v = (r()*26 | 0) + 2;
      for(let i = 0; i < 14; i++){
        P.cell(u, v, shade32(rgb32('#3a2f6c'), 0.9 + r()*0.2));
        if(r() < 0.5) u += r() < 0.5 ? 1 : -1; else v += r() < 0.5 ? 1 : -1;
        u = Math.max(1, Math.min(28, u)); v = Math.max(1, Math.min(28, v));
      }
    }
    // glinting shards
    const glowC = rgb32('#d0b0ff'), dimC = rgb32('#5b3fb0');
    for(let n = 0; n < (A ? 2 : 1); n++){
      const u = 2 + (r()*26 | 0), v = 2 + (r()*26 | 0), ph = (r()*4) | 0;
      const bri = [0.15, 0.55, 1, 0.55][(f + ph) & 3];
      const col = mix32(dimC, glowC, bri);
      const halo = mix32(bc, rgb32('#6a4bd0'), bri*0.35);
      P.cell(u - 1, v, halo); P.cell(u + 1, v, halo); P.cell(u, v - 1, halo); P.cell(u, v + 1, halo);
      P.bump(u, v, col, shade32(col, 0.75), shade32(col, 0.55));
    }
  },
  walls: [
    { id: 'cluster', w: 4, frames: 4, build(g, f, r, c){
      crystalGlow(c, f);
      shards(g, f, r, c, { n: 5 + (c.variant & 1), h0: 11, h1: 20, r0: 2.7, lean: 3, keys: ['c', 'C', 'u'], glowOf: CRY_GLOW, sparkle: 'w' });
      g.cap((x, y, z) => (z === c.zb - 1 && hash3(x, y, 63) < 0.28) ? (hash3(x, y, 64) > 0.5 ? 'g' : 'G') : null);
    } },
    { id: 'stalag', w: 3, frames: 4, build(g, f, r, c){
      crystalGlow(c, f);
      const zs = c.zb - 1;
      const rk = (x, y, z) => hash3(x, y, z) > 0.55 ? 'r' : 'q';
      g.cone(c.cx, c.cy, zs, zs + 15, minWD(c)/2 + 0.4, 0.7, (x, y, z) => (z > zs + 11 && hash3(x, y, z) < 0.5) ? 'g' : rk(x, y, z));
      g.cone(c.cx + 4.5, c.cy - 3, zs, zs + 8, 3, 0.5, rk);
      g.cone(c.cx - 4, c.cy + 3.5, zs, zs + 6, 2.4, 0.4, rk);
      g.cap((x, y, z, code) => (z > zs + 4 && hash3(x, y, z + 7) > 0.93) ? 'g' : null);
    } },
    { id: 'geode', w: 2, frames: 4, build(g, f, r, c){
      crystalGlow(c, f);
      const zb = c.zb;
      g.ell(c.cx, c.cy, zb, c.W/2 + 0.6, c.D/2 + 0.6, 5, (x, y, z) => hash3(x, y, z) > 0.5 ? 'q' : 'r');
      // lit crystal bed
      g.cyl(c.cx, c.cy, zb + 3, zb + 3, minWD(c)/2 - 2.2, (x, y, z) => hash3(x, y, z + f) > 0.5 ? 'g' : 'G');
      shards(g, f, r, { ...c, zb: zb + 3, W: c.W, D: c.D }, { n: 6, h0: 4, h1: 9, r0: 1.5, lean: 2, keys: ['c', 'C', 'u'], glowOf: CRY_GLOW, sparkle: 'w' });
    } },
    { id: 'monolith', w: 2, frames: 4, build(g, f, r, c){
      crystalGlow(c, f);
      const zs = c.zb - 1, h = 18 + (c.variant & 1)*3;
      const lx = (c.variant - 1.5)*1.4, ly = (1.5 - c.variant)*1.0;
      g.cone(c.cx - 1, c.cy - 1, zs, zs + h, 3.8, 1.3, (x, y, z) => {
        const t = (z - zs)/h;
        if(t > 0.9) return 'g';
        if(((x*3 + y*2 + z*2 + 4000) % 9) < 1 && t > 0.15) return 'e';
        if(hash3(x, y, z + f*29) > 0.99) return 'w';
        return (x + y + z) & 4 ? 'u' : 'c';
      }, false, lx, ly);
      g.cone(c.cx + 3.5, c.cy + 3, zs, zs + 9, 2.2, 0.5, 'C', false, 1, 0.5);
    } },
    { id: 'ridge', w: 2, frames: 4, build(g, f, r, c){
      crystalGlow(c, f);
      crag(g, f, r, c, { h0: 2, h1: 11, fn: (x, y, z, h, ff) => {
        if(z === h - 1) return hash3(x, y, z) > 0.6 ? 'Q' : 'q';
        if(((x*3 + z*5 + y*7) % 13) === 0 && hash3(x, y, 2) > 0.3) return 'g';
        return hash3(x, y, z) > 0.5 ? 'r' : 'q';
      } });
      g.cap((x, y, z) => hash3(x + f, y, z) > 0.985 ? 'w' : null);
    } },
  ],
  border: [
    { id: 'crystalwall', w: 4, frames: 4, build(g, f, r, c){
      crystalGlow(c, f);
      crag(g, f, r, c, { h0: 2, h1: 7, fn: (x, y, z, h) => z === h - 1 ? 'Q' : (hash3(x, y, z + 5) > 0.96 ? 'g' : (hash3(x, y, z) > 0.5 ? 'r' : 'q')) });
      shards(g, f, r, c, { n: 7, h0: 12, h1: 20, r0: 2.6, lean: 3, keys: ['c', 'C', 'u'], glowOf: CRY_GLOW, sparkle: 'w' });
    } },
    { id: 'spires', w: 3, frames: 4, build(g, f, r, c){
      crystalGlow(c, f);
      crag(g, f, r, c, { h0: 1, h1: 5, fn: (x, y, z) => hash3(x, y, z + 5) > 0.95 ? 'G' : (hash3(x, y, z) > 0.5 ? 'r' : 'd') });
      shards(g, f, r, c, { n: 8, h0: 13, h1: 20, r0: 2.3, lean: 2, keys: ['u', 'c', 'C'], glowOf: CRY_GLOW, sparkle: 'w' });
    } },
    { id: 'gemcliff', w: 3, frames: 4, build(g, f, r, c){
      crystalGlow(c, f);
      crag(g, f, r, c, { h0: 6, h1: 15, fn: (x, y, z, h) => {
        if(z === h - 1) return hash3(x, y, z) > 0.5 ? 'Q' : 'q';
        if(((x*5 + z*3 + y*2) % 11) === 0) return (z & 1) ? 'g' : 'G';
        return hash3(x, y, z) > 0.5 ? 'r' : 'q';
      } });
      shards(g, f, r, c, { n: 3, h0: 14, h1: 18, r0: 2.2, lean: 2, keys: ['C', 'u'], glowOf: CRY_GLOW, sparkle: 'w' });
    } },
  ],
  decor: [
    { kind: 'glowshroom', w: 5, frames: 4, fps: 3, H: 6, build(g, f, r, c){
      crystalGlow(c, f);
      for(let i = 0; i < 2; i++){
        const x = 2 + i*3 + (r()*2 | 0), y = 2 + (r()*4 | 0), h = 2 + (r()*2 | 0);
        g.cyl(x + 0.5, y + 0.5, 0, h, 0.7, 'k');
        g.ell(x + 0.5, y + 0.5, h + 0.8, 1.9, 1.9, 1.1, (vx, vy, vz) => hash3(vx, vy, vz) > 0.7 ? 'G' : 'g');
      }
    } },
    { kind: 'shardlet', w: 4, frames: 4, fps: 3, H: 6, build(g, f, r, c){
      crystalGlow(c, f);
      for(let i = 0; i < 4; i++) g.cone(1.5 + r()*5, 1.5 + r()*5, 0, 3 + (r()*3 | 0), 1.3, 0.3, ['c', 'C', 'u', 'C'][i], false, 0.4, 0);
      g.set(4, 4, 4, 'g');
    } },
    { kind: 'pebbles', w: 4, H: 3, build(g, f, r, c){
      for(let i = 0; i < 5; i++){ const x = 1 + (r()*6 | 0), y = 1 + (r()*6 | 0); g.set(x, y, 0, 'Q'); if(r() < 0.6) g.set(x, y, 1, 'Q'); if(r() < 0.2) g.set(x, y, 1, 'g'); }
    } },
    { kind: 'glowpool', w: 4, frames: 4, fps: 3, W: 8, D: 8, H: 3, build(g, f, r, c){
      crystalGlow(c, f);
      g.cyl(4, 4, 0, 0, 3.4, 'd');
      g.cyl(4, 4, 0, 0, 2.5, (x, y, z) => hash3(x + f, y, z) > 0.4 ? 'g' : 'e');
    } },
    { kind: 'spirelet', w: 1, tall: true, frames: 4, fps: 3, H: 10, build(g, f, r, c){
      crystalGlow(c, f);
      g.cone(4, 4, 0, 9, 2.4, 0.4, (x, y, z) => z > 6 ? 'g' : (hash3(x, y, z) > 0.5 ? 'Q' : 'q'));
    } },
  ],
  ambient: {
    count: 74,
    kinds: [
      { w: 5, z: [2, 10], zInit: [2, 30], v: [0, 0, 3.5], j: [2, 2, 1.5], wob: 4, wf: 0.9, life: [7, 16], cols: ['#cdaaff', '#ff9be8', '#9bc0ff', '#ffffff'], sz: [1, 2, 0.3], tw: 2.4, halo: true, front: 0.35, fade: true },
      { w: 2, z: [1, 6], zInit: [1, 24], v: [0, 0, 1.6], j: [1.5, 1.5, 0.6], wob: 2, life: [8, 18], cols: ['#8a60ff', '#b283ff'], sz: 2, tw: 1.4, a: 0.7, front: 0.2, fade: true },
    ],
  },
};

/* ===================================================================== */
/* THEME: SUNKEN RUINS                                                   */
/* ===================================================================== */

function statue(g, f, r, c, o){
  const ix = Math.floor(c.cx), iy = Math.floor(c.cy), zb = c.zb;
  const st = (x, y, z) => hash3(x, y, z) > 0.5 ? o.stone[0] : o.stone[1];
  g.box(ix - 3, iy - 3, zb - 1, ix + 2, iy + 2, zb + 2, o.ped);
  g.box(ix - 1, iy - 2, zb + 3, ix, iy - 1, zb + 8, st);
  g.box(ix - 1, iy, zb + 3, ix, iy + 1, zb + 8, st);
  g.box(ix - 1, iy - 2, zb + 9, ix, iy + 1, zb + 14, st);
  g.box(ix - 1, iy - 3, zb + 10, ix, iy - 3, zb + 14, st);
  const brokenArm = c.variant & 1;
  g.box(ix - 1, iy + 2, zb + (brokenArm ? 9 : 10), ix, iy + 2, zb + (brokenArm ? 11 : 14), st);
  g.box(ix - 1, iy - 1, zb + 15, ix, iy, zb + ((c.variant & 2) ? 17 : 19), st);
  if(!(c.variant & 2)) g.box(ix - 1, iy - 1, zb + 19, ix, iy, zb + 19, o.gold);
  g.set(ix + 1, iy - 3, zb + 10, o.gold); g.set(ix + 1, iy - 3, zb + 11, o.gold);
  g.cap((x, y, z) => (z > zb + 2 && hash3(x, y, z + 3) > 0.9) ? o.moss : null);
}

const RUINS = {
  id: 'ruins', name: 'SUNKEN RUINS', bg: '#120d08',
  floorFrames: 4, floorFps: 5, wallFrames: 4, wallFps: 3, animFloor: false,
  outline: '#120c06', baseH: 7,
  tintOverlay: { color: '#ffb868', alpha: 0.07 },
  minimap: { floor: '#5f5140', wall: '#c8aa72', border: '#8d7650' },
  palette: { floor: '#6c5e46', wall: '#b79c6c', accent: '#d8ad3c', glow: '#ff9a2e' },
  pal: {
    s: '#b79c6c', S: '#d2bb88', d: '#8d7650', D: '#6b5a41', m: '#5f7e47', M: '#7e9d58',
    g: '#d8ad3c', G: '#a6822a', i: '#3a3640', I: '#55505f', c: '#9ba1a9', C: '#79818a',
    F: '*#ff5a1e', O: '*#ff9a2e', Y: '*#ffe066', e: '*#ff4a1a', v: '#4f7d3e', k: '#2a241c',
  },
  base(g, c){
    slab(g, c, (x, y, z, zb) => {
      if(z >= zb - 1){ const n = hash3(x, y, 9); return n < 0.45 ? 'S' : n < 0.85 ? 's' : 'd'; }
      if(((x + (z >> 1)*3 + (c.along === 'y' ? y : 0)) % 6) === 0 && (z & 1)) return 'D';
      if(z < 2 && hash3(x, y, z + 2) > 0.7) return 'm';
      return hash3(x, y, z) > 0.5 ? 's' : 'd';
    }, 0.14);
  },
  floor(P, kind, f){
    const A = kind === 'floorA';
    const base = rgb32(A ? '#6c5e46' : '#69593f'), mort = rgb32('#43382a');
    const offs = A ? 0 : 5;
    for(let u = 0; u < 30; u++){
      for(let v = 0; v < 30; v++){
        const fu = Math.floor((u + offs)/10), fv = Math.floor(v/10);
        let c = shade32(base, 0.9 + hash3(fu + (A ? 0 : 9), fv, 31)*0.2);
        const lu = (u + offs) % 10, lv = v % 10;
        if(lu === 0 || lv === 0) c = mort;
        else if(lu === 1 || lv === 1) c = shade32(c, 1.1);
        else if(lu === 9 || lv === 9) c = shade32(c, 0.92);
        const n = hash3(u, v, 5);
        if(n < 0.06) c = shade32(c, 0.86); else if(n > 0.95) c = shade32(c, 1.14);
        P.cell(u, v, c);
      }
    }
    const r = mulberry32(A ? 77 : 99);
    for(let n = 0; n < 3; n++){
      let u = 2 + (r()*26 | 0), v = 2 + (r()*26 | 0);
      for(let i = 0; i < 6; i++){
        P.cell(u, v, mort);
        if(r() < 0.5) u += r() < 0.5 ? 1 : -1; else v += r() < 0.5 ? 1 : -1;
        u = Math.max(1, Math.min(28, u)); v = Math.max(1, Math.min(28, v));
      }
    }
    for(let n = 0; n < 2; n++){
      const cu = 4 + r()*22, cv = 4 + r()*22, rad = 2.5 + r()*2;
      for(let u = 0; u < 30; u++) for(let v = 0; v < 30; v++){
        const d = Math.hypot(u - cu, v - cv);
        if(d < rad && hash3(u, v, 14) > 0.3) P.cell(u, v, shade32(rgb32('#8a7656'), 0.95 + (1 - d/rad)*0.12));
      }
    }
  },
  walls: [
    { id: 'pillar', w: 3, frames: 1, build(g, f, r, c){
      pillar(g, f, r, c, { base: 'S', shaft: ['s', 'S'], h: 12, moss: 'm' });
    } },
    { id: 'blocks', w: 3, frames: 1, build(g, f, r, c){
      blocks(g, f, r, c, { body: ['s', 'd'], glyph: 'g', cap: 'm' });
    } },
    { id: 'statue', w: 2, frames: 1, build(g, f, r, c){
      statue(g, f, r, c, { ped: 'S', stone: ['c', 'C'], gold: 'g', moss: 'm' });
    } },
    { id: 'brazier', w: 3, frames: 4, fps: 9, build(g, f, r, c){
      brazier(g, f, r, c, { stone: ['s', 'd'], iron: 'i', coal: 'e', flame: ['F', 'O', 'Y'], h: 8 });
    } },
    { id: 'arch', w: 2, frames: 1, build(g, f, r, c){
      const zb = c.zb, W = c.W, D = c.D;
      const st = (x, y, z) => hash3(x, y, z) > 0.5 ? 's' : 'd';
      g.box(1, 3, zb - 1, 3, D - 4, zb + 13, st);
      g.box(W - 4, 3, zb - 1, W - 2, D - 4, zb + ((c.variant & 1) ? 8 : 13), st);
      g.box(1, 3, zb + 14, (c.variant & 1) ? 8 : W - 2, D - 4, zb + 16, (x, y, z) => hash3(x, y, z) > 0.5 ? 'S' : 's');
      g.box(4, 5, zb - 1, W - 5, D - 6, zb + 1 + (c.variant & 1)*2, 'D');
      g.cap((x, y, z) => (z > zb + 3 && hash3(x, y, z + 3) > 0.9) ? 'm' : null);
    } },
    { id: 'rubble', w: 1, frames: 1, build(g, f, r, c){
      for(let i = 0; i < 7; i++){
        const x = 1 + r()*(c.W - 3), y = 1 + r()*(c.D - 3), h = 2 + r()*5, rr = 1.8 + r()*1.6;
        g.ell(x, y, c.zb - 1 + h/2, rr, rr, h/2 + 0.6, (vx, vy, vz) => hash3(vx, vy, vz) > 0.5 ? 's' : 'D');
      }
      g.cap((x, y, z) => (z > c.zb && hash3(x, y, z + 6) > 0.8) ? 'v' : null);
    } },
  ],
  border: [
    { id: 'rampart', w: 4, frames: 1, orient: true, build(g, f, r, c){
      const zb = c.zb, ax = c.along === 'x';
      const L = ax ? c.W : c.D, T = ax ? c.D : c.W;
      const st = (x, y, z) => hash3(x, y, z) > 0.5 ? 's' : 'd';
      g.box(0, 0, zb - 1, c.W - 1, c.D - 1, zb + 3, st);
      for(let a = 0; a < L; a++){
        if((a + c.variant*3) % 8 >= 5) continue;
        if(c.variant === 3 && a > 9) continue;
        for(let t = 0; t < T; t++){
          if(t > 2 && t < T - 3) continue;
          const x = ax ? a : t, y = ax ? t : a;
          g.box(x, y, zb + 4, x, y, zb + 8, st);
        }
      }
      g.cap((x, y, z) => (z > zb + 1 && hash3(x, y, z + 3) > 0.88) ? 'm' : null);
    } },
    { id: 'tower', w: 2, frames: 4, fps: 9, build(g, f, r, c){
      const zb = c.zb, W = c.W, D = c.D;
      const st = (x, y, z) => hash3(x, y, z) > 0.5 ? 's' : 'd';
      g.box(1, 1, zb - 1, W - 2, D - 2, zb + 13, st);
      g.box(0, 0, zb + 14, W - 1, D - 1, zb + 15, 'S');
      for(let i = 0; i < 4; i++){ const a = 1 + i*4; g.box(a, 0, zb + 16, Math.min(W - 1, a + 1), 0, zb + 17, 'S'); g.box(0, a, zb + 16, 0, Math.min(D - 1, a + 1), zb + 17, 'S'); g.box(a, D - 1, zb + 16, Math.min(W - 1, a + 1), D - 1, zb + 17, 'S'); g.box(W - 1, a, zb + 16, W - 1, Math.min(D - 1, a + 1), zb + 17, 'S'); }
      g.box(W - 2, 5, zb + 6, W - 2, 6, zb + 9, 'k'); g.box(5, D - 2, zb + 6, 6, D - 2, zb + 9, 'k');
      flame(g, f, c.cx, c.cy, zb + 16, 4, ['F', 'O', 'Y'], c.variant);
    } },
    { id: 'breach', w: 2, frames: 1, build(g, f, r, c){
      crag(g, f, r, c, { h0: 2, h1: 11, fn: (x, y, z, h) => z === h - 1 ? (hash3(x, y, 3) > 0.7 ? 'v' : 'S') : (hash3(x, y, z) > 0.5 ? 's' : 'd') });
      g.cap((x, y, z) => hash3(x, y, z + 4) > 0.9 ? 'm' : null);
    } },
    { id: 'torchwall', w: 2, frames: 4, fps: 9, orient: true, build(g, f, r, c){
      const zb = c.zb;
      g.box(0, 0, zb - 1, c.W - 1, c.D - 1, zb + 5, (x, y, z) => hash3(x, y, z) > 0.5 ? 's' : 'd');
      g.box(1, 1, zb + 6, c.W - 2, c.D - 2, zb + 6, 'S');
      brazier(g, f, r, { ...c, zb: zb + 6 }, { stone: ['s', 'd'], iron: 'i', coal: 'e', flame: ['F', 'O', 'Y'], h: 6 });
    } },
  ],
  decor: [
    { kind: 'crack', w: 5, H: 2, build(g, f, r, c){
      let x = 1, y = 3 + (r()*2 | 0);
      for(let i = 0; i < 10; i++){ g.set(x, y, 0, 'D'); if(r() < 0.75) x++; y = Math.max(1, Math.min(6, y + Math.round((r() - 0.5)*1.6))); }
    } },
    { kind: 'rubble', w: 5, H: 4, build(g, f, r, c){
      for(let i = 0; i < 4; i++){ const x = 1 + (r()*5 | 0), y = 1 + (r()*5 | 0), h = r()*3 | 0; g.box(x, y, 0, x + (r() < 0.4 ? 1 : 0), y, h, (vx, vy, vz) => hash3(vx, vy, vz) > 0.5 ? 's' : 'd'); }
    } },
    { kind: 'sandpile', w: 4, H: 3, build(g, f, r, c){
      g.ell(4, 4, 0, 3.4, 3.2, 2.4, (x, y, z) => hash3(x, y, z) > 0.5 ? 'S' : 's');
    } },
    { kind: 'pot', w: 2, H: 5, build(g, f, r, c){
      g.ell(4, 4, 1.6, 1.8, 1.8, 1.7, 'G'); g.cyl(4, 4, 3, 3, 1.3, 'G'); g.set(4, 4, 3, 'k');
      g.set(2, 4, 2, 'g'); g.set(6, 4, 2, 'g');
    } },
    { kind: 'drum', w: 2, W: 12, D: 7, H: 5, build(g, f, r, c){
      g.ell(6, 3.5, 1.7, 5, 2.2, 1.9, (x, y, z) => ((x >> 1) & 1) ? 's' : 'S');
      g.set(1, 3, 1, 'D');
    } },
    { kind: 'head', w: 1, tall: true, H: 9, build(g, f, r, c){
      g.ell(4, 4, 3, 2.6, 2.4, 3, (x, y, z) => hash3(x, y, z) > 0.5 ? 'c' : 'C');
      g.set(5, 3, 3, 'k'); g.set(5, 5, 3, 'k'); g.set(3, 4, 0, 'm'); g.set(5, 5, 1, 'm');
    } },
  ],
  ambient: {
    count: 60,
    kinds: [
      { w: 6, z: [2, 18], v: [5, 2, 0.1], j: [3, 3, 0.4], wob: 2, wf: 0.6, life: [8, 18], cols: ['#e0c898', '#c9ad7a', '#f1ddb2'], sz: 1, tw: 0.7, a: 0.75, front: 0.45, fade: true },
      { w: 2, z: [1, 8], zInit: [1, 30], v: [0, 0, 6], j: [2, 2, 2], wob: 2, wf: 1.7, life: [2, 5], cols: ['#ff9a2e', '#ffd05a', '#ff6a24'], sz: 1, tw: 5, front: 0.3, fade: true },
    ],
  },
};

/* ===================================================================== */
/* THEME: FROSTFALL                                                      */
/* ===================================================================== */

const FROST = {
  id: 'frost', name: 'FROSTFALL', bg: '#0b1420',
  floorFrames: 4, floorFps: 4, wallFrames: 4, wallFps: 3, animFloor: true,
  outline: '#0a1626', baseH: 6,
  tintOverlay: { color: '#8cc4ff', alpha: 0.07 },
  minimap: { floor: '#566a86', wall: '#b9d6ee', border: '#6bb3de' },
  palette: { floor: '#6e8099', wall: '#c3d6e8', accent: '#6bb3de', glow: '#ffffff' },
  pal: {
    n: '#eef6fc', N: '#c3d6e8', q: '#a3b6cc', i: '#9fd8f2', I: '#62aedb', J: '#3b78ae', j: '#cdf1fc',
    w: '*#ffffff', p: '#2f6c55', P: '#234e40', t: '#5e4330', r: '#76839a', R: '#546075',
  },
  base(g, c){
    slab(g, c, (x, y, z, zb) => {
      if(z >= zb - 1){ const n = hash3(x, y, 9); return n < 0.55 ? 'n' : n < 0.9 ? 'N' : 'q'; }
      if(z >= zb - 3) return hash3(x, y, z) > 0.4 ? 'N' : 'q';
      return hash3(x, y, z) > 0.5 ? 'R' : 'r';
    }, 0.16);
  },
  floor(P, kind, f){
    const A = kind === 'floorA';
    const hex = A ? '#6e8099' : '#6a7b95';
    baseCells(P, hex, A ? 5 : 6, 0.08);
    const r = mulberry32(A ? 515 : 626), bc = rgb32(hex);
    for(let u = 0; u < 30; u++) for(let v = 0; v < 30; v++){
      const w = Math.sin((u + v*0.6)*0.55 + (A ? 0 : 2));
      let c = null;
      if(w > 0.72) c = shade32(bc, 1.1); else if(w < -0.72) c = shade32(bc, 0.92);
      if(hash3(u, v, 8) > 0.99) c = rgb32('#e9f4ff');
      const wv = Math.sin(u*0.35 + f*1.5708 + 1)*Math.sin(v*0.31 - f*1.2);
      if(wv > 0.6) c = mix32(c ?? bc, rgb32('#7fe8c0'), 0.09);
      if(c) P.cell(u, v, c);
    }
    for(let n = 0; n < (A ? 3 : 7); n++){
      const u = 1 + (r()*28 | 0), v = 1 + (r()*28 | 0);
      if(A){ const ph = (r()*4) | 0; if(((f + ph) & 3) === 0){ P.cell(u, v, rgb32('#ffffff')); P.cell(u + 1, v, rgb32('#dff0ff')); P.cell(u, v + 1, rgb32('#dff0ff')); } }
      else P.bump(u, v, rgb32('#92a8c4'), rgb32('#738aa8'), rgb32('#5d7390'));
    }
  },
  walls: [
    { id: 'pine', w: 4, frames: 4, build(g, f, r, c){
      pine(g, f, r, c, { R: 7.2, tiers: 4, step: 4, trunk: 't', needles: ['p', 'P'], snow: ['n', 'N'] });
    } },
    { id: 'spire', w: 3, frames: 4, build(g, f, r, c){
      shards(g, f, r, c, { n: 5, h0: 9, h1: 18, r0: 2.5, lean: 2.5, keys: ['i', 'I', 'j'], vein: 'j', sparkle: 'w' });
      g.cap((x, y, z) => (z < c.zb + 3 && hash3(x, y, z + 6) > 0.7) ? 'n' : null);
    } },
    { id: 'snowrock', w: 3, frames: 1, build(g, f, r, c){
      boulder(g, f, r, c, { rock: ['r', 'R'], cap: 'n', capZ: 2, capT: 0.12, rz: 7 });
    } },
    { id: 'iceblocks', w: 2, frames: 4, build(g, f, r, c){
      blocks(g, f, r, c, { body: ['i', 'I'], glyph: 'j', cap: null });
      g.cap((x, y, z) => hash3(x, y, z + 3) > 0.7 ? 'n' : (hash3(x + f, y, z) > 0.985 ? 'w' : null));
    } },
    { id: 'deadtree', w: 1, frames: 4, build(g, f, r, c){
      const zb = c.zb;
      g.cyl(c.cx, c.cy, zb - 1, zb + 12, 1.3, 't');
      g.cone(c.cx, c.cy, zb + 5, zb + 13, 1, 0.4, 't', false, 5 + sway(f)*0.5, -1);
      g.cone(c.cx, c.cy, zb + 7, zb + 15, 1, 0.4, 't', false, -4 + sway(f)*0.5, 3);
      g.cone(c.cx, c.cy, zb + 9, zb + 17, 0.9, 0.3, 't', false, 1, -5);
      g.cap((x, y, z) => (z > zb + 4 && hash3(x, y, z + 2) > 0.45) ? 'n' : null);
    } },
  ],
  border: [
    { id: 'cliff', w: 3, frames: 4, build(g, f, r, c){
      crag(g, f, r, c, { h0: 5, h1: 13, fn: (x, y, z, h) => {
        if(z === h - 1) return hash3(x, y, z) > 0.4 ? 'n' : 'N';
        if(z >= h - 3) return 'q';
        if(z < c.zb) return 'J';
        return hash3(x, y, z) > 0.5 ? 'I' : 'i';
      } });
      g.cap((x, y, z) => hash3(x + f, y, z) > 0.985 ? 'w' : null);
    } },
    { id: 'glacier', w: 2, frames: 4, build(g, f, r, c){
      crag(g, f, r, c, { h0: 4, h1: 15, q: 4, fn: (x, y, z, h) => {
        if(z === h - 1) return 'j';
        return hash3(x, y, z) > 0.5 ? 'i' : 'I';
      } });
      g.cap((x, y, z) => hash3(x + f, y, z) > 0.98 ? 'w' : (hash3(x, y, z + 4) > 0.8 ? 'n' : null));
    } },
    { id: 'icespires', w: 3, frames: 4, build(g, f, r, c){
      crag(g, f, r, c, { h0: 2, h1: 6, fn: (x, y, z, h) => z === h - 1 ? 'N' : (hash3(x, y, z) > 0.5 ? 'I' : 'J') });
      shards(g, f, r, c, { n: 7, h0: 12, h1: 18, r0: 2.3, lean: 2, keys: ['i', 'I', 'j'], vein: 'j', sparkle: 'w' });
    } },
    { id: 'pineline', w: 3, frames: 4, build(g, f, r, c){
      pine(g, f, r, c, { R: 7.6, tiers: 5, step: 4, trunk: 't', needles: ['p', 'P'], snow: ['n', 'N'] });
    } },
  ],
  decor: [
    { kind: 'drift', w: 6, H: 4, build(g, f, r, c){
      g.ell(4, 4, 0, 3.4, 2.8, 2.6, (x, y, z) => hash3(x, y, z) > 0.4 ? 'n' : 'N');
    } },
    { kind: 'puddle', w: 4, frames: 4, fps: 3, H: 2, build(g, f, r, c){
      g.cyl(4, 4, 0, 0, 3.3, (x, y, z) => hash3(x, y, z) > 0.5 ? 'i' : 'I');
      g.cyl(4, 4, 0, 0, 3.4, 'N', true);
      g.set(3 + (f & 1), 3 + (f >> 1), 0, 'w');
    } },
    { kind: 'icicles', w: 3, frames: 4, fps: 3, H: 6, build(g, f, r, c){
      for(let i = 0; i < 3; i++) g.cone(1.5 + r()*5, 1.5 + r()*5, 0, 2 + (r()*3 | 0), 1.1, 0.3, 'i');
      g.set(1 + ((f*2) % 6), 3, 1, 'w');
    } },
    { kind: 'twigs', w: 3, H: 2, build(g, f, r, c){
      for(let i = 0; i < 3; i++){ let x = 1 + (r()*3 | 0), y = 1 + (r()*6 | 0); for(let k = 0; k < 3; k++){ g.set(x + k, y, 0, 't'); if(r() < 0.3) y++; } }
      g.cap((x, y, z) => hash3(x, y, z) > 0.5 ? 'n' : null);
    } },
    { kind: 'rock', w: 3, H: 4, build(g, f, r, c){
      g.ell(4, 4, 1, 2.4, 2.2, 1.8, (x, y, z) => hash3(x, y, z) > 0.5 ? 'r' : 'R');
      g.cap((x, y, z) => z >= 2 ? 'n' : null);
    } },
    { kind: 'sapling', w: 1, tall: true, frames: 4, fps: 3, H: 10, build(g, f, r, c){
      g.cyl(4, 4, 0, 2, 0.6, 't');
      for(let t = 0; t < 3; t++) g.cone(4 + sway(f)*(t > 0 ? 0.5 : 0), 4, 1 + t*2, 3 + t*2, 2.6 - t*0.7, 0.6, (x, y, z) => hash3(x, y, z) > 0.5 ? 'p' : 'P');
      g.cap((x, y, z, code) => (code === 0x70 || code === 0x50) && hash3(x, y, z) > 0.3 ? 'n' : null);
    } },
  ],
  ambient: {
    count: 96,
    kinds: [
      { w: 7, z: [36, 48], zInit: [0, 46], v: [0, 0, -12], j: [4, 2, 3], wob: 5, wf: 1.1, life: [9, 14], cols: ['#ffffff', '#e1efff'], sz: [1, 2, 0.25], a: 0.95, front: 0.35 },
      { w: 1, z: [2, 12], zInit: [2, 24], v: [0, 0, 0.5], j: [2, 2, 0.5], wob: 2, life: [5, 10], cols: ['#bfe6ff'], sz: 1, tw: 3, a: 0.8, front: 0.3, fade: true },
    ],
  },
};

/* ===================================================================== */
/* THEME: NEON FOUNDRY                                                   */
/* ===================================================================== */

function neon(c, f){
  c.pal.m = '*' + ['#ff3fb0', '#ff63c2', '#ff8cd4', '#ff63c2'][f & 3];
  c.pal.M = '*' + ['#ff9ee0', '#ffb4e8', '#ffd0f2', '#ffb4e8'][f & 3];
  c.pal.v = '*' + ['#9b6bff', '#b08aff', '#c9aaff', '#b08aff'][f & 3];
}
const LEDS = ['G', 'R', 'a', 'm'];

function crate(g, x0, y0, z0, x1, y1, z1, body, frame, hazard){
  g.box(x0, y0, z0, x1, y1, z1, (x, y, z) => {
    const ex = (x === x0 || x === x1) ? 1 : 0, ey = (y === y0 || y === y1) ? 1 : 0, ez = (z === z0 || z === z1) ? 1 : 0;
    if(ex + ey + ez >= 2) return frame;
    if(hazard && ez && ((x + y) & 2)) return hazard;
    return body;
  });
}

const FOUNDRY = {
  id: 'foundry', name: 'NEON FOUNDRY', bg: '#06070e',
  floorFrames: 4, floorFps: 4, wallFrames: 4, wallFps: 4, animFloor: true,
  outline: '#05060e', baseH: 6,
  tintOverlay: { color: '#1a1c52', alpha: 0.09 },
  minimap: { floor: '#232839', wall: '#7b87aa', border: '#ff63c2' },
  palette: { floor: '#232839', wall: '#4c5672', accent: '#ff3fb0', glow: '#ff63c2' },
  pal: {
    s: '#4c5672', S: '#6d789a', d: '#2d3348', k: '#171a2b', y: '#e3b020', z: '#25252d',
    m: '*#ff3fb0', M: '*#ff9ee0', a: '*#ffb347', v: '*#9b6bff', G: '*#7dff7a', R: '*#ff4a5a',
    x: '#2a2f45', o: '#8f98b3', w: '#e2e8ff', W: '#aab3cc', c: '#c47a3a',
  },
  base(g, c){
    slab(g, c, (x, y, z, zb) => {
      if(z < 2) return (((x + y) >> 1) & 1) ? 'y' : 'z';
      if(z >= zb - 1) return (hash3(x, y, 9) > 0.93) ? 'o' : (hash3(x, y, 8) > 0.5 ? 'S' : 's');
      if(z % 4 === 3 || x % 8 === 0) return 'd';
      return hash3(x, y, z) > 0.5 ? 's' : 'd';
    }, 0.05);
  },
  floor(P, kind, f){
    const A = kind === 'floorA';
    const base = rgb32(A ? '#232839' : '#212637'), seam = rgb32('#12152a'), rivet = rgb32('#434c68');
    const hot = rgb32('#a8337f'), cold = rgb32('#33102a'), glow = rgb32('#7a2260');
    for(let u = 0; u < 30; u++){
      for(let v = 0; v < 30; v++){
        let c = shade32(base, 0.93 + hash3(u >> 1, v >> 1, 7)*0.12);
        if(u === 15 || v === 15) c = seam;
        if(!A && u >= 8 && u < 22 && v >= 8 && v < 22) c = ((u + v) & 1) ? seam : shade32(base, 1.06);
        if(A && ((u === 13 || u === 17) && (v === 13 || v === 17))) c = rivet;
        if(((u === 3 || u === 26) && (v === 3 || v === 26))) c = rivet;
        const p = 0.5 + 0.5*Math.sin(6.2832*(f/4 - (u + v)/58));
        if(u === 0 || v === 0) c = mix32(cold, hot, p);
        else if(u === 1 || v === 1) c = mix32(c, glow, 0.04 + 0.12*p);
        P.cell(u, v, c);
      }
    }
    if(!A){
      const p = 0.5 + 0.5*Math.sin(6.2832*f/4);
      const nc = mix32(cold, hot, p);
      P.cell(14, 14, nc); P.cell(14, 15, nc); P.cell(15, 14, nc); P.cell(15, 15, nc);
    }
  },
  walls: [
    { id: 'rack', w: 4, frames: 4, fps: 6, build(g, f, r, c){
      neon(c, f);
      const { W, D, zb } = c, h = 15 + (c.variant & 1)*2;
      g.box(1, 1, zb - 1, W - 2, D - 2, zb + h, (x, y, z) => hash3(x, y, z) > 0.5 ? 'd' : 'x');
      g.box(1, 1, zb + h + 1, W - 2, D - 2, zb + h + 1, 'S');
      const x1 = W - 2, y1 = D - 2;
      for(let z = zb + 1; z < zb + h; z++){
        for(let y = 2; y < y1; y++){
          if(z & 1){ const k = hash3(y, z, 3 + c.variant); g.set(x1, y, z, hash3(y, z, 17 + f*3) > 0.55 ? LEDS[(k*4) | 0] : 'k'); }
          else g.set(x1, y, z, 'k');
        }
        for(let x = 2; x < x1; x++){
          if(!(z & 1)){ const k = hash3(x, z, 5 + c.variant); g.set(x, y1, z, hash3(x, z, 23 + f*3) > 0.55 ? LEDS[(k*4) | 0] : 'k'); }
          else g.set(x, y1, z, 'k');
        }
      }
      if(c.variant & 2) g.box(3, 3, zb + h + 2, 5, 5, zb + h + 3, 'o');
    } },
    { id: 'crates', w: 3, frames: 1, build(g, f, r, c){
      const { W, D, zb } = c;
      crate(g, 1, 1, zb - 1, 7, 7, zb + 5, 's', 'o', 'y');
      crate(g, 8, 2, zb - 1, W - 2, D - 2, zb + 3, 'd', 'S', null);
      crate(g, 2, 2, zb + 6, 6, 6, zb + 10 + (c.variant & 1)*2, 's', 'o', null);
      if(c.variant & 2) crate(g, 9, 9, zb + 4, W - 3, D - 3, zb + 7, 'x', 'S', 'y');
    } },
    { id: 'pylon', w: 3, frames: 4, fps: 6, build(g, f, r, c){
      neon(c, f);
      const zb = c.zb;
      g.cyl(c.cx, c.cy, zb - 1, zb + 2, 4.4, (x, y, z) => hash3(x, y, z) > 0.5 ? 'S' : 's');
      g.cone(c.cx, c.cy, zb + 3, zb + 18, 2.5, 1.5, (x, y, z) => {
        const k = z - zb;
        if(k === 6 || k === 10 || k === 14) return (((k - 6)/4 + f) & 3) === 0 ? 'M' : 'm';
        return hash3(x, y, z) > 0.5 ? 'd' : 'x';
      });
      g.ell(c.cx, c.cy, zb + 20, 2.6 + (f & 1)*0.5, 2.6 + (f & 1)*0.5, 2.5 + (f & 1)*0.5, 'M');
      g.cyl(c.cx, c.cy, zb + 3, zb + 3, 3.6, 'o');
    } },
    { id: 'vent', w: 2, frames: 4, fps: 6, build(g, f, r, c){
      const zb = c.zb, cx = c.cx, cy = c.cy;
      g.box(2, 2, zb - 1, c.W - 3, c.D - 3, zb + 5, (x, y, z) => (z & 1) ? 'd' : 's');
      g.cyl(cx - 3, cy - 2, zb + 6, zb + 12, 1.8, 'c'); g.cyl(cx + 2.5, cy + 2, zb + 6, zb + 9, 1.8, 'o');
      g.cyl(cx - 3, cy - 2, zb + 8, zb + 8, 2.3, 'o');
      for(let i = 0; i < 4; i++){
        const k = (f*2 + i*3) % 10, z = zb + 13 + k, rr = 1.2 + k*0.22;
        g.ell(cx - 3 + Math.sin(i*2 + f)*0.8, cy - 2, z, rr, rr, 1, (x, y, zz) => hash3(x, y, zz) > 0.5 ? 'w' : 'W');
      }
    } },
    { id: 'tank', w: 2, frames: 4, fps: 6, build(g, f, r, c){
      const zb = c.zb, rad = minWD(c)/2 - 1.2;
      g.cyl(c.cx, c.cy, zb - 1, zb + 12, rad, (x, y, z) => {
        const k = z - zb;
        if(k === 3 || k === 9) return 'k';
        if(k >= 5 && k <= 7) return ((x + y) & 2) ? 'y' : 'z';
        return hash3(x, y, z) > 0.5 ? 's' : 'S';
      });
      g.cyl(c.cx, c.cy, zb + 13, zb + 13, rad - 0.5, 'o');
      for(let i = 0; i < 3; i++) g.set(Math.round(c.cx + rad*0.55) + 0, Math.round(c.cy + rad*0.65) + i - 1, zb + 11, hash3(i, f, 5) > 0.4 ? 'a' : 'x');
      g.set(Math.round(c.cx + rad*0.7), Math.round(c.cy + rad*0.2), zb + 4, (f & 1) ? 'G' : 'x');
    } },
  ],
  border: [
    { id: 'bulkhead', w: 4, frames: 4, fps: 5, build(g, f, r, c){
      neon(c, f);
      const { W, D, zb } = c;
      g.box(0, 0, zb - 1, W - 1, D - 1, zb + 8, (x, y, z) => ((x % 8 === 0) || ((z - zb) % 5 === 4)) ? 'd' : (hash3(x, y, z) > 0.5 ? 's' : 'S'));
      g.box(0, 0, zb + 9, W - 1, D - 1, zb + 9, 'o');
      for(let a = 0; a < 16; a++){
        const col = ((a + f*3) % 8) < 4 ? 'M' : 'm';
        g.set(W - 1, Math.min(D - 1, a), zb + 4, col); g.set(Math.min(W - 1, a), D - 1, zb + 4, col);
      }
      if(c.variant & 1) for(let a = 1; a < W; a += 5){ g.set(a, D - 1, zb + 7, 'o'); g.set(W - 1, Math.min(D - 1, a), zb + 7, 'o'); }
    } },
    { id: 'blastdoor', w: 2, frames: 4, fps: 3, build(g, f, r, c){
      neon(c, f);
      const { W, D, zb } = c;
      g.box(0, 0, zb - 1, W - 1, D - 1, zb + 12, (x, y, z) => hash3(x, y, z) > 0.5 ? 's' : 'S');
      g.box(0, 0, zb + 13, W - 1, D - 1, zb + 13, 'o');
      g.box(W - 1, 3, zb, W - 1, D - 4, zb + 9, (x, y, z) => ((z + y) & 2) && (z < zb + 2 || z > zb + 7) ? 'y' : 'd');
      g.box(3, D - 1, zb, W - 4, D - 1, zb + 9, (x, y, z) => ((z + x) & 2) && (z < zb + 2 || z > zb + 7) ? 'y' : 'd');
      g.set(W - 1, D - 2, zb + 11, (f & 1) ? 'G' : 'R'); g.set(W - 2, D - 1, zb + 11, (f & 1) ? 'R' : 'G');
      for(let a = 0; a < W; a++) g.set(a, D - 1, zb + 12, ((a + f*2) % 6) < 3 ? 'M' : 'm');
    } },
    { id: 'piping', w: 2, frames: 4, fps: 6, build(g, f, r, c){
      neon(c, f);
      const { W, D, zb } = c;
      g.box(0, 0, zb - 1, W - 1, D - 1, zb + 9, (x, y, z) => hash3(x, y, z) > 0.5 ? 's' : 'd');
      for(let i = 0; i < 3; i++){
        const x = 2 + i*5, y = D - 2 - (i & 1)*2;
        g.cyl(x, y, zb + 10, zb + 17, 2.2, (vx, vy, vz) => vz === zb + 13 ? 'c' : (hash3(vx, vy, vz) > 0.5 ? 's' : 'S'));
        g.cyl(x, y, zb + 18, zb + 18, 1.8, (f + i) & 1 ? 'M' : 'm');
      }
      for(let a = 0; a < 16; a++) g.set(Math.min(W - 1, a), D - 1, zb + 5, ((a + f*2) % 6) < 3 ? 'M' : 'm');
    } },
    { id: 'mast', w: 1, frames: 4, fps: 4, build(g, f, r, c){
      neon(c, f);
      const { W, D, zb } = c;
      g.box(0, 0, zb - 1, W - 1, D - 1, zb + 8, (x, y, z) => hash3(x, y, z) > 0.5 ? 's' : 'S');
      g.cyl(c.cx, c.cy, zb + 9, zb + 24, 1.2, 'o');
      g.cyl(c.cx, c.cy, zb + 15, zb + 15, 2.6, 'o'); g.cyl(c.cx, c.cy, zb + 20, zb + 20, 2, 'o');
      g.ell(c.cx, c.cy, zb + 25.5, 1.4, 1.4, 1.4, (f & 1) ? 'R' : 'x');
      for(let a = 0; a < 16; a++) g.set(Math.min(W - 1, a), D - 1, zb + 4, ((a + f*3) % 8) < 4 ? 'M' : 'm');
    } },
  ],
  decor: [
    { kind: 'cable', w: 5, H: 2, build(g, f, r, c){
      let x = 0, y = 3 + (r()*2 | 0);
      for(let i = 0; i < 12; i++){ g.set(x, y, 0, 'k'); if(r() < 0.8) x = Math.min(7, x + 1); y = Math.max(1, Math.min(6, y + Math.round((r() - 0.5)*1.5))); }
      g.set(3, y, 1, 'x');
    } },
    { kind: 'grate', w: 3, frames: 4, fps: 4, H: 6, build(g, f, r, c){
      g.box(1, 1, 0, 6, 6, 0, (x, y) => ((x + y) & 1) ? 'k' : 'd');
      for(let i = 0; i < 2; i++){ const k = (f + i*2) & 3; g.ell(3.5 + i, 3.5, 1.5 + k, 1 + k*0.25, 1 + k*0.25, 0.8, 'w'); }
    } },
    { kind: 'minicrate', w: 3, H: 6, build(g, f, r, c){
      crate(g, 2, 2, 0, 5, 5, 3, 's', 'o', 'y');
    } },
    { kind: 'panel', w: 4, frames: 4, fps: 3, H: 3, build(g, f, r, c){
      g.box(1, 1, 0, 6, 6, 0, 'd');
      for(let i = 0; i < 3; i++) g.set(2 + i*2, 2, 0, hash3(i, f, 9) > 0.45 ? LEDS[i] : 'x');
      for(let i = 0; i < 3; i++) g.set(2 + i*2, 5, 0, hash3(i, f, 4) > 0.5 ? LEDS[(i + 1) & 3] : 'x');
    } },
    { kind: 'barrel', w: 2, H: 6, build(g, f, r, c){
      g.cyl(4, 4, 0, 3, 1.9, (x, y, z) => z === 1 ? 'k' : (hash3(x, y, z) > 0.5 ? 'c' : 's'));
      g.cyl(4, 4, 4, 4, 1.7, 'o');
    } },
    { kind: 'antenna', w: 1, tall: true, frames: 2, fps: 2, H: 12, build(g, f, r, c){
      g.cyl(4, 4, 0, 1, 2, 'S'); g.cyl(4, 4, 2, 7, 0.7, 'o'); g.set(4, 4, 8, (f & 1) ? 'R' : 'x');
    } },
  ],
  ambient: {
    count: 80,
    kinds: [
      { w: 3, z: [1, 6], zInit: [1, 20], v: [0, 0, 14], j: [10, 10, 7], grav: -40, life: [0.5, 1.1], cols: ['#ffd05a', '#ffb347', '#ffffff'], sz: 1, front: 0.5, fade: true },
      { w: 4, z: [1, 10], zInit: [1, 32], v: [0, 0, 5], j: [2, 2, 2], life: [5, 10], cols: ['#ff63c2', '#ffffff', '#9b6bff'], sz: [1, 2, 0.3], tw: 4.5, front: 0.3, fade: true },
      { w: 2, z: [1, 4], zInit: [1, 20], v: [0, 0, 3], j: [1, 1, 1], wob: 2, life: [3, 6], cols: ['#aab3cc'], sz: 2, a: 0.3, front: 0.3, fade: true },
    ],
  },
};

/* ===================================================================== */
/* THEME: EMBERFALL                                                      */
/* ===================================================================== */

function heat(c, f){
  c.pal.L = '*' + ['#ff5a20', '#ff6f2a', '#ff8a38', '#ff6f2a'][f & 3];
  c.pal.Y = '*' + ['#ffa63a', '#ffb84a', '#ffd060', '#ffb84a'][f & 3];
  c.pal.R = '*' + ['#a8300f', '#b8380f', '#d04816', '#b8380f'][f & 3];
}

const EMBER = {
  id: 'ember', name: 'EMBERFALL', bg: '#0c0709',
  floorFrames: 4, floorFps: 4, wallFrames: 4, wallFps: 4, animFloor: true,
  outline: '#08040a', baseH: 6,
  tintOverlay: { color: '#ff4a10', alpha: 0.07 },
  minimap: { floor: '#1f1a28', wall: '#6a5a86', border: '#ff6a2a' },
  palette: { floor: '#1f1a28', wall: '#40354f', accent: '#ff6a2a', glow: '#ffb347' },
  pal: {
    o: '#3a3048', O: '#4f4363', b: '#241d30', h: '#7a6a98', v: '#5a4545', V: '#7a5e5e', a: '#8d8593',
    L: '*#ff6f2a', Y: '*#ffb84a', R: '*#b8380f', i: '#3a3238', F: '*#ff5a1e', f: '*#ff9a2e', y: '*#ffd866',
  },
  base(g, c){
    slab(g, c, (x, y, z, zb) => {
      if(z === 0 && hash3(x, y, 4) > 0.82) return 'R';
      if(z >= zb - 1){ const n = hash3(x, y, 9); return n < 0.45 ? 'O' : n < 0.9 ? 'o' : 'h'; }
      const col = hash3(x >> 1, y >> 1, 3);
      return col > 0.55 ? 'o' : col > 0.2 ? 'b' : 'O';
    }, 0.14);
  },
  floor(P, kind, f){
    const A = kind === 'floorA';
    const obs = rgb32(A ? '#1f1a28' : '#1c1825');
    baseCells(P, A ? '#1f1a28' : '#1c1825', A ? 7 : 8, 0.12);
    const paths = A
      ? [[[3, 8], [9, 11], [14, 15], [19, 16], [26, 22]], [[14, 15], [15, 23]]]
      : [[[7, 21], [11, 18], [15, 16], [19, 10]]];
    const dim = rgb32('#66230f'), hotc = rgb32('#f08a35'), warm = rgb32('#9a3817');
    let s = 0;
    for(const path of paths){
      for(let i = 0; i < path.length - 1; i++){
        const [u0, v0] = path[i], [u1, v1] = path[i + 1];
        const n = Math.max(Math.abs(u1 - u0), Math.abs(v1 - v0));
        for(let k = 0; k <= n; k++){
          const u = Math.round(u0 + (u1 - u0)*k/n), v = Math.round(v0 + (v1 - v0)*k/n);
          const heatv = 0.5 + 0.5*Math.sin(6.2832*f/4 - (s++)*0.4);
          const gl = mix32(obs, warm, heatv*0.3);
          P.cell(u + 1, v, gl); P.cell(u - 1, v, gl); P.cell(u, v + 1, gl); P.cell(u, v - 1, gl);
        }
      }
    }
    s = 0;
    for(const path of paths){
      for(let i = 0; i < path.length - 1; i++){
        const [u0, v0] = path[i], [u1, v1] = path[i + 1];
        const n = Math.max(Math.abs(u1 - u0), Math.abs(v1 - v0));
        for(let k = 0; k <= n; k++){
          const u = Math.round(u0 + (u1 - u0)*k/n), v = Math.round(v0 + (v1 - v0)*k/n);
          const heatv = 0.5 + 0.5*Math.sin(6.2832*f/4 - (s++)*0.4);
          P.cell(u, v, mix32(dim, hotc, heatv));
        }
      }
    }
    const r = mulberry32(A ? 88 : 99);
    for(let n = 0; n < 4; n++){
      const u = 2 + (r()*26 | 0), v = 2 + (r()*26 | 0), ph = (r()*4) | 0;
      if(((f + ph) & 3) < 2) P.cell(u, v, rgb32('#ff7a2a'));
    }
  },
  walls: [
    { id: 'spire', w: 4, frames: 4, build(g, f, r, c){
      heat(c, f);
      shards(g, f, r, c, { n: 3 + (c.variant & 1), h0: 11, h1: 20, r0: 3.0, lean: 2.5, keys: ['o', 'O', 'b'], vein: 'L', tip: 'L', sparkle: 'h' });
    } },
    { id: 'mound', w: 3, frames: 4, build(g, f, r, c){
      heat(c, f);
      boulder(g, f, r, c, { rock: ['v', 'V'], rz: 7 });
      g.cap((x, y, z) => (z > c.zb + 1 && ((x*3 + y*5 + z) % 7) === 0 && hash3(x, y, z) > 0.3) ? 'L' : null);
      g.cap((x, y, z) => (z > c.zb + 5 && hash3(x, y, z + 1) > 0.8) ? 'Y' : null);
    } },
    { id: 'brazier', w: 3, frames: 4, fps: 9, build(g, f, r, c){
      heat(c, f);
      brazier(g, f, r, c, { stone: ['o', 'O'], iron: 'i', coal: 'R', flame: ['F', 'f', 'y'], h: 8 });
    } },
    { id: 'columns', w: 3, frames: 4, build(g, f, r, c){
      heat(c, f);
      const zb = c.zb;
      for(let i = 0; i < 5; i++){
        const x = 2.5 + r()*(c.W - 5), y = 2.5 + r()*(c.D - 5), rad = 2.2 + r()*0.7, h = 7 + r()*9;
        g.cyl(x, y, zb - 1, zb - 1 + h, rad, (vx, vy, vz) => vz === Math.floor(zb - 1 + h) ? 'h' : (hash3(vx, vy, vz) > 0.5 ? 'o' : 'O'));
        g.cyl(x, y, zb - 1, zb - 1, rad + 1, 'R', true);
      }
    } },
    { id: 'lavafall', w: 2, frames: 4, build(g, f, r, c){
      heat(c, f);
      crag(g, f, r, c, { h0: 3, h1: 11, fn: (x, y, z, h) => z === h - 1 ? 'O' : (hash3(x, y, z) > 0.5 ? 'o' : 'b') });
      const y0 = 3 + (c.variant & 3)*3;
      for(let z = c.zb - 1; z < c.zb + 12; z++){
        for(let y = y0; y < y0 + 2; y++) g.set(c.W - 1, y, z, ((z + f) & 3) < 2 ? 'Y' : 'L');
        g.set(c.W - 2, y0, z, 'L');
      }
    } },
  ],
  border: [
    { id: 'cliff', w: 3, frames: 4, build(g, f, r, c){
      heat(c, f);
      crag(g, f, r, c, { h0: 6, h1: 16, fn: (x, y, z, h) => {
        if(z === h - 1) return hash3(x, y, z) > 0.6 ? 'h' : 'O';
        if(((x*3 + z*4 + y*2) % 12) === 0 && hash3(x, y, 2) > 0.2) return 'L';
        return hash3(x >> 1, y, z) > 0.5 ? 'o' : 'b';
      } });
    } },
    { id: 'spires', w: 2, frames: 4, build(g, f, r, c){
      heat(c, f);
      crag(g, f, r, c, { h0: 2, h1: 6, fn: (x, y, z, h) => z === h - 1 ? 'O' : (hash3(x, y, z) > 0.5 ? 'o' : 'b') });
      shards(g, f, r, c, { n: 6, h0: 12, h1: 18, r0: 2.6, lean: 2, keys: ['o', 'O', 'b'], vein: 'L', tip: 'L', sparkle: 'h' });
    } },
    { id: 'flow', w: 3, frames: 4, build(g, f, r, c){
      heat(c, f);
      crag(g, f, r, c, { h0: 5, h1: 14, fn: (x, y, z, h) => z === h - 1 ? 'O' : (hash3(x, y, z) > 0.5 ? 'o' : 'b') });
      for(let k = 0; k < 2; k++){
        const y0 = 2 + k*7 + (c.variant & 1)*2;
        for(let z = c.zb - 1; z < c.zb + 13; z++){
          g.set(c.W - 1, y0, z, ((z + f + k*2) & 3) < 2 ? 'Y' : 'L'); g.set(c.W - 1, y0 + 1, z, 'L');
        }
        const x0 = 2 + k*7 + (c.variant >> 1 & 1)*2;
        for(let z = c.zb - 1; z < c.zb + 13; z++){
          g.set(x0, c.D - 1, z, ((z + f + k*2) & 3) < 2 ? 'Y' : 'L'); g.set(x0 + 1, c.D - 1, z, 'L');
        }
      }
    } },
    { id: 'basalt', w: 2, frames: 4, build(g, f, r, c){
      heat(c, f);
      for(let cy = 0; cy < c.D; cy += 4){
        for(let cx = 0; cx < c.W; cx += 4){
          const h = c.zb + 4 + Math.floor(hash3(cx, cy, c.variant + 40)*13);
          g.box(cx, cy, c.zb - 1, Math.min(c.W - 1, cx + 3), Math.min(c.D - 1, cy + 3), h, (x, y, z) => {
            if(z === h) return 'h';
            if(x === cx || y === cy) return (z & 1) ? 'b' : 'o';
            return hash3(x, y, z) > 0.5 ? 'O' : 'o';
          });
          g.set(cx + 3, Math.min(c.D - 1, cy + 3), Math.max(c.zb, h - 5), 'L');
        }
      }
    } },
  ],
  decor: [
    { kind: 'ash', w: 6, H: 4, build(g, f, r, c){
      g.ell(4, 4, 0, 3.4, 3, 2.2, (x, y, z) => hash3(x, y, z) > 0.45 ? 'a' : 'o');
    } },
    { kind: 'lavapool', w: 4, frames: 4, fps: 3, H: 3, build(g, f, r, c){
      heat(c, f);
      g.cyl(4, 4, 0, 0, 3.4, 'b');
      g.cyl(4, 4, 0, 0, 2.6, (x, y, z) => hash3(x + f, y, z) > 0.5 ? 'L' : 'Y');
    } },
    { kind: 'emberstone', w: 4, frames: 4, fps: 3, H: 5, build(g, f, r, c){
      heat(c, f);
      g.ell(4, 4, 1, 2.6, 2.3, 1.9, (x, y, z) => hash3(x, y, z) > 0.5 ? 'v' : 'V');
      g.cap((x, y, z) => ((x + y*2) % 3 === 0 && z >= 2) ? 'L' : null);
    } },
    { kind: 'bones', w: 2, H: 3, build(g, f, r, c){
      for(let i = 0; i < 4; i++){ const x = 1 + i*1.5; g.set(Math.round(x), 2, 0, 'a'); g.set(Math.round(x), 3, 0, 'a'); g.set(Math.round(x), 4 + (i & 1), 0, 'a'); }
      g.box(1, 6, 0, 6, 6, 0, 'a');
    } },
    { kind: 'cinders', w: 3, frames: 4, fps: 6, H: 3, build(g, f, r, c){
      heat(c, f);
      for(let i = 0; i < 4; i++){ const x = 1 + (r()*6 | 0), y = 1 + (r()*6 | 0); g.set(x, y, 0, hash3(i, f, 2) > 0.4 ? 'L' : 'R'); }
    } },
    { kind: 'shard', w: 1, tall: true, frames: 4, fps: 3, H: 12, build(g, f, r, c){
      heat(c, f);
      g.cone(4, 4, 0, 8, 2.4, 0.4, (x, y, z) => z >= 7 ? 'L' : (hash3(x, y, z) > 0.5 ? 'o' : 'O'), false, 0.5, 0.3);
    } },
  ],
  ambient: {
    count: 90,
    kinds: [
      { w: 6, z: [0, 6], zInit: [0, 42], v: [2, 1, 10], j: [3, 3, 4], wob: 3, wf: 1.4, life: [3, 7], cols: ['#ff8a38', '#ffb84a', '#ff5a20'], sz: [1, 2, 0.25], tw: 3, halo: true, front: 0.4, fade: true },
      { w: 4, z: [30, 46], zInit: [0, 46], v: [3, 2, -4], j: [3, 3, 1.5], wob: 2, life: [8, 14], cols: ['#b8b0c0', '#8d8593'], sz: 1, a: 0.8, front: 0.3 },
      { w: 2, z: [1, 6], zInit: [1, 30], v: [1, 1, 3.5], j: [1, 1, 1], wob: 2, life: [4, 8], cols: ['#3a3340', '#2c2430'], sz: 2, a: 0.5, front: 0.2, fade: true },
    ],
  },
};

/* ------------------------------------------------------------ export --- */

/** All themes; index 0 is the duel-1 theme. */
export const THEMES = [GLADE, CRYSTAL, RUINS, FROST, FOUNDRY, EMBER];
export const THEME_BY_ID = Object.fromEntries(THEMES.map(t => [t.id, t]));
