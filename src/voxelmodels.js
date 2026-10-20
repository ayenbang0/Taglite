import { CLASSES, ISO_X, ISO_Z } from './config.js';
import { shade, mix, rotateModel, cached, makeGrid, hash3 } from './voxel.js';

/* Pixel-exact twin of voxel.js bakeModel (same 4x4 cube pattern, shades, 1px
   #05060c outline, anchor) written straight into a Uint32 buffer so the
   720-sprite first bake stays fast. Optional baked alpha. */
const rgbaCache = new Map();
function packHex(hex){
  let v = rgbaCache.get(hex);
  if(v === undefined){
    const h = hex.replace('#','');
    v = (0xff000000 | (parseInt(h.slice(4,6),16) << 16) | (parseInt(h.slice(2,4),16) << 8) | parseInt(h.slice(0,2),16)) >>> 0;
    rgbaCache.set(hex, v);
  }
  return v;
}
const OUTLINE_PX = packHex('#05060c');
function bakeModel(model, palette, opts = {}){
  const { w, d, h, layers } = model;
  const pad = opts.outline === false ? 0 : 1;
  const W = (w+d)*ISO_X + pad*2, H = h*ISO_Z + w + d + pad*2;
  const offX = d*ISO_X + pad, offY = h*ISO_Z + pad;
  const buf = new Uint32Array(W*H);
  const cols = {};
  for(let k=0;k<h;k++){
    const layer = layers[k];
    if(!layer) continue;
    for(let i=0;i<w;i++) for(let j=0;j<d;j++){
      const row = layer[j], ch = row ? row[i] : '.';
      if(!ch || ch==='.' || ch===' ') continue;
      let c = cols[ch];
      if(c === undefined){
        const base = palette[ch];
        c = cols[ch] = base ? [packHex(shade(base,1.2)), packHex(shade(base,.78)), packHex(shade(base,.58))] : null;
      }
      if(!c) continue;
      const x = (i-j-1)*ISO_X + offX, y = (i+j) - (k+1)*ISO_Z + offY, o = y*W + x;
      buf[o+1] = c[0]; buf[o+2] = c[0];
      buf[o+W] = c[0]; buf[o+W+1] = c[0]; buf[o+W+2] = c[0]; buf[o+W+3] = c[0];
      buf[o+2*W] = c[1]; buf[o+2*W+1] = c[1]; buf[o+2*W+2] = c[2]; buf[o+2*W+3] = c[2];
      buf[o+3*W] = c[1]; buf[o+3*W+1] = c[1]; buf[o+3*W+2] = c[2]; buf[o+3*W+3] = c[2];
    }
  }
  let out = buf;
  if(pad){
    out = buf.slice();
    for(let y=0;y<H;y++) for(let x=0;x<W;x++){
      const o = y*W + x;
      if(buf[o]) continue;
      if((x>0 && buf[o-1]) || (x<W-1 && buf[o+1]) || (y>0 && buf[o-W]) || (y<H-1 && buf[o+W])) out[o] = OUTLINE_PX;
    }
  }
  if(opts.alpha !== undefined && opts.alpha < 1){
    const a8 = Math.round(255*opts.alpha) << 24;
    for(let n=0;n<out.length;n++) if(out[n]) out[n] = ((out[n] & 0x00ffffff) | a8) >>> 0;
  }
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d');
  ctx.putImageData(new ImageData(new Uint8ClampedArray(out.buffer), W, H), 0, 0);
  return { canvas, ax: Math.round(w + d + pad), ay: Math.round((w+d)/2 + h*ISO_Z + pad) };
}

/* =========================================================================
   VOXEL MODELS: fighters (12 classes x 15 poses x 4 facings) + props.

   Fighter models are built procedurally on a 12x12x20 grid. The 6x6 body is
   centred on the grid centre (grid cell 3..8), so the baked anchor is the
   body's ground centre. Body-local coordinates used by the gear code:
     x = front(+)/back(-), 0..5 inside the body footprint
     y = 0..5 across (the two arm columns are y=0 and y=5)
     z = height, legs 0..3, torso 4..8, head 9..12 (before bob offsets)
   Facing 0 has the model front on world +x; rotateModel() turns it to +y,
   -x, -y for facing 1..3.
   ========================================================================= */

export const FIGHTER_FRAMES = ['idle0','idle1','idle2','idle3','runA','runB','runC','runD','dash','slide','stumble','cast','hit','air','frozen'];
export const PROP_FRAMES = { gem:1, crystal:4, pylon:4, cube:1, spikes:1, pad:2, iceblock:1, trap:1, mote:2, blade:4, guard:2, shade:4 };

const GW = 12, GD = 12, GH = 20, OFF = 3;

/* ---------- grid helpers in body-local coordinates ---------- */
function wrap(g){
  return {
    g,
    set(x,y,z,c){ g.set(x+OFF,y+OFF,z,c); },
    box(x0,y0,z0,x1,y1,z1,c){ g.box(x0+OFF,y0+OFF,z0,x1+OFF,y1+OFF,z1,c); },
    get(x,y,z){ return g.get(x+OFF,y+OFF,z); },
    ring(x0,y0,x1,y1,z,c){
      for(let x=x0;x<=x1;x++) for(let y=y0;y<=y1;y++){
        if(x===x0||x===x1||y===y0||y===y1) this.set(x,y,z,c);
      }
    },
  };
}

