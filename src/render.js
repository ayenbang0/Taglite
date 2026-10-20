import { IW, IH, ZONE_CELL, VISUAL_HALF, WORLD_W, WORLD_H, CLASSES } from './config.js';
import { norm, clamp, dist, len } from './math.js';
import { PICKUP_BY_ID } from './pickups.js';
import { isAimed, aimRange, aimPoint } from './targeting.js';
import { poseFor, drawAnimFX } from './anim.js';
import { tagRadius } from './physics.js';
import { state } from './state.js';

const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');
ctx.imageSmoothingEnabled = false;
const mmCanvas = document.getElementById('minimap');
const mmCtx = mmCanvas.getContext('2d');

export { canvas };

function worldToScreen(x,y){ return {x:x-state.camera.x, y:y-state.camera.y}; }

export function render(){
  const { camera, walls, zoneGrid, tempZones, powerups, decoys, particles,
          shockwaveFX, bot, player, round, traps, projectiles, wells,
          beacons, afterImages } = state;

  ctx.fillStyle = '#0d1120';
  ctx.fillRect(0,0,IW,IH);

  // grid
  ctx.strokeStyle = 'rgba(255,255,255,0.03)';
  ctx.lineWidth = 1;
  const gs = 20;
  for(let x = -(camera.x%gs); x<IW; x+=gs){
    ctx.beginPath(); ctx.moveTo(x,0); ctx.lineTo(x,IH); ctx.stroke();
  }
  for(let y = -(camera.y%gs); y<IH; y+=gs){
    ctx.beginPath(); ctx.moveTo(0,y); ctx.lineTo(IW,y); ctx.stroke();
  }

  // zones (irregular grid patches)
  const zc0 = Math.floor(camera.x/ZONE_CELL), zc1 = Math.floor((camera.x+IW)/ZONE_CELL);
  const zr0 = Math.floor(camera.y/ZONE_CELL), zr1 = Math.floor((camera.y+IH)/ZONE_CELL);
  for(let cc=zc0; cc<=zc1; cc++){
    for(let rr=zr0; rr<=zr1; rr++){
      const t = zoneGrid.get(cc+','+rr);
      if(!t) continue;
      const s = worldToScreen(cc*ZONE_CELL, rr*ZONE_CELL);
      ctx.fillStyle = t==='slow' ? 'rgba(120,80,40,0.42)' : 'rgba(63,224,197,0.16)';
      ctx.fillRect(s.x, s.y, ZONE_CELL, ZONE_CELL);
    }
  }
  for(const z of tempZones){
    const s = worldToScreen(z.x,z.y);
    ctx.beginPath();
    ctx.fillStyle = z.type==='speed' ? 'rgba(63,224,197,0.22)'
                  : z.type==='sticky' ? 'rgba(155,107,255,0.30)'
                  : 'rgba(120,80,40,0.5)';
    ctx.arc(s.x,s.y,z.r,0,Math.PI*2);
    ctx.fill();
  }

  // gravity wells
  for(const w of wells){
    const s = worldToScreen(w.x,w.y);
    const pulse = 0.5 + 0.5*Math.sin(w.life*8);
    ctx.strokeStyle = w.kind==='anchor' ? 'rgba(92,107,155,0.85)' : 'rgba(155,107,255,0.75)';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.arc(s.x,s.y,w.r,0,Math.PI*2); ctx.stroke();
    ctx.beginPath(); ctx.arc(s.x,s.y,w.r*(0.35+0.3*pulse),0,Math.PI*2); ctx.stroke();
  }

  // walls
  ctx.fillStyle = '#232a42';
  for(const w of walls){
    const s = worldToScreen(w.x,w.y);
    if(s.x>IW||s.y>IH||s.x+w.w<0||s.y+w.h<0) continue;
    ctx.fillRect(s.x,s.y,w.w,w.h);
    ctx.fillStyle='#333d5e';
    ctx.fillRect(s.x,s.y,w.w,2);
    ctx.fillStyle = '#232a42';
  }

  // BARRICADE slabs - same wall material, but visibly temporary
  for(const w of state.tempWalls){
    const s = worldToScreen(w.x,w.y);
    const a = clamp(w.life/6, 0, 1);
    ctx.globalAlpha = 0.55 + 0.45*a;
    ctx.fillStyle = '#3a4470';
    ctx.fillRect(s.x,s.y,w.w,w.h);
    ctx.fillStyle = '#8fd6ff';
    ctx.fillRect(s.x,s.y,w.w,1);
    ctx.globalAlpha = 1;
  }

  // traps - only visible to their owner (and briefly once sprung)
  for(const t of traps){
    if(t.owner !== player) continue;
    const s = worldToScreen(t.x,t.y);
    ctx.strokeStyle = 'rgba(168,162,63,0.55)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(s.x,s.y,t.r*(t.owner?t.owner.mods.trapRadiusMult:1),0,Math.PI*2);
    ctx.stroke();
    ctx.fillStyle = '#a8a23f';
    ctx.fillRect(s.x-1,s.y-1,3,3);
  }

  // warp beacons
  for(const b of beacons){
    const s = worldToScreen(b.x,b.y);
    const a = clamp(b.life/5,0,1);
    ctx.globalAlpha = 0.4 + 0.6*a;
    ctx.fillStyle = '#3fe0c5';
    ctx.fillRect(s.x-3,s.y-3,6,6);
    ctx.strokeStyle = '#3fe0c5';
    ctx.strokeRect(s.x-5,s.y-5,10,10);
    ctx.globalAlpha = 1;
  }

  // powerups (rare artifacts glow and read bigger)
  for(const p of powerups){
    const s = worldToScreen(p.x,p.y);
    const bob = Math.sin(p.bob)*2;
    const def = PICKUP_BY_ID[p.id];
    const color = def ? def.color : '#fff';
    if(p.rare){
      ctx.save();
      ctx.shadowColor = color;
      ctx.shadowBlur = 8 + Math.sin(p.bob*2)*4;
      ctx.fillStyle = color;
      ctx.fillRect(s.x-5,s.y-5+bob,10,10);
      ctx.restore();
      ctx.strokeStyle='#fff';
      ctx.strokeRect(s.x-5,s.y-5+bob,10,10);
    } else {
      ctx.fillStyle = color;
      ctx.fillRect(s.x-4,s.y-4+bob,8,8);
      ctx.strokeStyle='#000';
      ctx.strokeRect(s.x-4,s.y-4+bob,8,8);
    }
  }

  // projectiles
  for(const p of projectiles){
    const s = worldToScreen(p.x,p.y);
    if(p.kind==='strike'){
      // THUNDER CALL telegraph: a ring that fills as the fuse burns down
      const t = 1 - (p.life/p.fuse);
      ctx.strokeStyle = `rgba(255,210,63,${0.35+0.5*t})`;
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.arc(s.x,s.y,p.radius,0,Math.PI*2); ctx.stroke();
      ctx.beginPath(); ctx.arc(s.x,s.y,p.radius*t,0,Math.PI*2); ctx.stroke();
      continue;
    }
    if(p.kind==='seeker'){
      ctx.save();
      ctx.shadowColor = p.color; ctx.shadowBlur = 5;
      ctx.fillStyle = p.color;
      ctx.fillRect(s.x-2,s.y-2,5,5);
      ctx.restore();
      continue;
    }
    ctx.fillStyle = p.color || '#fff';
    ctx.fillRect(s.x-2,s.y-2,4,4);
  }

  // HUNGRY SHADE familiars
  for(const f of state.familiars){
    const s = worldToScreen(f.x||f.owner.x, f.y||f.owner.y);
    ctx.save();
    ctx.shadowColor = '#8fd6ff'; ctx.shadowBlur = 5;
    ctx.globalAlpha = 0.5 + 0.5*Math.sin(f.life*6);
    ctx.fillStyle = '#8fd6ff';
    ctx.fillRect(s.x-2,s.y-2,4,4);
    ctx.restore();
    ctx.globalAlpha = 1;
  }

  // after-images (Ghost Trail) - a decoy that isn't a decoy
  for(const g of afterImages){
    const s = worldToScreen(g.x,g.y);
    const seesThrough = player.mods.nightVision;
    ctx.globalAlpha = (g.life/g.maxLife) * (seesThrough ? 0.18 : 0.5);
    drawEntitySprite(s.x,s.y,g.color,{x:1,y:0},false);
    ctx.globalAlpha = 1;
  }

  // decoys
  for(const d of decoys){
    const s = worldToScreen(d.x,d.y);
    const seesThrough = player.mods.nightVision;
    ctx.globalAlpha = seesThrough ? 0.22 : (0.6 + Math.sin(d.t*10)*0.1);
    // decoys squash into their bursts, matching how a real fighter dashes
    const burst = d.burstT>0 ? 1 : 0;
    drawEntitySprite(s.x,s.y, d.owner.cls.color, d.dir, false,
      burst ? {ox:0, oy:0, sx:1.5, sy:0.7, rot:0} : null);
    ctx.globalAlpha = 1;
  }

  // particles
  for(const pt of particles){
    const s = worldToScreen(pt.x,pt.y);
    ctx.globalAlpha = Math.max(0,pt.life/pt.maxLife);
    ctx.fillStyle = pt.color;
    ctx.fillRect(s.x-pt.size/2, s.y-pt.size/2, pt.size, pt.size);
    ctx.globalAlpha = 1;
  }

  // shockwave rings
  for(const sw of shockwaveFX){
    const s = worldToScreen(sw.x,sw.y);
    ctx.strokeStyle = 'rgba(255,159,69,'+Math.max(0,(1-sw.t/0.4))+')';
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(s.x,s.y,sw.r,0,Math.PI*2); ctx.stroke();
  }

  // entities - everyone else first so the player always reads on top
  for(const e of state.entities){
    if(e !== player) drawEntity(e);
  }
  drawEntity(player);
  // ability FX last, so reach overlays the bodies rather than hiding behind them
  drawAnimFX(ctx, worldToScreen);
  drawDirectionPing();
  drawReticle();

  // grace overlay
  if(round.grace>0){
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.fillRect(0,0,IW,IH);
  }

  renderMinimap();
}

