/* =========================================================================
   WORLD EFFECTS
   Everything drafted abilities spawn into the arena: traps, thrown globs,
   gravity wells, warp beacons and stealth after-images. Kept in one place so
   round.js's update tick stays readable.
   ========================================================================= */
import { RADIUS, WORLD_W, WORLD_H } from './config.js';
import { len, norm, clamp, dist } from './math.js';
import { wallBlocked } from './arena.js';
import { applySlow, applyStagger, applyKnockback } from './physics.js';
import { playAnim } from './anim.js';
import { spawnEventFX } from './fx.js';
import { state } from './state.js';

export function resetEffects(){
  state.traps = [];
  state.projectiles = [];
  state.wells = [];
  state.beacons = [];
  state.afterImages = [];
  state.tempWalls = [];
  state.familiars = [];
}

export function updateEffects(dt, entities, onBoltHit){
  updateTraps(dt, entities);
  updateProjectiles(dt, entities, onBoltHit);
  updateWells(dt, entities);
  updateBeacons(dt);
  updateAfterImages(dt);
  updateTempWalls(dt);
  updateFamiliars(dt, entities);
  updateZones(dt, entities);
}

/* =========================================================================
   DECOYS
   A decoy has to be worth mistaking for a real fighter, so it moves like one:
   velocity and momentum rather than a drift vector, heading changes with
   commitment, occasional dash-like bursts, wall avoidance, and a flee bias
   away from whoever is hunting its owner.
   ========================================================================= */
function blendAngle(a, b, t){
  let diff = ((b - a + Math.PI*3) % (Math.PI*2)) - Math.PI;
  return a + diff*t;
}

export function updateDecoys(dt, entities){
  for(let i=state.decoys.length-1;i>=0;i--){
    const d = state.decoys[i];
    d.t += dt; d.life -= dt;
    d.turnT -= dt; d.burstCd -= dt; d.burstT -= dt;
    if(d.life<=0){ state.decoys.splice(i,1); continue; }

    // --- decide on a heading, and stick with it for a beat ---
    if(d.turnT<=0){
      d.turnT = 0.3 + Math.random()*0.7;
      let want = d.heading + (Math.random()-0.5)*2.4;
      // run from whoever is hunting its owner, like a real runner would
      let threat=null, td=Infinity;
      for(const e of entities){
        if(e.team === d.team || e.alive===false || e.frozen) continue;
        const dd = len(e.x-d.x, e.y-d.y);
        if(dd<td){ td=dd; threat=e; }
      }
      if(threat && td < 260){
        const away = Math.atan2(d.y-threat.y, d.x-threat.x);
        want = blendAngle(want, away, 0.55);
      }
      d.heading = want;
    }

    // --- wall avoidance: sweep for a clear-ish heading ---
    let heading = d.heading;
    if(wallBlocked(d.x + Math.cos(heading)*26, d.y + Math.sin(heading)*26)){
      for(const off of [0.6,-0.6,1.2,-1.2,1.9,-1.9,2.6,-2.6]){
        const h = heading + off;
        if(!wallBlocked(d.x + Math.cos(h)*26, d.y + Math.sin(h)*26)){ heading = h; break; }
      }
      d.heading = heading;
      d.turnT = Math.min(d.turnT, 0.15);
    }

    // --- occasional burst, so it reads as someone dashing away ---
    if(d.burstCd<=0 && Math.random()<0.02){
      d.burstT = 0.3;
      d.burstCd = 1.1 + Math.random()*1.4;
      state.particles.push({
        x:d.x,y:d.y,vx:0,vy:0,life:0.3,maxLife:0.3,color:d.cls.color,size:2,
      });
    }

    // --- integrate like an entity rather than teleporting along a vector ---
    const target = d.burstT>0 ? 210 : 76 + Math.sin(d.t*2.7)*20;
    const accel = d.burstT>0 ? 900 : 420;
    d.vx += Math.cos(heading)*accel*dt;
    d.vy += Math.sin(heading)*accel*dt;
    const sp = len(d.vx,d.vy);
    if(sp > target){
      const n = norm(d.vx,d.vy);
      d.vx = n.x*target; d.vy = n.y*target;
    }
    d.vx *= Math.exp(-3.2*dt);
    d.vy *= Math.exp(-3.2*dt);

    const nx = d.x + d.vx*dt, ny = d.y + d.vy*dt;
    if(wallBlocked(nx,ny)){
      d.heading += Math.PI*0.5 + Math.random()*0.6;   // bounce off and re-commit
      d.vx *= 0.3; d.vy *= 0.3;
    } else {
      d.x = nx; d.y = ny;
    }
    d.x = clamp(d.x, RADIUS, WORLD_W-RADIUS);
    d.y = clamp(d.y, RADIUS, WORLD_H-RADIUS);

    if(sp > 6){
      d.lastMoveDir = norm(d.vx,d.vy);
      d.dir = d.lastMoveDir;
    }
  }
}