/* ---------- palettes ---------- */
function basePalette(P){
  return {
    P, S:shade(P,.7), L:shade(P,1.3), K:'#f1c9a0', E:'#ffffff', B:'#2a2f45', M:'#aab3c8', G:'#ffd23f',
    H:shade(P,.45), C:shade(P,.6), W:'#8a5a2b', X:'#7df9ff', R:'#e23b3b', N:shade(P,.4), Q:'#cfe9ff',
  };
}
const PAL_EXTRA = {
  rogue:P=>({ H:shade(P,.5), C:shade(P,.62), B:'#231f3a' }),
  tank:P=>({ H:'#5a3b1e', M:'#c3cad8', E:'#f4ecd8' }),
  scout:P=>({ W:'#7a5a3a', H:'#1f4d49' }),
  trickster:P=>({ N:shade(P,.42) }),
  trapper:P=>({ W:'#8a5a2b', H:'#5a3d22' }),
  hunter:P=>({ H:shade(P,.3), W:'#6d4a2a' }),
  phantom:P=>{
    const D = mix(P,'#2b3a78',.38);
    return { P:D, S:shade(D,.68), L:shade(D,1.35), K:mix(P,'#ffffff',.45), E:'#e9ffff', B:'#0a0f26', H:shade(D,.55), X:'#9ff4ff', M:mix(P,'#4a5a8a',.4), N:'#0a0f26' };
  },
  anchor:P=>({ N:'#1c2a55', E:'#f1f4ff', W:'#a58250', H:'#2b2a38', M:'#b8c2d8' }),
  brawler:P=>({ H:'#3a2418', K:'#e8b48a', B:'#201a26' }),
  warden:P=>({ H:shade(P,.45), W:'#7a5a3a' }),
  skater:P=>({ R:'#ff5470', N:'#243a66', H:'#3a2418' }),
  chrono:P=>({ H:'#2a3a26', X:shade(P,1.25), N:'#25351f', B:'#222c24' }),
};
function paletteFor(cls, color, frozen){
  const pal = Object.assign(basePalette(color), (PAL_EXTRA[cls]||(()=>({})))(color));
  if(frozen){
    for(const k of Object.keys(pal)) pal[k] = k==='E' ? '#f4fcff' : mix(pal[k],'#bfe8ff',.5);
  }
  return pal;
}

/* ---------- poses ---------- */
function ctxFor(name){
  const ii = FIGHTER_FRAMES.indexOf(name);
  const idle = ii>=0 && ii<4, run = ii>=4 && ii<8;
  const spd = idle ? 0 : run ? 1 : (name==='dash'||name==='slide') ? 2 : name==='air' ? 1 : 0;
  return { name, idle, run, ph: idle ? ii : run ? ii-4 : 0, spd };
}

function genPose(c){
  const p = { bob:0, lean:0, hdx:0, hdy:0, drop:0, legs:'stand', lL:[0,0], lR:[0,0], aL:['down',0], aR:['down',0], eyes:'open', mouth:false };
  switch(c.name){
    case 'idle0': case 'idle1': case 'idle2': case 'idle3': p.bob = c.ph & 1; break;
    case 'runA': p.lean=1; p.lL=[1,0]; p.lR=[-1,1]; p.aL=['down',-1]; p.aR=['down',1]; break;
    case 'runB': p.lean=1; p.bob=1; p.lR=[0,1]; break;
    case 'runC': p.lean=1; p.lR=[1,0]; p.lL=[-1,1]; p.aR=['down',-1]; p.aL=['down',1]; break;
    case 'runD': p.lean=1; p.bob=1; p.lL=[0,1]; break;
    case 'dash': p.lean=2; p.lL=[-1,1]; p.lR=[2,0]; p.aL=['down',-2]; p.aR=['down',-2]; break;
    case 'slide': p.legs='slide'; p.lean=-1; p.aL=['fling',0]; p.aR=['down',-2]; break;
    case 'stumble': p.drop=1; p.lean=1; p.hdy=1; p.aL=['fling',0]; p.aR=['fling',0]; p.lL=[2,1]; p.lR=[-1,0]; p.mouth=true; break;
    case 'cast': p.bob=1; p.aL=['up',0]; p.aR=['up',0]; p.lL=[1,0]; p.lR=[-1,0]; break;
    case 'hit': p.lean=-1; p.hdx=-1; p.aL=['fling',0]; p.aR=['down',-2]; p.lL=[1,0]; p.lR=[1,0]; p.eyes='shut'; p.mouth=true; break;
    case 'air': p.bob=1; p.lean=1; p.aL=['up',0]; p.aR=['up',0]; p.lL=[1,2]; p.lR=[1,2]; break;
    case 'frozen': p.aL=['fling',0]; p.aR=['fling',0]; p.lL=[1,0]; p.lR=[-1,0]; break;
  }
  return p;
}

/* ---------- shared body ---------- */
const defTorso = (x,y,z,a) => z===a.tz ? 'S' : (z===a.tz+3 && x===a.fr && y>1 && y<4 ? 'L' : 'P');

function drawLeg(W, y0, lx, lz, tz, key, boot){
  lz = Math.min(lz, tz-1);
  const x0 = 2+lx;
  for(let z=lz; z<=tz-1; z++) W.box(x0,y0,z,x0+1,y0+1,z, z===lz ? boot : key);
}

function drawArm(W, a, side, mode, s, key, handKey){
  const y = side ? 5 : 0, tz = a.tz, ax = 2 + a.L + s;
  let hand;
  if(mode==='up'){
    W.box(ax,y,tz+3,ax+1,y,tz+5,key); W.box(ax,y,tz+6,ax+1,y,tz+6,handKey);
    hand = { x:ax, y, z:tz+6 };
  } else if(mode==='fwd'){
    W.box(ax,y,tz+2,ax+1,y,tz+3,key); W.box(ax+2,y,tz+3,ax+3,y,tz+3,handKey);
    hand = { x:ax+2, y, z:tz+3 };
  } else if(mode==='fling'){
    const yo = side ? 6 : -1;
    W.box(ax,y,tz+2,ax+1,y,tz+3,key); W.box(ax,yo,tz+4,ax+1,yo,tz+4,handKey);
    hand = { x:ax, y:yo, z:tz+4 };
  } else {
    W.box(ax,y,tz+2,ax+1,y,tz+3,key); W.box(ax,y,tz+1,ax+1,y,tz+1,handKey);
    hand = { x:ax, y, z:tz+1 };
  }
  hand.side = side;
  return hand;
}

