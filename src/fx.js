/* =========================================================================
   VOXEL FX
   Every effect in the game that is not a baked sprite lives here: ability and
   class-ability casts, event bursts (tag / stumble / bump / ...), and the
   persistent PASSIVE / STATUS auras drawn around each fighter.

   Everything is made of small shaded cubes (4x4 px) / mini cubes (2x2 px) /
   1px pixels plus crisp ground rings, never anti-aliased shapes.

   Data model (all private to this file, nothing is added to `state`):
     particles  fixed pool of PCAP cubes, ring-buffer reuse = "drop oldest"
     ground     rings, runes, discs, scorch cracks, cones, ropes (floor layer)
     air        beams and light pillars (air layer)
     timers     delayed callbacks + short emitters (spirals, fuses, rewinds)
   All positions are world x,y plus z in voxels; screen position always comes
   from the iso projection (state.camera is the world point at screen centre).
   ========================================================================= */
import { IW, IH, ISO_X, ISO_Y, ISO_Z, RADIUS, ROUND_TIME } from './config.js';
import { state } from './state.js';
import { groundRing, groundDisc, groundArc, pixelLine } from './iso.js';
import { shade, drawCubePx, hash3 } from './voxel.js';

const PCAP = 600;      // live particle cap
const GCAP = 140;      // live ground items
const ACAP = 56;       // live beams / pillars
const TCAP = 96;       // live timers
const TAU = Math.PI * 2;
const EMPTY = [];

/* ------------------------------ palette ------------------------------ */
const K = {
  white:'#ffffff', gold:'#ffd23f', teal:'#3fe0c5', red:'#ff5470', purple:'#9b6bff',
  blue:'#4aa3ff', orange:'#ff9f45', pink:'#ff5ec4', lime:'#c7f464', ice:'#a9d8ee',
  ice2:'#8fd6ff', dust:'#8b93b8', brown:'#a8742a', stone:'#7b83a1', dark:'#2a2f45',
  olive:'#a8a23f', green:'#7fb069', snow:'#dff6ff', fire:'#ff6a2b', silver:'#e9ecf4',
  tan:'#d9c7a0', violet:'#c9b0ff',
};
const CAT_COL = {
  movement:K.teal, zone:K.lime, taginteraction:K.red, physics:K.purple,
  buff:K.gold, defense:K.blue, utility:K.orange,
};

/* ------------------------------ tiny math ------------------------------ */
const rnd = (a, b) => a + Math.random()*(b-a);
const pick = c => Array.isArray(c) ? c[(Math.random()*c.length)|0] : c;
const fract = x => x - Math.floor(x);
const sin = Math.sin, cos = Math.cos;
function unit(x, y){ const l = Math.hypot(x, y) || 1; return { x:x/l, y:y/l }; }

/* ------------------------------ cube sprites ------------------------------ */
// per colour: 4 "big" tumble frames (cube, flat, cube with faces swapped, flat),
// 2 mini frames (2x2) and a single pixel colour. Baked lazily, drawn with drawImage.
const spriteCache = new Map();
function mkCanvas(w, h){ const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }
function bakeSprites(color){
  const hi = shade(color, 1.2), lf = shade(color, 0.78), rt = shade(color, 0.58);
  const big = [];
  for(let f=0; f<4; f++){
    if(f % 2 === 0){
      const c = mkCanvas(4, 4);
      drawCubePx(c.getContext('2d'), 0, 0, hi, f === 0 ? lf : rt, f === 0 ? rt : lf);
      big.push({ c, ox:-2, oy:-2 });
    } else {
      const c = mkCanvas(4, 3), g = c.getContext('2d');
      g.fillStyle = hi; g.fillRect(1, 0, 2, 1); g.fillRect(0, 1, 4, 1);
      g.fillStyle = f === 1 ? lf : rt; g.fillRect(0, 2, 2, 1);
      g.fillStyle = f === 1 ? rt : lf; g.fillRect(2, 2, 2, 1);
      big.push({ c, ox:-2, oy:-1 });
    }
  }
  const mini = [];
  for(let f=0; f<2; f++){
    const c = mkCanvas(2, 2), g = c.getContext('2d');
    g.fillStyle = hi; g.fillRect(0, 0, 2, 1);
    g.fillStyle = f === 0 ? lf : rt; g.fillRect(0, 1, 1, 1);
    g.fillStyle = f === 0 ? rt : lf; g.fillRect(1, 1, 1, 1);
    mini.push({ c, ox:-1, oy:-1 });
  }
  return { big, mini, px:hi };
}
function sprites(color){
  let s = spriteCache.get(color);
  if(!s){ s = bakeSprites(color); spriteCache.set(color, s); }
  return s;
}

/* ------------------------------ state ------------------------------ */
const pool = new Array(PCAP);
for(let i=0; i<PCAP; i++){
  pool[i] = {
    on:false, x:0, y:0, z:0, vx:0, vy:0, vz:0, life:0, max:1, color:K.white,
    size:0, grav:0, drag:0, bounce:0, spin:0, ph:0, mode:0, delay:0,
    cx:0, cy:0, rad:0, w:0, vr:0, a:0, ent:null, tx:0, ty:0, tz:0,
  };
}
let head = 0;
let ground = [];
let air = [];
let timers = [];

export function resetFX(){
  for(let i=0; i<PCAP; i++){ pool[i].on = false; pool[i].ent = null; }
  head = 0;
  ground.length = 0; air.length = 0; timers.length = 0;
}

/* particle count multiplier applied by the spawn helpers ("be generous") */
const D = 1.5;

/* ------------------------------ particle spawn ------------------------------ */
// size: 0 big cube, 1 mini cube, 2 single pixel
// mode: 0 ballistic, 1 orbit (centre cx,cy or entity `ent`; rad grows by vr, angle by w, z by vz),
//       2 seek (flies to tx,ty,tz or entity `ent`; speed vr, accelerates by w, dies on arrival)
function spawn(x, y, z, vx, vy, vz, life, color, o){
  const p = pool[head]; head = (head+1) % PCAP;
  p.on = true; p.x = x; p.y = y; p.z = z; p.vx = vx; p.vy = vy; p.vz = vz;
  p.life = p.max = Math.max(0.05, life); p.color = color; p.ph = Math.random();
  if(o){
    p.size = o.size || 0; p.grav = o.grav || 0; p.drag = o.drag || 0; p.bounce = o.bounce || 0;
    p.spin = o.spin || 0; p.mode = o.mode || 0; p.delay = o.delay || 0; p.ent = o.ent || null;
    p.cx = o.cx || 0; p.cy = o.cy || 0; p.rad = o.rad || 0; p.w = o.w || 0; p.vr = o.vr || 0;
    p.a = o.a || 0; p.tx = o.tx || 0; p.ty = o.ty || 0; p.tz = o.tz || 0;
  } else {
    p.size = 0; p.grav = 0; p.drag = 0; p.bounce = 0; p.spin = 0; p.mode = 0; p.delay = 0; p.ent = null;
    p.cx = 0; p.cy = 0; p.rad = 0; p.w = 0; p.vr = 0; p.a = 0; p.tx = 0; p.ty = 0; p.tz = 0;
  }
  return p;
}

/* ------------------------------ spawn helpers ------------------------------ */
/** Radial/hemispherical cube burst. o:{speed,up,flat,life,grav,size,spin,bounce,drag,delay} */
function burst(x, y, z, color, n, o){
  o = o || EMPTY;
  n = Math.ceil(n*D);
  const sp = o.speed ?? 40, up = o.up ?? 0.8, life = o.life ?? 0.6, g = o.grav ?? 140;
  const flat = o.flat ?? 1, mini = o.mini ?? 0.22;
  for(let i=0; i<n; i++){
    const a = Math.random()*TAU, hs = sp*(0.35 + 0.65*Math.random());
    spawn(x, y, z, cos(a)*hs*flat, sin(a)*hs*flat, (0.15 + Math.random()*0.85)*sp*up,
      life*rnd(0.7, 1.3), pick(color),
      { grav:g, size:o.size ?? (Math.random() < mini ? 1 : 0), spin:o.spin ?? 6,
        bounce:o.bounce ?? 0.4, drag:o.drag ?? 1, delay:o.delay || 0 });
  }
}
/** Soft rising dust/smoke puffs (big cubes, drifting up and out). */
function dust(x, y, z, color, n, o){
  o = o || EMPTY;
  const sp = o.speed ?? 22;
  n = Math.ceil(n*D);
  for(let i=0; i<n; i++){
    const a = Math.random()*TAU, hs = sp*rnd(0.3, 1);
    spawn(x + cos(a)*(o.spread ?? 1.5), y + sin(a)*(o.spread ?? 1.5), z + rnd(0, 2),
      cos(a)*hs, sin(a)*hs, rnd(4, 16)*(o.rise ?? 1), (o.life ?? 0.7)*rnd(0.7, 1.3), pick(color),
      { grav:o.grav ?? -4, drag:o.drag ?? 2.4, size:o.size ?? 0, spin:o.spin ?? 2, delay:o.delay || 0 });
  }
}
/** Mostly-upward sparkle fountain. */
function fountain(x, y, z, color, n, o){
  o = o || EMPTY;
  const sp = o.speed ?? 50;
  n = Math.ceil(n*D);
  for(let i=0; i<n; i++){
    const a = Math.random()*TAU, hs = rnd(0, 0.35)*sp;
    spawn(x, y, z, cos(a)*hs, sin(a)*hs, sp*rnd(0.7, 1.15), (o.life ?? 0.8)*rnd(0.7, 1.3), pick(color),
      { grav:o.grav ?? 150, size:o.size ?? (Math.random() < 0.4 ? 1 : 0), spin:6, bounce:o.bounce ?? 0.3, drag:0.4, delay:o.delay ?? i*(o.stagger || 0) });
  }
}
/** Horizontal ring of cubes flying outward. */
function ringBurst(x, y, z, color, n, speed, o){
  o = o || EMPTY;
  n = Math.ceil(n*D);
  const a0 = Math.random()*TAU;
  for(let i=0; i<n; i++){
    const a = a0 + i/n*TAU;
    spawn(x, y, z, cos(a)*speed, sin(a)*speed, o.vz ?? 4, (o.life ?? 0.5)*rnd(0.85, 1.15), pick(color),
      { grav:o.grav ?? 0, drag:o.drag ?? 3, size:o.size ?? 0, spin:o.spin ?? 3, delay:o.delay || 0 });
  }
}
/** Cubes scattered along a line (trail / speed streak). */
function streak(x0, y0, x1, y1, z, color, n, o){
  o = o || EMPTY;
  n = Math.ceil(n*D);
  const s = o.s ?? 8;
  for(let i=0; i<n; i++){
    const f = n > 1 ? i/(n-1) : 0.5;
    spawn(x0 + (x1-x0)*f + rnd(-1.5, 1.5), y0 + (y1-y0)*f + rnd(-1.5, 1.5), z + rnd(-2, 3),
      rnd(-s, s), rnd(-s, s), rnd(0, s), (o.life ?? 0.5)*(0.6 + 0.8*f), pick(color),
      { drag:o.drag ?? 2, size:o.size ?? (i % 2), spin:4, grav:o.grav || 0, delay:o.sweep ? f*o.sweep : 0 });
  }
}
/** Spiral of cubes orbiting a point or entity. o:{r0,vr,w,vz,life,stagger,ent,size,grav} */
function spiral(x, y, z, color, n, o){
  o = o || EMPTY;
  n = Math.ceil(n*D);
  for(let i=0; i<n; i++){
    const a = i*2.399 + (o.a0 || 0);
    spawn(x, y, z, 0, 0, o.vz ?? 20, (o.life ?? 0.9), pick(color),
      { mode:1, cx:x, cy:y, ent:o.ent, a, w:o.w ?? 7, rad:o.r0 ?? 8, vr:o.vr ?? 0,
        delay:i*(o.stagger ?? 0.02)/D, size:o.size ?? (i % 3 === 0 ? 0 : 1), spin:3, grav:o.grav || 0 });
  }
}
/** Cubes drawn in from a radius to a centre (or entity). */
function implode(x, y, z, color, n, R, o){
  o = o || EMPTY;
  n = Math.ceil(n*D*0.8);
  for(let i=0; i<n; i++){
    const a = Math.random()*TAU, r = R*rnd(0.7, 1.05);
    spawn(x + cos(a)*r, y + sin(a)*r, z + rnd(0, o.zr ?? 8), 0, 0, 0, o.life ?? 0.9, pick(color),
      { mode:2, tx:o.tx ?? x, ty:o.ty ?? y, tz:o.tz ?? z, ent:o.ent, vr:o.s0 ?? 12, w:o.acc ?? 150,
        delay:o.delay ?? Math.random()*(o.spread ?? 0.4), size:o.size ?? (Math.random() < 0.5 ? 1 : 0), spin:6 });
  }
}
/** Cubes flying from a point to a target entity / point. */
function fly(x, y, z, tgt, color, n, o){
  o = o || EMPTY;
  for(let i=0; i<n; i++){
    spawn(x + rnd(-2, 2), y + rnd(-2, 2), z + rnd(-2, 4), 0, 0, 0, o.life ?? 0.8, pick(color),
      { mode:2, ent:tgt.ent, tx:tgt.x, ty:tgt.y, tz:tgt.z ?? 6, vr:o.s0 ?? 30, w:o.acc ?? 220,
        delay:o.delay ?? i*(o.stagger ?? 0.03), size:o.size ?? (i % 2), spin:6 });
  }
}
/** Hemisphere/sphere shell of static cubes (domes, bubbles). o:{ent,spin,full,size} */
function shell(x, y, z, color, R, n, life, o){
  o = o || EMPTY;
  for(let i=0; i<n; i++){
    const u = o.full ? 1 - 2*(i+0.5)/n : 1 - (i+0.5)/n;   // y of the fibonacci sphere
    const rr = Math.sqrt(Math.max(0, 1 - u*u));
    const a = i*2.399;
    spawn(x + cos(a)*rr*R, y + sin(a)*rr*R, z + u*R*(o.squash ?? 1), 0, 0, 0, life*rnd(0.85, 1.1), pick(color),
      o.ent || o.w ? { mode:1, cx:x, cy:y, ent:o.ent, a, w:o.w ?? 1.2, rad:rr*R, vr:0, vz:0, size:o.size ?? 1, spin:2, delay:o.delay ?? i*0.008 }
                   : { size:o.size ?? 1, spin:2, delay:o.delay ?? i*0.008 });
    if(o.ent || o.w){ /* orbit particles keep their spawn z */ }
  }
}
/** Standing circle wall of cubes rising (cylinder shell). */
function wall(x, y, R, h, color, life, o){
  o = o || EMPTY;
  const n = Math.max(10, Math.round(R*0.3));
  for(let i=0; i<n; i++){
    const a = i/n*TAU;
    for(let k=0; k<h; k+=4){
      spawn(x + cos(a)*R, y + sin(a)*R, k, 0, 0, 0, life*rnd(0.9, 1.1), pick(color),
        { size:1, spin:1, delay:(o.delay ?? 0) + k*0.012 + Math.random()*0.1 });
    }
  }
}

function pushGround(g){
  if(ground.length >= GCAP) ground.shift();
  g.max = g.life; g.delay = g.delay || 0; ground.push(g);
  return g;
}
/** Expanding/contracting ring on the floor. o:{dot,ease:'out'|'lin'|'in',spin,delay,z,thick} */
function ring(x, y, r0, r1, life, color, alpha, o){
  o = o || EMPTY;
  return pushGround({ t:'ring', x, y, r0, r1, life, color, a:alpha ?? 1, dot:!!o.dot, ease:o.ease || 'out',
    spin:o.spin || 0, delay:o.delay, z:o.z || 0, thick:o.thick !== false });
}
function disc(x, y, r, life, color, alpha, o){
  o = o || EMPTY;
  return pushGround({ t:'disc', x, y, r, r1:o.r1 ?? r, life, color, a:alpha ?? 0.3, delay:o.delay });
}
/** Rotating rune circle: dotted rim, inner ring and spokes. */
function rune(x, y, r, life, color, o){
  o = o || EMPTY;
  return pushGround({ t:'rune', x, y, r, r1:o.r1 ?? r, life, color, n:o.n ?? 6, spin:o.spin ?? 1.2, a:o.alpha ?? 1, delay:o.delay });
}
/** Scorch / crack decal: dark disc + radial cracks. */
function scorch(x, y, r, life, color, o){
  const cracks = [];
  const nc = o && o.n || 7;
  for(let i=0; i<nc; i++){
    let a = Math.random()*TAU, px = 0, py = 0;
    const segs = 2 + ((Math.random()*2)|0);
    for(let s=0; s<segs; s++){
      a += rnd(-0.5, 0.5);
      const l = r*rnd(0.28, 0.5);
      cracks.push(px, py, px + cos(a)*l, py + sin(a)*l);
      px += cos(a)*l; py += sin(a)*l;
    }
  }
  return pushGround({ t:'scorch', x, y, r, life, color: color || '#05060c', cracks, glow:o && o.glow, a:o && o.alpha || 0.35 });
}
function cone(x, y, dx, dy, r, life, color, spread){
  return pushGround({ t:'cone', x, y, dx, dy, r, life, color, spread:spread ?? 0.8 });
}
function gline(x0, y0, x1, y1, life, color, o){
  return pushGround({ t:'line', x0, y0, x1, y1, life, color, delay:o && o.delay });
}
function pushAir(a){
  if(air.length >= ACAP) air.shift();
  a.max = a.life; air.push(a);
  return a;
}
function beam(x0, y0, z0, x1, y1, z1, color, life, jag){
  return pushAir({ t:'beam', x0, y0, z0, x1, y1, z1, color, life, jag:jag || 0 });
}
function pillar(x, y, h, color, life, r){
  return pushAir({ t:'pillar', x, y, h, color, life, r:r ?? 3 });
}
function later(delay, fn){
  if(timers.length >= TCAP) timers.shift();
  timers.push({ d:delay, fn, life:0, every:0, acc:0, age:0 });
}
/** Call fn(age) every `interval` seconds for `life` seconds. */
function every(life, interval, fn, delay){
  if(timers.length >= TCAP) timers.shift();
  timers.push({ d:delay || 0, fn, life, every:interval, acc:0, age:0 });
}