/** Stack a FROSTBITE / chill application onto an entity, up to 5. */
export function addChill(e, n){
  const before = e.chillStacks;
  if(e.chillStacks < 5) e.chillStacks = Math.min(5, e.chillStacks + (n||1));
  e.chillT = 2.5;   // refresh the melt timer
  if(e.chillStacks > before) playAnim('hit', e, e.lastMoveDir);
}

/** Anyone who isn't on the owner's side (and can actually be touched). */
function isFoeOf(owner, e){
  return e!==owner && e.team!==owner.team && e.alive!==false && !e.frozen && e.intangibleT<=0;
}

function burstAt(x, y, color, n=5, speed=40){
  for(let k=0;k<n;k++){
    state.particles.push({
      x,y,vx:(Math.random()-0.5)*speed,vy:(Math.random()-0.5)*speed,
      life:0.35,maxLife:0.35,color,size:2,
    });
  }
}

/**
 * Orbiting familiars, by `kind`:
 *   shade - HUNGRY SHADE: chills whoever else touches it
 *   guard - WARDEN's BULWARK: swats enemy projectiles, shoves foes, breaks after 2 hits
 *   blade - ORBIT BLADES: shoves and slows foes on contact
 */
function updateFamiliars(dt, entities){
  for(let i=state.familiars.length-1;i>=0;i--){
    const f = state.familiars[i];
    const kind = f.kind || 'shade';
    f.life -= dt;
    f.cd = Math.max(0, f.cd - dt);
    if(f.life<=0 || (f.hp!==undefined && f.hp<=0)){ state.familiars.splice(i,1); continue; }
    f.angle += dt*(kind==='guard' ? 3.2 : kind==='blade' ? 3.8 : 2.6);
    const r = kind==='guard' ? 20 : kind==='blade' ? 22 : 26;
    f.x = f.owner.x + Math.cos(f.angle)*r;
    f.y = f.owner.y + Math.sin(f.angle)*r;

    if(kind==='guard'){
      // swat any hostile projectile that wanders into the guard (telegraphed strikes are not swattable)
      for(let k=state.projectiles.length-1;k>=0;k--){
        const p = state.projectiles[k];
        if(p.kind==='strike' || !p.owner || p.owner.team===f.owner.team) continue;
        if(len(p.x-f.x, p.y-f.y) < 8){
          burstAt(p.x, p.y, p.color||'#fff', 6, 45);
          state.projectiles.splice(k,1);
          f.hp--;
          break;
        }
      }
      if(f.hp<=0) continue;
      if(f.cd>0) continue;
      for(const e of entities){
        if(!isFoeOf(f.owner, e)) continue;
        if(len(e.x-f.x, e.y-f.y) < RADIUS+4){
          applyKnockback(f.owner, e, 130);
          f.hp--; f.cd = 0.5;
          burstAt(f.x, f.y, '#7fb069', 6, 45);
          break;
        }
      }
      continue;
    }

    if(f.cd>0) continue;
    if(kind==='blade'){
      for(const e of entities){
        if(!isFoeOf(f.owner, e)) continue;
        if(len(e.x-f.x, e.y-f.y) < RADIUS+4){
          applyKnockback(f.owner, e, 110);
          applySlow(e, 0.6, 0.7);
          f.cd = 0.8;
          burstAt(f.x, f.y, '#e9ecf4', 6, 45);
          break;
        }
      }
      continue;
    }

    for(const e of entities){
      if(e===f.owner || e.intangibleT>0) continue;
      if(len(e.x-f.x, e.y-f.y) < RADIUS+4){
        addChill(e, 1);
        f.cd = 1.5;
        state.particles.push({
          x:f.x,y:f.y,vx:0,vy:-20,life:0.4,maxLife:0.4,color:'#8fd6ff',size:2,
        });
        break;
      }
    }
  }
}

/** DUST KICK clouds: anyone standing inside is hidden from sight. */
function updateZones(dt, entities){
  for(const z of state.tempZones){
    if(z.type!=='dust') continue;
    for(const e of entities){
      if(len(e.x-z.x, e.y-z.y) <= z.r) e.smokeT = Math.max(e.smokeT, 0.3);
    }
  }
}