/** The shared fighter body: legs, torso, arms, head. Gear is applied by the caller via o.gear. */
function buildBody(pose, o, c){
  const g = makeGrid(GW, GD, GH), W = wrap(g);
  const slide = pose.legs === 'slide';
  const tz = slide ? 2 : 4 + pose.bob - pose.drop;
  const L = pose.lean, hx = L + pose.hdx, hy = pose.hdy;
  const a = {
    tz, hz: tz+5, L, hx, hy,
    bk: o.slim ? 2+L : 1+L, fr: o.slim ? 3+L : 4+L,
    hbk: 1+hx, hfr: 4+hx, y0: 1+hy, y1: 4+hy, hands: [null,null],
  };
  const legKey = o.legKey || 'S', boot = o.bootKey || 'B', armKey = o.armKey || 'S', hair = o.hairKey || 'H';
  // legs
  if(!o.noLegs){
    if(slide){
      W.box(3,1,0,5,2,1,legKey); W.box(6,1,0,6,2,1,boot);   // extended leg
      W.box(1,3,0,2,4,1,legKey); W.box(0,3,0,0,4,0,boot);   // folded leg
    } else {
      drawLeg(W, 1, pose.lL[0], pose.lL[1], tz, legKey, boot);
      drawLeg(W, 3, pose.lR[0], pose.lR[1], tz, legKey, boot);
    }
  }
  // torso
  const tk = o.torsoKey || defTorso;
  for(let z=tz; z<=tz+4; z++) for(let x=a.bk; x<=a.fr; x++) for(let y=1; y<=4; y++) W.set(x,y,z,tk(x,y,z,a));
  // arms
  a.hands[0] = drawArm(W, a, 0, pose.aL[0], pose.aL[1], armKey, 'K');
  a.hands[1] = drawArm(W, a, 1, pose.aR[0], pose.aR[1], armKey, 'K');
  // head
  W.box(a.hbk, a.y0, a.hz, a.hfr, a.y1, a.hz+3, 'K');
  W.box(a.hbk, a.y0, a.hz+3, a.hfr, a.y1, a.hz+3, hair);
  a.eyes = () => {
    const k = pose.eyes==='shut' ? 'B' : (o.eyeKey || 'E');
    W.set(a.hfr, a.y0+1, a.hz+2, k); W.set(a.hfr, a.y0+2, a.hz+2, k);
    if(pose.mouth) W.box(a.hfr, a.y0+1, a.hz, a.hfr, a.y0+2, a.hz, 'B');
  };
  const r = o.gear ? o.gear(W, a, c) : null;
  if(r !== 'noEyes') a.eyes();
  return g.toModel();
}

/* ---------- reusable gear pieces ---------- */
function hood(W, a, key){
  const { hz, hbk, hfr, y0, y1 } = a;
  for(let z=hz; z<=hz+3; z++) for(let x=hbk; x<=hfr; x++) for(let y=y0; y<=y1; y++){
    if(z===hz+3 || x===hbk || y===y0 || y===y1) W.set(x,y,z,key);
  }
}
function cape(W, a, key, out, o = {}){
  const top = o.top ?? a.tz+4, y0 = o.y0 ?? 1, y1 = o.y1 ?? 4;
  out.forEach((d, r) => {
    const z = top - r, sw = o.sway ? (o.sway[r]||0) : 0;
    const k = (o.hem && r===out.length-1) ? o.hem : key;
    for(let x=a.bk-d; x<=a.bk-1; x++) W.box(x, y0+sw, z, x, y1+sw, z, k);
  });
}
function glove(W, h, key, cuff){
  const ys = h.side===0 ? [h.y-1, h.y] : [h.y, h.y+1];
  W.box(h.x, ys[0], h.z, h.x+1, ys[1], h.z+1, key);
  if(cuff) W.box(h.x, ys[0], h.z-1, h.x+1, ys[1], h.z-1, cuff);
}

/* ---------- per-class art ---------- */
const ART = {};

ART.rogue = {
  gear(W, a, c){
    const { tz, hz } = a;
    hood(W, a, 'H');
    W.box(a.hfr, a.y0+1, hz, a.hfr, a.y1-1, hz+1, 'B');           // shadowed lower face
    W.box(a.hbk+1, a.y0+1, hz+4, a.hbk+2, a.y1-1, hz+4, 'H');       // hood peak
    const lift = c.idle && (c.ph===1 || c.ph===2) ? 1 : 0;
    W.set(a.hbk-1, a.y0+1, hz+3, 'H'); W.set(a.hbk-1, a.y1-1, hz+3, 'H');
    W.set(a.hbk-2, a.y0+1+(c.ph&1), hz+3+lift, 'H');                 // fluttering hood tail
    const out = c.spd===2 ? [1,2,3,3] : c.spd===1 ? ((c.ph&1) ? [1,2,2,3] : [1,1,2,2])
      : [[1,1,1,1],[1,1,1,2],[1,1,2,2],[1,1,1,2]][c.ph];
    cape(W, a, 'C', out, { hem:'P' });
    W.set(a.fr, 2, tz, 'G'); W.set(a.fr, 3, tz, 'G');                // belt buckle
    W.box(a.fr-1, 0, tz-0, a.fr, 0, tz, 'M');                        // dagger at hip
    W.set(a.fr+1, 0, tz, 'E');
  },
};

