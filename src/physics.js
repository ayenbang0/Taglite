import {
  WORLD_W, WORLD_H, RADIUS, BASE_MAX_SPEED, BASE_ACCEL, FRICTION,
  DASH_IMPULSE, DASH_BURST_TIME, DASH_COOLDOWN, DASH_IFRAME, DASH_LOCK,
  SPRINT_BOOST_MAX, SPRINT_BOOST_MIN, SPRINT_ACCEL_MAX, SPRINT_ACCEL_MIN,
  SPRINT_TAPER_AT, SPRINT_DRAIN_BASE, SPRINT_DRAIN_RAMP, SPRINT_DRAIN_RAMP_T,
  SPRINT_REGEN_MIN, SPRINT_REGEN_MAX, SPRINT_REGEN_RAMP_T, SPRINT_REGEN_MOVE_PENALTY,
  SPRINT_FATIGUE_MULT, SPRINT_FATIGUE_TIME, SPRINT_RECOVER_FRAC, ROUND_TIME,
  STUMBLE_SPEED_MULT, STUMBLE_ACCEL_MULT, TURN_BRAKE, TURN_ACCEL_PENALTY,
  TURN_COS_START, TURN_MIN_SPEED, DASH_STAMINA_COST, FATIGUE_STUMBLE_SPEED,
  FATIGUE_STUMBLE_TIME, ICE_SLIP,
} from './config.js';
import { len, norm, clamp, dist } from './math.js';
import { kickShake } from './feel.js';
import { zoneAt, resolveWalls, wallBlocked } from './arena.js';
import { ABILITY_BY_ID } from './abilities.js';
import { makeDecoy } from './entity.js';
import { playAnim, archetypeForAbility, archetypeForClass } from './anim.js';
import { state } from './state.js';

/* =========================================================================
   MOVEMENT
   ========================================================================= */
