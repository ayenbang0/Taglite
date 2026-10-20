import { ISO_X, ISO_Z } from './config.js';
import { shade, mix, hash3 } from './voxel.js';

/* =========================================================================
   THEME ART HELPERS
   - VoxGrid + bakeVox: a flat byte grid of palette chars that is baked with
     surface culling, per-voxel brightness noise and optional emissive voxels
     ('*#rrggbb' palette entries ignore face shading).
   - TilePainter: writes a 120x60 iso floor tile straight into an ImageData
     (one 1x1-unit "voxel top" is a 4x2 px diamond, 30x30 of them per tile).
   - Shared gameplay tiles (slow / speed / ice) so they read the same in
     every theme.
   Nothing here touches the DOM beyond offscreen canvases, and everything is
   baked lazily by the callers.
   ========================================================================= */

/* ---------- small utils ---------- */

export function mulberry32(a){
  return function(){
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

export function seedOf(...v){
  let h = 2166136261;
  for(const x of v){
    const n = typeof x === 'string' ? strHash(x) : (x | 0);
    h = Math.imul(h ^ n, 16777619); h ^= h >>> 13;
  }
  return h >>> 0;
}

export function strHash(s){
  let h = 5381;
  for(let i = 0; i < s.length; i++) h = (Math.imul(h, 33) + s.charCodeAt(i)) | 0;
  return h;
}

export const clamp01 = v => v < 0 ? 0 : v > 1 ? 1 : v;

/* ---------- voxel grid ---------- */

export class VoxGrid {
  /** Footprint W x D (voxels = world units), height H, `M` voxels of margin on every side for overhang. */
  constructor(W, D, H, M = 3){
    this.W = W; this.D = D; this.H = H; this.M = M;
    this.gw = W + 2*M; this.gd = D + 2*M;
    this.a = new Uint8Array(this.gw * this.gd * H);
  }
  idx(x, y, z){
    const i = x + this.M, j = y + this.M;
    if(i < 0 || j < 0 || i >= this.gw || j >= this.gd || z < 0 || z >= this.H) return -1;
    return (z*this.gd + j)*this.gw + i;
  }
  set(x, y, z, ch){
    const k = this.idx(x, y, z);
    if(k >= 0) this.a[k] = ch.charCodeAt(0);
  }
  /** set only when empty */
  put(x, y, z, ch){
    const k = this.idx(x, y, z);
    if(k >= 0 && !this.a[k]) this.a[k] = ch.charCodeAt(0);
  }
  get(x, y, z){
    const k = this.idx(x, y, z);
    return k < 0 ? 0 : this.a[k];
  }
  clear(x, y, z){
    const k = this.idx(x, y, z);
    if(k >= 0) this.a[k] = 0;
  }
  _put(x, y, z, ch, keep){
    const k = this.idx(x, y, z);
    if(k < 0 || (keep && this.a[k])) return;
    const c = typeof ch === 'function' ? ch(x, y, z) : ch;
    if(c) this.a[k] = c.charCodeAt(0);
  }
  /** ch may be a char or (x,y,z)=>char|null. Inclusive integer bounds. */
  box(x0, y0, z0, x1, y1, z1, ch, keep = false){
    for(let z = z0; z <= z1; z++)
      for(let y = y0; y <= y1; y++)
        for(let x = x0; x <= x1; x++) this._put(x, y, z, ch, keep);
  }
  /** Ellipsoid, continuous centre/radii; voxel centres are sampled at +0.5. */
  ell(cx, cy, cz, rx, ry, rz, ch, keep = false){
    for(let z = Math.floor(cz - rz); z <= Math.ceil(cz + rz); z++){
      const dz = (z + 0.5 - cz) / rz; if(dz*dz > 1) continue;
      for(let y = Math.floor(cy - ry); y <= Math.ceil(cy + ry); y++){
        const dy = (y + 0.5 - cy) / ry;
        if(dz*dz + dy*dy > 1) continue;
        for(let x = Math.floor(cx - rx); x <= Math.ceil(cx + rx); x++){
          const dx = (x + 0.5 - cx) / rx;
          if(dx*dx + dy*dy + dz*dz <= 1) this._put(x, y, z, ch, keep);
        }
      }
    }
  }
  /** Vertical cylinder from z0..z1 inclusive. */
  cyl(cx, cy, z0, z1, r, ch, keep = false){
    const r2 = r*r;
    for(let y = Math.floor(cy - r); y <= Math.ceil(cy + r); y++)
      for(let x = Math.floor(cx - r); x <= Math.ceil(cx + r); x++){
        const dx = x + 0.5 - cx, dy = y + 0.5 - cy;
        if(dx*dx + dy*dy > r2) continue;
        for(let z = z0; z <= z1; z++) this._put(x, y, z, ch, keep);
      }
  }
  /** Tapered cylinder, radius r0 at z0 down/up to r1 at z1. */
  cone(cx, cy, z0, z1, r0, r1, ch, keep = false, lx = 0, ly = 0){
    const n = Math.max(1, z1 - z0);
    for(let z = z0; z <= z1; z++){
      const t = (z - z0) / n;
      const r = r0 + (r1 - r0)*t;
      const ox = cx + lx*t, oy = cy + ly*t;
      const r2 = r*r;
      for(let y = Math.floor(oy - r); y <= Math.ceil(oy + r); y++)
        for(let x = Math.floor(ox - r); x <= Math.ceil(ox + r); x++){
          const dx = x + 0.5 - ox, dy = y + 0.5 - oy;
          if(dx*dx + dy*dy <= r2 + 0.01) this._put(x, y, z, ch, keep);
        }
    }
  }
  /** Calls fn(x,y,z,code) for every solid voxel whose top is exposed. */
  eachTop(fn){
    const { W, D, M, H, gw, gd, a } = this;
    for(let z = 0; z < H; z++)
      for(let j = 0; j < gd; j++)
        for(let i = 0; i < gw; i++){
          const k = (z*gd + j)*gw + i;
          if(!a[k]) continue;
          if(z + 1 < H && a[k + gw*gd]) continue;
          fn(i - M, j - M, z, a[k]);
        }
  }
  /** Recolour exposed tops: fn(x,y,z,code) -> char|null */
  cap(fn){
    const todo = [];
    this.eachTop((x, y, z, c) => { const n = fn(x, y, z, c); if(n) todo.push(x, y, z, n); });
    for(let i = 0; i < todo.length; i += 4) this.set(todo[i], todo[i+1], todo[i+2], todo[i+3]);
  }
  /** Replace every voxel of code `from` by fn(x,y,z)->char|null */
  recolor(from, fn){
    const { M, H, gw, gd, a } = this;
    const fc = from.charCodeAt(0);
    for(let z = 0; z < H; z++)
      for(let j = 0; j < gd; j++)
        for(let i = 0; i < gw; i++){
          const k = (z*gd + j)*gw + i;
          if(a[k] !== fc) continue;
          const n = fn(i - M, j - M, z);
          if(n) a[k] = n.charCodeAt(0);
        }
  }
}

/* ---------- baking ---------- */

const NOISE_LV = 5;
const colCache = new Map();
/** [top,left,right] packed colours for a palette entry at a noise level. */
function triple(hex, lv, amp){
  const key = hex + lv + amp;
  let t = colCache.get(key);
  if(t) return t;
  let s;
  if(hex[0] === '*'){
    const c = hex.slice(1);
    s = [c, shade(c, 0.9), shade(c, 0.78)];
  } else {
    const f = 1 + (lv - 2) * amp * 0.5;
    const c = f === 1 ? hex : shade(hex, f);
    s = [shade(c, 1.2), shade(c, 0.78), shade(c, 0.58)];
  }
  t = [rgb32(s[0]), rgb32(s[1]), rgb32(s[2])];
  colCache.set(key, t);
  return t;
}

/**
 * Bake a VoxGrid straight into a pixel buffer (no per-voxel canvas calls).
 * pal: {char: '#hex' | '*#hex'}. Returns {canvas, ax, ay, h}; the canvas is cropped
 * to the highest occupied layer.
 */
export function bakeVox(g, pal, o = {}){
  const { gw, gd, H, a } = g;
  const amp = o.noise ?? 0.12;
  const pad = 1;
  const layer = gw*gd;
  let Hp = 0;
  for(let k = H - 1; k >= 0 && !Hp; k--){
    const base = k*layer;
    for(let n = 0; n < layer; n++){ if(a[base + n]){ Hp = k + 1; break; } }
  }
  if(!Hp) Hp = 1;
  const offX = gd*ISO_X + pad, offY = Hp*ISO_Z + pad;
  const W = (gw + gd)*ISO_X + pad*2, Hh = Hp*ISO_Z + gw + gd + pad*2;
  const px = new Uint32Array(W*Hh);
  const names = new Array(128);
  for(let k = 0; k < Hp; k++){
    for(let i = 0; i < gw; i++){
      for(let j = 0; j < gd; j++){
        const idx = (k*gd + j)*gw + i;
        const code = a[idx];
        if(!code) continue;
        const up = k + 1 >= H ? 0 : a[idx + layer];
        const rt = i + 1 >= gw ? 0 : a[idx + 1];
        const lf = j + 1 >= gd ? 0 : a[idx + gw];
        if(up && rt && lf) continue;
        const hex = pal[names[code] || (names[code] = String.fromCharCode(code))];
        if(!hex) continue;
        const lv = hex[0] === '*' ? 2 : Math.min(NOISE_LV - 1, (hash3(i, j, k) * NOISE_LV) | 0);
        const c = triple(hex, lv, amp);
        const x = (i - j - 1)*ISO_X + offX, y = (i + j) - (k + 1)*ISO_Z + offY;
        let p = y*W + x;
        px[p + 1] = c[0]; px[p + 2] = c[0];
        p += W; px[p] = c[0]; px[p + 1] = c[0]; px[p + 2] = c[0]; px[p + 3] = c[0];
        p += W; px[p] = c[1]; px[p + 1] = c[1]; px[p + 2] = c[2]; px[p + 3] = c[2];
        p += W; px[p] = c[1]; px[p + 1] = c[1]; px[p + 2] = c[2]; px[p + 3] = c[2];
      }
    }
  }
  let out = px;
  if(o.outline !== false){
    const oc = rgb32(o.outline || '#05060c');
    out = new Uint32Array(px);
    for(let y = 0; y < Hh; y++){
      for(let x = 0; x < W; x++){
        const p = y*W + x;
        if(px[p]) continue;
        if((x > 0 && px[p - 1]) || (x < W - 1 && px[p + 1]) || (y > 0 && px[p - W]) || (y < Hh - 1 && px[p + W])) out[p] = oc;
      }
    }
  }
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = Hh;
  canvas.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(out.buffer), W, Hh), 0, 0);
  return { canvas, ax: gw + gd + pad, ay: Math.round((gw + gd)/2) + Hp*ISO_Z + pad, h: Hp };
}