ART.tank = {
  opts: { armKey:'S' },
  pose(p, c){
    if(!c.idle) return;
    if(c.ph===2){ p.aL=['fling',0]; p.aR=['fling',0]; }
    if(c.ph===3){ p.aR=['fling',0]; }
  },
  gear(W, a, c){
    const { tz, hz, bk, fr } = a, up = c.idle && (c.ph&1) ? 1 : 0;
    W.box(bk, -1, tz+3+up, fr, 0, tz+4+up, 'M'); W.box(bk, 5, tz+3+up, fr, 6, tz+4+up, 'M');   // 8-wide shoulders
    W.set(fr, -1, tz+4+up, 'P'); W.set(fr, 6, tz+4+up, 'P'); W.set(bk, -1, tz+4+up, 'P'); W.set(bk, 6, tz+4+up, 'P');
    W.box(fr, 2, tz+1, fr, 3, tz+3, 'M');                                                        // chest plate
    W.box(bk, 1, tz, fr, 4, tz, 'G');
    // helm
    W.box(a.hbk, a.y0, hz+1, a.hfr, a.y1, hz+3, 'M');
    W.box(a.hfr, a.y0, hz+2, a.hfr, a.y1, hz+2, 'B');
    W.box(a.hbk+1, a.y0+1, hz+4, a.hfr, a.y1-1, hz+4, 'P');                                      // crest
    for(const yy of [a.y0-1, a.y1+1]) W.box(a.hbk+1, yy, hz+2, a.hbk+2, yy, hz+4, 'E');         // horns
    W.box(a.hbk+1, a.y0, hz+4, a.hbk+2, a.y0, hz+4, 'E'); W.box(a.hbk+1, a.y1, hz+4, a.hbk+2, a.y1, hz+4, 'E');
  },
};

ART.scout = {
  opts: { slim:true, bootKey:'P', legKey:'N' },
  pose(p, c){ if(c.idle && (c.ph&1)) p.bob = 2; },
  gear(W, a, c){
    const { tz, hz } = a;
    const pb = c.idle && c.ph===3 ? 1 : 0;                                                       // loose pack bounce
    W.box(a.bk-2, 1, tz+1+pb, a.bk-1, 4, tz+3+pb, 'W'); W.box(a.bk-2, 1, tz+3+pb, a.bk-1, 4, tz+3+pb, 'P');  // small pack
    W.box(a.bk-2, 2, tz+4+pb, a.bk-1, 3, tz+4+pb, 'M');                                          // bedroll
    W.box(a.fr, 1, tz+2, a.fr, 1, tz+4, 'W'); W.box(a.fr, 4, tz+2, a.fr, 4, tz+4, 'W');          // straps
    W.ring(a.hbk, a.y0, a.hfr, a.y1, hz+2, 'B');                                                // goggle band
    const gl = c.idle && c.ph===2;
    W.box(a.hfr, a.y0+1, hz+2, a.hfr, a.y0+2, hz+2, 'X');
    W.box(a.hfr+1, a.y0+1, hz+2, a.hfr+1, a.y0+1, hz+3, gl ? 'E' : 'X'); W.box(a.hfr+1, a.y0+2, hz+2, a.hfr+1, a.y0+2, hz+3, gl ? 'X' : 'E');
    W.box(a.hbk+1, a.y0+1, hz+4, a.hbk+2, a.y0+2, hz+4, 'H');                                   // hair tuft
    return 'noEyes';
  },
};

ART.trickster = {
  opts: { legKey:'N', bootKey:'G', hairKey:'N', torsoKey:(x,y,z,a) => z===a.tz+4 ? 'E' : (((x+y+z)&1) ? 'P' : 'N') },
  pose(p, c){
    if(c.idle && c.ph===1) p.aL=['fling',0];
    if(c.idle && c.ph===3) p.aR=['fling',0];
  },
  gear(W, a, c){
    const { hz } = a, xm = a.hbk+1, wag = [0,1,0,-1][c.ph];
    for(const [yy, dir] of [[a.y0,-1],[a.y1,1]]){
      W.box(xm, yy, hz+3, xm+1, yy, hz+5, 'P');
      W.box(xm, yy+dir, hz+5, xm+1, yy+dir, hz+6, 'P');
      W.box(xm, yy+dir*(1+(wag>0?1:0)), hz+7, xm+1, yy+dir*(1+(wag>0?1:0)), hz+7, 'G');          // wiggling bell tips
    }
    const mk = ['E','E','P','E'][c.ph];
    W.box(a.hfr, a.y0, hz+1, a.hfr, a.y1, hz+2, mk);                                            // mask
    W.set(a.hfr, a.y0+1, hz+2, 'B'); W.set(a.hfr, a.y0+2, hz+2, 'B');
    W.set(a.hfr, a.y0, hz, 'B'); W.set(a.hfr, a.y1, hz, 'B');
    W.set(a.hfr+1, a.y0+1, hz+1, 'G'); W.set(a.hfr+1, a.y0+2, hz+1, 'G');
    return 'noEyes';
  },
};

ART.trapper = {
  opts: { hairKey:'H' },
  gear(W, a, c){
    const { tz, hz } = a, tip = c.idle && c.ph===2 ? 1 : 0;
    W.box(a.hbk-1, a.y0-1, hz+3+tip, a.hfr+1, a.y1+1, hz+3+tip, 'W');                           // 6x6 brim
    W.ring(a.hbk, a.y0, a.hfr, a.y1, hz+4+tip, 'G');                                            // band
    W.box(a.hbk+1, a.y0+1, hz+4+tip, a.hfr-1, a.y1-1, hz+4+tip, 'W');
    W.box(a.hbk, a.y0, hz+5+tip, a.hfr, a.y1, hz+5+tip, 'W');                                   // crown
    const sw = [0,1,0,-1][c.ph];
    W.box(a.bk-2, 2+sw, tz-1, a.bk-1, 4+sw, tz+1, 'W');                                         // satchel
    W.box(a.bk-2, 2+sw, tz+1, a.bk-1, 4+sw, tz+1, 'G');
    W.set(a.bk-2, 3+sw, tz-1, 'B');
    for(let k=0;k<4;k++) W.set(a.fr, 1+k, tz+4-k, 'B');                                         // strap
    W.set(a.fr, 1, tz+3, 'B');
  },
};