export function updatePhysics(e, dirX, dirY, dt, sprint, aiSpeedMult){
  const m = e.mods;
  const airborne = e.airT>0;
  const inZone = airborne ? null : zoneAt(e.x,e.y);
  let maxSpeed = BASE_MAX_SPEED * m.speedMult;
  let accel = BASE_ACCEL * m.accelMult;
  let frictionScale = 1;

  if(airborne) maxSpeed *= 1.1;
  if(inZone){
    if(inZone.type==='slow' && !m.slowZoneImmune && e.rushT<=0){
      const resist = m.slowZoneResist !== undefined ? m.slowZoneResist : 1;
      maxSpeed *= 1 - 0.45*resist;
      accel *= 1 - 0.3*resist;
    } else if(inZone.type==='speed'){
      maxSpeed *= 1.4;
      accel *= 1.25;
    } else if(inZone.type==='ice'){
      if(m.iceAffinity){
        maxSpeed *= 1.25;
      } else {
        const slip = ICE_SLIP * m.iceSlipMult * (e.gripT>0 ? 0 : 1);
        frictionScale = Math.max(0.3, 1 - slip);
        accel *= 1 - 0.35*(slip/ICE_SLIP);
      }
    } else if(inZone.type==='warp' && inZone.owner!==e){
      maxSpeed *= 0.55; accel *= 0.55;
    } else if(inZone.type==='dust' && inZone.owner!==e){
      maxSpeed *= 0.85;
    }
  }
  if(e.speedBuffT>0) maxSpeed *= 1.5;
  if(e.surgeT>0) maxSpeed *= 1.5;
  // WIND UP: rewards holding a sprint rather than tapping it
  if(m.windUp && e.sprintHeldT >= 2) maxSpeed *= 1.15;
  // LAST STAND: the final 30 seconds of a duel
  if(m.lastStand && state.round && state.round.timer < 30) maxSpeed *= 1.20;
  // ---- wave 3 growth / conditional traits ----
  if(e.lustStacks)   maxSpeed *= 1 + 0.04*e.lustStacks;   // BLOODY LUST
  if(e.pickupStacks) maxSpeed *= 1 + 0.03*e.pickupStacks; // QUICKSILVER
  if(m.privilegedStatus && e.privileged) maxSpeed *= 1.18;
  if(m.boilingBlood && e.closeToFoe) accel *= 1.25;
  // FROSTBITE stacks, applied to whoever is carrying them
  if(e.chillStacks) maxSpeed *= Math.max(0.5, 1 - 0.08*e.chillStacks);
  // BRITTLE BONES daze after a wall hit
  if(e.stunT>0){ maxSpeed *= 0.45; accel *= 0.45; }
  // SIPHON BEAM windup roots you while it charges - that's the cost
  if(e.beamChargeT>0){ maxSpeed *= 0.25; accel *= 0.25; }
  if(e.burstActive) maxSpeed *= 1.6;
  if(e.slowDebuffT>0) maxSpeed *= e.slowDebuffMult;
  if(e.accelDebuffT>0) accel *= e.accelDebuffMult;
  // ---- stumbles, timed buffs and conditional traits ----
  if(e.stumbleT>0){ maxSpeed *= STUMBLE_SPEED_MULT; accel *= STUMBLE_ACCEL_MULT; }
  if(e.rushT>0){ maxSpeed *= 1.45; accel *= 1.5; }
  if(e.stampedeT>0) maxSpeed *= 1.25;
  if(e.overdriveT>0) accel *= 1.5;
  if(e.kickT>0) accel *= 1.3;
  if(e.slingT>0) accel *= 1.8;
  if(e.gripT>0) accel *= 1.1;
  if(e.pressedT>0) maxSpeed *= 0.9;
  if(m.slowburn) maxSpeed *= e.calmT>=6 ? 1.3 : 0.85;
  if(m.grudge) maxSpeed *= 1 + 0.05*Math.min(5, e.debuffN);
  if(m.cadence) maxSpeed *= 1 + 0.04*e.cadenceStacks;
  // sprint raises top speed AND acceleration - a real burst, not just a ceiling
  if(sprint){ maxSpeed *= sprint.speedMult; accel *= sprint.accelMult; }
  if(aiSpeedMult) maxSpeed *= aiSpeedMult;

  const moving = len(dirX,dirY) > 0.05;
  if(e.dashLockT<=0 && e.slideT<=0 && moving){
    const dl = len(dirX,dirY);
    const n = {x:dirX/dl, y:dirY/dl};
    // planted turn: reversing against your own momentum costs you speed and
    // bite, unless you're gripping (class/passive/ability)
    const sp0 = len(e.vx,e.vy);
    if(sp0 > TURN_MIN_SPEED){
      const cosang = (n.x*e.vx + n.y*e.vy)/sp0;
      if(cosang < TURN_COS_START){
        const t = (TURN_COS_START-cosang)/(1+TURN_COS_START);
        const grip = clamp(m.turnGrip + (e.gripT>0 ? 1 : 0), -1, 1);
        accel *= Math.max(0.1, 1 - TURN_ACCEL_PENALTY*t*(1-grip));
        const brake = Math.exp(-TURN_BRAKE*t*(1-grip)*dt);
        e.vx *= brake; e.vy *= brake;
        if(sp0>120 && t>0.4 && e.skidCd<=0){
          e.skidCd = 0.1;
          for(let i=0;i<3;i++){
            state.particles.push({x:e.x,y:e.y,vx:(Math.random()-0.5)*30,vy:(Math.random()-0.5)*30,life:0.35,maxLife:0.35,color:'#8b93b8',size:2});
          }
          kickShake(1,0.12);
        }
      }
    }
    e.vx += n.x*accel*dt;
    e.vy += n.y*accel*dt;
    e.lastMoveDir = n;
  }

  // "standing still" tracking, for Static Charge / Camouflage / Anchor
  const speedNow = len(e.vx,e.vy);
  if(!moving && speedNow < 14){
    e.staticT += dt;
    if(m.staticCharge && e.staticT >= 1.5) e.staticReady = true;
  } else {
    e.staticT = 0;
  }

  // friction: exponential decay toward 0, then soft-clamp to maxSpeed
  // (dash impulses are allowed to briefly exceed maxSpeed and bleed off naturally)
  const fricFactor = Math.exp(-FRICTION*m.frictionMult*frictionScale*(e.slideT>0 ? 0.3 : 1)*dt);
  e.vx *= fricFactor;
  e.vy *= fricFactor;
  const sp = len(e.vx,e.vy);
  const burst = e.dashBurstT>0 || e.slideT>0 || e.pounceT>0 || e.launchT>0;
  const hardCap = maxSpeed * (burst ? 3.6 : 1.9);
  if(sp > hardCap){
    const n = norm(e.vx,e.vy);
    e.vx = n.x*hardCap; e.vy = n.y*hardCap;
  }

  e.x += e.vx*dt;
  e.y += e.vy*dt;
  resolveWalls(e);
  e.x = clamp(e.x, RADIUS, WORLD_W-RADIUS);
  e.y = clamp(e.y, RADIUS, WORLD_H-RADIUS);

  recordPosition(e, dt);
  tickTimers(e, dt);
}