/* ------------------------------ update ------------------------------ */
export function updateFX(dt){
  if(!(dt > 0)) return;
  if(dt > 0.05) dt = 0.05;

  // timers / emitters
  for(let i=timers.length-1; i>=0; i--){
    const T = timers[i];
    T.d -= dt;
    if(T.d > 0) continue;
    if(!T.every){ timers.splice(i, 1); try{ T.fn(0); }catch(err){ warnOnce('timer', err); } continue; }
    T.age += dt; T.acc += dt;
    while(T.acc >= T.every){ T.acc -= T.every; try{ T.fn(T.age); }catch(err){ warnOnce('emitter', err); } }
    if(T.age >= T.life) timers.splice(i, 1);
  }

  // particles
  for(let i=0; i<PCAP; i++){
    const p = pool[i];
    if(!p.on) continue;
    if(p.delay > 0){ p.delay -= dt; continue; }
    p.life -= dt;
    if(p.life <= 0){ p.on = false; p.ent = null; continue; }
    if(p.mode === 0){
      if(p.drag > 0){
        const f = Math.max(0, 1 - p.drag*dt);
        p.vx *= f; p.vy *= f;
        if(p.grav === 0) p.vz *= f;
      }
      p.vz -= p.grav*dt;
      p.x += p.vx*dt; p.y += p.vy*dt; p.z += p.vz*dt;
      if(p.z < 0){
        p.z = 0;
        if(p.bounce > 0 && Math.abs(p.vz) > 10){ p.vz = -p.vz*p.bounce; p.vx *= 0.7; p.vy *= 0.7; }
        else { p.vz = 0; p.vx *= 0.5; p.vy *= 0.5; }
      }
    } else if(p.mode === 1){
      p.a += p.w*dt; p.rad = Math.max(0, p.rad + p.vr*dt);
      const cx = p.ent ? p.ent.x : p.cx, cy = p.ent ? p.ent.y : p.cy;
      p.x = cx + cos(p.a)*p.rad; p.y = cy + sin(p.a)*p.rad;
      p.vz -= p.grav*dt;
      p.z = Math.max(0, p.z + p.vz*dt);
    } else if(p.mode === 2){
      const tx = p.ent ? p.ent.x : p.tx, ty = p.ent ? p.ent.y : p.ty, tz = p.ent ? p.tz : p.tz;
      const dx = tx - p.x, dy = ty - p.y, dz = tz - p.z;
      const d = Math.sqrt(dx*dx + dy*dy + dz*dz);
      p.vr += p.w*dt;
      const step = p.vr*dt;
      if(d <= step + 1.5){ p.on = false; p.ent = null; continue; }
      p.x += dx/d*step; p.y += dy/d*step; p.z += dz/d*step;
    }
  }

  // ground / air lists (in-place compaction)
  let w = 0;
  for(let i=0; i<ground.length; i++){
    const g = ground[i];
    if(g.delay > 0){ g.delay -= dt; ground[w++] = g; continue; }
    g.life -= dt;
    if(g.life > 0) ground[w++] = g;
  }
  ground.length = w;
  w = 0;
  for(let i=0; i<air.length; i++){
    const a = air[i];
    a.life -= dt;
    if(a.life > 0) air[w++] = a;
  }
  air.length = w;
}

const warned = new Set();
function warnOnce(tag, err){
  if(warned.has(tag)) return;
  warned.add(tag);
  console.warn('[fx] ' + tag + ' failed:', err);
}

/* ------------------------------ drawing: shared ------------------------------ */
let camx = 0, camy = 0;
const S = { x:0, y:0 };
function scr(x, y, z){
  S.x = Math.round(IW/2 + ((x-camx) - (y-camy))*ISO_X);
  S.y = Math.round(IH/2 + ((x-camx) + (y-camy))*ISO_Y - z*ISO_Z);
}
function grabCamera(){
  const c = state.camera;
  camx = c ? c.x : 0; camy = c ? c.y : 0;
}
function blitMini(ctx, color, sx, sy, f){
  const m = sprites(color).mini[f & 1];
  ctx.drawImage(m.c, sx + m.ox, sy + m.oy);
}
function blitBig(ctx, color, sx, sy, f){
  const b = sprites(color).big[f & 3];
  ctx.drawImage(b.c, sx + b.ox, sy + b.oy);
}

/* ------------------------------ drawing: ground layer ------------------------------ */
function easeK(k, ease){
  if(ease === 'lin') return k;
  if(ease === 'in') return k*k;
  return 1 - (1-k)*(1-k);
}
function dotRing(ctx, x, y, z, r, color, n, spin, big){
  n = Math.max(6, n | 0);
  for(let i=0; i<n; i++){
    const a = spin + i/n*TAU;
    scr(x + cos(a)*r, y + sin(a)*r, z);
    if(S.x < -6 || S.x > IW+6 || S.y < -6 || S.y > IH+6) continue;
    if(big) blitBig(ctx, color, S.x, S.y, 0); else blitMini(ctx, color, S.x, S.y, i);
  }
}

export function drawFXGround(ctx, t){
  grabCamera();
  const baseA = ctx.globalAlpha;
  ctx.imageSmoothingEnabled = false;
  for(let i=0; i<ground.length; i++){
    const g = ground[i];
    if(g.delay > 0) continue;
    const k = 1 - g.life/g.max;
    switch(g.t){
      case 'disc': {
        const r = g.r + (g.r1-g.r)*easeK(k, 'out');
        groundDisc(ctx, g.x, g.y, r, g.color, g.a*(1-k));
        break;
      }
      case 'scorch': {
        const fade = k < 0.7 ? 1 : (1-k)/0.3;
        groundDisc(ctx, g.x, g.y, g.r*0.8, g.color, g.a*fade);
        if(g.glow) groundDisc(ctx, g.x, g.y, g.r*0.35*(1-k), g.glow, 0.5*fade);
        ctx.globalAlpha = baseA*0.8*fade;
        const cr = g.cracks;
        for(let j=0; j<cr.length; j+=4){
          scr(g.x+cr[j], g.y+cr[j+1], 0); const ax = S.x, ay = S.y;
          scr(g.x+cr[j+2], g.y+cr[j+3], 0);
          pixelLine(ctx, ax, ay, S.x, S.y, g.glow && k < 0.4 ? g.glow : '#05060c');
        }
        ctx.globalAlpha = baseA;
        break;
      }
      case 'ring': {
        const r = g.r0 + (g.r1-g.r0)*easeK(k, g.ease);
        if(r < 0.5) break;
        const al = g.a*(g.ease === 'in' ? (k < 0.2 ? k/0.2 : 1) : (1 - k*k));
        if(g.dot){
          ctx.globalAlpha = baseA*al;
          dotRing(ctx, g.x, g.y, g.z, r, g.color, r*0.9 + 6, g.spin*t, false);
          ctx.globalAlpha = baseA;
        } else {
          groundRing(ctx, g.x, g.y, r, g.color, al);
          if(g.thick && r > 7) groundRing(ctx, g.x, g.y, r + 1, g.color, al*0.75);
        }
        break;
      }
      case 'rune': {
        const env = k < 0.12 ? k/0.12 : (k > 0.7 ? (1-k)/0.3 : 1);
        const r = g.r + (g.r1-g.r)*k;
        ctx.globalAlpha = baseA*env*g.a;
        dotRing(ctx, g.x, g.y, 0, r, g.color, r*0.9 + 8, g.spin*t, false);
        ctx.globalAlpha = baseA;
        groundRing(ctx, g.x, g.y, r*0.66, g.color, 0.55*env*g.a);
        ctx.globalAlpha = baseA*env*g.a;
        for(let s=0; s<g.n; s++){
          const a = -g.spin*t*0.7 + s/g.n*TAU;
          scr(g.x + cos(a)*r*0.8, g.y + sin(a)*r*0.8, 0); blitMini(ctx, g.color, S.x, S.y, 0);
          scr(g.x + cos(a)*r*0.52, g.y + sin(a)*r*0.52, 0); blitMini(ctx, '#ffffff', S.x, S.y, 1);
        }
        scr(g.x, g.y, 0); blitBig(ctx, g.color, S.x, S.y, (t*8)|0);
        ctx.globalAlpha = baseA;
        break;
      }
      case 'cone': {
        const al = 1 - k*k;
        const base = Math.atan2(g.dy, g.dx);
        ctx.globalAlpha = baseA*al;
        const n = Math.max(3, (g.r/6)|0);
        const off = (t*50) % 6;
        for(let rr=-2; rr<=2; rr++){
          const a = base + rr*g.spread/2;
          for(let s=0; s<n; s++){
            const d = g.r*0.15 + s*6 + off + k*g.r*0.4;
            if(d > g.r) break;
            scr(g.x + cos(a)*d, g.y + sin(a)*d, 0); blitMini(ctx, g.color, S.x, S.y, s);
          }
        }
        ctx.globalAlpha = baseA;
        break;
      }
      case 'line': {
        const al = g.life/g.max;
        ctx.globalAlpha = baseA*al;
        const dx = g.x1-g.x0, dy = g.y1-g.y0, L = Math.hypot(dx, dy);
        const n = Math.max(2, (L/5)|0);
        const off = (t*20) % 1;
        for(let s=0; s<n; s++){
          const f = (s+off)/n;
          scr(g.x0 + dx*f, g.y0 + dy*f, 0); blitMini(ctx, g.color, S.x, S.y, s);
        }
        ctx.globalAlpha = baseA;
        break;
      }
    }
  }
  ctx.globalAlpha = baseA;
}

/* ------------------------------ drawing: air layer ------------------------------ */
export function drawFXAir(ctx, t, entitiesDepthSorted){
  grabCamera();
  const baseA = ctx.globalAlpha;
  ctx.imageSmoothingEnabled = false;

  // beams & pillars
  for(let i=0; i<air.length; i++){
    const a = air[i];
    const k = 1 - a.life/a.max;
    if(a.t === 'beam'){
      const fade = a.life/a.max < 0.4 ? (a.life/a.max)/0.4 : 1;
      scr(a.x0, a.y0, a.z0); const x0 = S.x, y0 = S.y;
      scr(a.x1, a.y1, a.z1); const x1 = S.x, y1 = S.y;
      const dx = x1-x0, dy = y1-y0, L = Math.hypot(dx, dy) || 1;
      const n = Math.min(260, Math.ceil(L/2));
      const px = -dy/L, py = dx/L;
      const seed = (t*28) | 0;
      ctx.globalAlpha = baseA*fade;
      for(let s=0; s<=n; s++){
        const f = s/n;
        let j = 0;
        if(a.jag) j = (hash3(seed, s, 7) - 0.5)*2*a.jag*sin(Math.PI*f)*3;
        const bx = Math.round(x0 + dx*f + px*j), by = Math.round(y0 + dy*f + py*j);
        blitMini(ctx, s % 3 === 0 ? '#ffffff' : a.color, bx, by, s);
      }
    } else if(a.t === 'pillar'){
      const grow = k < 0.18 ? k/0.18 : 1;
      const fade = k > 0.55 ? (1-k)/0.45 : 1;
      const h = a.h*grow, rad = a.r*(0.35 + 0.65*fade);
      ctx.globalAlpha = baseA*Math.min(1, fade*1.2);
      for(let z=0; z<h; z+=2){
        const col = ((z/2 + (t*14)|0) % 5 === 0) ? '#ffffff' : a.color;
        for(let c=0; c<4; c++){
          const ang = c*Math.PI/2 + t*3 + z*0.14;
          scr(a.x + cos(ang)*rad, a.y + sin(ang)*rad, z);
          blitMini(ctx, col, S.x, S.y, c);
        }
      }
    }
  }
  ctx.globalAlpha = baseA;

  // particles
  let lastA = baseA;
  for(let i=0; i<PCAP; i++){
    const p = pool[i];
    if(!p.on || p.delay > 0) continue;
    const sx = Math.round(IW/2 + ((p.x-camx) - (p.y-camy))*ISO_X);
    const sy = Math.round(IH/2 + ((p.x-camx) + (p.y-camy))*ISO_Y - p.z*ISO_Z);
    if(sx < -8 || sx > IW+8 || sy < -8 || sy > IH+8) continue;
    const a = p.life/p.max;
    const al = a < 0.28 ? baseA*(a/0.28) : baseA;
    if(al !== lastA){ ctx.globalAlpha = al; lastA = al; }
    let size = p.size;
    if(size === 0 && a < 0.3) size = 1;                 // big cubes shrink before they vanish
    if(size === 0){
      const f = p.spin > 0 ? (((p.max-p.life)*p.spin + p.ph*4) | 0) : 0;
      blitBig(ctx, p.color, sx, sy, f);
    } else if(size === 1){
      const f = p.spin > 0 ? (((p.max-p.life)*p.spin + p.ph*2) | 0) : 0;
      blitMini(ctx, p.color, sx, sy, f);
    } else {
      ctx.fillStyle = sprites(p.color).px;
      ctx.fillRect(sx, sy, 1, 1);
    }
  }
  ctx.globalAlpha = baseA;
}

/* =========================================================================
   ABILITY / CLASS / EVENT EFFECTS
   ========================================================================= */
function isFriendly(e){
  const p = state.player;
  return !p || e === p || (e.team && e.team === p.team);
}
function ctxOf(e, info){
  info = info || EMPTY;
  const raw = info.dir || e.lastMoveDir || { x:1, y:0 };
  const d = (raw.x || raw.y) ? unit(raw.x, raw.y) : { x:1, y:0 };
  const aim = info.aim || { x:e.x + d.x*60, y:e.y + d.y*60 };
  return {
    e, x:e.x, y:e.y, dx:d.x, dy:d.y, px:-d.y, py:d.x, aim, hasAim:!!info.aim,
    tgt:info.target || null, col:(e.cls && e.cls.color) || K.white, friendly:isFriendly(e),
  };
}
const dist2 = (ax, ay, bx, by) => Math.hypot(ax-bx, ay-by);

/** Shared "cast at feet" accent used by buffs: small ring + sparks in the category colour. */
function castPop(c, col, n){
  ring(c.x, c.y, 2, 14, 0.4, col, 0.9);
  fountain(c.x, c.y, 2, [col, K.white], n ?? 8, { speed:34, life:0.55 });
}
function clock(x, y, r, col, life, ccw){
  rune(x, y, r, life, col, { n:12, spin:ccw ? -1.6 : 1.6 });
  // sweeping clock hand
  every(life, 0.03, age => {
    const a = (ccw ? -1 : 1)*age*9;
    beam(x, y, 2, x + cos(a)*r*0.75, y + sin(a)*r*0.75, 2, col, 0.08);
  });
}
function chevronsForward(c, col, n, z){
  for(let i=0; i<n; i++){
    const d = 8 + i*7;
    const bx = c.x + c.dx*d, by = c.y + c.dy*d;
    spawn(bx, by, z, c.dx*60, c.dy*60, 0, 0.45, col, { size:1, drag:3, delay:i*0.05 });
    spawn(bx - c.dx*3 + c.px*3, by - c.dy*3 + c.py*3, z, c.dx*60, c.dy*60, 0, 0.45, col, { size:1, drag:3, delay:i*0.05 });
    spawn(bx - c.dx*3 - c.px*3, by - c.dy*3 - c.py*3, z, c.dx*60, c.dy*60, 0, 0.45, col, { size:1, drag:3, delay:i*0.05 });
  }
}
function flames(x, y, z, n, o){
  o = o || EMPTY;
  const cols = o.cols || [K.red, K.orange, K.gold, K.fire];
  for(let i=0; i<n; i++){
    const a = Math.random()*TAU, r = rnd(0, o.r ?? 4);
    spawn(x + cos(a)*r, y + sin(a)*r, z, rnd(-6, 6), rnd(-6, 6), rnd(18, 42), rnd(0.35, 0.7), pick(cols),
      { size:Math.random() < 0.6 ? 1 : 0, grav:-20, drag:1.2, spin:5, delay:o.delay ?? Math.random()*(o.spread ?? 0.15) });
  }
}
function lightningBolt(x, y, col){
  beam(x + rnd(-6, 6), y + rnd(-6, 6), 70, x, y, 0, col, 0.22, 2.5);
  beam(x + rnd(-6, 6), y + rnd(-6, 6), 70, x, y, 0, K.white, 0.14, 1.5);
}