ART.hunter = {
  opts: { bootKey:'H' },
  pose(p, c){ if(c.idle && c.ph===2) p.hdy = 1; },
  gear(W, a, c){
    const { tz, hz } = a, cu = c.idle && (c.ph===1 || c.ph===2) ? 1 : 0;
    hood(W, a, 'H');
    W.box(a.hfr+1, a.y0+1, hz+3, a.hfr+1, a.y1-1, hz+3, 'H');                                   // peak overhang
    W.box(a.hbk+1, a.y0+1, hz+4, a.hfr-1, a.y1-1, hz+4, 'H');
    W.box(a.bk, 0, tz+4, a.fr, 5, tz+4, 'H');                                                   // mantle
    for(let k=0;k<4;k++) W.set(a.fr, 1+k, tz+4-k, 'G');                                         // bandolier
    // crossbow on the back
    const x = a.bk-1;
    W.box(x, 2, tz-1+cu, x, 3, tz+4+cu, 'W');
    W.box(x, 0, tz+3+cu, x, 5, tz+3+cu, 'M');
    W.set(x, 0, tz+4+cu, 'E'); W.set(x, 5, tz+4+cu, 'E');
    W.set(x-1, 2, tz+4+cu, 'E');                                                                // bolt tip
  },
};

ART.phantom = {
  opts: { noLegs:true, eyeKey:'X', hairKey:'H' },
  alpha(c){ return c.idle && c.ph===2 ? 0.6 : 0.88; },
  gear(W, a, c){
    const { tz, hz } = a;
    hood(W, a, 'P');
    W.box(a.hfr, a.y0+1, hz, a.hfr, a.y1-1, hz+2, 'B');                                         // void face
    W.box(a.hbk+1, a.y0+1, hz+4, a.hbk+2, a.y1-1, hz+4, 'P'); W.set(a.hbk+1, a.y0+1+(c.ph&1), hz+5, 'P'); // pointed hood
    W.set(a.hbk-1, a.y0+1, hz+3, 'P'); W.set(a.hbk-2, a.y0+1+(c.ph&1), hz+3+(c.idle&&c.ph===1?1:0), 'P');
    const s1 = c.spd ? -1 : 0, w = c.idle ? [0,-1,0,1][c.ph] : 0;
    W.box(a.bk-1, 0, tz-1, a.fr+1, 5, tz-1, 'S');                                               // flared robe skirt
    W.box(a.bk+s1, 1, tz-2, a.fr+s1, 4, tz-2, 'S');
    W.box(2+a.L+2*s1+w, 2, tz-3, 3+a.L+2*s1+w, 3, tz-3, 'S');                                  // 2-voxel taper
    W.set(2+a.L+3*s1+2*w, 2+(c.ph&1), tz-4, 'X');                                               // wisp tip
    const wp = [[a.bk-1,-1,tz+2],[a.fr+1,-1,tz+3],[a.fr+1,6,tz+2],[a.bk-1,6,tz+3]][c.ph];
    W.set(wp[0], wp[1], wp[2], 'X');
  },
};

ART.anchor = {
  opts: { armKey:'S', hairKey:'H' },
  pose(p, c){ if(c.idle) p.lean = [0,-1,0,1][c.ph]; },
  gear(W, a, c){
    const { tz, hz, bk, fr } = a;
    W.box(bk, -1, tz+3, fr, 0, tz+4, 'S'); W.box(bk, 5, tz+3, fr, 6, tz+4, 'S');                // broad shoulders
    W.box(bk, -1, tz+4, fr, 0, tz+4, 'M'); W.box(bk, 5, tz+4, fr, 6, tz+4, 'M');
    for(let k=0;k<4;k++) W.set(fr, 1+k, tz+4-k, 'M');                                           // chain
    W.box(bk, 1, tz, fr, 4, tz, 'W');                                                           // rope belt
    // sailor cap
    W.box(a.hbk, a.y0, hz+3, a.hfr, a.y1, hz+3, 'E'); W.ring(a.hbk, a.y0, a.hfr, a.y1, hz+3, 'N');
    W.box(a.hbk, a.y0, hz+4, a.hfr, a.y1, hz+4, 'E'); W.set(a.hfr+1, a.y0+1, hz+3, 'N'); W.set(a.hfr+1, a.y0+2, hz+3, 'N');
    // anchor on the back
    const x = bk-1 - (c.idle && c.ph===2 ? 1 : 0), ys = c.idle ? [0,-1,0,1][c.ph] : 0;
    W.box(x, 2+ys, tz-1, x, 3+ys, tz+5, 'M');                                                  // shaft
    W.box(x, 0+ys, tz+4, x, 5+ys, tz+4, 'M');                                                  // stock
    W.box(x, 2+ys, tz+6, x, 3+ys, tz+7, 'M'); W.set(x, 2+ys, tz+7, 'E'); W.set(x, 3+ys, tz+7, 'E');  // ring
    W.box(x, 0+ys, tz-1, x, 5+ys, tz-1, 'M');                                                  // flukes
    W.box(x, 0+ys, tz, x, 1+ys, tz, 'M'); W.box(x, 4+ys, tz, x, 5+ys, tz, 'M');
    W.box(x, 0+ys, tz+1, x, 0+ys, tz+1, 'E'); W.box(x, 5+ys, tz+1, x, 5+ys, tz+1, 'E');
    W.set(x, 2+ys, tz+2, 'W'); W.set(x, 3+ys, tz+2, 'W'); W.set(x, 2+ys, tz+3, 'W'); W.set(x, 3+ys, tz+3, 'W');
  },
};

