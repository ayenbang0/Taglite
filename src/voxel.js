import { ISO_X, ISO_Z } from './config.js';

/* =========================================================================
   VOXEL BAKER
   Models are authored as layered ASCII grids and baked once into small
   offscreen canvases of pre-drawn 4x4px cubes, so per-frame cost is a
   drawImage per object, and the look stays pixel-exact.

   model = { w, d, h, layers:[ [rowString, ...], ... ] }
     layers[k]  = z slice k (0 = ground)
     row index  = y (0..d-1), char index = x (0..w-1)
     '.' or ' ' = empty, any other char = palette key
   A model's FRONT is +x. rotateModel() turns it a quarter-turn so that
   +x -> +y -> -x -> -y.
   ========================================================================= */

const hexCache = new Map();
function parseHex(hex){
  let v = hexCache.get(hex);
  if(v) return v;
  let h = hex.replace('#','');
  if(h.length===3) h = h.split('').map(c=>c+c).join('');
  v = [parseInt(h.slice(0,2),16), parseInt(h.slice(2,4),16), parseInt(h.slice(4,6),16)];
  hexCache.set(hex, v);
  return v;
}
const toHex = n => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2,'0');

/** Multiply a #rrggbb colour's brightness by f (f>1 brightens toward white a little). */
export function shade(hex, f){
  const [r,g,b] = parseHex(hex);
  if(f <= 1) return '#'+toHex(r*f)+toHex(g*f)+toHex(b*f);
  const t = f-1;
  return '#'+toHex(r+(255-r)*t*0.6)+toHex(g+(255-g)*t*0.6)+toHex(b+(255-b)*t*0.6);
}

/** Linear mix of two hex colours, t in 0..1. */
export function mix(a, b, t){
  const A = parseHex(a), B = parseHex(b);
  return '#'+toHex(A[0]+(B[0]-A[0])*t)+toHex(A[1]+(B[1]-A[1])*t)+toHex(A[2]+(B[2]-A[2])*t);
}

/** The shared 4x4 isometric cube: top diamond over two side faces. */
export function drawCubePx(ctx, x, y, top, left, right){
  ctx.fillStyle = top;
  ctx.fillRect(x+1, y,   2, 1);
  ctx.fillRect(x,   y+1, 4, 1);
  ctx.fillStyle = left;
  ctx.fillRect(x,   y+2, 2, 2);
  ctx.fillStyle = right;
  ctx.fillRect(x+2, y+2, 2, 2);
}

/** Draw a single shaded cube of colour `c` at the top-left (x,y). */
export function cubeColored(ctx, x, y, c){
  drawCubePx(ctx, Math.round(x), Math.round(y), shade(c,1.2), shade(c,0.78), shade(c,0.58));
}

/** One quarter-turn: cell (i,j) -> (d-1-j, i), so the +x front ends up facing +y. */
export function rotateModel(model, quarterTurns = 1){
  let m = model;
  const turns = ((quarterTurns % 4) + 4) % 4;
  for(let t=0; t<turns; t++){
    const nw = m.d, nd = m.w;
    const layers = m.layers.map(layer=>{
      const rows = [];
      for(let j=0;j<nd;j++){
        let row = '';
        for(let i=0;i<nw;i++){
          // new (i,j) came from old (x=j, y=m.d-1-i)
          const src = layer[m.d-1-i];
          row += src ? (src[j] ?? '.') : '.';
        }
        rows.push(row);
      }
      return rows;
    });
    m = { w:nw, d:nd, h:m.h, layers };
  }
  return m;
}

function palColors(palette, key){
  const base = palette[key];
  if(!base) return null;
  return [shade(base,1.2), shade(base,0.78), shade(base,0.58)];
}

/**
 * Bake a model to a canvas. Returns { canvas, ax, ay }: blit at
 * project(x,y,z) - (ax,ay) so the footprint's ground centre lands on (x,y,z).
 * opts: { outline:true, alpha:1 }
 */