/* ----------------------------- drafted abilities ----------------------------- */
const AB = {
  /* ---- movement ---- */
  a_grapple(c){
    const bx = c.x - c.dx*70, by = c.y - c.dy*70;
    streak(bx, by, c.x, c.y, 6, [K.teal, K.white], 16, { drag:2, life:0.5 });
    beam(bx, by, 8, c.x, c.y, 8, K.teal, 0.3, 1);
    ring(c.x, c.y, 2, 22, 0.4, K.teal, 0.9);
    dust(c.x, c.y, 1, K.dust, 6, { speed:25 });
    burst(c.x, c.y, 7, K.gold, 8, { speed:40 });
  },
  a_phase(c){
    ring(c.x, c.y, 3, 18, 0.55, K.ice2, 0.9);
    ring(c.x, c.y, 2, 12, 0.45, K.white, 0.7, { delay:0.08 });
    spiral(c.x, c.y, 0, [K.ice2, K.white, K.violet], 18, { ent:c.e, r0:7, vr:-5, w:9, vz:26, life:0.6, stagger:0.015, a0:0 });
    for(let k=0; k<4; k++)       // wavering ghost slices
      spawn(c.x + rnd(-2, 2), c.y + rnd(-2, 2), 2 + k*3.4, 0, 0, 6, 0.6, K.ice2, { size:1, spin:8, delay:k*0.04 });
  },
  a_surge(c){
    flames(c.x, c.y, 1, 12, { r:4, cols:[K.red, K.orange, K.gold] });
    ring(c.x, c.y, 2, 16, 0.4, K.red, 0.9);
    chevronsForward(c, K.orange, 3, 6);
    for(let i=0; i<6; i++)
      streak(c.x - c.dx*(6+i*2) + c.px*rnd(-5, 5), c.y - c.dy*(6+i*2) + c.py*rnd(-5, 5),
        c.x - c.dx*(22+i*2), c.y - c.dy*(22+i*2), 5, [K.orange, K.white], 3, { life:0.4, s:3 });
  },
  a_blinkstrike(c){
    const bx = c.x - c.dx*55, by = c.y - c.dy*55;
    streak(bx, by, c.x, c.y, 6, [c.col, K.white], 18, { life:0.5, s:5 });
    beam(bx, by, 7, c.x, c.y, 7, K.white, 0.14);
    ring(bx, by, 2, 14, 0.35, c.col, 0.8);
    ring(c.x, c.y, 2, 20, 0.45, K.red, 1);
    burst(c.x + c.dx*6, c.y + c.dy*6, 7, [K.red, K.white], 10, { speed:55, up:0.4 });
    beam(c.x, c.y, 7, c.x + c.dx*18, c.y + c.dy*18, 7, K.red, 0.22);
  },
  a_wallbreak(c){
    burst(c.x + c.dx*4, c.y + c.dy*4, 5, [K.stone, K.brown, '#4a5273'], 14, { speed:55, up:0.8, bounce:0.45, mini:0.2 });
    dust(c.x, c.y, 2, K.dust, 8, { speed:30 });
    scorch(c.x + c.dx*8, c.y + c.dy*8, 12, 1.4, '#05060c', { n:6 });
    ring(c.x, c.y, 2, 18, 0.4, K.orange, 0.9);
    spiral(c.x, c.y, 4, [K.orange, K.stone], 6, { ent:c.e, r0:5, vz:2, w:12, life:0.5 });
  },
  a_beacon(c){
    pillar(c.x, c.y, 34, K.teal, 1.1, 3);
    rune(c.x, c.y, 16, 1.1, K.teal, { n:4, spin:2 });
    spiral(c.x, c.y, 0, [K.teal, K.white], 14, { r0:10, vr:-8, w:6, vz:30, life:0.9, stagger:0.03 });
    if(c.hasAim && dist2(c.aim.x, c.aim.y, c.x, c.y) > 12){
      pillar(c.aim.x, c.aim.y, 26, K.teal, 0.9, 2.5);
      ring(c.aim.x, c.aim.y, 2, 14, 0.6, K.teal, 0.9);
    }
  },
  a_recall(c){
    ring(c.x, c.y, 28, 4, 0.55, K.teal, 0.9, { ease:'lin' });
    ring(c.x, c.y, 18, 3, 0.45, K.white, 0.7, { ease:'lin', delay:0.1 });
    implode(c.x, c.y, 4, [K.teal, K.white], 18, 26, { life:0.6, spread:0.25 });
    spiral(c.x, c.y, 0, [K.teal, K.ice2], 14, { ent:c.e, r0:10, vr:-14, w:-12, vz:22, life:0.55, stagger:0.02 });
  },
  a_swap(c){
    const t = c.tgt;
    const sw = (x, y) => {
      ring(x, y, 2, 20, 0.5, K.pink, 1);
      spiral(x, y, 0, [K.pink, K.white, K.violet], 12, { r0:3, vr:14, w:11, vz:26, life:0.55, stagger:0.02 });
      burst(x, y, 6, [K.pink, K.white], 8, { speed:40 });
    };
    sw(c.x, c.y);
    if(t){ sw(t.x, t.y); beam(c.x, c.y, 8, t.x, t.y, 8, K.pink, 0.35, 2.5); beam(c.x, c.y, 11, t.x, t.y, 11, K.white, 0.2, 1.5); }
  },
  a_slide(c){
    for(let i=0; i<10; i++)
      spawn(c.x - c.dx*rnd(0, 8) + c.px*rnd(-3, 3), c.y - c.dy*rnd(0, 8) + c.py*rnd(-3, 3), rnd(0.5, 3),
        -c.dx*rnd(20, 60) + c.px*rnd(-14, 14), -c.dy*rnd(20, 60) + c.py*rnd(-14, 14), rnd(6, 20), rnd(0.35, 0.7),
        pick([K.dust, K.tan, '#bdb5cc']), { drag:2.4, grav:-6, size:i % 3 === 0 ? 0 : 1, spin:3 });
    burst(c.x + c.dx*2, c.y + c.dy*2, 2, [K.gold, K.orange], 6, { speed:36, up:0.4, life:0.35 });
    ring(c.x, c.y, 2, 14, 0.35, K.tan, 0.8);
  },
  a_sidestep(c){
    for(const s of [-1, 1]){
      for(let i=0; i<6; i++)
        spawn(c.x, c.y, 3 + i*1.5, c.px*s*rnd(30, 70), c.py*s*rnd(30, 70), 0, 0.35, i % 2 ? K.white : K.teal,
          { size:1, drag:4, delay:i*0.012, spin:4 });
    }
    ring(c.x, c.y, 2, 15, 0.3, K.teal, 0.8);
    dust(c.x, c.y, 1, K.dust, 4, { speed:20 });
  },
  a_hover(c){
    for(let k=0; k<3; k++) ring(c.x, c.y, 3, 18 + k*3, 0.5, K.ice2, 0.8, { delay:k*0.14 });
    ringBurst(c.x, c.y, 1, [K.dust, K.snow], 14, 38, { life:0.5, drag:3.5 });
    for(let i=0; i<10; i++)
      spawn(c.x + rnd(-3, 3), c.y + rnd(-3, 3), 7, rnd(-12, 12), rnd(-12, 12), -rnd(10, 40), 0.55, pick([K.teal, K.white]),
        { size:1, spin:5, grav:0, delay:i*0.03 });
    fountain(c.x, c.y, 1, K.white, 6, { speed:22, life:0.45 });
  },
  a_pounce(c){
    for(let k=-1; k<=1; k++){       // three claw rakes forward
      const ox = c.px*k*5, oy = c.py*k*5;
      beam(c.x + ox + c.dx*4, c.y + oy + c.dy*4, 8, c.x + ox + c.dx*26, c.y + oy + c.dy*26, 8, k === 0 ? K.white : K.red, 0.25);
    }
    burst(c.x - c.dx*3, c.y - c.dy*3, 1, [K.dust, K.tan], 8, { speed:26, up:0.4, life:0.4 });
    chevronsForward(c, K.red, 3, 7);
    ring(c.x + c.dx*8, c.y + c.dy*8, 2, 24, 0.35, K.red, 0.9);
  },
  a_stampede(c){
    ring(c.x, c.y, 3, 26, 0.55, K.brown, 1, { thick:true });
    ring(c.x, c.y, 3, 18, 0.45, K.gold, 0.8, { delay:0.1 });
    dust(c.x, c.y, 1, [K.brown, K.tan, K.dust], 20, { speed:44, life:0.9, rise:1.4 });
    for(let i=0; i<8; i++){        // a herd of cubes thundering outward along the floor
      const a = c.dx ? Math.atan2(c.dy, c.dx) + rnd(-1.1, 1.1) : Math.random()*TAU;
      spawn(c.x, c.y, 2, cos(a)*90, sin(a)*90, 0, 0.6, pick([K.orange, K.brown, K.gold]),
        { drag:3, size:0, spin:5, delay:i*0.025 });
    }
    scorch(c.x, c.y, 18, 1.2, '#05060c', { n:8 });
    chevronsForward(c, K.orange, 4, 6);
  },

  /* ---- zone / traps (hidden ones stay quiet for the opponent) ---- */
  a_snare(c){
    if(!c.friendly){ dust(c.x, c.y, 2, K.dust, 3, { speed:14 }); return; }
    rune(c.aim.x, c.aim.y, 15, 0.9, K.olive, { n:5, spin:2 });
    burst(c.aim.x, c.aim.y, 2, [K.olive, K.lime, K.green], 10, { speed:30, up:0.9 });
    for(let i=0; i<6; i++){        // little thorn spikes
      const a = i/6*TAU;
      spawn(c.aim.x + cos(a)*9, c.aim.y + sin(a)*9, 0, 0, 0, 14, 0.5, K.olive, { size:0, grav:50, delay:i*0.04 });
    }
  },
  a_mines(c){
    ring(c.x, c.y, 8, 32, 0.55, K.orange, c.friendly ? 0.9 : 0.4, { dot:true, spin:1.5 });
    if(c.friendly) for(let i=0; i<3; i++){
      const a = i/3*TAU + 0.5;
      burst(c.x + cos(a)*30, c.y + sin(a)*30, 1, [K.orange, K.gold], 5, { speed:24, life:0.4 });
    }
    dust(c.x, c.y, 1, K.dust, 6, { speed:26 });
  },
  a_spring(c){
    if(!c.friendly){ dust(c.x, c.y, 2, K.dust, 3, { speed:14 }); return; }
    for(let k=0; k<5; k++) ring(c.aim.x, c.aim.y, 12 - k, 8 - k*0.5, 0.5, K.gold, 0.9, { z:k*2.5, dot:true, delay:k*0.05 });
    fountain(c.aim.x, c.aim.y, 2, [K.gold, K.orange], 8, { speed:55 });
  },
  a_tripwire(c){
    if(!c.friendly){ dust(c.x, c.y, 2, K.dust, 3, { speed:14 }); return; }
    const hx = c.aim.x, hy = c.aim.y;
    const px = -c.dy*14, py = c.dx*14;
    for(const s of [-1, 1]){ pillar(hx + px*s, hy + py*s, 9, K.stone, 0.7, 1.2); }
    beam(hx - px, hy - py, 4, hx + px, hy + py, 4, K.white, 0.9, 0.4);
    ring(hx, hy, 2, 16, 0.5, K.lime, 0.8);
  },
  a_zonepaint(c){
    ring(c.x, c.y, 4, 40, 0.7, K.teal, 1, { thick:true });
    ring(c.x, c.y, 2, 28, 0.55, K.white, 0.7, { delay:0.08 });
    rune(c.x, c.y, 34, 0.8, K.teal, { n:4, spin:-2 });
    for(let i=0; i<4; i++){
      const a = i/4*TAU;
      chevronsForward({ x:c.x, y:c.y, dx:cos(a), dy:sin(a), px:-sin(a), py:cos(a) }, K.teal, 2, 1);
    }
    fountain(c.x, c.y, 1, [K.teal, K.white], 8, { speed:32 });
  },
  a_mud(c){
    const d = unit(c.aim.x - c.x, c.aim.y - c.y);
    for(let i=0; i<10; i++)
      spawn(c.x, c.y, 8, d.x*rnd(40, 120) + rnd(-12, 12), d.y*rnd(40, 120) + rnd(-12, 12), rnd(20, 50), 0.6,
        pick([K.brown, '#7a5420', '#c58f3d']), { grav:140, size:i % 2, spin:5, bounce:0.2 });
    ring(c.x, c.y, 2, 12, 0.3, K.brown, 0.8);
    gline(c.x, c.y, c.aim.x, c.aim.y, 0.5, K.brown);
  },
  a_sticky(c){
    const d = unit(c.aim.x - c.x, c.aim.y - c.y);
    for(let i=0; i<8; i++)
      spawn(c.x, c.y, 8, d.x*rnd(30, 90) + rnd(-10, 10), d.y*rnd(30, 90) + rnd(-10, 10), rnd(20, 45), 0.7,
        pick([K.purple, K.violet, '#7d4ee0']), { grav:130, size:i % 2, spin:4, bounce:0.1, drag:0.6 });
    ring(c.x, c.y, 2, 12, 0.3, K.purple, 0.9);
    gline(c.x, c.y, c.aim.x, c.aim.y, 0.45, K.purple);
  },
  a_barricade(c){
    const dx = c.aim.x - c.x, dy = c.aim.y - c.y;
    const horiz = Math.abs(dx) < Math.abs(dy);
    for(let i=0; i<14; i++){
      const f = rnd(-0.5, 0.5), L = 76;
      const x = c.aim.x + (horiz ? f*L : 0), y = c.aim.y + (horiz ? 0 : f*L);
      spawn(x, y, 0, rnd(-6, 6), rnd(-6, 6), rnd(20, 50), 0.6, pick([K.teal, K.white, K.dust]),
        { grav:110, size:i % 2, spin:5, bounce:0.3, delay:Math.random()*0.15 });
    }
    scorch(c.aim.x, c.aim.y, 20, 1.0, '#05060c', { n:5 });
    ring(c.aim.x, c.aim.y, 4, 30, 0.4, K.teal, 0.8, { dot:true });
    pillar(c.aim.x, c.aim.y, 18, K.teal, 0.5, 2);
  },
  a_thunder(c){
    const r = 52, fuse = 1.2;
    rune(c.aim.x, c.aim.y, r, fuse + 0.1, K.gold, { n:8, spin:2.5 });
    ring(c.aim.x, c.aim.y, r, 6, fuse, K.red, 0.9, { ease:'lin' });
    every(fuse, 0.07, () => {
      spawn(c.aim.x + rnd(-r*0.7, r*0.7), c.aim.y + rnd(-r*0.7, r*0.7), 0, 0, 0, rnd(20, 40), 0.5, pick([K.gold, K.white]),
        { size:1, drag:0.2, spin:6 });
    });
    burst(c.x, c.y, 10, [K.gold, K.white], 6, { speed:30, life:0.4 });
    every(fuse*0.45, 0.18, () => {      // gathering clouds
      lightningBolt(c.aim.x + rnd(-r*0.6, r*0.6), c.aim.y + rnd(-r*0.6, r*0.6), K.gold);
    }, fuse*0.55);
  },
  a_powderkeg(c){
    const r = 55, fuse = 1.2;
    rune(c.aim.x, c.aim.y, r, fuse + 0.1, K.orange, { n:6, spin:-2 });
    ring(c.aim.x, c.aim.y, r, 8, fuse, K.red, 0.9, { ease:'lin' });
    every(fuse, 0.05, age => {      // sizzling fuse at the keg
      flames(c.aim.x, c.aim.y, 6, 2, { r:1.5, cols:[K.gold, K.white, K.orange], spread:0 });
    });
    burst(c.x, c.y, 8, [K.orange, K.gold], 6, { speed:30, life:0.4 });
    gline(c.x, c.y, c.aim.x, c.aim.y, 0.4, K.orange);
  },
  a_springboard(c){
    for(let k=0; k<4; k++) ring(c.aim.x, c.aim.y, 9, 6, 0.6, K.teal, 0.9, { z:k*3, dot:true, delay:k*0.06 });
    for(let k=0; k<3; k++){          // rising chevrons
      const bx = c.aim.x, by = c.aim.y;
      spawn(bx, by, 2, 0, 0, 34, 0.7, K.teal, { size:1, delay:k*0.1 });
      spawn(bx - 2, by + 2, 1, 0, 0, 34, 0.7, K.white, { size:1, delay:k*0.1 });
      spawn(bx + 2, by - 2, 1, 0, 0, 34, 0.7, K.white, { size:1, delay:k*0.1 });
    }
    fountain(c.aim.x, c.aim.y, 1, [K.teal, K.gold], 8, { speed:48 });
  },
  a_dustkick(c){
    const x = c.x - c.dx*20, y = c.y - c.dy*20;
    dust(x, y, 1, [K.dust, K.tan, '#bdb5cc'], 22, { speed:36, life:1.1, rise:1.2, spread:6 });
    ring(x, y, 4, 30, 0.8, K.dust, 0.6, { dot:true });
    disc(x, y, 26, 1.2, K.dust, 0.25);
  },
  a_trail(c){
    for(let i=0; i<10; i++)
      spawn(c.x + rnd(-3, 3), c.y + rnd(-3, 3), rnd(4, 9), rnd(-14, 14), rnd(-14, 14), rnd(10, 30), 0.7,
        pick([K.brown, '#c58f3d', K.olive]), { grav:110, size:i % 2, spin:3, bounce:0.15 });
    ring(c.x, c.y, 2, 16, 0.5, K.brown, 0.9);
    spiral(c.x, c.y, 0, K.brown, 6, { ent:c.e, r0:5, vz:14, w:8, life:0.6 });
  },
  a_lasso(c){
    const R = 26;
    ring(c.aim.x, c.aim.y, R, 5, 0.5, K.tan, 1, { ease:'lin', thick:true });
    spiral(c.aim.x, c.aim.y, 3, [K.tan, K.gold], 14, { r0:R, vr:-40, w:14, vz:4, life:0.5, stagger:0.01 });
    beam(c.x, c.y, 8, c.aim.x, c.aim.y, 4, K.tan, 0.5, 0.6);
    gline(c.x, c.y, c.aim.x, c.aim.y, 0.5, K.tan);
    if(c.tgt) fly(c.tgt.x, c.tgt.y, 6, { ent:c.e, z:6 }, [K.tan, K.gold], 8, { life:0.5 });
  },

  /* ---- taginteraction ---- */
  a_deflect(c){
    ring(c.x, c.y, 4, 16, 0.5, K.gold, 1, { thick:true });
    for(let i=0; i<8; i++){
      const a = i/8*TAU;
      spawn(c.x + cos(a)*10, c.y + sin(a)*10, 7, 0, 0, 0, 0.6, i % 2 ? K.white : K.gold,
        { mode:1, cx:c.x, cy:c.y, ent:c.e, a, w:5, rad:10, vr:-6, vz:0, size:0, spin:3 });
    }
    fountain(c.x, c.y, 8, [K.gold, K.white], 6, { speed:26, life:0.5 });
  },
  a_longarm(c){
    ring(c.x, c.y, 4, 12*1.4 + 4, 0.6, K.red, 1, { dot:true, spin:2 });
    ring(c.x, c.y, 3, 14, 0.4, K.white, 0.6);
    for(let k=0; k<3; k++){
      const a = Math.atan2(c.dy, c.dx) + (k-1)*0.5;
      beam(c.x, c.y, 8, c.x + cos(a)*20, c.y + sin(a)*20, 8, K.red, 0.3);
    }
    burst(c.x + c.dx*14, c.y + c.dy*14, 8, [K.red, K.white], 5, { speed:24, life:0.4 });
  },
  a_pierce(c){
    const L = 38;
    beam(c.x, c.y, 7, c.x + c.dx*L, c.y + c.dy*L, 7, '#ffd6dd', 0.45);
    beam(c.x + c.px*2, c.y + c.py*2, 7, c.x + c.dx*(L-8), c.y + c.dy*(L-8), 7, K.red, 0.35);
    burst(c.x + c.dx*L, c.y + c.dy*L, 7, [K.white, K.red], 10, { speed:50, up:0.4, flat:1 });
    streak(c.x, c.y, c.x + c.dx*L, c.y + c.dy*L, 7, [K.red, K.white], 10, { life:0.5, s:6 });
    ring(c.x + c.dx*L, c.y + c.dy*L, 1, 14, 0.4, K.red, 0.9);
  },
  a_brand(c){
    const t = c.tgt || { x:c.x + c.dx*30, y:c.y + c.dy*30 };
    rune(t.x, t.y, 22, 3, K.orange, { n:5, spin:2, r1:8 });
    ring(t.x, t.y, 40, 8, 3, K.red, 0.8, { ease:'lin', dot:true, spin:-1 });
    flames(t.x, t.y, 2, 14, { r:10, spread:0.3 });
    beam(c.x, c.y, 10, t.x, t.y, 10, K.orange, 0.25, 1.5);
  },
  a_beam(c){
    const d = unit(c.dx, c.dy);
    rune(c.x, c.y, 14, 0.7, K.pink, { n:4, spin:4 });
    implode(c.x + d.x*6, c.y + d.y*6, 7, [K.pink, K.white], 16, 22, { life:0.6, spread:0.4 });
    ring(c.x, c.y, 18, 4, 0.6, K.pink, 0.8, { ease:'lin' });
  },
  a_counter(c){
    ring(c.x, c.y, 3, 17, 0.5, K.silver, 1, { thick:true });
    // crossed blades flash above the head
    beam(c.x - 5, c.y + 5, 16, c.x + 5, c.y - 5, 8, K.white, 0.35);
    beam(c.x - 5, c.y - 5, 8, c.x + 5, c.y + 5, 16, K.silver, 0.35);
    for(let i=0; i<8; i++){
      const a = i/8*TAU;
      spawn(c.x + cos(a)*11, c.y + sin(a)*11, 7, 0, 0, 0, 0.7, i % 2 ? K.silver : K.white,
        { mode:1, cx:c.x, cy:c.y, ent:c.e, a, w:-4, rad:11, vr:-3, vz:0, size:0, spin:4 });
    }
    fountain(c.x, c.y, 6, [K.white, K.silver], 6, { speed:28 });
  },

  /* ---- physics ---- */
  a_well(c){
    const x = c.aim.x, y = c.aim.y;
    rune(x, y, 55, 3.1, K.purple, { n:6, spin:-1.5 });
    disc(x, y, 8, 3, '#1b1033', 0.7);
    ring(x, y, 55, 10, 0.9, K.violet, 0.9, { ease:'lin' });
    every(3, 0.2, () => implode(x, y, 5, [K.purple, K.violet, K.white], 4, 55, { life:0.7, spread:0.1, acc:200 }));
    spiral(x, y, 0, [K.purple, K.white], 14, { r0:30, vr:-26, w:9, vz:22, life:0.8, stagger:0.04 });
  },
  a_tether(c){
    const x = c.aim.x, y = c.aim.y;
    wall(x, y, 95, 12, [K.purple, K.violet], 3, { delay:0 });
    rune(x, y, 95, 3, K.purple, { n:10, spin:0.8 });
    ring(x, y, 20, 95, 0.5, K.violet, 0.9);
    gline(c.x, c.y, x, y, 0.5, K.purple);
  },
  a_stasis(c){
    const x = c.aim.x, y = c.aim.y;
    shell(x, y, 0, [K.ice2, K.snow, K.ice], 55, 46, 1.6, { size:1, squash:0.6 });
    ring(x, y, 10, 85, 0.7, K.ice2, 1, { thick:true });
    rune(x, y, 60, 2, K.ice, { n:12, spin:0.4 });
    disc(x, y, 80, 1.5, K.ice, 0.18);
    fountain(x, y, 2, [K.snow, K.white], 10, { speed:20, life:1.2, grav:12 });
    if(c.tgt) burst(c.tgt.x, c.tgt.y, 6, [K.snow, K.ice2], 8, { speed:20 });
  },
  a_shove(c){
    const base = Math.atan2(c.dy, c.dx);
    cone(c.x, c.y, c.dx, c.dy, 95, 0.55, K.ice2, 0.9);
    ring(c.x, c.y, 4, 95, 0.45, K.ice2, 0.6, { dot:true });
    for(let i=0; i<24; i++){
      const a = base + rnd(-0.75, 0.75), s = rnd(80, 190);
      spawn(c.x + c.dx*5, c.y + c.dy*5, rnd(2, 10), cos(a)*s, sin(a)*s, rnd(-4, 8), rnd(0.3, 0.55), pick([K.white, K.snow, K.ice2]),
        { drag:3.2, size:i % 2, spin:6, delay:i*0.008 });
    }
  },
  a_frost(c){
    ring(c.x, c.y, 3, 26, 0.7, K.ice, 1, { thick:true });
    ringBurst(c.x, c.y, 2, [K.snow, K.ice2], 14, 30, { life:0.7, drag:2.5 });
    burst(c.x, c.y, 6, [K.ice2, K.white, K.ice], 12, { speed:44, up:1, bounce:0.3, mini:0.25 });
    spiral(c.x, c.y, 0, [K.snow, K.white], 10, { ent:c.e, r0:9, vz:16, w:5, life:0.9 });
  },
  a_dice(c){
    for(let i=0; i<6; i++){          // tumbling dice cubes
      const a = i/6*TAU + Math.random();
      spawn(c.x, c.y, 8, cos(a)*rnd(30, 70), sin(a)*rnd(30, 70), rnd(40, 80), 1.0, pick([K.white, K.pink, K.gold]),
        { grav:170, size:0, spin:9, bounce:0.55 });
    }
    const t = c.tgt;
    ring(c.x, c.y, 2, 20, 0.45, K.pink, 1);
    spiral(c.x, c.y, 0, [K.pink, K.white], 10, { r0:2, vr:16, w:12, vz:24, life:0.5 });
    if(t){ ring(t.x, t.y, 2, 20, 0.45, K.pink, 1); burst(t.x, t.y, 6, [K.pink, K.white], 8, { speed:36 }); }
  },
  a_stomp(c){
    for(let k=0; k<3; k++) ring(c.x, c.y, 4, 80, 0.5 + k*0.08, k === 0 ? K.white : K.orange, 1, { delay:k*0.09, thick:k === 0 });
    scorch(c.x, c.y, 34, 2, '#05060c', { n:11, glow:K.orange });
    burst(c.x, c.y, 1, [K.stone, K.brown, '#4a5273', K.orange], 20, { speed:90, up:1.1, bounce:0.5, mini:0.2, life:0.9 });
    ringBurst(c.x, c.y, 2, [K.dust, K.tan], 20, 60, { life:0.6, drag:3 });
    dust(c.x, c.y, 1, K.dust, 10, { speed:22 });
  },

  /* ---- buffs ---- */
  a_adren(c){
    castPop(c, K.gold, 6);
    ring(c.x, c.y, 2, 20, 0.5, K.gold, 0.8, { delay:0.15 });   // double heart-beat
    spiral(c.x, c.y, 0, [K.gold, K.white, K.red], 18, { ent:c.e, r0:7, vr:-3, w:8, vz:30, life:0.8, stagger:0.025 });
    pillar(c.x, c.y, 22, K.gold, 0.5, 2.5);
  },
  a_overclock(c){
    clock(c.x, c.y, 22, K.gold, 0.9, true);
    spiral(c.x, c.y, 0, [K.gold, K.white], 12, { ent:c.e, r0:12, vr:-10, w:-9, vz:18, life:0.8, stagger:0.04 });
    fountain(c.x, c.y, 14, [K.gold, K.white], 6, { speed:30, life:0.6 });
  },
  a_pacer(c){
    for(let k=0; k<3; k++) ring(c.x, c.y, 2, 20, 0.45, K.teal, 0.9, { delay:k*0.22 });
    for(let k=0; k<4; k++)
      spawn(c.x - c.dx*(3+k*3), c.y - c.dy*(3+k*3), 1, -c.dx*10, -c.dy*10, 4, 0.7, K.white, { size:0, drag:2, delay:k*0.15, spin:3 });
    fountain(c.x, c.y, 2, [K.teal, K.white], 5, { speed:24 });
  },
  a_cleats(c){
    for(let i=0; i<6; i++){          // spikes pop out around the feet
      const a = i/6*TAU;
      spawn(c.x + cos(a)*4, c.y + sin(a)*4, 0, cos(a)*8, sin(a)*8, 20, 0.5, i % 2 ? K.silver : K.stone, { grav:120, size:1, spin:3, bounce:0.3 });
    }
    dust(c.x, c.y, 1, [K.white, K.snow], 8, { speed:26 });
    ring(c.x, c.y, 2, 14, 0.4, K.white, 0.9);
  },
  a_overdrive(c){
    flames(c.x, c.y, 1, 22, { r:5, spread:0.25 });
    pillar(c.x, c.y, 26, K.orange, 0.45, 3);
    ring(c.x, c.y, 2, 22, 0.45, K.orange, 1, { thick:true });
    spiral(c.x, c.y, 0, [K.red, K.orange, K.gold], 12, { ent:c.e, r0:6, vr:-1, w:11, vz:26, life:0.7 });
  },
  a_brace(c){
    const base = Math.atan2(c.dy, c.dx);
    for(let j=-2; j<=2; j++){        // plates slam down in front
      const a = base + j*0.38;
      for(let h=0; h<2; h++)
        spawn(c.x + cos(a)*8, c.y + sin(a)*8, 26 + h*5, 0, 0, -140, 0.5, h ? K.silver : K.stone,
          { size:0, grav:0, spin:0, delay:Math.abs(j)*0.03 });
    }
    later(0.2, () => {
      ring(c.x, c.y, 3, 18, 0.35, K.stone, 1, { thick:true });
      dust(c.x + c.dx*7, c.y + c.dy*7, 1, K.dust, 8, { speed:26 });
      burst(c.x + c.dx*8, c.y + c.dy*8, 4, [K.silver, K.white], 6, { speed:40, life:0.3 });
    });
  },
  a_shellgame(c){
    for(let i=0; i<3; i++){          // three cups tossed into the air
      const a = i/3*TAU + 0.6;
      spawn(c.x, c.y, 8, cos(a)*30, sin(a)*30, rnd(50, 80), 1.0, pick([K.pink, K.gold, K.teal]),
        { grav:170, size:0, spin:7, bounce:0.45 });
    }
    dust(c.x, c.y, 2, [K.pink, K.white, K.violet], 14, { speed:40, life:0.8 });
    ring(c.x, c.y, 3, 26, 0.55, K.pink, 1);
    burst(c.x, c.y, 8, [K.pink, K.gold, K.teal, K.white], 14, { speed:60, up:1.2, life:0.9 });
  },

  /* ---- defense / utility ---- */
  a_smoke(c){
    dust(c.x, c.y, 1, [K.stone, '#a3abc7', '#4a5273'], 24, { speed:34, life:1.1, rise:1.3, spread:3 });
    ring(c.x, c.y, 3, 28, 0.6, K.stone, 0.7, { dot:true });
    disc(c.x, c.y, 18, 1.2, '#2a2f45', 0.35);
  },
  a_magnet(c){
    for(let k=0; k<3; k++) ring(c.x, c.y, 55, 6, 0.7, k % 2 ? K.blue : K.red, 0.9, { ease:'lin', delay:k*0.2, dot:true, spin:-1 });
    implode(c.x, c.y, 5, [K.red, K.blue, K.white], 20, 50, { life:0.7, spread:0.5, ent:c.e });
  },
  a_ghosttrail(c){
    for(let i=0; i<3; i++){          // ghostly echo slices
      const bx = c.x - c.dx*(6 + i*7), by = c.y - c.dy*(6 + i*7);
      for(let k=0; k<4; k++) spawn(bx, by, 2 + k*3.3, 0, 0, 3, 0.7, K.ice2, { size:1, spin:6, delay:i*0.06 });
    }
    ring(c.x, c.y, 2, 16, 0.45, K.ice2, 0.8);
    spiral(c.x, c.y, 0, [K.ice2, K.white], 8, { ent:c.e, r0:6, vz:16, w:6, life:0.6 });
  },
  a_mark(c){
    const t = c.tgt;
    if(!t){ ring(c.x, c.y, 2, 16, 0.4, K.red, 0.8); return; }
    pillar(t.x, t.y, 24, K.red, 0.7, 2);
    ring(t.x, t.y, 2, 22, 0.5, K.red, 1, { thick:true });
    burst(t.x, t.y, 16, [K.red, K.white], 8, { speed:30 });
    beam(c.x, c.y, 12, t.x, t.y, 17, K.red, 0.3, 1);
  },
  a_leech(c){
    const t = c.tgt;
    if(!t){ ring(c.x, c.y, 2, 16, 0.4, K.red, 0.8); return; }
    ring(t.x, t.y, 2, 20, 0.5, K.red, 1);
    fly(t.x, t.y, 7, { ent:c.e, z:7 }, [K.red, K.pink, K.white], 14, { life:0.7, stagger:0.025, s0:40, acc:240 });
    burst(t.x, t.y, 7, K.red, 8, { speed:30 });
  },
  a_flash(c){
    const x = c.aim.x, y = c.aim.y;
    pillar(x, y, 30, K.white, 0.4, 4);
    for(let k=0; k<3; k++) ring(x, y, 2, 42 + k*8, 0.5 + k*0.1, K.white, 1, { delay:k*0.05, thick:k === 0 });
    burst(x, y, 8, K.white, 22, { speed:80, up:0.9, life:0.7, bounce:0.2 });
    disc(x, y, 20, 0.45, K.white, 0.5, { r1:50 });
    for(let i=0; i<8; i++){
      const a = i/8*TAU;
      beam(x, y, 8, x + cos(a)*28, y + sin(a)*28, 8, K.white, 0.2);
    }
  },
  a_sense(c){
    for(let k=0; k<3; k++) ring(c.x, c.y, 4, 70, 0.9, K.orange, 0.8, { delay:k*0.2, dot:true, spin:1.5 });
    for(let i=0; i<8; i++){
      const a = i/8*TAU;
      streak(c.x, c.y, c.x + cos(a)*50, c.y + sin(a)*50, 1, [K.orange, K.white], 5, { life:0.6, s:2 });
    }
    spawn(c.x - 2, c.y + 2, 16, 0, 0, 6, 0.7, K.white, { size:1 });   // two eyes
    spawn(c.x + 2, c.y - 2, 16, 0, 0, 6, 0.7, K.white, { size:1 });
  },
  a_shade(c){
    spiral(c.x, c.y, 0, ['#3a2a66', K.purple, K.violet], 16, { ent:c.e, r0:12, vr:-6, w:7, vz:22, life:0.9, stagger:0.04 });
    ring(c.x, c.y, 3, 20, 0.6, K.purple, 0.9);
    pillar(c.x, c.y, 18, '#3a2a66', 0.6, 2.5);
    spawn(c.x - 1.5, c.y + 1.5, 14, 0, 0, 10, 0.9, K.white, { size:1, delay:0.4 });
    spawn(c.x + 1.5, c.y - 1.5, 14, 0, 0, 10, 0.9, K.white, { size:1, delay:0.4 });
  },
  a_ward(c){
    ring(c.x, c.y, 3, 18, 0.6, K.violet, 1, { thick:true });
    rune(c.x, c.y, 18, 0.9, K.silver, { n:6, spin:2 });
    shell(c.x, c.y, 7, [K.violet, K.silver, K.white], 10, 20, 0.7, { ent:c.e, w:-4, full:true });
    fountain(c.x, c.y, 8, [K.violet, K.white], 6, { speed:24 });
  },
  a_seeker(c){
    const base = Math.atan2(c.dy, c.dx);
    ring(c.x, c.y, 2, 14, 0.4, K.teal, 0.9);
    for(let i=0; i<10; i++){
      const a = base + rnd(-0.5, 0.5);
      spawn(c.x, c.y, 8, cos(a)*rnd(30, 70), sin(a)*rnd(30, 70), 0, 0.5, pick([K.teal, K.white]), { drag:3, size:i % 2, spin:5 });
    }
    spiral(c.x, c.y, 8, [K.teal, K.white], 8, { r0:3, vr:10, w:12, vz:0, life:0.45 });
  },
  a_orbitblades(c){
    for(let i=0; i<3; i++){
      const a = i*2.0944;
      for(let k=0; k<4; k++)
        spawn(c.x, c.y, 8, 0, 0, 0, 0.5 + k*0.04, k === 0 ? K.white : K.silver,
          { mode:1, cx:c.x, cy:c.y, ent:c.e, a:a - k*0.12, w:10, rad:4, vr:36, vz:0, size:k === 0 ? 0 : 1, spin:5, delay:k*0.02 });
    }
    ring(c.x, c.y, 4, 24, 0.5, K.silver, 0.9, { dot:true, spin:3 });
    burst(c.x, c.y, 8, [K.white, K.silver], 8, { speed:36, life:0.4 });
  },
  a_boomerang(c){
    const base = Math.atan2(c.dy, c.dx);
    ring(c.x, c.y, 2, 16, 0.4, K.gold, 0.9);
    for(let i=0; i<12; i++){
      const a = base + i*0.5;
      spawn(c.x, c.y, 8, 0, 0, 0, 0.6, pick([K.gold, K.white, K.orange]),
        { mode:1, cx:c.x + c.dx*8, cy:c.y + c.dy*8, a, w:14, rad:7, vr:i*2.5, vz:0, size:i % 2, spin:6, delay:i*0.02 });
    }
    ringBurst(c.x, c.y, 8, K.white, 8, 36, { life:0.3 });
  },
  a_ricochet(c){
    let x = c.x, y = c.y, a = Math.atan2(c.dy, c.dx);
    for(let s=0; s<3; s++){          // zig-zag trail previewing the bounces
      const nx = x + cos(a)*20, ny = y + sin(a)*20;
      beam(x, y, 8, nx, ny, 8, K.purple, 0.3 + s*0.06);
      burst(nx, ny, 8, [K.purple, K.white], 5, { speed:30, life:0.35, delay:s*0.05 });
      x = nx; y = ny; a += s % 2 ? 1.2 : -1.2;
    }
    ring(c.x, c.y, 2, 14, 0.35, K.purple, 0.9);
  },
};