ART.brawler = {
  opts: { armKey:'K', legKey:'P', bootKey:'B', torsoKey:(x,y,z,a) => z===a.tz ? 'G' : 'K' },
  pose(p, c){
    if(!c.idle) return;
    if(c.ph===1) p.aL=['fwd',0];
    if(c.ph===2){ p.aL=['fwd',0]; p.aR=['fwd',0]; }
    if(c.ph===3) p.aR=['fwd',0];
  },
  gear(W, a, c){
    const { tz, hz } = a;
    for(const h of a.hands) glove(W, h, 'P', 'E');                                              // oversized fists
    W.ring(a.hbk, a.y0, a.hfr, a.y1, hz+3, 'E');                                                // headband
    W.box(a.hbk+1, a.y0+1, hz+4, a.hfr-1, a.y1-1, hz+4, 'H');
    const fl = c.idle ? [0,1,0,-1][c.ph] : (c.spd ? 1 : 0);
    W.set(a.hbk-1, a.y0+1, hz+3, 'E'); W.set(a.hbk-2, a.y0+1, hz+2+Math.min(fl,0), 'E'); W.set(a.hbk-2, a.y0+2, hz+1+Math.min(fl,0), 'E');
    W.set(a.fr, 2, tz+3, 'S'); W.set(a.fr, 3, tz+3, 'S');                                       // pecs
    W.set(a.hfr, a.y0, hz+3, 'B'); W.set(a.hfr, a.y1, hz+3, 'B');
  },
};

ART.warden = {
  gear(W, a, c){
    const { tz, hz } = a;
    W.box(a.hbk, a.y0, hz+1, a.hfr, a.y1, hz+3, 'M');                                           // helm
    W.box(a.hfr, a.y0+1, hz, a.hfr, a.y1-1, hz+1, 'K');
    W.box(a.hfr, a.y0+1, hz+2, a.hfr, a.y1-1, hz+2, 'E');
    W.set(a.hfr, a.y0, hz+2, 'B'); W.set(a.hfr, a.y1, hz+2, 'B');
    const ru = c.idle ? [0,1,0,1][c.ph] : 0;                                                    // crest rustle
    W.box(a.hbk, a.y0+1, hz+4, a.hfr, a.y0+2, hz+5, 'G');
    W.box(a.hbk-1, a.y0+1, hz+4-ru, a.hbk-1, a.y0+2, hz+5-ru, 'P');
    W.box(a.bk, 1, tz+1, a.fr, 4, tz+3, 'P'); W.box(a.fr, 2, tz+1, a.fr, 3, tz+3, 'M');         // tabard + plate
    W.box(a.bk, 1, tz, a.fr, 4, tz, 'W');
    // shield slab on the left arm (1x3x4)
    const sx = 2 + a.L;
    W.box(sx, 6, tz, sx+2, 6, tz+3, 'M');
    W.box(sx+1, 6, tz+1, sx+1, 6, tz+2, 'P');
    W.set(sx+1, 6, tz+1, 'G'); W.set(sx+1, 7, tz+1, 'G');
    const gl = [[0,3],[1,2],[2,1],[2,2]][c.idle ? c.ph : 0];
    W.set(sx+gl[0], 7, tz+gl[1], 'E');
    W.box(sx, 6, tz+3, sx+2, 6, tz+3, 'G');
  },
};

ART.skater = {
  opts: { legKey:'N', bootKey:'E', hairKey:'H' },
  pose(p, c){ if(c.idle){ p.lL=[1,0]; p.lR=[-1,0]; if(c.ph===2){ p.lean=1; } } },
  gear(W, a, c){
    const { tz, hz } = a;
    W.ring(a.bk, 1, a.fr, 4, tz+4, 'R');                                                        // scarf wrap
    const n = c.spd===2 ? 4 : c.spd===1 ? 3 : 2;
    for(let i=0;i<n;i++){
      const wz = [0,1,0,-1][(c.ph*(c.spd?2:1)+i)&3];
      const yy = (c.idle && c.ph===2 && i===1) ? 1 : 0;
      W.box(a.bk-1-i, 2+yy, tz+4+wz, a.bk-1-i, 3+yy, tz+4+wz, 'R');                             // trailing scarf
    }
    // beanie
    W.box(a.hbk, a.y0, hz+3, a.hfr, a.y1, hz+3, 'R'); W.ring(a.hbk, a.y0, a.hfr, a.y1, hz+3, 'E');
    W.box(a.hbk, a.y0, hz+4, a.hfr, a.y1, hz+4, 'P');
    W.box(a.hbk+1, a.y0+1, hz+5, a.hfr-1, a.y1-1, hz+5, 'P');
    const fl = c.idle ? [0,-1,0,1][c.ph] : (c.spd ? -1 : 0);
    W.set(a.hbk+1+fl, a.y0+1, hz+6, 'E');                                                       // pompom
    W.set(a.fr, 1, tz+2, 'R'); W.set(a.fr, 4, tz+2, 'R');
  },
};