/** Rolling ~3s breadcrumb trail, so RECALL has somewhere to send you back to. */
function recordPosition(e, dt){
  e.posHistoryT -= dt;
  if(e.posHistoryT<=0){
    e.posHistoryT = 0.25;
    e.posHistory.push({x:e.x, y:e.y});
    if(e.posHistory.length > 12) e.posHistory.shift();  // 12 * 0.25s = 3s
  }
}

function tickTimers(e, dt){
  const dec = t => Math.max(0, t-dt);
  e.dashCd        = dec(e.dashCd);
  e.dashLockT     = dec(e.dashLockT);
  e.dashIframe    = dec(e.dashIframe);
  e.dashBurstT    = dec(e.dashBurstT);
  e.abilityCd     = dec(e.abilityCd);
  e.invisT        = dec(e.invisT);
  e.shieldT       = dec(e.shieldT);
  e.speedBuffT    = dec(e.speedBuffT);
  e.revealT       = dec(e.revealT);
  e.slowDebuffT   = dec(e.slowDebuffT);
  e.intangibleT   = dec(e.intangibleT);
  e.tagBuffT      = dec(e.tagBuffT);
  e.pierceT       = dec(e.pierceT);
  e.surgeT        = dec(e.surgeT);
  e.noDashT       = dec(e.noDashT);
  e.smokeT        = dec(e.smokeT);
  e.markedT       = dec(e.markedT);
  e.magnetT       = dec(e.magnetT);
  e.absorbT       = dec(e.absorbT);
  e.fatigueImmuneT= dec(e.fatigueImmuneT);
  e.accelDebuffT  = dec(e.accelDebuffT);
  e.blindT        = dec(e.blindT);
  e.seeThroughT   = dec(e.seeThroughT);
  e.revealedByTrapT = dec(e.revealedByTrapT);
  e.frostT        = dec(e.frostT);
  e.wardT         = dec(e.wardT);
  e.stunT         = dec(e.stunT);
  e.puddleT       = dec(e.puddleT);
  e.skidCd        = dec(e.skidCd);
  e.launchT       = dec(e.launchT);
  e.stumbleT      = dec(e.stumbleT);
  e.slideT        = dec(e.slideT);
  e.airT          = dec(e.airT);
  e.braceT        = dec(e.braceT);
  e.stampedeT     = dec(e.stampedeT);
  e.pacerT        = dec(e.pacerT);
  e.gripT         = dec(e.gripT);
  e.counterT      = dec(e.counterT);
  e.kickT         = dec(e.kickT);
  e.slingT        = dec(e.slingT);
  e.pressedT      = dec(e.pressedT);
  e.startleCd     = dec(e.startleCd);
  e.calmT        += dt;
  const prevRush = e.rushT, prevPounce = e.pounceT, prevOver = e.overdriveT;
  e.rushT         = dec(e.rushT);
  e.pounceT       = dec(e.pounceT);
  e.overdriveT    = dec(e.overdriveT);
  e.bodyCheckT    = (e.rushT>0 || e.braceT>0 || e.stampedeT>0) ? 1 : 0;
  if(prevPounce>0 && e.pounceT<=0 && !e.pounceHit) applyStagger(e, 0.8);
  if(prevOver>0 && e.overdriveT<=0) applyStagger(e, 0.9);
  if(prevRush>0 && e.rushT<=0) rushDetonate(e);

  // STILL WATERS: cooldowns tick twice as fast while standing still
  if(e.mods.stillnessCharm && e.staticT>=0.8){
    e.abilityCd = dec(e.abilityCd);
    for(let i=0;i<e.slotCd.length;i++) e.slotCd[i] = dec(e.slotCd[i]);
  }
  // CADENCE: sustained hard running builds speed; stopping or stumbling resets it
  if(e.mods.cadence){
    const spd = len(e.vx,e.vy);
    if(spd > 0.7*BASE_MAX_SPEED*e.mods.speedMult && e.stumbleT<=0){
      e.slowStillT = 0;
      e.cadenceT += dt;
      if(e.cadenceT>=3){ e.cadenceT = 0; e.cadenceStacks = Math.min(5, e.cadenceStacks+1); }
    } else if(spd<20 || e.stumbleT>0){
      e.slowStillT += dt;
      if(e.stumbleT>0 || e.slowStillT>=1){ e.cadenceStacks = 0; e.cadenceT = 0; }
    }
  }

  // FROSTBITE stacks melt once they stop being refreshed
  e.chillT = dec(e.chillT);
  if(e.chillT<=0 && e.chillStacks>0){ e.chillStacks--; e.chillT = 1.2; }
  for(let i=0;i<e.slotCd.length;i++) e.slotCd[i] = dec(e.slotCd[i]);

  if(e.tagBuffT<=0) e.tagBuffMult = 1;

  // dash charge regeneration: one charge per cooldown, re-arming the timer
  // while any are still missing
  if(e.dashCd<=0 && e.dashCharges < e.dashChargesMax){
    e.dashCharges++;
    if(e.dashCharges < e.dashChargesMax){
      e.dashCd = DASH_COOLDOWN * e.mods.dashCdMult;
    }
  }

  // scout stamina (its signature ability is stamina-gated rather than cooldown-gated)
  if(e.clsKey==='scout'){
    if(e.burstActive){
      e.stamina -= 45*dt;
      if(e.stamina<=0){ e.stamina=0; e.burstActive=false; }
    } else {
      e.stamina = Math.min(100, e.stamina + 16*dt);
    }
  }
}