/* =========================================================================
   CLICK-TO-TARGET RETICLE
   Drawn in-world at the internal resolution so it reads as part of the same
   pixel space as the sprites, never as an HTML overlay.
   ========================================================================= */
function drawReticle(){
  const armed = state.aim.armed;
  if(!armed) return;
  const p = state.player;
  const range = aimRange(p, armed);
  const pt = aimPoint(p, range);
  const c = worldToScreen(p.x,p.y);
  const s = worldToScreen(pt.x,pt.y);

  // range ring
  ctx.strokeStyle = 'rgba(255,210,63,0.35)';
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.arc(c.x,c.y,range,0,Math.PI*2); ctx.stroke();

  // aim line
  ctx.strokeStyle = 'rgba(255,210,63,0.25)';
  ctx.beginPath(); ctx.moveTo(c.x,c.y); ctx.lineTo(s.x,s.y); ctx.stroke();

  // reticle: four ticks around the point, pixel-crisp
  ctx.fillStyle = '#ffd23f';
  ctx.fillRect(s.x-5,s.y,3,1);
  ctx.fillRect(s.x+3,s.y,3,1);
  ctx.fillRect(s.x,s.y-5,1,3);
  ctx.fillRect(s.x,s.y+3,1,3);
  ctx.fillRect(s.x,s.y,1,1);
}