ART.chrono = {
  opts: { legKey:'N', bootKey:'G', hairKey:'H' },
  gear(W, a, c){
    const { tz, hz } = a, ph = c.ph;
    // hourglass pack (2x4x4 on the back): gold frame, glass chambers, glowing sand
    const x0 = a.bk-2, cells = [[0,2],[1,2],[0,3],[1,3]];
    const lower = [[0,1,2,3],[0,1],[],[2,3]][ph], upper = [[],[0,1],[0,1,2,3],[2,3]][ph];
    W.box(x0, 1, tz, x0+1, 4, tz, 'G'); W.box(x0, 1, tz+3, x0+1, 4, tz+3, 'G');
    W.box(x0, 1, tz+1, x0+1, 1, tz+2, 'G'); W.box(x0, 4, tz+1, x0+1, 4, tz+2, 'G');
    cells.forEach(([dx,y],i)=>{
      W.set(x0+dx, y, tz+1, lower.includes(i) ? 'X' : 'Q');
      W.set(x0+dx, y, tz+2, upper.includes(i) ? 'X' : 'Q');
    });
    W.box(x0, 2, tz+4, x0+1, 3, tz+4, 'M');
    // chest clock
    W.box(a.fr, 2, tz+2, a.fr, 3, tz+3, 'G');
    const tk = [[2,tz+3],[3,tz+3],[3,tz+2],[2,tz+2]][ph]; W.set(a.fr, tk[0], tk[1], 'E');
    W.box(a.bk, 1, tz+4, a.fr, 4, tz+4, 'S');                                                   // high collar
    // wrap-around visor
    const glow = (c.idle && (ph&1)) ? 'E' : 'X';
    W.box(a.hfr, a.y0, a.hz+1, a.hfr, a.y1, a.hz+2, 'B');
    W.box(a.hfr, a.y0, a.hz+2, a.hfr, a.y1, a.hz+2, glow);
    W.box(a.hfr-1, a.y0, a.hz+2, a.hfr-1, a.y0, a.hz+2, 'X'); W.box(a.hfr-1, a.y1, a.hz+2, a.hfr-1, a.y1, a.hz+2, 'X');
    W.box(a.hfr+1, a.y0+1, a.hz+2, a.hfr+1, a.y1-1, a.hz+2, glow);
    // swept hair
    W.box(a.hbk-1, a.y0+1, hz+2, a.hbk-1, a.y1-1, hz+3, 'H');
    W.set(a.hbk+1, a.y0+1, hz+4, 'H'); W.set(a.hbk, a.y1-1, hz+4, 'H');
    return 'noEyes';
  },
};

/* ---------- fighter bake ---------- */
function fighterModel(cls, name){
  return cached(`fm|${cls}|${name}`, () => {
    const art = ART[cls] || ART.rogue, c = ctxFor(name), p = genPose(c);
    if(art.pose) art.pose(p, c);
    return buildBody(p, { ...(art.opts||{}), gear: art.gear }, c);
  });
}

function frameName(frame){
  if(typeof frame === 'number') return FIGHTER_FRAMES[((frame % 15) + 15) % 15];
  return FIGHTER_FRAMES.includes(frame) ? frame : 'idle0';
}

export function getFighterSprite(clsKey, facingIdx, frame, color){
  const cls = ART[clsKey] ? clsKey : 'rogue';
  const name = frameName(frame);
  const col = color || (CLASSES[cls] && CLASSES[cls].color) || '#9b6bff';
  const f = ((facingIdx|0) % 4 + 4) % 4;
  return cached(`fs|${cls}|${f}|${name}|${col}`, () => {
    const model = rotateModel(fighterModel(cls, name), f);
    const art = ART[cls];
    return bakeModel(model, paletteFor(cls, col, name==='frozen'), { outline:true, alpha: art.alpha ? art.alpha(ctxFor(name)) : undefined });
  });
}

export function previewSprite(clsKey, facingIdx, frame){
  return getFighterSprite(clsKey, facingIdx, frame || 'idle0');
}

/* =========================================================================
   PROPS
   ========================================================================= */
const PROP_COLOR = {
  gem:'#3fe0c5', crystal:'#9b6bff', pylon:'#c7f464', cube:'#ffd23f', spikes:'#ff5470', pad:'#ffd23f',
  iceblock:'#bfe8ff', trap:'#ff5470', mote:'#9b6bff', blade:'#e9ecf4', guard:'#7fb069', shade:'#b9a8ff',
};

function propPalette(P){
  return { P, S:shade(P,.7), L:shade(P,1.3), E:'#ffffff', B:'#2a2f45', M:'#aab3c8', G:'#ffd23f', X:mix(P,'#ffffff',.55), W:'#8a5a2b' };
}