function updateTempWalls(dt){
  for(let i=state.tempWalls.length-1;i>=0;i--){
    state.tempWalls[i].life -= dt;
    if(state.tempWalls[i].life<=0) state.tempWalls.splice(i,1);
  }
}

function updateTraps(dt, entities){
  for(let i=state.traps.length-1;i>=0;i--){
    const t = state.traps[i];
    t.life -= dt;
    if(t.life<=0){ state.traps.splice(i,1); continue; }
    const isPad = t.kind==='pad';
    if(isPad && t.cd>0) t.cd -= dt;
    for(const e of entities){
      if(!isPad && e===t.owner) continue;   // your own traps don't bite you (pads help everyone)
      if(e.intangibleT>0) continue;
      if(e.airT>0 && !isPad) continue;      // hovering / hopping clears ground traps
      const r = t.r * (t.owner ? t.owner.mods.trapRadiusMult : 1);
      if(len(e.x-t.x, e.y-t.y) <= r){
        if(isPad){
          // SPRINGBOARD: launches whoever steps on it along their heading; wears out after `uses`
          if(e.frozen || t.cd>0) continue;
          const d = len(e.vx,e.vy)>10 ? norm(e.vx,e.vy) : e.lastMoveDir;
          e.vx += d.x*300; e.vy += d.y*300;
          e.dashBurstT = Math.max(e.dashBurstT, 0.3);
          playAnim('dash', e, d);
          t.cd = 0.5;
          t.uses--;
          burstAt(t.x, t.y, '#ffd23f', 6, 50);
          spawnEventFX('trapTrigger', t.x, t.y, {kind:'pad'});
          if(t.uses<=0) state.traps.splice(i,1);
          break;
        }
        if(t.kind==='spring'){
          // fling them away from the trap instead of rooting
          const n = norm(e.x-t.x, e.y-t.y);
          e.vx += n.x*320; e.vy += n.y*320;
          e.dashBurstT = Math.max(e.dashBurstT, 0.3);
          playAnim('hit', e, n);
        } else if(t.kind==='mine'){
          applySlow(e, 2, 0.45);
        } else if(t.kind==='trip'){
          // TRIP WIRE: a hard stumble, not a root
          applyStagger(e, 1.1);
          if(t.owner) applyKnockback(t.owner, e, 80);
        } else {
          applySlow(e, 1.2, 0.15);   // snare: near-total root
        }
        e.revealedByTrapT = 3;
        e.invisT = 0;
        state.shockwaveFX.push({x:t.x,y:t.y,r:0,maxR:r,t:0});
        spawnEventFX('trapTrigger', t.x, t.y, {kind:t.kind});
        for(let k=0;k<8;k++){
          state.particles.push({
            x:t.x,y:t.y,vx:(Math.random()-0.5)*40,vy:(Math.random()-0.5)*40,
            life:0.4,maxLife:0.4,color:'#a8a23f',size:2,
          });
        }
        state.traps.splice(i,1);
        break;
      }
    }
  }
}