function drawDirectionPing(){
  const { player } = state;
  if(player.blindT>0) return;   // FLASHBANG kills the compass

  // FROZEN: no chase ping, but a standing arrow toward your nearest free ally
  // so you can watch the rescue coming
  if(player.frozen){
    let ally=null, ad=Infinity;
    for(const o of state.entities){
      if(o===player || o.frozen || o.team!==player.team) continue;
      const d = dist(player,o);
      if(d<ad){ ad=d; ally=o; }
    }
    if(!ally) return;
    const s = worldToScreen(player.x, player.y);
    const dir = norm(ally.x-player.x, ally.y-player.y);
    ctx.save();
    ctx.translate(s.x+dir.x*15, s.y+dir.y*15);
    ctx.rotate(Math.atan2(dir.y,dir.x));
    ctx.globalAlpha = 0.55 + 0.45*Math.sin(performance.now()/220);
    ctx.fillStyle = '#ffd23f';
    ctx.beginPath();
    ctx.moveTo(5,0); ctx.lineTo(-3,-4); ctx.lineTo(-3,4); ctx.closePath();
    ctx.fill();
    ctx.restore();
    ctx.globalAlpha = 1;
    return;
  }

  if(state.pingShowT<=0) return;
  // the ping points at the nearest ENEMY - the same information a bot gets
  let foe=null, fd=Infinity;
  for(const o of state.entities){
    if(o===player || o.team===player.team || o.frozen) continue;
    const d = dist(player,o);
    if(d<fd){ fd=d; foe=o; }
  }
  if(!foe) return;
  const bot = foe;
  const s = worldToScreen(player.x, player.y);
  const dir = norm(bot.x-player.x, bot.y-player.y);
  const off = 15;
  const px = s.x + dir.x*off, py = s.y + dir.y*off;
  const alpha = clamp(state.pingShowT/0.9, 0, 1);
  ctx.save();
  ctx.translate(px,py);
  ctx.rotate(Math.atan2(dir.y,dir.x));
  ctx.globalAlpha = alpha;
  ctx.fillStyle = player.role==='tagger' ? '#ff5470' : '#ffd23f';
  ctx.beginPath();
  ctx.moveTo(5,0); ctx.lineTo(-3,-4); ctx.lineTo(-3,4); ctx.closePath();
  ctx.fill();
  ctx.restore();
  ctx.globalAlpha = 1;

  // BLOODHOUND passive: the ping also reads out exact distance
  if(player.mods.bloodhound){
    ctx.globalAlpha = alpha;
    ctx.fillStyle = '#ffd23f';
    ctx.font = '6px monospace';
    ctx.fillText(Math.round(dist(player,bot))+'', px+7, py+2);
    ctx.globalAlpha = 1;
  }
}