const BUILDERS = {
  gem(){
    const g = makeGrid(3,3,3);
    g.set(1,1,0,'S'); g.box(0,1,1,2,1,1,'P'); g.box(1,0,1,1,2,1,'P'); g.set(1,1,2,'L');
    return { m:g.toModel() };
  },
  crystal(f){
    const g = makeGrid(5,5,7);
    const noCorner = (z) => { for(let i=0;i<5;i++) for(let j=0;j<5;j++){
      if((i===0||i===4)&&(j===0||j===4)) continue; g.set(i,j,z,'P'); } };
    g.set(2,2,0,'S'); g.box(1,1,1,3,3,1,'P'); noCorner(2); noCorner(3); g.box(1,1,4,3,3,4,'P');
    g.box(2,1,5,2,3,5,'P'); g.box(1,2,5,3,2,5,'P'); g.set(2,2,6, f&1 ? 'E' : 'L');
    const sh = [[4,1,2],[4,2,3],[2,4,3],[1,4,2]][f]; g.set(sh[0], sh[1], sh[2], 'E');
    g.set(2,2,3,'X');
    return { m:g.toModel() };
  },
  pylon(f){
    const g = makeGrid(5,5,11);
    g.box(0,0,0,4,4,0,'B'); g.box(1,1,1,3,3,1,'M'); g.set(2,2,2,'M'); g.set(2,2,3,'M'); g.set(2,2,4,'M'); g.set(2,2,5,'M');
    const rz = 2 + f;
    for(let i=1;i<=3;i++) for(let j=1;j<=3;j++) if(i!==2||j!==2) g.set(i,j,rz,'P');
    g.set(2,2,6,'S');
    g.box(1,2,7,3,2,7,'P'); g.box(2,1,7,2,3,7,'P');                                          // beacon orb
    g.box(1,2,8,3,2,8,'P'); g.box(2,1,8,2,3,8,'P'); g.set(2,2,8, f&1 ? 'E' : 'L');
    g.set(2,2,9,'P'); g.set(2,2,10,'L');
    return { m:g.toModel() };
  },
  cube(){
    const g = makeGrid(2,2,2); g.box(0,0,0,1,1,1,'P');
    return { m:g.toModel() };
  },
  spikes(){
    const g = makeGrid(5,5,3);
    for(let i=0;i<5;i++) for(let j=0;j<5;j++) if(!((i===0||i===4)&&(j===0||j===4))) g.set(i,j,0,'B');
    for(const [i,j] of [[1,1],[3,1],[2,3]]){ g.set(i,j,1,'M'); g.set(i,j,2,'P'); }
    return { m:g.toModel() };
  },
  pad(f){
    const g = makeGrid(5,5,3);
    g.box(0,0,0,4,4,0,'B');
    if(f===0){ g.box(0,0,1,4,4,1,'P'); g.box(1,2,1,3,2,1,'E'); g.set(2,1,1,'E'); g.set(2,3,1,'E'); }
    else { g.box(1,1,1,3,3,1,'M'); g.box(0,0,2,4,4,2,'P'); g.box(1,2,2,3,2,2,'E'); g.set(2,1,2,'E'); g.set(2,3,2,'E'); }
    return { m:g.toModel() };
  },
  iceblock(){
    const g = makeGrid(8,8,14);
    for(let k=0;k<14;k++) for(let j=0;j<8;j++) for(let i=0;i<8;i++){
      const ex = (i===0||i===7), ey = (j===0||j===7), ez = (k===0||k===13);
      if(!(ex||ey||ez)) continue;
      const edges = (ex?1:0)+(ey?1:0)+(ez?1:0);
      g.set(i,j,k, edges>=2 || hash3(i,j,k)<0.07 ? 'E' : 'P');
    }
    return { m:g.toModel(), outline:false, alpha:0.5 };
  },
  trap(f){
    const g = makeGrid(5,5,3);
    for(let i=0;i<5;i++) for(let j=0;j<5;j++) if(!((i===0||i===4)&&(j===0||j===4))) g.set(i,j,0,'B');
    g.box(1,1,1,3,3,1,'M'); g.set(2,2,2,'P'); g.set(1,2,1,'S'); g.set(3,2,1,'S');
    return { m:g.toModel() };
  },
  mote(f){
    const g = makeGrid(2,2,2); g.box(0,0,0,1,1,1,'P');
    if(f===0) g.set(1,1,1,'E'); else { g.set(1,0,1,'E'); g.set(0,1,1,'E'); }
    return { m:g.toModel() };
  },
  blade(f){
    const g = makeGrid(3,3,2);
    const lines = [[[0,1],[1,1],[2,1]],[[0,0],[1,1],[2,2]],[[1,0],[1,1],[1,2]],[[2,0],[1,1],[0,2]]][f];
    lines.forEach(([i,j],n) => { g.set(i,j,0,'M'); });
    g.set(lines[2][0], lines[2][1], 1, 'E'); g.set(1,1,1,'G');
    return { m:g.toModel() };
  },
  guard(f){
    const g = makeGrid(3,2,5);
    g.box(1,0,0,1,1,0,'M');
    for(let k=1;k<=4;k++) g.box(0,0,k,2,1,k,'M');
    g.box(1,0,1,1,1,3,'P');
    g.set(1,0,2,'G'); g.set(1,1,2,'G');
    const gl = [[0,4],[2,3]][f]; g.set(gl[0], 0, gl[1], 'E'); g.set(gl[0], 1, gl[1], 'E');
    return { m:g.toModel() };
  },
  shade(f){
    const g = makeGrid(4,4,7);
    const zb = (f===1||f===3) ? 2 : 1;
    for(let i=0;i<4;i++) for(let j=0;j<4;j++) if(((i+j+f)&1)===0) g.set(i,j,zb,'S');          // flickering ragged hem
    g.set(1+(f>>1), 1+(f&1), zb-1, 'S');                                                      // trailing wisp
    const body = (z, key) => { for(let i=0;i<4;i++) for(let j=0;j<4;j++){ if((i===0||i===3)&&(j===0||j===3)) continue; g.set(i,j,z,key); } };
    body(zb+1,'P'); g.box(0,0,zb+2,3,3,zb+2,'P'); body(zb+3,'L');
    g.set(3,1,zb+2,'B'); g.set(3,2,zb+2,'B'); g.set(3,1,zb+3,'B'); g.set(3,2,zb+3,'B'); g.set(3,1,zb+1,'B'); g.set(3,2,zb+1,'B');
    g.set(0,0,zb+2,'S'); g.set(3,3,zb+2,'S');
    return { m:g.toModel() };
  },
};

export function getPropSprite(kind, opts = {}){
  const b = BUILDERS[kind] || BUILDERS.cube;
  const k = BUILDERS[kind] ? kind : 'cube';
  const n = PROP_FRAMES[k] || 1;
  const frame = ((((opts.frame || 0) | 0) % n) + n) % n;
  const color = opts.color || PROP_COLOR[k];
  return cached(`ps|${k}|${color}|${frame}`, () => {
    const built = b(frame);
    let pal = propPalette(color);
    if(k === 'iceblock') pal = { P:'#a9dcf5', E:'#f4fcff', B:'#a9dcf5' };
    const r = bakeModel(built.m, pal, { outline: built.outline !== false, alpha: built.alpha });
    return r;
  });
}