/* ----------------------------- class abilities ----------------------------- */
const CLS = {
  rogue(c){
    const bx = c.x - c.dx*95, by = c.y - c.dy*95;
    streak(bx, by, c.x, c.y, 6, [c.col, K.white, '#3a2a66'], 26, { life:0.6, s:7 });
    ring(bx, by, 2, 18, 0.5, c.col, 0.9);
    spiral(bx, by, 0, [c.col, K.white], 10, { r0:2, vr:16, w:10, vz:20, life:0.45 });
    ring(c.x, c.y, 2, 22, 0.5, c.col, 1);
    burst(c.x, c.y, 7, [c.col, K.white], 12, { speed:48 });
  },
  tank(c){
    for(let k=0; k<3; k++) ring(c.x, c.y, 4, 75, 0.5 + k*0.08, k === 0 ? K.white : c.col, 1, { delay:k*0.08, thick:k === 0 });
    scorch(c.x, c.y, 30, 1.8, '#05060c', { n:10, glow:c.col });
    burst(c.x, c.y, 1, [K.stone, K.brown, c.col], 16, { speed:80, up:1, bounce:0.5, mini:0.2, life:0.8 });
    ringBurst(c.x, c.y, 2, [K.dust, K.tan], 18, 56, { life:0.55, drag:3 });
  },
  scout(c){
    ring(c.x, c.y, 2, 18, 0.45, c.col, 1);
    fountain(c.x, c.y, 1, [c.col, K.white], 14, { speed:44, life:0.6 });
    chevronsForward(c, c.col, 3, 5);
    pillar(c.x, c.y, 16, c.col, 0.4, 2);
    for(let i=0; i<5; i++)
      streak(c.x - c.dx*(6+i*2), c.y - c.dy*(6+i*2), c.x - c.dx*(22+i*2), c.y - c.dy*(22+i*2), 3 + i, [c.col, K.white], 3, { life:0.4, s:2 });
  },
  trickster(c){
    burst(c.x, c.y, 6, [c.col, K.white, K.gold, K.teal, K.violet], 26, { speed:60, up:1.1, life:0.9, bounce:0.3, mini:0.3 });
    dust(c.x, c.y, 2, [c.col, K.white], 12, { speed:32, life:0.8 });
    ring(c.x, c.y, 3, 24, 0.5, c.col, 1);
    spiral(c.x, c.y, 0, [c.col, K.white], 8, { r0:3, vr:12, w:9, vz:22, life:0.5 });
  },
  trapper(c){
    rune(c.x, c.y, 30, 1.1, c.col, { n:8, spin:1.5 });
    ring(c.x, c.y, 4, 30, 0.5, K.lime, 0.9, { thick:true });
    for(let i=0; i<10; i++){         // thorny vines rise at the rim
      const a = i/10*TAU;
      for(let k=0; k<3; k++)
        spawn(c.x + cos(a)*28, c.y + sin(a)*28, k*3, 0, 0, 0, 0.8, k === 2 ? K.lime : c.col, { size:k === 2 ? 0 : 1, spin:0, delay:k*0.06 + i*0.02 });
    }
    burst(c.x, c.y, 2, [c.col, K.lime, K.green], 14, { speed:44, up:0.8 });
  },
  hunter(c){
    burst(c.x + c.dx*8, c.y + c.dy*8, 8, [K.gold, K.orange, K.white], 12, { speed:90, up:0.2, flat:1, life:0.3, drag:3 });
    beam(c.x + c.dx*6, c.y + c.dy*6, 8, c.x + c.dx*30, c.y + c.dy*30, 8, c.col, 0.18);
    ring(c.x, c.y, 2, 14, 0.3, c.col, 0.9);
    spawn(c.x - c.px*3, c.y - c.py*3, 9, -c.px*20, -c.py*20, 40, 0.8, K.gold, { grav:160, size:1, spin:8, bounce:0.5 });  // casing
  },
  phantom(c){
    const bx = c.x - c.dx*105, by = c.y - c.dy*105;
    for(let i=0; i<6; i++){          // ghost slices along the wall-crossing path
      const f = i/5;
      for(let k=0; k<4; k++)
        spawn(bx + (c.x-bx)*f, by + (c.y-by)*f, 2 + k*3.3, 0, 0, 4, 0.6, K.ice2, { size:1, spin:6, delay:f*0.15 });
    }
    streak(bx, by, c.x, c.y, 6, [K.ice2, K.white], 14, { life:0.6, s:4 });
    ring(bx, by, 2, 18, 0.5, K.ice2, 0.9);
    ring(c.x, c.y, 2, 20, 0.5, K.white, 0.9);
    spiral(c.x, c.y, 0, [K.ice2, K.white], 10, { ent:c.e, r0:6, vz:22, w:8, life:0.6 });
  },
  anchor(c){
    const x = c.aim.x, y = c.aim.y;
    spawn(x, y, 56, 0, 0, -170, 0.5, K.stone, { size:0, spin:0 });       // falling anchor weight
    spawn(x, y, 62, 0, 0, -170, 0.5, K.silver, { size:1, spin:0 });
    beam(c.x, c.y, 9, x, y, 14, K.stone, 0.45, 0.6);
    later(0.3, () => {
      ring(x, y, 4, 40, 0.5, c.col, 1, { thick:true });
      scorch(x, y, 16, 1.6, '#05060c', { n:7 });
      burst(x, y, 1, [K.stone, c.col, K.white], 14, { speed:60, up:1, bounce:0.4 });
      implode(x, y, 4, [c.col, K.silver], 14, 60, { life:0.7, spread:0.3 });
      rune(x, y, 70, 1.4, c.col, { n:6, spin:-1.5 });
    });
  },
  brawler(c){
    flames(c.x, c.y, 1, 16, { r:4 });
    dust(c.x - c.dx*3, c.y - c.dy*3, 1, [K.dust, K.tan], 12, { speed:36 });
    ring(c.x, c.y, 3, 22, 0.5, c.col, 1, { thick:true });
    chevronsForward(c, K.red, 3, 7);
    for(let k=0; k<2; k++)           // steam from the nose
      spawn(c.x + c.dx*4 + c.px*(k ? 1.5 : -1.5), c.y + c.dy*4 + c.py*(k ? 1.5 : -1.5), 11, c.dx*18, c.dy*18, 4, 0.5, K.white, { size:0, drag:2, delay:k*0.08 });
    burst(c.x, c.y, 2, [c.col, K.orange], 8, { speed:44 });
  },
  warden(c){
    ring(c.x, c.y, 3, 24, 0.6, c.col, 1, { thick:true });
    rune(c.x, c.y, 20, 0.9, c.col, { n:6, spin:2 });
    for(let s=0; s<2; s++){          // two slabs assemble out of cubes
      const a = s*Math.PI;
      for(let k=0; k<10; k++)
        spawn(c.x + cos(a)*30 + rnd(-8, 8), c.y + sin(a)*30 + rnd(-8, 8), rnd(0, 14), 0, 0, 0, 0.7, pick([c.col, K.white, K.lime]),
          { mode:1, cx:c.x, cy:c.y, ent:c.e, a:a + rnd(-0.2, 0.2), w:3.2, rad:20, vr:0, vz:0, size:k % 2, spin:4, delay:k*0.03 });
    }
    fountain(c.x, c.y, 8, [c.col, K.white], 8, { speed:30 });
  },
  skater(c){
    ring(c.x, c.y, 4, 48, 0.7, c.col, 1, { thick:true });
    ring(c.x, c.y, 2, 34, 0.55, K.white, 0.7, { delay:0.08, dot:true, spin:2 });
    disc(c.x, c.y, 10, 1.4, K.ice, 0.35, { r1:44 });
    burst(c.x, c.y, 2, [K.snow, K.ice2, K.white], 16, { speed:56, up:0.9, bounce:0.35, mini:0.3 });
    spiral(c.x, c.y, 0, [K.snow, c.col], 12, { r0:6, vr:30, w:9, vz:6, life:0.6, stagger:0.025 });
  },
  chrono(c){
    clock(c.x, c.y, 70, c.col, 1.2, false);
    shell(c.x, c.y, 0, [c.col, K.white, K.lime], 70, 52, 1.3, { size:1, squash:0.35 });
    ring(c.x, c.y, 4, 70, 0.7, c.col, 1, { thick:true });
    for(let i=0; i<12; i++)          // falling sand
      spawn(c.x + rnd(-3, 3), c.y + rnd(-3, 3), 18, 0, 0, -rnd(8, 20), 1.2, pick([K.gold, K.lime, K.white]), { size:1, spin:2, delay:i*0.06 });
    fountain(c.x, c.y, 2, [c.col, K.white], 8, { speed:30 });
  },
};

