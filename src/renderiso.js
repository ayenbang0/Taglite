import { IW, IH, ZONE_CELL, WORLD_W, WORLD_H } from './config.js';
import { clamp, dist } from './math.js';
import { PICKUP_BY_ID } from './pickups.js';
import { isAimed, aimRange, aimPoint } from './targeting.js';
import { poseFor, drawAnimFX, activeAnimKind } from './anim.js';
import { tagRadius } from './physics.js';
import { state } from './state.js';
import { project, screenToWorld, dirToScreen, groundRing, groundArc, groundDisc, pixelLine, onScreen } from './iso.js';
import { tint, silhouette, cubeColored, shade } from './voxel.js';
import { getFighterSprite, getPropSprite, PROP_FRAMES } from './voxelmodels.js';
import { THEMES, getFloorTile, getWallPiece, chunkRects, getDecorSprite, drawAmbient } from './themes.js';
import { drawFXGround, drawFXAir, drawEntityAuras } from './fx.js';

const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');
ctx.imageSmoothingEnabled = false;
const mmCanvas = document.getElementById('minimap');
const mmCtx = mmCanvas.getContext('2d');
mmCtx.imageSmoothingEnabled = false;

export { canvas };

const AXES = [{x:1,y:0},{x:0,y:1},{x:-1,y:0},{x:0,y:-1}];
const RUN = ['runA','runB','runC','runD'];

/* =========================================================================
   SMALL HELPERS
   ========================================================================= */
const chunkCache = new WeakMap();
function chunksOf(rect){
  let c = chunkCache.get(rect);
  if(!c){ c = chunkRects(rect); chunkCache.set(rect, c); }
  return c;
}

const tintCache = new WeakMap();
function tinted(sp, color, alpha){
  let m = tintCache.get(sp.canvas);
  if(!m){ m = new Map(); tintCache.set(sp.canvas, m); }
  const key = color+'|'+alpha;
  let v = m.get(key);
  if(!v){ v = { canvas: tint(sp.canvas, color, alpha), ax: sp.ax, ay: sp.ay }; m.set(key, v); }
  return v;
}

function blit(sp, x, y, z = 0, sx = 1, sy = 1){
  const p = project(x, y, z);
  const w = sp.canvas.width, h = sp.canvas.height;
  if(sx === 1 && sy === 1){
    ctx.drawImage(sp.canvas, Math.round(p.x) - sp.ax, Math.round(p.y) - sp.ay);
  } else {
    const dw = Math.max(1, Math.round(w*sx)), dh = Math.max(1, Math.round(h*sy));
    ctx.drawImage(sp.canvas, 0, 0, w, h, Math.round(p.x - sp.ax*sx), Math.round(p.y - sp.ay*sy), dw, dh);
  }
}

function theme(){ return state.theme || THEMES[0]; }

function facingOf(e){
  const d = e.lastMoveDir || e.dir || {x:1,y:0};
  let best = e.facingIdx || 0;
  let bs = d.x*AXES[best].x + d.y*AXES[best].y;
  for(let i=0;i<4;i++){
    const s = d.x*AXES[i].x + d.y*AXES[i].y;
    if(s > bs + 0.35){ best = i; bs = s; }
  }
  e.facingIdx = best;
  return best;
}

function frameFor(e, t, speed){
  if(e.frozen) return 'frozen';
  if(e.airT > 0) return 'air';
  if(e.stumbleT > 0) return 'stumble';
  if(e.slideT > 0) return 'slide';
  const k = activeAnimKind(e);
  if(k === 'cast' || k === 'throw' || k === 'slam' || k === 'pull') return 'cast';
  if(k === 'hit') return 'hit';
  if(k === 'dash' || k === 'thrust' || k === 'shove' || e.dashBurstT > 0 || e.rushT > 0 || e.pounceT > 0) return 'dash';
  if(speed > 15) return RUN[Math.floor(e.stepPhase || 0) & 3];
  return 'idle' + (Math.floor(t*3.5 + (e.id || 0)*0.7) & 3);
}

function hopZ(e){
  if(!(e.airT > 0)) return e.dashBurstT > 0 ? 1 : 0;
  const a0 = Math.max(e.airT0 || 0.3, e.airT);
  const ramp = Math.min(1, e.airT*5, Math.max(0, a0 - e.airT)*5 + 0.01);
  return 6*ramp + Math.sin(performance.now()/180)*0.5*ramp;
}