/* ---------- 32-bit colour helpers for tiles ---------- */

const rgbCache = new Map();
/** '#rrggbb' -> packed little-endian RGBA int */
export function rgb32(hex){
  let v = rgbCache.get(hex);
  if(v !== undefined) return v;
  let h = hex.replace('#', '');
  if(h.length === 3) h = h.split('').map(c => c + c).join('');
  v = pack(parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16));
  rgbCache.set(hex, v);
  return v;
}
export function pack(r, g, b){
  r = r < 0 ? 0 : r > 255 ? 255 : r | 0; g = g < 0 ? 0 : g > 255 ? 255 : g | 0; b = b < 0 ? 0 : b > 255 ? 255 : b | 0;
  return (((255 << 24) | (b << 16) | (g << 8) | r) >>> 0);
}
export const r32 = c => c & 255;
export const g32 = c => (c >> 8) & 255;
export const b32 = c => (c >> 16) & 255;
export function shade32(c, f){
  if(f <= 1) return pack(r32(c)*f, g32(c)*f, b32(c)*f);
  const t = (f - 1)*0.6;
  return pack(r32(c) + (255 - r32(c))*t, g32(c) + (255 - g32(c))*t, b32(c) + (255 - b32(c))*t);
}
export function mix32(a, b, t){
  return pack(r32(a) + (r32(b) - r32(a))*t, g32(a) + (g32(b) - g32(a))*t, b32(a) + (b32(b) - b32(a))*t);
}