/* ------------------------------ public API ------------------------------ */
export function spawnAbilityFX(e, id, info){
  if(!e) return;
  try{
    const c = ctxOf(e, info);
    const f = AB[id];
    if(f){ f(c); return; }
    // unknown id: generic burst in the caster colour
    ring(c.x, c.y, 2, 18, 0.45, c.col, 0.9);
    burst(c.x, c.y, 6, [c.col, K.white], 12, { speed:44 });
  }catch(err){ warnOnce('ability:' + id, err); }
}

export function spawnClassFX(e, clsKey, info){
  if(!e) return;
  try{
    const c = ctxOf(e, info);
    const f = CLS[clsKey];
    if(f){ f(c); return; }
    ring(c.x, c.y, 2, 20, 0.45, c.col, 0.9);
    burst(c.x, c.y, 6, [c.col, K.white], 12, { speed:44 });
  }catch(err){ warnOnce('class:' + clsKey, err); }
}

const EV = {
  tag(x, y, o){
    const hc = o.hunterColor || K.red, pc = o.color || K.white;
    pillar(x, y, 28, K.white, 0.35, 3);
    ring(x, y, 3, 36, 0.5, K.white, 1, { thick:true });
    ring(x, y, 2, 26, 0.45, hc, 1, { delay:0.05 });
    ring(x, y, 2, 20, 0.4, pc, 1, { delay:0.1 });
    burst(x, y, 8, [hc, pc, K.white, K.gold], 30, { speed:90, up:1.1, life:0.8, bounce:0.4, mini:0.35 });
    for(let i=0; i<8; i++){          // starburst spokes
      const a = i/8*TAU + 0.2;
      beam(x, y, 8, x + cos(a)*20, y + sin(a)*20, 8, i % 2 ? K.white : hc, 0.22);
    }
  },
  stumble(x, y, o){
    for(let i=0; i<6; i++){
      const a = i/6*TAU;
      spawn(x, y, 14, cos(a)*18, sin(a)*18, rnd(24, 44), 0.8, i % 2 ? K.gold : '#fff4a8',
        { grav:90, size:i % 2, spin:9, bounce:0.2, drag:1 });
    }
    ring(x, y, 2, 16, 0.4, K.dust, 0.9);
    dust(x, y, 1, K.dust, 8, { speed:30 });
    if(o.dir) burst(x + o.dir.x*3, y + o.dir.y*3, 1, [K.dust, K.tan], 6, { speed:36, up:0.5 });
  },
  bump(x, y, o){
    const p = Math.min(2, o.power ?? 1);
    ring(x, y, 1, 10 + p*5, 0.3, K.white, 0.9);
    burst(x, y, 6, [K.white, K.gold, K.silver], 4 + (p*5 | 0), { speed:30 + p*18, up:0.6, life:0.4 });
    if(o.dir){
      beam(x, y, 7, x + o.dir.x*9, y + o.dir.y*9, 7, K.white, 0.12);
      beam(x, y, 7, x - o.dir.x*9, y - o.dir.y*9, 7, K.white, 0.12);
    }
  },
  landing(x, y, o){
    ring(x, y, 2, 20, 0.4, K.tan, 0.9);
    ringBurst(x, y, 1.5, [K.dust, K.tan, '#bdb5cc'], 12, 40, { life:0.45, drag:3 });
    dust(x, y, 1, K.dust, 6, { speed:20 });
  },
  dash(x, y, o){
    const d = o.dir ? unit(o.dir.x, o.dir.y) : { x:1, y:0 }, col = o.color || K.white;
    const px = -d.y, py = d.x;
    for(let i=0; i<10; i++){
      const back = rnd(2, 20), side = rnd(-5, 5);
      spawn(x - d.x*back + px*side, y - d.y*back + py*side, rnd(2, 10), -d.x*rnd(10, 30), -d.y*rnd(10, 30), 0, rnd(0.25, 0.45),
        i % 2 ? col : K.white, { size:i % 3 === 0 ? 0 : 1, drag:2, spin:4 });
    }
    for(let k=-1; k<=1; k+=2)
      streak(x - d.x*4 + px*k*4, y - d.y*4 + py*k*4, x - d.x*22 + px*k*4, y - d.y*22 + py*k*4, 6, [col, K.white], 4, { life:0.3, s:1 });
    dust(x, y, 1, K.dust, 4, { speed:18 });
    ring(x, y, 2, 13, 0.3, col, 0.8);
  },
  skid(x, y, o){
    const d = o.dir ? unit(o.dir.x, o.dir.y) : { x:1, y:0 };
    for(let i=0; i<5; i++)
      spawn(x, y, 1, d.x*rnd(10, 40) + rnd(-12, 12), d.y*rnd(10, 40) + rnd(-12, 12), rnd(4, 14), rnd(0.25, 0.45),
        pick([K.dust, K.tan, '#bdb5cc']), { drag:3, size:i % 2 ? 1 : 0, grav:20, spin:3 });
    gline(x, y, x - d.x*8, y - d.y*8, 0.4, K.dust);
  },
  pickup(x, y, o){
    const col = o.color || K.gold;
    ring(x, y, 2, 18, 0.45, col, 1);
    fountain(x, y, 3, [col, K.white], 12, { speed:42, life:0.7 });
    spiral(x, y, 0, [col, K.white], 8, { r0:6, vr:-6, w:9, vz:30, life:0.6, stagger:0.025 });
  },
  rare(x, y, o){
    const col = o.color || K.gold;
    pillar(x, y, 46, col, 1.1, 4);
    for(let k=0; k<3; k++) ring(x, y, 3, 34 + k*8, 0.7 + k*0.1, k === 1 ? K.white : col, 1, { delay:k*0.1, thick:k === 0 });
    rune(x, y, 20, 1.2, col, { n:6, spin:2.5 });
    spiral(x, y, 0, [col, K.white, K.gold], 28, { r0:12, vr:-6, w:8, vz:34, life:1.0, stagger:0.03 });
    burst(x, y, 4, [col, K.white, K.gold, K.pink, K.teal], 30, { speed:76, up:1.5, life:1.0, bounce:0.4 });
  },
  thaw(x, y, o){
    ring(x, y, 3, 30, 0.6, K.ice2, 1, { thick:true });
    burst(x, y, 7, [K.snow, K.ice2, K.white, K.ice], 26, { speed:70, up:1.2, life:0.9, bounce:0.45, mini:0.3 });
    dust(x, y, 2, [K.snow, K.white], 10, { speed:22, life:0.9 });
    pillar(x, y, 20, K.ice2, 0.5, 3);
  },
  deflect(x, y, o){
    ring(x, y, 3, 26, 0.5, K.gold, 1, { thick:true });
    for(let i=0; i<10; i++){
      const a = i/10*TAU;
      spawn(x + cos(a)*10, y + sin(a)*10, 7, cos(a)*60, sin(a)*60, 0, 0.45, i % 2 ? K.white : K.gold, { drag:2.5, size:0, spin:5 });
    }
    if(o.dir) for(let i=0; i<6; i++)
      spawn(x, y, 8, o.dir.x*rnd(60, 130) + rnd(-12, 12), o.dir.y*rnd(60, 130) + rnd(-12, 12), 0, 0.4, K.white, { size:1, drag:2, spin:6 });
    burst(x, y, 8, [K.gold, K.white], 10, { speed:50, life:0.5 });
  },
  trapTrigger(x, y, o){
    switch(o.kind){
      case 'mine':
        pillar(x, y, 20, K.orange, 0.3, 3);
        ring(x, y, 2, 34, 0.45, K.orange, 1, { thick:true });
        burst(x, y, 2, [K.orange, K.gold, K.red, K.white], 20, { speed:70, up:1.2, life:0.7 });
        scorch(x, y, 16, 1.6, '#05060c', { n:7, glow:K.orange });
        break;
      case 'spring':
        for(let k=0; k<4; k++) ring(x, y, 12, 5, 0.5, K.gold, 1, { z:k*3, delay:k*0.04, dot:true });
        fountain(x, y, 2, [K.gold, K.orange, K.white], 16, { speed:75 });
        break;
      case 'snare':
        ring(x, y, 2, 18, 0.5, K.olive, 1, { thick:true });
        for(let i=0; i<8; i++){
          const a = i/8*TAU;
          for(let k=0; k<3; k++) spawn(x + cos(a)*9, y + sin(a)*9, k*3, 0, 0, 0, 0.9, k === 2 ? K.lime : K.olive, { size:k === 2 ? 0 : 1, delay:k*0.04 + i*0.02 });
        }
        burst(x, y, 2, [K.olive, K.lime], 10, { speed:36 });
        break;
      case 'trip':
        beam(x - 10, y + 10, 3, x + 10, y - 10, 3, K.white, 0.25, 1.5);
        eventStars(x, y);
        ring(x, y, 2, 20, 0.4, K.lime, 1);
        break;
      case 'pad':
        for(let k=0; k<3; k++) ring(x, y, 8, 22, 0.5, K.teal, 1, { z:k*3, delay:k*0.05 });
        fountain(x, y, 2, [K.teal, K.white], 10, { speed:55 });
        break;
      default:
        ring(x, y, 2, 24, 0.45, K.orange, 1);
        burst(x, y, 3, [K.orange, K.white], 12, { speed:50 });
    }
  },
  wellPulse(x, y, o){
    const r = o.r || 55, col = o.color || (o.kind === 'tether' ? K.violet : K.purple);
    if(o.kind === 'tether'){
      ring(x, y, r*0.9, r, 0.5, col, 0.9, { dot:true, spin:2 });
      burst(x + cos(Math.random()*TAU)*r, y + sin(Math.random()*TAU)*r, 4, col, 4, { speed:16, life:0.4 });
    } else {
      ring(x, y, r, 6, 0.6, col, 0.9, { ease:'lin', dot:true, spin:-1.5 });
      implode(x, y, 4, [col, K.white], 8, r, { life:0.6, spread:0.15, acc:220 });
    }
  },
  strikeImpact(x, y, o){
    const r = o.r || 52, col = o.color || K.gold;
    lightningBolt(x, y, col);
    pillar(x, y, 52, K.white, 0.4, 5);
    ring(x, y, 4, r, 0.5, K.white, 1, { thick:true });
    ring(x, y, 2, r*0.7, 0.45, col, 1, { delay:0.06 });
    disc(x, y, r*0.4, 0.4, K.white, 0.45, { r1:r });
    scorch(x, y, r*0.55, 2.2, '#05060c', { n:11, glow:col });
    burst(x, y, 1, [K.stone, K.brown, col, K.white], 22, { speed:95, up:1.2, bounce:0.5, mini:0.25, life:0.9 });
    ringBurst(x, y, 2, [K.dust, K.tan], 20, r*1.1, { life:0.55, drag:3 });
  },
};
function eventStars(x, y){
  for(let i=0; i<5; i++){
    const a = i/5*TAU;
    spawn(x, y, 12, cos(a)*14, sin(a)*14, rnd(20, 40), 0.7, i % 2 ? K.gold : '#fff4a8', { grav:90, size:1, spin:8, bounce:0.2 });
  }
}