function drawEntitySprite(sx,sy,color,dir,glow,pose){
  ctx.save();
  // an animation's pose offsets/squashes the body along its own action
  // vector; at rest this is a no-op
  if(pose){
    ctx.translate(sx + pose.ox, sy + pose.oy);
    if(pose.rot) ctx.rotate(pose.rot);
    ctx.scale(pose.sx, pose.sy);
  } else {
    ctx.translate(sx,sy);
  }
  if(glow){
    ctx.shadowColor = color;
    ctx.shadowBlur = 6;
  }
  ctx.fillStyle = color;
  ctx.fillRect(-VISUAL_HALF,-VISUAL_HALF,VISUAL_HALF*2,VISUAL_HALF*2);
  ctx.fillStyle = '#0b0d16';
  ctx.fillRect(-VISUAL_HALF,-VISUAL_HALF,VISUAL_HALF*2,3);
  // facing nub
  ctx.fillStyle = '#fff';
  ctx.fillRect(dir.x*6-1, dir.y*6-1, 3,3);
  ctx.restore();
}

function drawEntity(e){
  const s = worldToScreen(e.x,e.y);
  if(!revealCheck(e)) return;

  const hidden = e.invisT>0 || (e.mods.camouflage && e.staticT>=2 && e!==state.player);
  ctx.globalAlpha = hidden ? 0.35 : (e.intangibleT>0 ? 0.55 : 1);

  // outline says which SIDE they're on; the sprite still says which class
  const hunterRing = e.hunting;
  const ally = e.team && e.team === state.player.team && e !== state.player;
  ctx.save();
  if(hunterRing){ ctx.shadowColor='#ff5470'; ctx.shadowBlur=8; ctx.strokeStyle='#ff5470'; }
  else if(ally){ ctx.shadowColor='#ffd23f'; ctx.shadowBlur=6; ctx.strokeStyle='rgba(255,210,63,0.75)'; }
  else { ctx.shadowColor='#3fe0c5'; ctx.shadowBlur=6; ctx.strokeStyle='rgba(63,224,197,0.5)'; }
  ctx.lineWidth=1;
  ctx.strokeRect(s.x-7,s.y-7,14,14);
  ctx.restore();

  // FROZEN: an ice shell, plus the rescue progress filling around them
  if(e.frozen){
    ctx.save();
    ctx.shadowColor='#8fd6ff'; ctx.shadowBlur=8;
    ctx.strokeStyle='#8fd6ff'; ctx.lineWidth=1;
    ctx.strokeRect(s.x-9,s.y-9,18,18);
    ctx.restore();
    ctx.fillStyle='rgba(143,214,255,0.22)';
    ctx.fillRect(s.x-9,s.y-9,18,18);
    const mode = state.mode;
    if(e.thawProgress>0 && mode && mode.thawTime){
      const t = clamp(e.thawProgress/mode.thawTime, 0, 1);
      ctx.strokeStyle='#ffd23f';
      ctx.beginPath();
      ctx.arc(s.x, s.y, 12, -Math.PI/2, -Math.PI/2 + t*Math.PI*2);
      ctx.stroke();
    }
  }
  if(e.shieldT>0 || e.absorbT>0){
    ctx.strokeStyle = 'rgba(255,210,63,0.8)';
    ctx.beginPath(); ctx.arc(s.x,s.y,9,0,Math.PI*2); ctx.stroke();
  }
  if(e.deflectArmed){
    ctx.strokeStyle = 'rgba(63,224,197,0.9)';
    ctx.beginPath(); ctx.arc(s.x,s.y,11,0,Math.PI*2); ctx.stroke();
  }
  if(e.markedT>0){
    ctx.fillStyle = '#ff5ec4';
    ctx.fillRect(s.x-1, s.y-13, 3, 3);
  }
  // REVERSAL WARD: a counter-rotating ring, so the threat is readable
  if(e.wardT>0){
    ctx.strokeStyle = 'rgba(255,94,196,0.85)';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.arc(s.x,s.y,12,e.wardT*4,e.wardT*4+Math.PI*1.4); ctx.stroke();
  }
  // BRAND: a countdown ring closing in on them
  if(e.brandT>0){
    const t = clamp(e.brandT/3, 0, 1);
    ctx.strokeStyle = 'rgba(255,84,112,0.9)';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.arc(s.x,s.y,6+10*t,0,Math.PI*2); ctx.stroke();
  }
  // FROSTBITE stacks: pips above the sprite
  if(e.chillStacks>0){
    ctx.fillStyle = '#8fd6ff';
    for(let i=0;i<e.chillStacks;i++) ctx.fillRect(s.x-5+i*3, s.y-11, 2, 2);
  }
  // SIPHON BEAM windup: the line you're about to fire
  if(e.beamChargeT>0 && e.beamDir){
    const t = 1 - (e.beamChargeT/0.6);
    ctx.strokeStyle = `rgba(255,94,196,${0.3+0.6*t})`;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(s.x,s.y);
    ctx.lineTo(s.x+e.beamDir.x*160*t, s.y+e.beamDir.y*160*t);
    ctx.stroke();
  }
  drawEntitySprite(s.x,s.y, e.cls.color, e.lastMoveDir, true, poseFor(e));
  drawPassiveTells(e, s);
  ctx.globalAlpha = 1;
}