/** Effective tag radius for a tagger, including buffs and build mods. */
export function tagRadius(e){
  let mult = e.mods.tagRadiusMult * (e.tagBuffT>0 ? e.tagBuffMult : 1);
  // DEATH'S TOUCH: reach creeps up the longer the duel drags on
  if(e.mods.deathsTouch && state.round){
    const elapsed = (state.round.duration || ROUND_TIME) - state.round.timer;
    mult += 0.02 * Math.floor(elapsed/15);
  }
  let r = RADIUS*2 * mult;
  if(e.slideT>0) r *= 1.25;
  if(e.pounceT>0) r *= 1.5;
  r += e.mods.momentumReach*3*clamp(len(e.vx,e.vy)/250, 0, 1);
  return r;
}

/* =========================================================================
   DASH
   ========================================================================= */
export function tryDash(e){
  if(e.noDashT>0) return false;
  // charges are the resource; dashCd is the refill timer that hands them back
  if(e.dashCharges<=0) return false;
  if(e.stumbleT>0) return false;

  const m = e.mods;
  const dir = len(e.vx,e.vy)>5 ? norm(e.vx,e.vy) : e.lastMoveDir;
  const staticBonus = e.staticReady ? 1.3 : 1;
  // remember where the dash started, so "dashing THROUGH someone" can be
  // measured against the path travelled - teleport dashes (Blink, Phase Walk)
  // would otherwise skip straight past without ever registering a pass
  e.dashFrom = {x:e.x, y:e.y};

  const phasing = m.wallPhaseDash || e.wallbreakCharge;

  if(e.clsKey==='rogue'){
    // blink: short teleport, covers real ground
    teleportAlong(e, dir, 78*staticBonus, phasing);
    e.vx = dir.x*70; e.vy = dir.y*70;
  } else if(phasing){
    // phantom / wallbreaker: punch straight through geometry
    teleportAlong(e, dir, 70*staticBonus, true);
    e.vx += dir.x*DASH_IMPULSE*0.6;
    e.vy += dir.y*DASH_IMPULSE*0.6;
    e.intangibleT = Math.max(e.intangibleT, 0.18);
  } else {
    e.vx += dir.x*DASH_IMPULSE*staticBonus;
    e.vy += dir.y*DASH_IMPULSE*staticBonus;
  }

  e.wallbreakCharge = false;
  e.staticReady = false;

  e.dashCharges--;
  if(e.dashCd<=0) e.dashCd = DASH_COOLDOWN * m.dashCdMult;
  e.dashLockT = DASH_LOCK * m.dashLockMult;
  // lunging costs breath, but never enough to tip you into fatigue by itself
  const cost = Math.min(e.sprint, DASH_STAMINA_COST);
  e.sprint -= cost;
  e.restT = 0;
  if(m.airTime && e.airT<0.3){ e.airT = 0.3; e.airT0 = 0.3; }
  e.dashIframe = DASH_IFRAME + m.dashIframeBonus;
  e.dashBurstT = DASH_BURST_TIME;
  e.dashHitApplied = false;   // DIVINE DASH re-arms for this dash
  playAnim('dash', e, dir);
  spawnTrail(e);

  if(e.ghostTrailCharge){
    state.afterImages.push({x:e.x,y:e.y,life:2,maxLife:2,color:e.cls.color,owner:e});
    e.ghostTrailCharge = false;
  }
  if(e.clsKey==='trickster'){ e.invisT = 1; }
  return true;
}