function visibleEntity(e){ return revealCheck(e); }

/* =========================================================================
   MAIN
   ========================================================================= */
export function render(){
  const t = performance.now()/1000;
  const th = theme();
  const { camera, round, player } = state;

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  if(state.shake.t > 0){
    const m = state.shake.mag * Math.min(1, state.shake.t/0.15);
    ctx.setTransform(1, 0, 0, 1, Math.round((Math.random()-0.5)*2*m), Math.round((Math.random()-0.5)*2*m));
  }
  ctx.globalAlpha = 1;
  ctx.fillStyle = th.bg;
  ctx.fillRect(-8, -8, IW+16, IH+16);

  drawFloor(t, th);
  drawGroundPass(t, th);
  drawAmbient(ctx, th, camera, t, 'back');

  // ---- depth-sorted world ----
  const list = [];
  const wallBoxes = [];
  collectWalls(list, t, th);
  collectDecor(list, t, th);
  collectObjects(list, t);
  for(const e of state.entities) if(e !== player && visibleEntity(e)) list.push({d:e.x+e.y+0.01, f:drawFighter, a:e, e});
  if(visibleEntity(player)) list.push({d:player.x+player.y+0.02, f:drawFighter, a:player, e:player});
  list.sort((a,b)=>a.d-b.d);
  const drawn = [];
  for(const it of list){
    const box = it.f(it.a, t);
    if(it.wall && box) drawn.push({d:it.d, box});
  }

  // ---- x-ray: fighters hidden behind obstacles stay readable ----
  drawXray(list, drawn);

  // ---- overlays ----
  for(const pt of state.particles){
    const s = project(pt.x, pt.y, pt.z !== undefined ? pt.z : 3 + (1 - pt.life/pt.maxLife)*8);
    ctx.globalAlpha = Math.max(0, pt.life/pt.maxLife);
    ctx.fillStyle = pt.color;
    const sz = Math.max(1, Math.round(pt.size));
    ctx.fillRect(Math.round(s.x - sz/2), Math.round(s.y - sz/2), sz, sz);
  }
  ctx.globalAlpha = 1;
  drawFXAir(ctx, t);
  drawAnimFX(ctx);
  drawAmbient(ctx, th, camera, t, 'front');
  drawDirectionPing();
  drawReticle(t);

  if(th.tintOverlay){
    ctx.globalAlpha = th.tintOverlay.alpha;
    ctx.fillStyle = th.tintOverlay.color;
    ctx.fillRect(-8, -8, IW+16, IH+16);
    ctx.globalAlpha = 1;
  }
  drawVignette();
  if(round.grace > 0){
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.fillRect(-8, -8, IW+16, IH+16);
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  renderMinimap();
}

/* =========================================================================
   FLOOR AND GROUND
   ========================================================================= */
function drawFloor(t, th){
  const c0 = screenToWorld(0, 0), c1 = screenToWorld(IW, 0), c2 = screenToWorld(0, IH), c3 = screenToWorld(IW, IH);
  const minX = Math.min(c0.x, c1.x, c2.x, c3.x), maxX = Math.max(c0.x, c1.x, c2.x, c3.x);
  const minY = Math.min(c0.y, c1.y, c2.y, c3.y), maxY = Math.max(c0.y, c1.y, c2.y, c3.y);
  const cols = Math.ceil(WORLD_W/ZONE_CELL), rows = Math.ceil(WORLD_H/ZONE_CELL);
  const ca = Math.max(0, Math.floor(minX/ZONE_CELL) - 1), cb = Math.min(cols-1, Math.floor(maxX/ZONE_CELL) + 1);
  const ra = Math.max(0, Math.floor(minY/ZONE_CELL) - 1), rb = Math.min(rows-1, Math.floor(maxY/ZONE_CELL) + 1);
  const grid = state.zoneGrid;
  for(let cc=ca; cc<=cb; cc++){
    for(let rr=ra; rr<=rb; rr++){
      const p = project(cc*ZONE_CELL, rr*ZONE_CELL);
      if(p.x < -70 || p.x > IW+70 || p.y < -64 || p.y > IH+4) continue;
      const z = grid.get(cc+','+rr);
      const kind = z || (((cc+rr) & 1) ? 'floorB' : 'floorA');
      ctx.drawImage(getFloorTile(th, kind, t), Math.round(p.x) - 60, Math.round(p.y));
    }
  }
}

const ZONE_LOOK = {
  slow:   ['#5c4326', 0.40],
  speed:  ['#3fe0c5', 0.20],
  sticky: ['#9b6bff', 0.30],
  ice:    ['#a9d8ee', 0.50],
  warp:   ['#c7f464', 0.18],
  dust:   ['#8b93b8', 0.35],
};

function drawGroundPass(t, th){
  const { player, tempZones, wells, traps, afterImages, shockwaveFX } = state;

  for(const z of tempZones){
    const [col, a] = ZONE_LOOK[z.type] || ZONE_LOOK.slow;
    groundDisc(ctx, z.x, z.y, z.r, col, a);
    if(z.type === 'warp') groundRing(ctx, z.x, z.y, z.r*(0.7 + 0.3*Math.sin(t*5)), '#c7f464', 0.7);
    else if(z.type === 'ice') groundRing(ctx, z.x, z.y, z.r, '#ffffff', 0.35);
    else if(z.type === 'dust') groundRing(ctx, z.x, z.y, z.r*(0.8 + 0.1*Math.sin(t*3)), '#8b93b8', 0.4);
  }

  for(const w of wells){
    const pulse = 0.5 + 0.5*Math.sin(w.life*8);
    const col = w.kind === 'anchor' ? '#8a95c9' : '#9b6bff';
    groundRing(ctx, w.x, w.y, w.r, col, 0.85);
    groundRing(ctx, w.x, w.y, w.r*(0.35 + 0.3*pulse), col, 0.85);
  }

  // traps: your own are visible; pads are visible to everyone
  for(const tr of traps){
    if(tr.kind !== 'pad' && tr.owner !== player) continue;
    const r = tr.r*(tr.owner ? tr.owner.mods.trapRadiusMult : 1);
    groundRing(ctx, tr.x, tr.y, r, tr.kind === 'pad' ? '#ffd23f' : '#a8a23f', 0.6);
  }

  for(const g of afterImages){
    const seesThrough = player.mods.nightVision;
    drawGhostSprite(g.x, g.y, g.color, g.owner, (g.life/g.maxLife)*(seesThrough ? 0.18 : 0.5), t);
  }

  for(const sw of shockwaveFX){
    const a = Math.max(0, 1 - sw.t/0.4);
    groundRing(ctx, sw.x, sw.y, sw.r, '#ff9f45', a);
    groundRing(ctx, sw.x, sw.y, sw.r*0.85, '#ffffff', a*0.6);
  }

  // fighter shadows, side rings and ground-level status rings
  for(const e of state.entities){
    if(!visibleEntity(e)) continue;
    groundDisc(ctx, e.x, e.y, 4.6, '#000000', e.airT > 0 ? 0.22 : 0.38);
    const ally = e.team && e.team === player.team && e !== player;
    const col = e.hunting ? '#ff5470' : (ally ? '#ffd23f' : '#3fe0c5');
    const pulse = e.hunting ? 0.75 + 0.25*Math.sin(t*8) : 0.7;
    groundRing(ctx, e.x, e.y, 6.5, col, pulse);
    if(e.hunting) groundRing(ctx, e.x, e.y, 7.5, col, 0.25);
    if(e.frozen){
      groundDisc(ctx, e.x, e.y, 8, '#8fd6ff', 0.3);
      groundRing(ctx, e.x, e.y, 9, '#8fd6ff', 0.9);
      const mode = state.mode;
      if(e.thawProgress > 0 && mode && mode.thawTime){
        const k = clamp(e.thawProgress/mode.thawTime, 0, 1);
        groundArc(ctx, e.x, e.y, 12, -Math.PI/2, -Math.PI/2 + k*Math.PI*2, '#ffd23f', 1);
      }
    }
    if(e.shieldT > 0 || e.absorbT > 0) groundRing(ctx, e.x, e.y, 10, '#ffd23f', 0.8);
    if(e.deflectArmed) groundRing(ctx, e.x, e.y, 12, '#3fe0c5', 0.9);
    if(e.wardT > 0) groundArc(ctx, e.x, e.y, 13, e.wardT*4, e.wardT*4 + Math.PI*1.4, '#ff5ec4', 0.9);
    if(e.brandT > 0) groundRing(ctx, e.x, e.y, 6 + 10*clamp(e.brandT/3, 0, 1), '#ff5470', 0.9);
    if(e.beamChargeT > 0 && e.beamDir){
      const k = 1 - (e.beamChargeT/0.6);
      const a = project(e.x, e.y, 6), b = project(e.x + e.beamDir.x*160*k, e.y + e.beamDir.y*160*k, 6);
      ctx.globalAlpha = 0.3 + 0.6*k;
      pixelLine(ctx, a.x, a.y, b.x, b.y, '#ff5ec4');
      ctx.globalAlpha = 1;
    }
    if(e.mods.noSprint && e === player) groundRing(ctx, e.x, e.y, tagRadius(e), '#ffd23f', 0.18);
    drawEntityAuras(ctx, e, t, false);
  }
  drawFXGround(ctx, t);
}

function drawGhostSprite(x, y, color, owner, alpha, t){
  const cls = owner && owner.clsKey;
  if(!cls) return;
  const dir = owner.lastMoveDir || {x:1,y:0};
  let f = 0, bs = -9;
  for(let i=0;i<4;i++){ const s = dir.x*AXES[i].x + dir.y*AXES[i].y; if(s > bs){ bs = s; f = i; } }
  ctx.globalAlpha = alpha;
  blit(getFighterSprite(cls, f, 'idle0', color), x, y, 0);
  ctx.globalAlpha = 1;
}

/* =========================================================================
   DEPTH-SORTED COLLECTION
   ========================================================================= */
function collectWalls(list, t, th){
  const push = (rect, temp)=>{
    for(const c of chunksOf(rect)){
      const cx = c.x + c.w/2, cy = c.y + c.h/2;
      const p = project(cx, cy);
      if(p.x < -90 || p.x > IW+90 || p.y < -80 || p.y > IH+120) continue;
      list.push({d:cx+cy, f:temp ? drawBarricadeChunk : drawWallChunk, a:{rect, c, temp}, wall:true});
    }
  };
  for(const w of state.walls) push(w, false);
  for(const w of state.tempWalls) push(w, true);
}

function drawWallChunk(o, t){
  const th = theme();
  const sp = getWallPiece(th, o.rect, o.c.ci, o.c.cj, t);
  if(!sp) return null;
  const cx = o.c.x + o.c.w/2, cy = o.c.y + o.c.h/2;
  blit(sp, cx, cy, 0);
  const p = project(cx, cy);
  const x0 = Math.round(p.x) - sp.ax, y0 = Math.round(p.y) - sp.ay;
  return {x0, y0, x1:x0 + sp.canvas.width, y1:y0 + sp.canvas.height};
}

const barricadeCache = new Map();
function barricadeSprite(w, h){
  const key = Math.round(w)+'x'+Math.round(h);
  let sp = barricadeCache.get(key);
  if(!sp){
    const W = Math.max(1, Math.round(w)), D = Math.max(1, Math.round(h)), H = 9;
    const canvas = document.createElement('canvas');
    canvas.width = (W+D)*2 + 2; canvas.height = H*2 + W + D + 2;
    const g = canvas.getContext('2d');
    const offX = D*2 + 1, offY = H*2 + 1;
    for(let k=0;k<H;k++) for(let j=0;j<D;j++) for(let i=0;i<W;i++){
      // surface voxels only, so large slabs stay cheap to bake
      if(k < H-1 && i > 0 && i < W-1 && j > 0 && j < D-1) continue;
      const hue = (i+j+k) & 1 ? '#3fe0c5' : '#2bb7a2';
      cubeColored(g, (i-j-1)*2 + offX, (i+j) - (k+1)*2 + offY, k === H-1 ? '#8ff5e3' : hue);
    }
    sp = { canvas, ax: W + D + 1, ay: (W+D)/2 + H*2 + 1 };
    barricadeCache.set(key, sp);
  }
  return sp;
}

function drawBarricadeChunk(o, t){
  const c = o.c;
  const cx = c.x + c.w/2, cy = c.y + c.h/2;
  const sp = barricadeSprite(c.w, c.h);
  ctx.globalAlpha = 0.55 + 0.35*clamp(o.rect.life/6, 0, 1);
  blit(sp, cx, cy, 0);
  ctx.globalAlpha = 1;
  return null;
}

function collectDecor(list, t, th){
  if(!state.decor) return;
  for(const d of state.decor){
    const p = project(d.x, d.y);
    if(p.x < -40 || p.x > IW+40 || p.y < -50 || p.y > IH+40) continue;
    list.push({d:d.x+d.y, f:drawDecor, a:d});
  }
}
function drawDecor(d, t){
  const sp = getDecorSprite(theme(), d, t);
  if(sp) blit(sp, d.x, d.y, 0);
}

function collectObjects(list, t){
  const { player, powerups, beacons, traps, projectiles, familiars, decoys } = state;

  for(const p of powerups) list.push({d:p.x+p.y, f:drawPowerup, a:p});
  for(const b of beacons) list.push({d:b.x+b.y, f:drawBeacon, a:b});
  for(const tr of traps){
    if(tr.kind !== 'pad' && tr.owner !== player) continue;
    list.push({d:tr.x+tr.y-0.5, f:drawTrap, a:tr});
  }
  for(const p of projectiles) list.push({d:p.x+p.y, f:drawProjectile, a:p});
  for(const f of familiars) list.push({d:(f.x ?? f.owner.x)+(f.y ?? f.owner.y), f:drawFamiliar, a:f});
  for(const d of decoys) list.push({d:d.x+d.y, f:drawDecoy, a:d});
}

function drawPowerup(p, t){
  const def = PICKUP_BY_ID[p.id];
  const color = def ? def.color : '#ffffff';
  const bob = 3 + Math.sin(p.bob)*1.5;
  if(p.rare){
    groundRing(ctx, p.x, p.y, 7 + Math.sin(p.bob*2)*1.5, color, 0.8);
    groundDisc(ctx, p.x, p.y, 4, color, 0.25);
    blit(getPropSprite('crystal', {color, frame:Math.floor(t*8) % PROP_FRAMES.crystal}), p.x, p.y, bob + 1);
  } else {
    groundDisc(ctx, p.x, p.y, 3, '#000000', 0.3);
    blit(getPropSprite('gem', {color}), p.x, p.y, bob);
  }
}

function drawBeacon(b, t){
  const a = clamp(b.life/5, 0, 1);
  groundRing(ctx, b.x, b.y, 6 + Math.sin(t*5), '#3fe0c5', 0.4 + 0.5*a);
  ctx.globalAlpha = 0.5 + 0.5*a;
  blit(getPropSprite('pylon', {color:'#3fe0c5', frame:Math.floor(t*6) % PROP_FRAMES.pylon}), b.x, b.y, 0);
  ctx.globalAlpha = 1;
}

function drawTrap(tr, t){
  const kind = tr.kind === 'pad' ? 'pad' : (tr.kind === 'snare' || tr.kind === 'trip') ? 'spikes' : 'trap';
  const frame = kind === 'pad' ? Math.floor(t*4) % PROP_FRAMES.pad : 0;
  blit(getPropSprite(kind, {color:tr.kind === 'pad' ? '#ffd23f' : '#a8a23f', frame}), tr.x, tr.y, 0);
}

function drawProjectile(p, t){
  if(p.kind === 'strike'){
    // telegraph: rings fill as the fuse burns, a cube falls onto the target
    const k = 1 - (p.life/p.fuse);
    groundRing(ctx, p.x, p.y, p.radius, '#ffd23f', 0.35 + 0.5*k);
    groundRing(ctx, p.x, p.y, p.radius*k, '#ffffff', 0.8);
    blit(getPropSprite('cube', {color:p.color || '#ffd23f'}), p.x, p.y, 6 + (1-k)*34);
    return;
  }
  groundDisc(ctx, p.x, p.y, 2, '#000000', 0.3);
  if(p.kind === 'boomerang'){
    blit(getPropSprite('blade', {color:p.color || '#ffd23f', frame:Math.floor(t*20) % PROP_FRAMES.blade}), p.x, p.y, 6);
    return;
  }
  blit(getPropSprite('cube', {color:p.color || '#ffffff'}), p.x, p.y, 6);
}

function drawFamiliar(f, t){
  const x = f.x ?? f.owner.x, y = f.y ?? f.owner.y;
  const kind = f.kind === 'guard' ? 'guard' : f.kind === 'blade' ? 'blade' : f.kind === 'mote' ? 'mote' : 'shade';
  const frames = PROP_FRAMES[kind] || 1;
  const bob = 7 + Math.sin(t*4 + (f.angle || 0))*1.2;
  groundDisc(ctx, x, y, 2.5, '#000000', 0.25);
  ctx.globalAlpha = kind === 'shade' ? 0.55 + 0.45*Math.sin(f.life*6) : 1;
  blit(getPropSprite(kind, {color:f.owner && f.owner.cls ? f.owner.cls.color : '#8fd6ff', frame:Math.floor(t*8) % frames}), x, y, bob);
  ctx.globalAlpha = 1;
}

function drawDecoy(d, t){
  const seesThrough = state.player.mods.nightVision;
  ctx.globalAlpha = seesThrough ? 0.22 : (0.6 + Math.sin(d.t*10)*0.1);
  const speed = Math.hypot(d.vx || 0, d.vy || 0);
  d.stepPhase = (d.stepPhase || 0) + speed*0.016/16;
  const f = d.burstT > 0 ? 'dash' : (speed > 15 ? RUN[Math.floor(d.stepPhase) & 3] : 'idle'+(Math.floor(t*3.5) & 3));
  blit(getFighterSprite(d.owner.clsKey, facingOf(d), f, d.owner.cls.color), d.x, d.y, 0);
  ctx.globalAlpha = 1;
}

/* =========================================================================
   FIGHTERS
   ========================================================================= */
function drawFighter(e, t){
  const hidden = e.invisT > 0 || (e.mods.camouflage && e.staticT >= 2 && e !== state.player);
  const speed = Math.hypot(e.vx, e.vy);
  const facing = facingOf(e);
  const frame = frameFor(e, t, speed);
  let sp = getFighterSprite(e.clsKey, facing, frame, e.cls.color);
  if(state.mode && state.mode.key === 'zombie' && e.hunting) sp = tinted(sp, '#7ed957', 0.42);
  const pose = poseFor(e);
  const z = hopZ(e);
  ctx.globalAlpha = hidden ? 0.35 : (e.intangibleT > 0 ? 0.55 : 1);
  if(pose) blit(sp, e.x + pose.ox, e.y + pose.oy, z, pose.sx, pose.sy);
  else blit(sp, e.x, e.y, z);
  ctx.globalAlpha = 1;
  if(e.frozen) blit(getPropSprite('iceblock', {}), e.x, e.y, 0);
  drawEntityAuras(ctx, e, t, true);
  return null;
}

/* =========================================================================
   X-RAY (fighters behind obstacles)
   ========================================================================= */
const xrayCache = new WeakMap();
function drawXray(list, drawn){
  if(!drawn.length) return;
  for(const it of list){
    if(!it.e || !visibleEntity(it.e)) continue;
    const e = it.e;
    if(dist(e, state.player) > 260) continue;
    const p = project(e.x, e.y);
    const bx0 = p.x - 14, bx1 = p.x + 14, by0 = p.y - 40, by1 = p.y + 6;
    let covered = false;
    for(const w of drawn){
      if(w.d <= it.d) continue;
      const b = w.box;
      if(b.x1 > bx0 && b.x0 < bx1 && b.y1 > by0 && b.y0 < by1){ covered = true; break; }
    }
    if(!covered) continue;
    const sp = getFighterSprite(e.clsKey, e.facingIdx || 0, frameFor(e, performance.now()/1000, Math.hypot(e.vx, e.vy)), e.cls.color);
    let s = xrayCache.get(sp.canvas);
    if(!s){ s = { canvas: silhouette(sp.canvas, e.cls.color), ax: sp.ax, ay: sp.ay }; xrayCache.set(sp.canvas, s); }
    ctx.globalAlpha = 0.38;
    blit(s, e.x, e.y, hopZ(e));
    ctx.globalAlpha = 1;
  }
}

/* =========================================================================
   OVERLAYS
   ========================================================================= */
function drawVignette(){
  const steps = 6;
  for(let i=0;i<steps;i++){
    ctx.fillStyle = 'rgba(0,0,0,' + (0.18*(1 - i/steps)).toFixed(3) + ')';
    const w = 4 + i*0; // 4px bands, stacked inward
    ctx.fillRect(i*w, 0, w, IH);
    ctx.fillRect(IW - (i+1)*w, 0, w, IH);
    ctx.fillRect(0, i*w, IW, w);
    ctx.fillRect(0, IH - (i+1)*w, IW, w);
  }
}

function arrow(px, py, d, color, alpha, off){
  const tx = px + d.x*off, ty = py + d.y*off;
  const nx = -d.y, ny = d.x;
  ctx.globalAlpha = alpha;
  pixelLine(ctx, tx, ty, tx - d.x*6 + nx*3.5, ty - d.y*6 + ny*3.5, color);
  pixelLine(ctx, tx, ty, tx - d.x*6 - nx*3.5, ty - d.y*6 - ny*3.5, color);
  pixelLine(ctx, tx - d.x*6 + nx*3.5, ty - d.y*6 + ny*3.5, tx - d.x*6 - nx*3.5, ty - d.y*6 - ny*3.5, color);
  ctx.globalAlpha = 1;
}

function drawDirectionPing(){
  const { player } = state;
  if(player.blindT > 0) return;   // FLASHBANG kills the compass
  const s = project(player.x, player.y, 8);

  if(player.frozen){
    let ally = null, ad = Infinity;
    for(const o of state.entities){
      if(o === player || o.frozen || o.team !== player.team) continue;
      const d = dist(player, o);
      if(d < ad){ ad = d; ally = o; }
    }
    if(!ally) return;
    arrow(s.x, s.y, dirToScreen(ally.x - player.x, ally.y - player.y), '#ffd23f', 0.55 + 0.45*Math.sin(performance.now()/220), 22);
    return;
  }

  if(state.pingShowT <= 0) return;
  let foe = null, fd = Infinity;
  for(const o of state.entities){
    if(o === player || o.team === player.team || o.frozen) continue;
    const d = dist(player, o);
    if(d < fd){ fd = d; foe = o; }
  }
  if(!foe) return;
  const dir = dirToScreen(foe.x - player.x, foe.y - player.y);
  const alpha = clamp(state.pingShowT/0.9, 0, 1);
  arrow(s.x, s.y, dir, player.role === 'tagger' ? '#ff5470' : '#ffd23f', alpha, 26);

  // BLOODHOUND passive: the ping also reads out exact distance
  if(player.mods.bloodhound){
    ctx.globalAlpha = alpha;
    ctx.fillStyle = '#ffd23f';
    ctx.font = '12px VT323, monospace';
    ctx.fillText(String(Math.round(fd)), s.x + dir.x*26 + 8, s.y + dir.y*26 + 4);
    ctx.globalAlpha = 1;
  }
}

function drawReticle(t){
  const armed = state.aim.armed;
  if(!armed) return;
  const p = state.player;
  const range = aimRange(p, armed);
  const pt = aimPoint(p, range);
  groundRing(ctx, p.x, p.y, range, '#ffd23f', 0.4);
  const a = project(p.x, p.y, 2), b = project(pt.x, pt.y, 0);
  ctx.globalAlpha = 0.4;
  pixelLine(ctx, a.x, a.y, b.x, b.y, '#ffd23f');
  ctx.globalAlpha = 1;
  const pulse = 3 + Math.sin(t*10);
  groundRing(ctx, pt.x, pt.y, pulse, '#ffd23f', 0.95);
  ctx.fillStyle = '#ffd23f';
  ctx.fillRect(Math.round(b.x) - 1, Math.round(b.y), 3, 1);
  ctx.fillRect(Math.round(b.x), Math.round(b.y) - 1, 1, 3);
}

/* =========================================================================
   VISIBILITY
   ========================================================================= */
export function revealCheck(e){
  const { player } = state;
  if(e === player) return true;
  // team-mates are always visible to you - you need to see who to go thaw
  if(e.team && e.team === player.team) return true;

  // Hunter's Mark, sprung traps and Predator Sense defeat every concealment
  if(e.markedT > 0 || e.revealedByTrapT > 0 || player.seeThroughT > 0) return true;

  const d = dist(player, e);
  const revealRange = 40 + player.mods.revealRangeBonus;
  if(e.invisT > 0 && d > revealRange) return false;
  if(e.smokeT > 0 && d > revealRange) return false;
  if(e.mods.camouflage && e.staticT >= 2 && d > revealRange) return false;

  const s = project(e.x, e.y);
  if(onScreen(s.x, s.y, 24)) return true;
  if(player.revealT > 0) return true;
  return false;
}

/* =========================================================================
   MINIMAP  (an isometric diamond of the whole arena)
   ========================================================================= */
function renderMinimap(){
  const { player, walls, powerups } = state;
  const th = theme();
  const MW = mmCanvas.width, MH = mmCanvas.height;
  const k = (MW - 8)/(WORLD_W + WORLD_H);
  const ox = MW/2, oy = 6;
  const mm = (x, y)=>({ x:Math.round((x - y)*k + ox), y:Math.round((x + y)*k/2 + oy) });
  const mini = th.minimap || {floor:'#1b2038', wall:'#58618a', border:'#7b83a1'};

  mmCtx.clearRect(0, 0, MW, MH);
  mmCtx.fillStyle = '#080a12';
  mmCtx.fillRect(0, 0, MW, MH);

  // floor diamond
  const n = mm(0, 0), e = mm(WORLD_W, 0), s = mm(WORLD_W, WORLD_H), w = mm(0, WORLD_H);
  mmCtx.fillStyle = mini.floor;
  mmCtx.beginPath();
  mmCtx.moveTo(n.x, n.y); mmCtx.lineTo(e.x, e.y); mmCtx.lineTo(s.x, s.y); mmCtx.lineTo(w.x, w.y);
  mmCtx.closePath();
  mmCtx.fill();
  pixelLine(mmCtx, n.x, n.y, e.x, e.y, mini.border);
  pixelLine(mmCtx, e.x, e.y, s.x, s.y, mini.border);
  pixelLine(mmCtx, s.x, s.y, w.x, w.y, mini.border);
  pixelLine(mmCtx, w.x, w.y, n.x, n.y, mini.border);

  for(const wl of walls){
    if(wl.kind === 'border') continue;
    const a = wl.w >= wl.h ? mm(wl.x, wl.y + wl.h/2) : mm(wl.x + wl.w/2, wl.y);
    const b = wl.w >= wl.h ? mm(wl.x + wl.w, wl.y + wl.h/2) : mm(wl.x + wl.w/2, wl.y + wl.h);
    pixelLine(mmCtx, a.x, a.y, b.x, b.y, mini.wall);
    pixelLine(mmCtx, a.x, a.y + 1, b.x, b.y + 1, mini.wall);
  }

  // FLASHBANG: the map goes dark for its duration
  if(player.blindT > 0){
    mmCtx.fillStyle = 'rgba(8,10,18,0.92)';
    mmCtx.fillRect(0, 0, MW, MH);
    return;
  }
  // rare artifacts are worth crossing the map for
  for(const p of powerups){
    if(!p.rare) continue;
    const def = PICKUP_BY_ID[p.id];
    const q = mm(p.x, p.y);
    mmCtx.fillStyle = def ? def.color : '#fff';
    mmCtx.fillRect(q.x - 1, q.y - 1, 3, 3);
  }
  for(const en of state.entities){
    if(en === player) continue;
    // THE COMPASS passive keeps enemies pinned regardless of stealth
    if(!(revealCheck(en) || player.mods.compass)) continue;
    const ally = en.team === player.team;
    const q = mm(en.x, en.y);
    mmCtx.fillStyle = en.frozen ? '#8fd6ff' : (ally ? '#ffd23f' : en.cls.color);
    mmCtx.fillRect(q.x - 1, q.y - 1, 3, 3);
  }
  const pq = mm(player.x, player.y);
  mmCtx.fillStyle = '#05060c';
  mmCtx.fillRect(pq.x - 2, pq.y - 2, 5, 5);
  mmCtx.fillStyle = player.cls.color;
  mmCtx.fillRect(pq.x - 1, pq.y - 1, 3, 3);

  // viewport: the projected screen rectangle
  const c = [screenToWorld(0,0), screenToWorld(IW,0), screenToWorld(IW,IH), screenToWorld(0,IH)].map(v=>mm(v.x, v.y));
  mmCtx.globalAlpha = 0.5;
  for(let i=0;i<4;i++){
    const a = c[i], b = c[(i+1)%4];
    pixelLine(mmCtx, a.x, a.y, b.x, b.y, '#ffffff');
  }
  mmCtx.globalAlpha = 1;
}