/* =========================================================================
   PASSIVE TELLS
   The build-defining passives get a persistent visual so a fight is readable
   at a glance - you can see what someone is running before it hits you.
   ========================================================================= */
function drawPassiveTells(e, s){
  const m = e.mods;
  const now = performance.now()/1000;

  // BLOODY LUST - heat rises as the stacks climb
  if(e.lustStacks > 0){
    ctx.strokeStyle = `rgba(255,84,112,${0.25 + 0.13*e.lustStacks})`;
    ctx.lineWidth = 1;
    const r = 9 + e.lustStacks*1.2 + Math.sin(now*7)*0.8;
    ctx.beginPath(); ctx.arc(s.x, s.y, r, 0, Math.PI*2); ctx.stroke();
  }
  // APOTHEOSIS - a slow halo, one ring per completed set
  if(m.apotheosisSets > 0){
    for(let i=0;i<m.apotheosisSets;i++){
      const a = now*1.1 + i*(Math.PI*2/3);
      ctx.fillStyle = '#ffd23f';
      ctx.fillRect(s.x + Math.cos(a)*13 - 1, s.y + Math.sin(a)*13 - 1, 2, 2);
    }
  }
  // COLD BLOOD - a held guard, spent on the first tag
  if(m.coldBlood && e.deflectArmed){
    ctx.strokeStyle = 'rgba(255,210,63,0.5)';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.arc(s.x, s.y, 13, -0.6, 0.6); ctx.stroke();
    ctx.beginPath(); ctx.arc(s.x, s.y, 13, Math.PI-0.6, Math.PI+0.6); ctx.stroke();
  }
  // GLASS CANNON / BRITTLE BONES - a fracture line, flashing while dazed
  if((m.brittleBones || m.sprintMax < 90) && (e.stunT > 0 || Math.sin(now*2.2) > 0.93)){
    ctx.strokeStyle = e.stunT>0 ? '#ff5470' : 'rgba(255,84,112,0.5)';
    ctx.beginPath();
    ctx.moveTo(s.x-4, s.y-6); ctx.lineTo(s.x-1, s.y-1);
    ctx.lineTo(s.x-4, s.y+2); ctx.lineTo(s.x+1, s.y+6);
    ctx.stroke();
  }
  // MOM'S GRIP - the extended reach it bought, shown as a faint ring
  if(m.noSprint && e === state.player){
    ctx.strokeStyle = 'rgba(255,210,63,0.16)';
    ctx.beginPath(); ctx.arc(s.x, s.y, tagRadius(e), 0, Math.PI*2); ctx.stroke();
  }
  // QUICKSILVER - a tick per pickup absorbed this duel
  if(e.pickupStacks > 0){
    ctx.fillStyle = '#3fe0c5';
    for(let i=0;i<Math.min(e.pickupStacks,6);i++){
      ctx.fillRect(s.x - 5 + i*2, s.y + 8, 1, 2);
    }
  }
}