export function spawnEventFX(kind, x, y, opts){
  try{
    const f = EV[kind];
    const o = opts || EMPTY;
    if(f){ f(x, y, o); return; }
    ring(x, y, 2, 18, 0.4, K.white, 0.9);
    burst(x, y, 6, [o.color || K.white, K.gold], 10, { speed:40 });
  }catch(err){ warnOnce('event:' + kind, err); }
}

/* =========================================================================
   ENTITY AURAS  - persistent, stateless (driven only by `t`) passive tells and
   status effects. Called twice per fighter: front=false behind the sprite
   (floor rings, halos, far-side orbiters), front=true in front of it.
   ========================================================================= */
let _ctx = null, _e = null, _front = false, _t = 0, _ba = 1;
let _ex = 0, _ey = 0, _bz = 0, _dx = 1, _dy = 0, _px = 0, _py = 1, _fa = 0, _spd = 0, _col = K.white;

// Which side of the sprite a point at (x,y) is on (further = behind, nearer = in front).
function sideOk(x, y){ return ((x + y) - (_ex + _ey) >= 0) === _front; }

function aMini(x, y, z, color, a, f){
  if(!sideOk(x, y)) return;
  scr(x, y, z);
  if(a !== undefined && a < 1){ _ctx.globalAlpha = _ba*a; blitMini(_ctx, color, S.x, S.y, f || 0); _ctx.globalAlpha = _ba; }
  else blitMini(_ctx, color, S.x, S.y, f || 0);
}
function aCube(x, y, z, color, a, f){
  if(!sideOk(x, y)) return;
  scr(x, y, z);
  if(a !== undefined && a < 1){ _ctx.globalAlpha = _ba*a; blitBig(_ctx, color, S.x, S.y, f || 0); _ctx.globalAlpha = _ba; }
  else blitBig(_ctx, color, S.x, S.y, f || 0);
}
function aPix(x, y, z, color){
  if(!sideOk(x, y)) return;
  scr(x, y, z);
  _ctx.fillStyle = sprites(color).px;
  _ctx.fillRect(S.x, S.y, 1, 1);
}
/** Screen-space mini above/beside the head (front pass only). ox/oy are px offsets. */
function hudMini(color, ox, oy, zz, a, f){
  if(!_front) return;
  scr(_ex, _ey, _bz + zz);
  if(a !== undefined && a < 1){ _ctx.globalAlpha = _ba*a; blitMini(_ctx, color, S.x + ox, S.y + oy, f || 0); _ctx.globalAlpha = _ba; }
  else blitMini(_ctx, color, S.x + ox, S.y + oy, f || 0);
}
function hudCube(color, ox, oy, zz, a, f){
  if(!_front) return;
  scr(_ex, _ey, _bz + zz);
  if(a !== undefined && a < 1){ _ctx.globalAlpha = _ba*a; blitBig(_ctx, color, S.x + ox, S.y + oy, f || 0); _ctx.globalAlpha = _ba; }
  else blitBig(_ctx, color, S.x + ox, S.y + oy, f || 0);
}
function gRing(r, color, a){ if(!_front) groundRing(_ctx, _ex, _ey, r, color, a ?? 1); }
function gDisc(r, color, a){ if(!_front) groundDisc(_ctx, _ex, _ey, r, color, a ?? 1); }
function gDots(r, color, spin, a, n){
  if(_front) return;
  _ctx.globalAlpha = _ba*(a ?? 1);
  dotRing(_ctx, _ex, _ey, 0, r, color, n || (r*0.9 + 6), spin, false);
  _ctx.globalAlpha = _ba;
}
function gArc(r, a0, a1, color, a){ if(!_front) groundArc(_ctx, _ex, _ey, r, a0, a1, color, a ?? 1); }
/** Orbiting cube/mini around the body. */
function orb(i, n, rad, z, speed, color, big, phase){
  const a = _t*speed + i*TAU/n + (phase || 0);
  const x = _ex + cos(a)*rad, y = _ey + sin(a)*rad;
  if(big) aCube(x, y, _bz + z, color, undefined, (_t*6 + i) | 0);
  else aMini(x, y, _bz + z, color, undefined, (_t*6 + i) | 0);
}
/** Procedural rising particles. o:{down,big,z0,wob,seed,back,fade} */
function rise(n, color, rate, h, rad, o){
  o = o || EMPTY;
  const seed = o.seed || 0, z0 = o.z0 ?? 0, wob = o.wob ?? 1.5;
  for(let i=0; i<n; i++){
    const ph = fract(_t*rate + i/n + seed + i*0.13);
    const ang = i*2.399 + _t*wob;
    const rr = rad*(1 - 0.35*ph) + (o.back ? o.back*ph : 0);
    const x = _ex + cos(ang)*rr - (o.back ? _dx*o.back*ph : 0), y = _ey + sin(ang)*rr - (o.back ? _dy*o.back*ph : 0);
    const z = _bz + z0 + (o.down ? h*(1-ph) : h*ph);
    const al = ph > 0.7 ? (1-ph)/0.3 : (ph < 0.12 ? ph/0.12 : 1);
    const col = Array.isArray(color) ? color[i % color.length] : color;
    if(o.big) aCube(x, y, z, col, al, i); else aMini(x, y, z, col, al, i);
  }
}
function speedLines(n, color, len, o){
  if(!_front) return;
  o = o || EMPTY;
  const col = sprites(color).px;
  for(let i=0; i<n; i++){
    const ph = fract(_t*(o.rate ?? 4) + i/n);
    const side = (i - (n-1)/2)*(o.gap ?? 2.5);
    const b0 = 3 + ph*(o.dist ?? 14), b1 = b0 + len;
    scr(_ex - _dx*b0 + _px*side, _ey - _dy*b0 + _py*side, _bz + (o.z ?? 5) + (i % 2)*2.5);
    const x0 = S.x, y0 = S.y;
    scr(_ex - _dx*b1 + _px*side, _ey - _dy*b1 + _py*side, _bz + (o.z ?? 5) + (i % 2)*2.5);
    _ctx.globalAlpha = _ba*(1-ph)*(o.alpha ?? 0.9);
    pixelLine(_ctx, x0, y0, S.x, S.y, col);
  }
  _ctx.globalAlpha = _ba;
}
/** Chevron "V" of minis pointing along (dx,dy). */
function chev(x, y, z, dx, dy, color, s, a){
  const px = -dy, py = dx;
  aMini(x, y, z, color, a, 0);
  aMini(x - dx*s + px*s, y - dy*s + py*s, z, color, a, 1);
  aMini(x - dx*s - px*s, y - dy*s - py*s, z, color, a, 1);
}
function tagR(e){       // mirrors physics.tagRadius (display only)
  const m = e.mods;
  let mult = m.tagRadiusMult * (e.tagBuffT > 0 ? e.tagBuffMult : 1);
  if(m.deathsTouch && state.round){
    const elapsed = (state.round.duration || ROUND_TIME) - state.round.timer;
    mult += 0.02*Math.floor(elapsed/15);
  }
  let r = RADIUS*2*mult;
  if(e.slideT > 0) r *= 1.25;
  if(e.pounceT > 0) r *= 1.5;
  r += m.momentumReach*3*Math.max(0, Math.min(1, _spd/250));
  return r;
}

/* ----- passive "charm belt": passives without a bespoke tell orbit the feet as small gems ----- */
const CHARM = {
  p_swift:K.teal, p_lungs:K.blue, p_breath:K.ice2, p_reach:K.red, p_feather:K.lime, p_momentum:K.violet,
  p_edge:K.gold, p_escape:K.white, p_skin:K.orange, p_quick:K.gold, p_packrat:K.brown, p_hound:K.red,
  p_adrenal:K.red, p_scav:K.green, p_instinct:K.lime, p_zonerun:K.lime, p_camo:K.green, p_night:K.purple,
  p_lucky:K.pink, p_oppo:K.red, p_ghostwt:K.ice2, p_laststand:K.red, p_chaos:K.pink, p_deaths:K.violet,
  p_compass:K.gold, p_pacing:K.teal, p_quickstart:K.orange, p_footwork:K.blue, p_shakeoff:K.green,
  p_anchorpt:'#5c6b9b', p_boots:K.stone, p_double:K.teal, p_windup:K.orange, p_static:K.gold,
  p_boiling:K.orange, p_privil:K.gold, p_divine:K.white, p_glass:K.ice, p_lunge:K.red,
};
/* artifacts orbit at chest height as little relics: colour per id */
const RELIC = {
  x_heart:K.red, x_claw:K.gold, x_latch:K.ice2, x_flask:K.teal, x_stopwatch:K.gold, x_chalk:K.silver,
  x_ironlung:K.teal, x_spurs:K.orange, x_horseshoe:K.green, x_gland:K.red,
  x_stridespikes:K.blue, x_stridevest:K.blue, x_stridebands:K.blue,
  x_bulwarkpad:K.stone, x_bulwarkplate:K.stone, x_bulwarkgreave:K.stone,
};