function teleportAlong(e, dir, distance, ignoreWalls){
  let travel = 0; const step = 4;
  while(travel < distance){
    const nx = e.x + dir.x*step, ny = e.y + dir.y*step;
    if(nx<RADIUS||ny<RADIUS||nx>WORLD_W-RADIUS||ny>WORLD_H-RADIUS) break;
    if(!ignoreWalls && wallBlocked(nx,ny)) break;
    e.x = nx; e.y = ny; travel += step;
  }
  // never end a phase inside geometry
  if(ignoreWalls && wallBlocked(e.x,e.y)){
    let t=0;
    while(t<60 && wallBlocked(e.x,e.y)){
      e.x += dir.x*step; e.y += dir.y*step; t+=step;
      e.x = clamp(e.x, RADIUS, WORLD_W-RADIUS);
      e.y = clamp(e.y, RADIUS, WORLD_H-RADIUS);
    }
  }
}

/** Bull Rush ending: a shoulder-charge shockwave that staggers whoever is close. */
function rushDetonate(e){
  const R = 45;
  state.shockwaveFX.push({x:e.x,y:e.y,r:0,maxR:R,t:0});
  for(const o of state.entities){
    if(o===e || o.alive===false || o.frozen || o.hunting===e.hunting) continue;
    if(dist(e,o) <= R){
      applyStagger(o, 0.9);
      applyKnockback(e, o, 170);
    }
  }
  kickShake(3, 0.25);
}

/* =========================================================================
   ABILITIES
   ========================================================================= */
/**
 * Direction an ability should animate along. Explicit and in world/screen
 * space, in priority order: where you aimed, else toward the target, else
 * where you're moving. Never derived from a body-relative notion of "right".
 */