export function bakeModel(model, palette, opts = {}){
  const { w, d, h, layers } = model;
  const pad = opts.outline === false ? 0 : 1;
  const W = (w+d)*ISO_X + pad*2;
  const H = h*ISO_Z + w + d + pad*2;
  const offX = d*ISO_X + pad, offY = h*ISO_Z + pad;
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  const cols = {};
  for(let k=0;k<h;k++){
    const layer = layers[k];
    if(!layer) continue;
    for(let i=0;i<w;i++){
      for(let j=0;j<d;j++){
        const row = layer[j];
        const ch = row ? row[i] : '.';
        if(!ch || ch==='.' || ch===' ') continue;
        const c = cols[ch] || (cols[ch] = palColors(palette, ch));
        if(!c) continue;
        drawCubePx(ctx, (i-j-1)*ISO_X + offX, (i+j) - (k+1)*ISO_Z + offY, c[0], c[1], c[2]);
      }
    }
  }
  let out = canvas;
  let ax = w + d + pad, ay = (w+d)/2 + h*ISO_Z + pad;
  if(opts.outline !== false){
    out = outline(canvas, '#05060c');
  }
  return { canvas: out, ax: Math.round(ax), ay: Math.round(ay) };
}

/** Add a 1px dilated outline. Input canvas needs >=1px transparent padding. */
export function outline(src, color){
  const c = document.createElement('canvas');
  c.width = src.width; c.height = src.height;
  const ctx = c.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  const sil = document.createElement('canvas');
  sil.width = src.width; sil.height = src.height;
  const sctx = sil.getContext('2d');
  sctx.drawImage(src, 0, 0);
  sctx.globalCompositeOperation = 'source-in';
  sctx.fillStyle = color;
  sctx.fillRect(0, 0, sil.width, sil.height);
  ctx.drawImage(sil, -1, 0); ctx.drawImage(sil, 1, 0);
  ctx.drawImage(sil, 0, -1); ctx.drawImage(sil, 0, 1);
  ctx.drawImage(src, 0, 0);
  return c;
}

/** A tinted copy of a sprite canvas (colour over opaque pixels only). */
export function tint(src, color, alpha = 1){
  const c = document.createElement('canvas');
  c.width = src.width; c.height = src.height;
  const ctx = c.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(src, 0, 0);
  ctx.globalCompositeOperation = 'source-atop';
  ctx.globalAlpha = alpha;
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, c.width, c.height);
  return c;
}

/** Solid single-colour silhouette copy of a sprite canvas. */
export function silhouette(src, color){
  return tint(src, color, 1);
}

const cache = new Map();
/** Memoise an expensive bake by string key. */
export function cached(key, builder){
  let v = cache.get(key);
  if(v === undefined){ v = builder(); cache.set(key, v); }
  return v;
}

/** Deterministic 0..1 hash of integers, for stable per-voxel / per-prop variation. */
export function hash3(a, b = 0, c = 0){
  let h = (a*374761393 + b*668265263 + c*2147483647) | 0;
  h = (h ^ (h >>> 13)) * 1274126177 | 0;
  h = h ^ (h >>> 16);
  return (h >>> 0) / 4294967296;
}

/** Build a fresh empty model grid (all '.'), returning mutable helpers. */
export function makeGrid(w, d, h){
  const cells = [];
  for(let k=0;k<h;k++){
    const layer = [];
    for(let j=0;j<d;j++) layer.push(new Array(w).fill('.'));
    cells.push(layer);
  }
  return {
    w, d, h,
    set(i, j, k, ch){ if(i>=0&&i<w&&j>=0&&j<d&&k>=0&&k<h) cells[k][j][i] = ch; },
    get(i, j, k){ return (i>=0&&i<w&&j>=0&&j<d&&k>=0&&k<h) ? cells[k][j][i] : '.'; },
    box(i0,j0,k0,i1,j1,k1,ch){
      for(let k=k0;k<=k1;k++) for(let j=j0;j<=j1;j++) for(let i=i0;i<=i1;i++) this.set(i,j,k,ch);
    },
    toModel(){ return { w, d, h, layers: cells.map(l=>l.map(r=>r.join(''))) }; },
  };
}