/* ---------- floor tile painter ---------- */

export const TILE_W = 120, TILE_H = 60, TILE_CELLS = 30;

export class TilePainter {
  constructor(){
    this.canvas = document.createElement('canvas');
    this.canvas.width = TILE_W; this.canvas.height = TILE_H;
    this.ctx = this.canvas.getContext('2d');
    this.img = this.ctx.createImageData(TILE_W, TILE_H);
    this.u32 = new Uint32Array(this.img.data.buffer);
  }
  px(x, y, c){
    if(x >= 0 && x < TILE_W && y >= 0 && y < TILE_H) this.u32[y*TILE_W + x] = c;
  }
  /** Flat 1x1-unit top at world cell (u,v) of this tile (0..29). */
  cell(u, v, c){
    const x = 58 + (u - v)*2, y = u + v;
    const w = this.u32;
    if(y >= 0 && y < TILE_H - 1 && x >= 0 && x < TILE_W - 3){
      const o = y*TILE_W + x;
      w[o + 1] = c; w[o + 2] = c;
      const p = o + TILE_W;
      w[p] = c; w[p + 1] = c; w[p + 2] = c; w[p + 3] = c;
    }
  }
  /** A 1-voxel-tall cube standing on cell (u,v); use only for 1<=u,v<=28. */
  bump(u, v, top, left, right){
    const x = 58 + (u - v)*2, y = u + v - 2;
    this.px(x + 1, y, top); this.px(x + 2, y, top);
    for(let i = 0; i < 4; i++) this.px(x + i, y + 1, top);
    this.px(x, y + 2, left); this.px(x + 1, y + 2, left); this.px(x, y + 3, left); this.px(x + 1, y + 3, left);
    this.px(x + 2, y + 2, right); this.px(x + 3, y + 2, right); this.px(x + 2, y + 3, right); this.px(x + 3, y + 3, right);
  }
  /** bump coloured from a single base colour */
  bumpC(u, v, c){
    this.bump(u, v, shade32(c, 1.2), shade32(c, 0.78), shade32(c, 0.58));
  }
  finish(){
    this.ctx.putImageData(this.img, 0, 0);
    return this.canvas;
  }
}