function actionDir(e, aim, target){
  if(aim) return {x:aim.x-e.x, y:aim.y-e.y};
  if(target) return {x:target.x-e.x, y:target.y-e.y};
  return e.lastMoveDir;
}

/** The class's fixed signature ability (E). */
export function tryClassAbility(e, opponent, aim){
  const m = e.mods;
  if(e.clsKey==='scout'){
    if(e.stamina>25){
      e.burstActive = true;
      playAnim(archetypeForClass('scout'), e, e.lastMoveDir);
      return true;
    }
    return false;
  }
  if(e.abilityCd>0) return false;
  playAnim(archetypeForClass(e.clsKey), e, actionDir(e, aim, opponent));

  if(e.clsKey==='rogue'){
    teleportAlong(e, e.lastMoveDir, 95, false);
    spawnTrail(e);
  } else if(e.clsKey==='tank'){
    const radius = 75;
    state.shockwaveFX.push({x:e.x,y:e.y,r:0,maxR:radius,t:0});
    if(opponent && dist(e,opponent) <= radius){
      applyKnockback(e, opponent, 140);
      applySlow(opponent, 2, 0.55);
    }
  } else if(e.clsKey==='trickster'){
    state.decoys.push(makeDecoy(e, 4));
  } else if(e.clsKey==='trapper'){
    // SNARE FIELD - a wide root trap centred on the caster
    state.traps.push({x:e.x,y:e.y,r:30*m.trapRadiusMult,owner:e,life:18,kind:'snare'});
    state.shockwaveFX.push({x:e.x,y:e.y,r:0,maxR:30*m.trapRadiusMult,t:0});
  } else if(e.clsKey==='hunter'){
    // HUNTER'S BOLT - aimed ranged tag attempt
    if(!aim) return false;
    const d = norm(aim.x-e.x, aim.y-e.y);
    state.projectiles.push({
      x:e.x,y:e.y,vx:d.x*300,vy:d.y*300,owner:e,life:0.6,kind:'bolt',color:'#e0673f',
    });
  } else if(e.clsKey==='phantom'){
    // PHASE WALK - a wall-crossing burst
    teleportAlong(e, e.lastMoveDir, 105, true);
    e.intangibleT = Math.max(e.intangibleT, 0.35);
    e.dashIframe = Math.max(e.dashIframe, 0.3);
    spawnTrail(e);
  } else if(e.clsKey==='anchor'){
    // GRAVITY ANCHOR - aimed pull well
    if(!aim) return false;
    state.wells.push({x:aim.x,y:aim.y,r:70,life:2,strength:200,owner:e,kind:'anchor'});
  } else if(e.clsKey==='brawler'){
    // BULL RUSH - unstoppable charge; the shockwave lands when it ends (rushDetonate)
    e.rushT = 0.7;
    e.rushFrom = {x:e.x, y:e.y};
  } else if(e.clsKey==='warden'){
    // BULWARK - two orbiting guards that swat projectiles and shove foes
    for(let i=0;i<2;i++){
      state.familiars.push({kind:'guard',owner:e,angle:i*Math.PI,life:6,hp:2,cd:0,x:e.x,y:e.y});
    }
  } else if(e.clsKey==='skater'){
    // SLICK - lay down your own ice
    state.tempZones.push({x:e.x,y:e.y,r:48,type:'ice',life:6,owner:e});
  } else if(e.clsKey==='chrono'){
    // TIMEWARP - a bubble that drags everyone but you
    state.tempZones.push({x:e.x,y:e.y,r:70,type:'warp',life:3.5,owner:e});
  }

  e.abilityCd = e.cls.abilityCooldown * m.abilityCdMult;
  return true;
}