export function drawEntityAuras(ctx, e, t, front){
  if(!e || e.isDecoy || !e.mods) return;
  _ctx = ctx; _e = e; _front = !!front; _t = t; _ba = ctx.globalAlpha;
  grabCamera();
  _ex = e.x; _ey = e.y;
  _bz = e.airT > 0 ? 6*sin(Math.PI*(1 - e.airT/(e.airT0 || e.airT))) : (e.dashBurstT > 0 ? 2 : 0);
  _spd = Math.hypot(e.vx || 0, e.vy || 0);
  const lm = e.lastMoveDir || { x:1, y:0 };
  const dv = _spd > 8 ? unit(e.vx, e.vy) : ((lm.x || lm.y) ? unit(lm.x, lm.y) : { x:1, y:0 });
  _dx = dv.x; _dy = dv.y; _px = -dv.y; _py = dv.x; _fa = Math.atan2(_dy, _dx);
  _col = (e.cls && e.cls.color) || K.white;
  ctx.imageSmoothingEnabled = false;

  const m = e.mods;
  const ps = (e.build && e.build.passives) || EMPTY;
  const ar = (e.build && e.build.artifacts) || EMPTY;
  const has = id => ps.includes(id);

  statusAuras(e, m);
  passiveAuras(e, m, has);
  artifactAuras(e, m, ar);
  charmBelt(ps);

  ctx.globalAlpha = _ba;
}

/* ---------------------------------- statuses ---------------------------------- */
function statusAuras(e, m){
  const t = _t;

  if(e.stumbleT > 0){                      // orbiting stars + dust
    for(let i=0; i<3; i++){
      const a = t*7 + i*2.094;
      aMini(_ex + cos(a)*5.5, _ey + sin(a)*5.5, _bz + 14.5 + sin(t*9 + i)*0.8, i % 2 ? K.gold : '#fff4a8', undefined, (t*10 + i) | 0);
    }
    rise(3, K.dust, 2.2, 5, 5);
  }
  if(e.slideT > 0){                        // dust spray + scrape marks
    for(let i=0; i<9; i++){
      const ph = fract(t*5 + i/9), back = 3 + ph*15, side = sin(i*5.1)*3.2;
      aMini(_ex - _dx*back + _px*side, _ey - _dy*back + _py*side, _bz + 0.5 + ph*(3 + 3*sin(i + 1)),
        i % 3 === 0 ? K.tan : (i % 3 === 1 ? K.dust : '#bdb5cc'), 1 - ph, i);
    }
    if(_front){
      for(const s of [-1.5, 1.5]){
        scr(_ex + _px*s, _ey + _py*s, 0); const x0 = S.x, y0 = S.y;
        scr(_ex - _dx*20 + _px*s, _ey - _dy*20 + _py*s, 0);
        _ctx.globalAlpha = _ba*0.6; pixelLine(_ctx, x0, y0, S.x, S.y, '#05060c'); _ctx.globalAlpha = _ba;
      }
    }
  }
  if(e.airT > 0){                          // hover glow + down-draft
    gDisc(5, K.ice2, 0.22 + 0.08*sin(t*6));
    gRing(5 + 4*fract(t*2), K.ice2, 0.7);
    for(let i=0; i<4; i++){
      const ph = fract(t*2.4 + i*0.25), a = i*1.7 + t;
      aMini(_ex + cos(a)*3, _ey + sin(a)*3, _bz*(1-ph), i % 2 ? K.white : K.teal, 1 - ph, i);
    }
  }
  if(e.braceT > 0){                        // plates in front
    for(let j=-2; j<=2; j++){
      const a = _fa + j*0.36, rr = 7 + sin(t*10 + j)*0.3;
      aCube(_ex + cos(a)*rr, _ey + sin(a)*rr, _bz + 4, K.stone, undefined, 0);
      aCube(_ex + cos(a)*rr, _ey + sin(a)*rr, _bz + 8, K.silver, undefined, 0);
    }
  }
  if(e.rushT > 0){                         // bull rush: red-orange speed + dust
    gRing(8 + 1.5*sin(t*14), K.red, 0.8);
    speedLines(5, K.orange, 12, { rate:5 });
    speedLines(3, K.white, 8, { rate:6, gap:4, z:8 });
    rise(6, [K.dust, K.tan], 2.8, 7, 5, { back:10 });
  }
  if(e.stampedeT > 0){                     // stampede: hooves, horns, big dust
    gRing(11, K.brown, 0.6 + 0.2*sin(t*12));
    gDots(13, K.gold, t*0.5, 0.5);
    rise(8, [K.brown, K.tan, K.dust], 2.2, 8, 7, { back:12, big:true });
    speedLines(4, K.gold, 12, { rate:4.5, gap:3 });
    for(const s of [-1, 1]) aCube(_ex + _px*3.2*s + _dx*1, _ey + _py*3.2*s + _dy*1, _bz + 14, '#f1e6c8', undefined, 0);
  }
  if(e.overdriveT > 0){                    // engine flames
    rise(10, [K.red, K.orange, K.gold, K.fire], 2.4, 16, 5, { wob:3 });
    gRing(8 + sin(t*18), K.orange, 0.7);
    for(const s of [-1, 1])               // exhaust jets
      aMini(_ex - _dx*5 + _px*2*s, _ey - _dy*5 + _py*2*s, _bz + 7 + sin(t*30 + s)*0.8, K.fire, undefined, (t*20) | 0);
  }
  if(e.pacerT > 0){                        // metronome ring + puffs
    gDots(9, K.teal, t*1.2, 0.5, 8);
    rise(3, K.white, 1.8, 3, 3, { back:9 });
    hudMini(K.teal, ((t*4)|0) % 2 ? -6 : 6, 0, 16, 0.9, 0);
  }
  if(e.gripT > 0){                         // chalk + cleats
    rise(4, K.white, 1.6, 5, 4.5);
    for(let i=0; i<4; i++){
      const a = i*TAU/4 + 0.4;
      aMini(_ex + cos(a)*3.5, _ey + sin(a)*3.5, _bz + 0.5, K.silver, undefined, i);
    }
  }
  if(e.counterT > 0){                      // mirror stance
    gRing(11, K.silver, 0.8);
    gDots(12.5, K.white, -t*1.5, 0.7, 12);
    for(let i=0; i<8; i++) orb(i, 8, 9, 7 + sin(t*5 + i)*0.6, 2.6, i % 2 ? K.white : K.silver, true);
  }
  if(e.chillStacks > 0){                   // snowflake cubes + drifting snow
    const n = Math.min(5, e.chillStacks);
    for(let i=0; i<n; i++){
      const a = t*1.8 + i*TAU/n;
      aCube(_ex + cos(a)*7, _ey + sin(a)*7, _bz + 15.5 + sin(t*3 + i), K.snow, undefined, (t*3 + i) | 0);
    }
    rise(n + 1, K.white, 0.9, 12, 6, { z0:2, down:true });
  }
  if(e.shieldT > 0){                       // bubble of cubes
    gRing(11, K.ice2, 0.5 + 0.2*sin(t*5));
    for(let i=0; i<18; i++){
      const u = 1 - 2*(i + 0.5)/18, rr = Math.sqrt(1 - u*u), th = i*2.399 + t*1.5;
      aMini(_ex + cos(th)*rr*9, _ey + sin(th)*rr*9, _bz + 7 + u*9, i % 4 === 0 ? K.white : K.ice2, 0.55 + 0.35*sin(t*6 + i), i);
    }
  }
  if(e.markedT > 0){                       // floating red diamond
    const z = 19 + sin(t*3)*1.2, bl = 0.65 + 0.35*sin(t*10);
    hudCube(K.red, 0, 0, z, bl, 0);
    hudMini(K.red, 0, -4, z, bl, 0);
    hudMini(K.red, 0, 4, z, bl, 1);
    hudMini(K.red, -6, 0, z, bl, 0);
    hudMini(K.red, 6, 0, z, bl, 1);
    gRing(9 + sin(t*6), K.red, 0.4);
  }
  if(e.stunT > 0){                         // stun spiral
    for(let i=0; i<8; i++){
      const ph = i/8, a = t*9 + ph*TAU*1.5, rr = 2 + ph*4;
      aMini(_ex + cos(a)*rr, _ey + sin(a)*rr, _bz + 12.5 + ph*4, i % 2 ? K.gold : K.white, undefined, i);
    }
  }
  if(e.frozen){                            // ice glints
    for(let i=0; i<7; i++){
      const ph = fract(t*0.9 + i*0.19);
      if(ph > 0.3) continue;
      const a = i*2.1 + 1, rr = 4.5, z = 1 + ((i*5.3) % 12);
      aMini(_ex + cos(a)*rr, _ey + sin(a)*rr, _bz + z, K.white, undefined, 0);
      if(_front){ scr(_ex + cos(a)*rr, _ey + sin(a)*rr, _bz + z); aPixCross(S.x, S.y); }
    }
    gDots(9, K.ice2, t*0.3, 0.35, 10);
  }
  if(e.intangibleT > 0) rise(9, [K.ice2, K.white, K.violet], 1.4, 14, 5, { wob:2.5 });
  if(e.smokeT > 0) rise(5, [K.stone, '#a3abc7'], 0.8, 10, 6, { big:true });
  if(e.invisT > 0) rise(4, K.white, 1.1, 12, 5, { wob:3 });
  if(e.slowDebuffT > 0){                   // heavy drips + sluggish ring
    rise(3, [K.brown, K.dust], 0.9, 10, 4, { z0:3, down:true });
    gDots(8, K.stone, -t*0.4, 0.4, 8);
    hudMini(K.dust, -3, 0, 18, 0.9, 0); hudMini(K.dust, 3, 0, 18, 0.9, 1);
    hudMini(K.dust, 0, 3, 18 - 1, 0.9, 0);
  }
  if(e.blindT > 0){                        // flash spots round the head
    for(let i=0; i<4; i++) orb(i, 4, 3.8, 11 + sin(t*8 + i), 9, K.white, false);
  }
  if(e.wardT > 0){                         // reversal ward
    gRing(12, K.violet, 0.7);
    gDots(13.5, K.silver, -t, 0.6, 10);
    for(let i=0; i<4; i++){
      const a = -t*2.4 + i*TAU/4;
      aCube(_ex + cos(a)*11, _ey + sin(a)*11, _bz + 4, '#c9b0ff', undefined, i);
    }
  }
  if(e.frostT > 0){                        // cold mist
    gDots(14, K.ice, t*0.6, 0.5, 14);
    rise(4, [K.snow, K.ice2], 0.8, 8, 7, { z0:1 });
  }
  if(e.puddleT > 0) rise(3, [K.brown, '#c58f3d'], 1.3, 3, 2, { down:true, z0:0, back:10 });
  if(e.magnetT > 0){                       // inward pulses
    for(let k=0; k<2; k++){
      const ph = fract(t*0.9 + k*0.5), r = 36*(1-ph) + 4;
      gDots(r, k ? K.blue : K.red, 0, Math.sin(ph*Math.PI)*0.8, r*0.8 + 6);
    }
  }
  if(e.deflectArmed){                      // guard arcs
    const a = t*0.8;
    gArc(13, a - 0.6, a + 0.6, K.gold, 0.7);
    gArc(13, a + Math.PI - 0.6, a + Math.PI + 0.6, K.gold, 0.7);
    aCube(_ex + cos(a)*13, _ey + sin(a)*13, _bz + 6, K.gold, undefined, 0);
    aCube(_ex - cos(a)*13, _ey - sin(a)*13, _bz + 6, K.gold, undefined, 0);
  }
  if(e.absorbT > 0){                       // thick hide
    gDots(8, K.orange, t*0.7, 0.5, 9);
    for(let i=0; i<6; i++) orb(i, 6, 6.5, 3 + (i % 3)*3, 1.4, i % 2 ? K.orange : '#c97b2e', false);
  }
  if(e.surgeT > 0){
    speedLines(4, K.red, 12, { rate:5 });
    rise(5, [K.red, K.orange], 3, 9, 4, { back:8 });
  }
  if(e.tagBuffT > 0) gDots(tagR(e), K.red, t*1.2, 0.35 + 0.15*sin(t*6));
  if(e.pierceT > 0){                       // needle ahead of the hands
    for(let i=0; i<5; i++){
      const d = 5 + i*2.4;
      aMini(_ex + _dx*d, _ey + _dy*d, _bz + 6.5, i === 4 ? K.white : '#ffd6dd', 0.6 + 0.4*sin(t*14 + i), i);
    }
  }
  if(e.seeThroughT > 0){                   // glinting eyes + radar ping
    const bl = fract(t*0.8) < 0.1 ? 0.2 : 1;
    aMini(_ex + _dx*3 + _px*1.5, _ey + _dy*3 + _py*1.5, _bz + 10.5, K.white, bl, 0);
    aMini(_ex + _dx*3 - _px*1.5, _ey + _dy*3 - _py*1.5, _bz + 10.5, K.white, bl, 0);
    gDots(8 + 22*fract(t*0.9), K.orange, 0, 0.6*(1 - fract(t*0.9)), 12);
  }
  if(e.speedBuffT > 0){
    for(let i=0; i<2; i++){
      const d = 5 + i*5 + fract(t*3)*3;
      chev(_ex - _dx*d, _ey - _dy*d, _bz + 6, _dx, _dy, K.gold, 1.5, 1 - i*0.4);
    }
  }
  if(e.revealT > 0){                       // spotter drone
    const a = t*1.4;
    aCube(_ex + cos(a)*8, _ey + sin(a)*8, _bz + 20 + sin(t*4), K.pink, undefined, (t*5) | 0);
    aMini(_ex + cos(a)*8, _ey + sin(a)*8, _bz + 18 + sin(t*4), K.white, 0.7, 0);
  }
  if(e.ghostTrailCharge){
    for(let i=0; i<3; i++) aMini(_ex - _dx*(4 + i*3.5), _ey - _dy*(4 + i*3.5), _bz + 6 + sin(t*5 + i)*1.2, K.ice2, 0.7 - i*0.2, i);
  }
  if(e.wallbreakCharge){
    for(let i=0; i<3; i++) orb(i, 3, 5.5, 6 + sin(t*6 + i), 6, i % 2 ? K.brown : K.orange, false);
  }
  if(e.brandT > 0){                        // brand rune contracts with the timer
    const k = e.brandT/3, r = 6 + 34*k;
    gDots(r, K.orange, t*1.5, 0.85, r*0.9 + 6);
    gRing(r*0.7, K.red, 0.6);
    rise(3, [K.red, K.orange, K.gold], 1.8, 12, 5);
  }
  if(e.beamChargeT > 0 && e.beamDir){      // siphon beam charge line
    const k = 1 - e.beamChargeT/0.6, L = 160*k, bd = e.beamDir;
    gDots(10, K.pink, t*4, 0.8, 10);
    if(_front){
      const n = Math.max(2, (L/5) | 0);
      for(let i=1; i<=n; i++){
        const f = i/n;
        scr(_ex + bd.x*L*f, _ey + bd.y*L*f, _bz + 7);
        blitMini(_ctx, i % 3 ? K.pink : K.white, S.x, S.y, i);
      }
    }
  }
  if(e.fatigued){                          // sweat + heavy breathing
    rise(3, K.ice2, 1.3, 9, 4, { z0:3, down:true, wob:2 });
    hudMini(K.ice2, ((t*3)|0) % 2 ? -7 : 7, 2, 11, 0.8, 0);
  } else if(e.sprintActive){
    speedLines(2, _col, 10, { rate:5, alpha:0.5, z:3 });
  }
  if(e.dashBurstT > 0){                    // dash blur
    for(let i=0; i<5; i++){
      const d = 3 + i*3.2;
      aMini(_ex - _dx*d, _ey - _dy*d, _bz + 5 + sin(t*18 + i)*1.2, i % 2 ? _col : K.white, 0.85 - i*0.15, i);
    }
  }
  if(e.dashIframe > 0 && sin(t*40) > 0){   // i-frame flicker
    for(let i=0; i<4; i++) aMini(_ex + cos(i*1.6)*4.5, _ey + sin(i*1.6)*4.5, _bz + 3 + i*3, K.white, 0.7, i);
  }
  if(e.pounceT > 0){                       // claws + extended reach
    for(let k=-1; k<=1; k++){
      for(let i=0; i<4; i++){
        const d = 7 + i*3;
        aMini(_ex + _dx*d + _px*k*3, _ey + _dy*d + _py*k*3, _bz + 7, k === 0 ? K.white : K.red, 0.9 - i*0.15, i);
      }
    }
    gDots(tagR(e), K.red, t*2, 0.3);
  }
  if(e.kickT > 0) rise(7, [K.gold, K.orange, K.white], 3.5, 8, 6);
  if(e.slingT > 0){
    rise(8, [K.blue, K.white], 3, 10, 5, { back:10 });
    speedLines(4, K.blue, 12, { rate:6 });
  }
  if(m.iceAffinity && _spd > 25) rise(3, [K.snow, K.ice2], 1.2, 4, 5, { z0:0 });
}
function aPixCross(sx, sy){
  _ctx.fillStyle = '#ffffff';
  _ctx.fillRect(sx - 2, sy, 5, 1);
  _ctx.fillRect(sx, sy - 2, 1, 5);
}