/** Fill a whole tile with noisy cells of one colour. amp = brightness spread. */
export function baseCells(P, hex, seed, amp = 0.1){
  const base = rgb32(hex);
  const lv = [shade32(base, 1 - amp), shade32(base, 1 - amp*0.45), base, shade32(base, 1 + amp*0.6)];
  for(let u = 0; u < TILE_CELLS; u++){
    for(let v = 0; v < TILE_CELLS; v++){
      const n = hash3(u, v, seed);
      let i = n < 0.18 ? 0 : n < 0.45 ? 1 : n < 0.86 ? 2 : 3;
      if(hash3(u >> 2, v >> 2, seed + 7) > 0.72) i = Math.max(0, i - 1);
      P.cell(u, v, lv[i]);
    }
  }
}

const edgeCell = (u, v) => u === 0 || v === 0 || u === TILE_CELLS - 1 || v === TILE_CELLS - 1;

/* ---------- gameplay tiles, identical in meaning in every theme ---------- */

/** slow: murky brown sludge with darker blotches and popping bubbles */
export function slowTile(frame){
  const P = new TilePainter();
  const mud = rgb32('#52391f'), dark = rgb32('#2f2010'), wet = rgb32('#715a2e'), murk = rgb32('#3d3a1c');
  for(let u = 0; u < TILE_CELLS; u++){
    for(let v = 0; v < TILE_CELLS; v++){
      const blot = Math.sin(u*0.55 + 1.3)*Math.sin(v*0.47 + 0.7) + (hash3(u >> 1, v >> 1, 5) - 0.5)*0.9;
      let c = blot > 0.42 ? dark : blot < -0.5 ? wet : (hash3(u, v, 3) > 0.7 ? murk : mud);
      if(hash3(u, v, 9) < 0.08) c = shade32(c, 1.15);
      if(edgeCell(u, v)) c = shade32(c, 0.78);
      P.cell(u, v, c);
    }
  }
  const sites = [[8, 9, 0], [20, 13, 1], [13, 22, 2], [24, 24, 3]];
  for(const [u, v, ph] of sites){
    const s = (frame + ph) & 3;
    if(s === 1) P.bump(u, v, wet, mud, dark);
    else if(s === 2){ P.bump(u, v, shade32(wet, 1.25), wet, mud); }
    else if(s === 3){
      const hi = shade32(wet, 1.3);
      P.cell(u - 1, v, hi); P.cell(u + 1, v, hi); P.cell(u, v - 1, hi); P.cell(u, v + 1, hi);
    }
  }
  return P.finish();
}