/** A drafted ability in slot 0-3. */
export function trySlotAbility(e, slot, opponent, aim){
  const id = e.build.abilities[slot];
  if(!id) return false;
  const def = ABILITY_BY_ID[id];
  if(!def) return false;
  if(e.slotCd[slot]>0) return false;
  if(def.aimed && !aim) return false;

  const ok = def.cast(e, {opponent, aim, mods:e.mods});
  if(!ok) return false;
  e.slotCd[slot] = def.cd * e.mods.abilityCdMult;
  playAnim(archetypeForAbility(def.id), e, actionDir(e, aim, opponent));
  return true;
}

export function applyKnockback(source, target, force){
  if(target.absorbT>0){ target.absorbT = 0; return; }
  if(target.rushT>0) return;               // a charging body can't be shoved off its line
  const braceMult = target.braceT>0 ? 0.3 : 1;
  const mult = (source ? source.mods.knockbackDealtMult : 1) * target.mods.knockbackTakenMult * braceMult;
  if(mult<=0) return;
  const n = norm(target.x-source.x, target.y-source.y);
  target.vx += n.x*force*mult;
  target.vy += n.y*force*mult;
  if(force>=200){ target.launchT = Math.max(target.launchT, 0.25); kickShake(2,0.15); }
  target.calmT = 0;
  // the other half of the pair: every strike gets a reaction, flinching
  // along the impact vector
  playAnim('hit', target, n);
  startleCheck(target);
}

/** A hard stumble: slows and robs steering. Resisted by mass-y builds and braced states. */
export function applyStagger(e, t){
  if(e.absorbT>0){ e.absorbT = 0; return; }
  const res = e.mods.staggerResist + ((e.stampedeT>0 || e.rushT>0 || e.braceT>0) ? 1 : 0);
  if(res>=1) return;
  e.stumbleT = Math.max(e.stumbleT, t*(1-res));
  e.calmT = 0;
  playAnim('hit', e, e.lastMoveDir);
  startleCheck(e);
}

/** STARTLE REFLEX: being shoved or stumbled buys a short dodge and a burst. */
function startleCheck(e){
  if(e.mods.startleReflex && e.startleCd<=0){
    e.startleCd = 6;
    e.dashIframe = Math.max(e.dashIframe, 0.6);
    e.speedBuffT = Math.max(e.speedBuffT, 0.5);
  }
}

export function applySlow(target, time, mult){
  if(target.absorbT>0){ target.absorbT = 0; return; }
  target.slowDebuffT = Math.max(target.slowDebuffT, time);
  target.slowDebuffMult = mult;
  target.calmT = 0;
  playAnim('hit', target, target.lastMoveDir);
  startleCheck(target);
}

export function spawnTrail(e){
  for(let i=0;i<4;i++){
    state.particles.push({x:e.x,y:e.y,vx:(Math.random()-0.5)*20,vy:(Math.random()-0.5)*20,life:0.35,maxLife:0.35,color:e.cls.color,size:2});
  }
}

/* =========================================================================
   SPRINT
   ========================================================================= */
const NEUTRAL_SPRINT = {speedMult:1, accelMult:1};
const FATIGUED_SPRINT = {speedMult:SPRINT_FATIGUE_MULT, accelMult:SPRINT_FATIGUE_MULT};
const FATIGUED_SOFT = {speedMult:0.85, accelMult:0.85};

function smoothstep(x){ x = clamp(x,0,1); return x*x*(3-2*x); }

/**
 * Recovery rate per second. Two things suppress it, both deliberately:
 * being freshly stopped (oxygen debt) and still moving fast (you don't get
 * your breath back at a dead run).
 */
function regenPerSec(e){
  const restRamp = smoothstep(e.restT / SPRINT_REGEN_RAMP_T);
  let rate = SPRINT_REGEN_MIN + (SPRINT_REGEN_MAX - SPRINT_REGEN_MIN)*restRamp;
  const speedNow = len(e.vx, e.vy);
  const moveFrac = clamp(speedNow / (BASE_MAX_SPEED * e.mods.speedMult), 0, 1);
  rate *= 1 - SPRINT_REGEN_MOVE_PENALTY*moveFrac;
  return rate * e.mods.sprintRegenMult * (e.pacerT>0 ? 1.5 : 1);
}