function updateProjectiles(dt, entities, onBoltHit){
  for(let i=state.projectiles.length-1;i>=0;i--){
    const p = state.projectiles[i];
    p.life -= dt;

    // THUNDER CALL sits still and detonates on its fuse - no travel, no collision
    if(p.kind==='strike'){
      if(p.life<=0){
        detonate(p, null, onBoltHit, entities);
        state.projectiles.splice(i,1);
      }
      continue;
    }

    // BOOMERANG DISC: flies out to the aim point, then homes back to its owner.
    // Each foe is hit once per leg. The return leg ignores walls so it always comes home.
    if(p.kind==='boomerang'){
      if(p.life<=0 || !p.owner){ state.projectiles.splice(i,1); continue; }
      const goalX = p.phase==='out' ? p.tx : p.owner.x;
      const goalY = p.phase==='out' ? p.ty : p.owner.y;
      const gd = len(goalX-p.x, goalY-p.y);
      if(p.phase==='out' && gd<6){ p.phase='back'; p.hit.clear(); }
      else if(p.phase==='back' && gd<8){
        burstAt(p.x, p.y, p.color, 4, 30);
        state.projectiles.splice(i,1);
        continue;
      }
      const gn = p.phase==='out' ? norm(p.tx-p.x, p.ty-p.y) : norm(p.owner.x-p.x, p.owner.y-p.y);
      p.vx = gn.x*p.speed; p.vy = gn.y*p.speed;
      const bx = p.x + p.vx*dt, by = p.y + p.vy*dt;
      if(p.phase==='out' && (wallBlocked(bx,by) || bx<0 || by<0 || bx>WORLD_W || by>WORLD_H)){
        p.phase='back'; p.hit.clear();
      } else {
        p.x = bx; p.y = by;
      }
      for(const e of entities){
        if(!isFoeOf(p.owner, e) || p.hit.has(e)) continue;
        if(len(e.x-p.x, e.y-p.y) < RADIUS+4){
          p.hit.add(e);
          applyKnockback(p.owner, e, 120);
          applySlow(e, 0.8, 0.6);
          burstAt(p.x, p.y, p.color, 6, 45);
        }
      }
      continue;
    }

    // RICOCHET SHOT: bounces off walls (reflecting whichever axis re-opens the path)
    if(p.kind==='ricochet'){
      if(p.life<=0){ burstAt(p.x, p.y, p.color, 5, 40); state.projectiles.splice(i,1); continue; }
      const rx = p.x + p.vx*dt, ry = p.y + p.vy*dt;
      if(rx<0||ry<0||rx>WORLD_W||ry>WORLD_H){ state.projectiles.splice(i,1); continue; }
      if(wallBlocked(rx,ry)){
        if(p.bounces<=0){ burstAt(p.x, p.y, p.color, 5, 40); state.projectiles.splice(i,1); continue; }
        p.bounces--;
        const openX = !wallBlocked(rx, p.y);   // an x-only step is fine -> the y step was the problem
        const openY = !wallBlocked(p.x, ry);
        if(openX && !openY) p.vy = -p.vy;
        else if(openY && !openX) p.vx = -p.vx;
        else { p.vx = -p.vx; p.vy = -p.vy; }
        burstAt(p.x, p.y, p.color, 3, 30);
      } else {
        p.x = rx; p.y = ry;
      }
      let hitFoe = null;
      for(const e of entities){
        if(isFoeOf(p.owner, e) && len(e.x-p.x, e.y-p.y) < RADIUS+4){ hitFoe = e; break; }
      }
      if(hitFoe){
        applyKnockback(p.owner, hitFoe, 90);
        applySlow(hitFoe, 1.4, 0.5);
        burstAt(p.x, p.y, p.color, 6, 45);
        state.projectiles.splice(i,1);
      }
      continue;
    }

    // SEEKER ORB steers toward whoever isn't its owner
    if(p.kind==='seeker'){
      const target = entities.find(e=>e!==p.owner);
      if(target){
        const want = norm(target.x-p.x, target.y-p.y);
        const cur = norm(p.vx, p.vy);
        const bx = cur.x + (want.x-cur.x)*Math.min(1, p.turn*dt);
        const by = cur.y + (want.y-cur.y)*Math.min(1, p.turn*dt);
        const n = norm(bx,by);
        p.vx = n.x*p.speed; p.vy = n.y*p.speed;
      }
    }

    p.x += p.vx*dt;
    p.y += p.vy*dt;

    let done = p.life<=0;
    let hitEntity = null;

    // a seeker shrugs off walls rather than dying on them, so it stays a threat
    if(!done && wallBlocked(p.x,p.y)){
      if(p.kind==='seeker'){ p.vx *= -0.6; p.vy *= -0.6; p.x += p.vx*dt*2; p.y += p.vy*dt*2; }
      else done = true;
    }
    if(p.x<0||p.y<0||p.x>WORLD_W||p.y>WORLD_H) done = true;

    if(!done){
      for(const e of entities){
        if(e===p.owner) continue;
        if(e.intangibleT>0) continue;
        if(len(e.x-p.x, e.y-p.y) < RADIUS+4){ hitEntity = e; done = true; break; }
      }
    }
    // thrown zone-globs also detonate on reaching their aim point
    if(!done && p.tx !== undefined && len(p.x-p.tx, p.y-p.ty) < 8) done = true;

    if(done){
      detonate(p, hitEntity, onBoltHit, entities);
      state.projectiles.splice(i,1);
    }
  }
}