/** speed: bright teal glow with nested '^' chevrons streaming up the screen */
export function speedTile(frame){
  const P = new TilePainter();
  const base = rgb32('#10504e'), base2 = rgb32('#14605c'), chev = rgb32('#5ff5e6'), glow = rgb32('#25b8ab');
  const rim = rgb32('#35e0cf');
  const pulse = [1.0, 1.1, 1.2, 1.1][frame & 3];
  for(let u = 0; u < TILE_CELLS; u++){
    for(let v = 0; v < TILE_CELLS; v++){
      let c = hash3(u, v, 21) > 0.5 ? base : base2;
      if(Math.abs(u - v) <= 14){
        const m = Math.min(u, v);
        const ph = ((m + frame*2) % 8 + 8) % 8;
        if(ph < 2 && m < 28) c = ph === 0 ? chev : shade32(chev, 0.86);
        else if(ph === 2 || ph === 7) c = glow;
      }
      if(edgeCell(u, v)) c = rim;
      else if(c === base || c === base2) c = shade32(c, pulse);
      P.cell(u, v, c);
    }
  }
  return P.finish();
}

/** ice: pale blue glossy streaks with travelling glints */
export function iceTile(frame){
  const P = new TilePainter();
  const base = rgb32('#a5d6ee'), base2 = rgb32('#96cbe6'), streak = rgb32('#f0fbff'), crack = rgb32('#6fb0d3'), rim = rgb32('#d6f0fb');
  for(let u = 0; u < TILE_CELLS; u++){
    for(let v = 0; v < TILE_CELLS; v++){
      let c = hash3(u >> 1, v >> 1, 33) > 0.55 ? base2 : base;
      if(hash3(u, v, 4) < 0.1) c = shade32(c, 1.1);
      // long streaks along world +u (screen down-right)
      const sv = (v === 6 || v === 7 || v === 19 || v === 25);
      if(sv && ((u + (v*5)) % 13) < 8) c = (v & 1) ? streak : shade32(streak, 0.9);
      if((u - v === 9 || u - v === -12) && ((u*3) % 7) < 4) c = crack;
      if(edgeCell(u, v)) c = rim;
      P.cell(u, v, c);
    }
  }
  const sites = [[7, 12, 0], [21, 8, 1], [16, 21, 2], [25, 17, 3], [11, 4, 2]];
  for(const [u, v, ph] of sites){
    const s = (frame + ph) & 3;
    if(s === 1) P.cell(u, v, streak);
    else if(s === 2){ P.cell(u, v, streak); P.cell(u - 1, v, streak); P.cell(u + 1, v, streak); P.cell(u, v - 1, streak); P.cell(u, v + 1, streak); }
    else if(s === 3) P.cell(u, v, streak);
  }
  return P.finish();
}

export { shade, mix, hash3 };