/** Returns {speedMult, accelMult} for this frame. */
export function updateSprint(e, held, dt){
  const m = e.mods;
  const max = e.sprintMax;
  // SLINGSHOT: letting go of a long sprint fires a short burst
  if(m.slingshot && !held && e.prevSprintHeld && e.sprintHeldT>=1.5) e.slingT = 0.4;
  e.prevSprintHeld = held;
  // MOM'S GRIP trades sprinting away entirely for reach
  if(m.noSprint){
    e.sprintActive = false;
    e.sprintHeldT = 0;
    e.sprint = max;
    return NEUTRAL_SPRINT;
  }

  // ---- blown: hard penalty until you've both waited AND got breath back ----
  if(e.fatigued){
    e.fatigueT -= dt;
    e.sprintActive = false;
    e.sprintHeldT = 0;
    e.restT += dt;
    e.sprint = Math.min(max, e.sprint + regenPerSec(e)*dt);
    if(e.fatigueT<=0 && e.sprint >= max*SPRINT_RECOVER_FRAC) e.fatigued = false;
    // Phantom's passive: fatigue never touches the dash, only ground speed
    return (m.fatigueDashImmune && e.dashBurstT>0) ? NEUTRAL_SPRINT
         : (m.ironCalves ? FATIGUED_SOFT : FATIGUED_SPRINT);
  }

  // ---- stumbling: no boost, but breath still comes back ----
  if(e.stumbleT>0){
    e.sprintActive = false;
    e.sprintHeldT = 0;
    e.restT += dt;
    e.sprint = Math.min(max, e.sprint + regenPerSec(e)*dt);
    return NEUTRAL_SPRINT;
  }

  // ---- sprinting ----
  if(held && e.sprint > 1){
    e.sprintActive = true;
    e.sprintHeldT += dt;
    e.restT = 0;

    // cost climbs the longer the burst is sustained
    const ramp = smoothstep(e.sprintHeldT / SPRINT_DRAIN_RAMP_T);
    let drain = (SPRINT_DRAIN_BASE + SPRINT_DRAIN_RAMP*ramp) * m.sprintDrainMult
              * (e.pacerT>0 ? 0.6 : 1) * (e.overdriveT>0 ? 1.4 : 1);
    if(m.firstWind && e.sprintHeldT < 1.5) drain = 0;
    drain = Math.max(0, drain);
    e.sprint = Math.max(0, e.sprint - drain*dt);

    if(e.sprint<=0){
      e.sprint = 0;
      if(e.fatigueImmuneT>0){
        e.sprint = max*0.25;            // immunity converts the crash into a top-up
      } else if(e.adrenalLeft>0){
        e.adrenalLeft--;                 // Adrenal Rush: cancel the first fatigue
        e.sprint = max*0.35;
      } else {
        e.fatigued = true;
        if(len(e.vx,e.vy) > FATIGUE_STUMBLE_SPEED) applyStagger(e, FATIGUE_STUMBLE_TIME);
        e.fatigueT = SPRINT_FATIGUE_TIME;
        e.sprintActive = false;
        e.sprintHeldT = 0;
        return FATIGUED_SPRINT;
      }
    }

    // output fades as the tank empties - no top-speed sprinting while gassed
    const k = smoothstep((e.sprint/max) / SPRINT_TAPER_AT);
    return {
      speedMult: SPRINT_BOOST_MIN + (SPRINT_BOOST_MAX-SPRINT_BOOST_MIN)*k,
      accelMult: SPRINT_ACCEL_MIN + (SPRINT_ACCEL_MAX-SPRINT_ACCEL_MIN)*k,
    };
  }

  // ---- easing off ----
  e.sprintActive = false;
  e.sprintHeldT = 0;
  e.restT += dt;
  e.sprint = Math.min(max, e.sprint + regenPerSec(e)*dt);
  return NEUTRAL_SPRINT;
}