export function revealCheck(e){
  const { player } = state;
  if(e===player) return true;
  // team-mates are always visible to you - you need to see who to go thaw
  if(e.team && e.team === player.team) return true;

  // Hunter's Mark, sprung traps and Predator Sense defeat every concealment
  if(e.markedT>0 || e.revealedByTrapT>0 || player.seeThroughT>0) return true;

  const d = dist(player,e);
  const revealRange = 40 + player.mods.revealRangeBonus;
  if(e.invisT>0 && d>revealRange) return false;
  if(e.smokeT>0 && d>revealRange) return false;
  if(e.mods.camouflage && e.staticT>=2 && d>revealRange) return false;

  const s = worldToScreen(e.x,e.y);
  const onScreen = s.x > -8 && s.x < IW+8 && s.y > -8 && s.y < IH+8;
  if(onScreen) return true;
  if(player.revealT>0) return true;
  return false;
}

function renderMinimap(){
  const { player, walls, camera, powerups } = state;
  mmCtx.clearRect(0,0,110,74);
  mmCtx.fillStyle = '#0f1220';
  mmCtx.fillRect(0,0,110,74);
  const sx = 110/WORLD_W, sy = 74/WORLD_H;
  mmCtx.fillStyle = '#232a42';
  for(const w of walls){
    mmCtx.fillRect(w.x*sx, w.y*sy, Math.max(1,w.w*sx), Math.max(1,w.h*sy));
  }
  // FLASHBANG: the map goes dark for its duration
  if(player.blindT>0){
    mmCtx.fillStyle = 'rgba(15,18,32,0.92)';
    mmCtx.fillRect(0,0,110,74);
    return;
  }
  // rare artifacts are worth crossing the map for, so they show on the minimap
  for(const p of powerups){
    if(!p.rare) continue;
    const def = PICKUP_BY_ID[p.id];
    mmCtx.fillStyle = def ? def.color : '#fff';
    mmCtx.fillRect(p.x*sx-1.5, p.y*sy-1.5, 3,3);
  }
  // everyone else, then the player on top
  for(const e of state.entities){
    if(e === player) continue;
    // THE COMPASS passive keeps enemies pinned regardless of stealth
    if(!(revealCheck(e) || player.mods.compass)) continue;
    const ally = e.team === player.team;
    mmCtx.fillStyle = e.frozen ? '#8fd6ff' : (ally ? '#ffd23f' : e.cls.color);
    mmCtx.fillRect(e.x*sx-1.5, e.y*sy-1.5, 3,3);
  }
  mmCtx.fillStyle = player.cls.color;
  mmCtx.fillRect(player.x*sx-2, player.y*sy-2, 4,4);
  // viewport box
  mmCtx.strokeStyle = 'rgba(255,255,255,0.35)';
  mmCtx.strokeRect(camera.x*sx, camera.y*sy, IW*sx, IH*sy);
}