function detonate(p, hitEntity, onBoltHit, entities){
  if(p.kind==='strike'){
    // telegraphed AoE: everyone caught in the ring gets shoved and slowed
    state.shockwaveFX.push({x:p.x,y:p.y,r:0,maxR:p.radius,t:0});
    spawnEventFX('strikeImpact', p.x, p.y, {r:p.radius, color:p.color});
    for(const e of (entities||[])){
      if((e===p.owner && !p.indiscriminate) || e.intangibleT>0) continue;
      const d = len(e.x-p.x, e.y-p.y);
      if(d <= p.radius){
        const n = norm(e.x-p.x, e.y-p.y);
        const shove = p.indiscriminate ? 260 : 200;
        e.vx += n.x*shove; e.vy += n.y*shove;
        applySlow(e, 1.8, 0.55);
      }
    }
  } else if(p.kind==='seeker'){
    if(hitEntity) addChill(hitEntity, 2);
  } else if(p.kind==='beam'){
    if(hitEntity) applySlow(hitEntity, 1.5, 0.12);   // rooted, not just slowed
  } else if(p.kind==='mud'){
    state.tempZones.push({x:p.x,y:p.y,r:40,type:'slow',life:6});
  } else if(p.kind==='sticky'){
    state.tempZones.push({x:p.x,y:p.y,r:30,type:'sticky',life:3});
    if(hitEntity){
      hitEntity.accelDebuffT = 3;
      hitEntity.accelDebuffMult = 0.5;
    }
  } else if(p.kind==='bolt'){
    if(hitEntity && onBoltHit) onBoltHit(p.owner, hitEntity);
  }
  for(let k=0;k<6;k++){
    state.particles.push({
      x:p.x,y:p.y,vx:(Math.random()-0.5)*45,vy:(Math.random()-0.5)*45,
      life:0.35,maxLife:0.35,color:p.color||'#fff',size:2,
    });
  }
}

function updateWells(dt, entities){
  for(let i=state.wells.length-1;i>=0;i--){
    const w = state.wells[i];
    w.life -= dt;
    if(w.life<=0){ state.wells.splice(i,1); continue; }
    w.pulseT = (w.pulseT||0) - dt;
    if(w.pulseT<=0){
      w.pulseT = 0.6;
      spawnEventFX('wellPulse', w.x, w.y, {r:w.r, kind:w.kind==='tether' ? 'tether' : 'pull', color:w.kind==='anchor' ? '#8a95c9' : '#9b6bff'});
    }
    for(const e of entities){
      // anchor + tether only affect the caster's opponent; a gravity well drags everyone
      if((w.kind==='anchor' || w.kind==='tether') && e===w.owner) continue;
      if(e.intangibleT>0) continue;
      if(e.mods.wellImmune) continue;                                  // HEAVY BOOTS
      const d = len(w.x-e.x, w.y-e.y);

      if(w.kind==='tether'){
        // a leash, not a vacuum: only bites once they try to leave the ring
        if(d > w.r){
          const n = norm(w.x-e.x, w.y-e.y);
          e.vx += n.x*w.strength*e.mods.wellPullMult*dt;
          e.vy += n.y*w.strength*e.mods.wellPullMult*dt;
        }
        continue;
      }

      if(d < w.r && d > 1){
        if(e.mods.knockbackTakenMult<=0 && w.kind==='anchor') continue; // knockback-immune resists the pull
        const n = norm(w.x-e.x, w.y-e.y);
        const falloff = 1 - (d/w.r);
        e.vx += n.x*w.strength*falloff*e.mods.wellPullMult*dt;
        e.vy += n.y*w.strength*falloff*e.mods.wellPullMult*dt;
      }
    }
  }
}

function updateBeacons(dt){
  for(let i=state.beacons.length-1;i>=0;i--){
    state.beacons[i].life -= dt;
    if(state.beacons[i].life<=0) state.beacons.splice(i,1);
  }
}

function updateAfterImages(dt){
  for(let i=state.afterImages.length-1;i>=0;i--){
    state.afterImages[i].life -= dt;
    if(state.afterImages[i].life<=0) state.afterImages.splice(i,1);
  }
}

/** Magnet Pulse / Magnet Charm: drag loose pickups toward the holder. */
export function updateMagnet(dt, entities){
  for(const e of entities){
    if(e.magnetT<=0) continue;
    for(const p of state.powerups){
      const d = len(p.x-e.x, p.y-e.y);
      if(d < 130 && d > 1){
        const n = norm(e.x-p.x, e.y-p.y);
        p.x += n.x*90*dt;
        p.y += n.y*90*dt;
      }
    }
  }
}

/** Warp Crystal: teleport the holder to a random open spot. */
export function resolveWarps(entities){
  for(const e of entities){
    if(!e.warpRequest) continue;
    e.warpRequest = false;
    for(let tries=0; tries<40; tries++){
      const x = 40 + Math.random()*(WORLD_W-80);
      const y = 40 + Math.random()*(WORLD_H-80);
      if(!wallBlocked(x,y)){
        e.x = x; e.y = y; e.vx*=0.2; e.vy*=0.2;
        for(let k=0;k<10;k++){
          state.particles.push({
            x,y,vx:(Math.random()-0.5)*50,vy:(Math.random()-0.5)*50,
            life:0.45,maxLife:0.45,color:'#9b6bff',size:2,
          });
        }
        break;
      }
    }
  }
}