/* ---------------------------------- passives ---------------------------------- */
function passiveAuras(e, m, has){
  const t = _t;

  // ---- existing build-defining passives ----
  if(e.lustStacks > 0){                    // BLOODY LUST: heat ring + embers
    const r = 9 + e.lustStacks*1.2 + sin(t*7)*0.8;
    gRing(r, K.red, 0.25 + 0.13*e.lustStacks);
    rise(Math.min(6, e.lustStacks + 1), [K.red, K.orange], 1.6, 12, r*0.8);
  }
  if(m.apotheosisSets > 0 || m.apotheosis){// APOTHEOSIS: golden halo cubes, one per set
    const n = Math.max(1, m.apotheosisSets || 0);
    for(let i=0; i<n; i++) orb(i, n, 10, 14 + sin(t*2 + i)*0.8, 1.1, K.gold, true);
    if(m.apotheosisSets > 0) hudMini(K.white, 0, 0, 16 + sin(t*4)*0.8, 0.4 + 0.3*sin(t*5), 0);
  }
  if(m.brittleBones || m.sprintMax < 90){  // fracture lines on the shadow
    const flash = e.stunT > 0 || sin(t*2.2) > 0.93;
    if(!_front){
      const col = e.stunT > 0 ? '#ff5470' : 'rgba(255,84,112,0.55)';
      if(flash || m.brittleBones){
        _ctx.globalAlpha = _ba*(flash ? 1 : 0.35);
        for(let i=0; i<3; i++){
          const a = i*2.1 + 0.5;
          scr(_ex + cos(a)*2, _ey + sin(a)*2, 0); const x0 = S.x, y0 = S.y;
          scr(_ex + cos(a + 0.35)*7, _ey + sin(a + 0.35)*7, 0); const x1 = S.x, y1 = S.y;
          pixelLine(_ctx, x0, y0, x1, y1, col);
          scr(_ex + cos(a - 0.2)*10, _ey + sin(a - 0.2)*10, 0);
          pixelLine(_ctx, x1, y1, S.x, S.y, col);
        }
        _ctx.globalAlpha = _ba;
      }
    }
  }
  if(m.noSprint && e === state.player) gDots(tagR(e), K.gold, t*0.5, 0.18);   // MOM'S GRIP reach
  if(e.pickupStacks > 0){                  // QUICKSILVER ticks
    const n = Math.min(e.pickupStacks, 6);
    for(let i=0; i<n; i++) hudMini(K.teal, -7 + i*3, 4 - sin(t*4 + i)*1.2, 16, undefined, i);
  }

  // ---- new passives ----
  if(has('p_grip')){                       // chalk puffs; ring of chalk at rest
    if(_spd > 20) rise(3, K.white, 1.4, 4, 3.5, { back:8 });
    else gDots(7, K.silver, 0, 0.35 + 0.15*sin(t*3), 8);
  }
  if(has('p_ballast')){                    // anchor-weight ring
    gRing(8, K.stone, 0.55);
    for(let i=0; i<4; i++){
      const a = t*0.5 + i*TAU/4;
      aCube(_ex + cos(a)*8, _ey + sin(a)*8, _bz + 0.5, '#3a4060', undefined, 0);
    }
  }
  if(has('p_startle')){                    // arrows flash outward, bright when ready
    const ready = !(e.startleCd > 0), ph = fract(t*0.7);
    for(let i=0; i<4; i++){
      const a = i*TAU/4 + Math.PI/4, rr = 10 + ph*3;
      const al = ready ? (0.4 + 0.5*sin(ph*Math.PI)) : 0.18;
      chev(_ex + cos(a)*rr, _ey + sin(a)*rr, _bz + 6, cos(a), sin(a), ready ? K.gold : K.stone, 1.2, al);
    }
  }
  if(has('p_slowburn')){                   // ember simmer, flares when charged
    const hot = e.calmT >= 6;
    rise(hot ? 8 : 3, hot ? [K.fire, K.gold, K.white] : [K.orange, K.red], hot ? 2.2 : 0.9, hot ? 14 : 6, 4.5);
    if(hot) gRing(9 + sin(t*9), K.orange, 0.5);
  }
  if(has('p_stillness') && (e.staticT >= 0.8 || _spd < 6)){   // ripples while still
    for(let k=0; k<2; k++){
      const ph = fract(t*0.8 + k*0.5);
      gDots(3 + ph*16, K.teal, 0, (1-ph)*0.7, 8 + ph*12);
    }
  }
  if(has('p_wallkick')){                   // spark rebound; bursts after a kick
    const kk = e.kickT > 0;
    const side = ((t*3) | 0) % 2 ? 1 : -1;
    aMini(_ex + _px*5*side, _ey + _py*5*side, _bz + 2 + (t*8) % 2, K.gold, kk ? 1 : 0.6, 0);
    if(kk) rise(5, [K.gold, K.white], 4, 6, 6);
  }
  if(has('p_bully')){                      // shoulder sparks
    for(const s of [-1, 1]){
      const fl = sin(t*13 + s*2) > 0 ? K.orange : K.red;
      aMini(_ex + _px*5*s, _ey + _py*5*s, _bz + 9 + sin(t*9 + s)*0.5, fl, undefined, (t*9) | 0);
      if(sin(t*7 + s) > 0.6) aPix(_ex + _px*6*s + _dx*1, _ey + _py*6*s + _dy*1, _bz + 11, K.white);
    }
  }
  if(has('p_ironcalves')){                 // glowing calves
    const pulse = 0.55 + 0.45*sin(t*5), hot = e.sprintActive ? 1 : pulse;
    for(const s of [-1, 1]) aMini(_ex + _px*1.8*s + _dx*(sin(e.stepPhase*Math.PI + s)*0.8), _ey + _py*1.8*s + _dy*(sin(e.stepPhase*Math.PI + s)*0.8), _bz + 1.5, e.fatigued ? K.orange : K.teal, hot, 0);
  }
  if(m.grudge){                            // purple wisps per debuff
    const n = Math.max(1, Math.min(5, e.debuffN || 0));
    rise(n, [K.purple, K.violet], 1.1, 15, 6, { wob:2.2 });
  }
  if(m.slingshot){                         // coil sparks, tighter as charge builds
    const ch = Math.min(1, (e.sprintHeldT || 0)/1.5), full = ch >= 1;
    for(let i=0; i<4; i++){
      const a = t*(5 + ch*8) + i*TAU/4, rr = 7 - ch*3.5;
      aMini(_ex + cos(a)*rr, _ey + sin(a)*rr, _bz + 3 + ch*8 + sin(t*9 + i), full && sin(t*30) > 0 ? K.white : K.blue, 0.4 + 0.6*ch, i);
    }
  }
  if(m.pressure){                          // red field of pressure at the 60u radius
    const pr = 0.22 + 0.12*sin(t*3);
    gDots(60, K.red, t*0.25, pr, 56);
    const ph = fract(t*0.6);
    gDots(60 - ph*14, K.red, 0, (1-ph)*0.18, 40);
  }
  if(m.airTime){                           // floating dust
    for(let i=0; i<5; i++){
      const a = i*1.26 + t*0.6;
      aMini(_ex + cos(a)*6, _ey + sin(a)*6, _bz + 2.5 + sin(t*2.4 + i*1.7)*1.8, K.tan, 0.75, i);
    }
  }
  if(has('p_glide') && _spd > 40){         // shimmer trail
    for(let i=0; i<4; i++){
      const d = 4 + i*3.5;
      aMini(_ex - _dx*d, _ey - _dy*d, _bz + 3 + sin(t*12 + i*1.4)*3, i % 2 ? K.snow : K.ice2, (0.9 - i*0.2)*(0.6 + 0.4*sin(t*20 + i)), i);
    }
  }
  if(has('p_juggernaut') || m.staggerResist >= 1){   // stone plating
    for(let i=0; i<4; i++){
      const a = i*TAU/4 + 0.7;
      aCube(_ex + cos(a)*5.5, _ey + sin(a)*5.5, _bz + (i % 2 ? 9 : 4), i % 2 ? '#8a7a68' : K.stone, undefined, 0);
    }
    gRing(9, '#5b5140', 0.45);
  }
  if(m.cadence){                           // stacked chevrons grow with cadence
    const n = e.cadenceStacks || 0;
    for(let i=0; i<n; i++){
      const al = 0.7 + 0.3*sin(t*6 - i), col = i === n-1 ? K.white : K.gold;
      hudMini(col, 0, -(i*3), 16.5, al, 0);
      hudMini(col, -2, -(i*3) + 2, 16.5, al, 1);
      hudMini(col, 2, -(i*3) + 2, 16.5, al, 1);
    }
    if(n === 0) hudMini(K.stone, 0, 0, 16.5, 0.35, 0);
  }
  if(has('p_lunge') && _spd > 90){         // momentum lance
    const reach = Math.min(4, _spd/60);
    for(let i=0; i<4; i++) aMini(_ex + _dx*(6 + i*1.4 + reach), _ey + _dy*(6 + i*1.4 + reach), _bz + 6, i === 3 ? K.white : K.red, 0.9 - i*0.12, i);
  }

  // ---- existing passives with conditional tells ----
  if(e.staticReady){                       // STATIC CHARGE
    gRing(9 + sin(t*12), K.gold, 0.8);
    rise(5, [K.gold, K.white], 3, 12, 5);
  }
  if(has('p_windup') && (e.sprintHeldT || 0) >= 2) speedLines(3, K.orange, 10, { rate:5, alpha:0.6 });
  if(has('p_boiling') && e.closeToFoe) rise(5, [K.orange, K.gold], 2, 12, 5);
  if(e.privileged){                        // PRIVILEGED STATUS
    for(let i=0; i<3; i++) hudMini(i === 1 ? K.white : K.gold, -4 + i*4, 3 - (i === 1 ? 1 : 0) + sin(t*5 + i)*0.5, 16, undefined, i);
    rise(3, [K.gold, K.purple], 1.2, 10, 6);
  }
  if(has('p_divine') && e.dashHitApplied){ gRing(8 + 10*fract(t*3), K.white, 0.7); }
  if(m.camouflage && e.staticT >= 1.2) rise(4, [K.green, K.lime], 1.0, 10, 5, { wob:3 });   // CAMO shimmer
  if(has('p_double') && e.dashChargesMax > 1){      // dash pips at the feet
    for(let i=0; i<e.dashChargesMax; i++){
      const a = t*1.5 + i*Math.PI + 0.3;
      aMini(_ex + cos(a)*8.5, _ey + sin(a)*8.5, _bz + 0.8, i < e.dashCharges ? K.teal : '#2a2f45', undefined, 0);
    }
  }
}

/* ---------------------------------- artifacts ---------------------------------- */
function artifactAuras(e, m, ar){
  if(!ar.length) return;
  const t = _t, n = ar.length;
  for(let i=0; i<n; i++){
    const id = ar[i], col = RELIC[id];
    if(!col) continue;
    const a = t*0.9 + i*TAU/n, rr = 13 + (i % 2)*2.5, z = 8 + sin(t*2.2 + i*1.9)*1.6;
    const x = _ex + cos(a)*rr, y = _ey + sin(a)*rr;
    aCube(x, y, _bz + z, col, undefined, (t*2.5 + i) | 0);
    // per-relic flourish
    switch(id){
      case 'x_heart':{                       // double-beat pulse
        const b = fract(t*1.2); if(b < 0.12 || (b > 0.2 && b < 0.3)) aMini(x, y, _bz + z + 3, K.white, 0.9, 0); break; }
      case 'x_claw':
        for(let k=-1; k<=1; k++) aPix(x + k*1.5, y - k*1.5, _bz + z - 3, K.white); break;
      case 'x_latch':
        if(sin(t*11 + i) > 0.2) aMini(x - cos(a + 1.57)*2, y - sin(a + 1.57)*2, _bz + z, K.ice2, 0.5, 0); break;
      case 'x_flask': {
        const ph = fract(t*1.1 + i*0.3); aMini(x, y, _bz + z + 2 + ph*4, K.white, 1 - ph, 0); break; }
      case 'x_stopwatch': {
        const ha = t*5; aMini(x + cos(ha)*2, y + sin(ha)*2, _bz + z + 3, K.white, 0.9, 0); break; }
      case 'x_chalk': {
        const ph = fract(t*1.3 + i*0.2); aMini(x, y, _bz + z - 2 - ph*3, K.white, 1 - ph, 0); break; }
      case 'x_ironlung': {
        const br = 0.5 + 0.5*sin(t*2.2); aMini(x, y, _bz + z + 2 + br*2, K.teal, 0.4 + 0.5*br, 0); break; }
      case 'x_spurs':
        if(sin(t*7 + i) > 0.7) aPix(x, y, _bz + z + 3, K.white); break;
      case 'x_horseshoe':
        if(sin(t*3 + i) > 0.6){ aMini(x + 2, y + 2, _bz + z + 2, K.lime, 0.9, 0); aMini(x - 2, y - 2, _bz + z + 3, K.white, 0.9, 1); } break;
      case 'x_gland':
        if(e.adrenalLeft > 0 || e.mods.adrenalCharges > 0){
          const pu = 0.5 + 0.5*sin(t*6); aMini(x, y, _bz + z + 3, K.red, 0.4 + 0.6*pu, 0);
        } break;
      default:
        if(sin(t*4 + i*2) > 0.85) aPix(x, y, _bz + z + 3, K.white);
    }
  }

  const sets = m.sets || EMPTY;
  if(sets.includes('strider')){            // FIRST WIND: bright halo, flares on a free sprint
    const free = e.sprintActive && (e.sprintHeldT || 0) < 1.5;
    gDots(11, free ? K.white : K.blue, t*1.4, free ? 0.9 : 0.45, 12);
    for(let i=0; i<3; i++){
      const a = t*1.4 + i*TAU/3;
      chev(_ex + cos(a)*11, _ey + sin(a)*11, _bz + 1, -sin(a), cos(a), free ? K.white : K.blue, 1.2, free ? 1 : 0.6);
    }
    if(free) speedLines(3, K.white, 12, { rate:6, alpha:0.7 });
  }
  if(sets.includes('bulwark')){            // IMMOVABLE: plates lock around you when planted
    const planted = (e.staticT || 0) >= 0.5;
    if(planted){
      gRing(10, K.stone, 0.8); gRing(11, '#3a4060', 0.6);
      for(let i=0; i<8; i++){
        const a = i*TAU/8 + 0.2;
        aCube(_ex + cos(a)*9, _ey + sin(a)*9, _bz + 3, K.stone, undefined, 0);
        aCube(_ex + cos(a)*9, _ey + sin(a)*9, _bz + 8, K.silver, undefined, 0);
      }
    } else {
      gDots(10, K.stone, t*0.3, 0.3, 10);
    }
  }
}

/* ------------------------------- passive charm belt ------------------------------- */
function charmBelt(ps){
  if(!ps.length) return;
  let n = 0;
  for(let i=0; i<ps.length; i++) if(CHARM[ps[i]]) n++;
  if(!n) return;
  const t = _t;
  let k = 0;
  for(let i=0; i<ps.length; i++){
    const col = CHARM[ps[i]];
    if(!col) continue;
    const a = t*0.55 + k*TAU/n, rr = 9.5 + (k % 2)*1.6;
    const x = _ex + cos(a)*rr, y = _ey + sin(a)*rr, z = 0.8 + sin(t*2.6 + k*1.3)*0.6;
    aMini(x, y, _bz + z, col, undefined, (t*3 + k) | 0);
    if(sin(t*3.1 + k*2.2) > 0.93) aPix(x, y, _bz + z + 2, K.white);
    k++;
  }
}
