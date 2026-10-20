import {
  IW, IH, WORLD_W, WORLD_H, RADIUS, ROUND_TIME, GRACE_TIME,
  PING_INTERVAL_TAGGER, PING_INTERVAL_RUNNER, PING_SHOW_TIME,
  CLASSES, MAX_ACTIVE_SLOTS, RARE_PICKUP_CHANCE, setWorldSize, HITSTOP_TAG,
} from './config.js';
import { clamp, len, norm, dist } from './math.js';
import { state } from './state.js';
import { makeEntity } from './entity.js';
import { refreshMods } from './build.js';
import { buildWalls, buildZones, wallBlocked, segmentBlocked, puSpawnPoints } from './arena.js';
import { buildPathGrid } from './pathfinding.js';
import { mapParams } from './mapmods.js';
import { modeForDuel, enemiesOf, alliesOf, teamOf, draftThresholds } from './modes.js';
import {
  updatePhysics, updateSprint, tryDash, tryClassAbility, trySlotAbility,
  tagRadius, applyKnockback, applySlow, applyStagger,
} from './physics.js';
import { kickShake, hitstop, updateCamera, updateFeel, snapCamera } from './feel.js';
import { inputToWorld } from './iso.js';
import { effectiveMass, resolveBodies } from './bodies.js';
import { updateAI } from './ai.js';
import {
  resetEffects, updateEffects, updateMagnet, resolveWarps, addChill, updateDecoys,
} from './effects.js';
import { COMMON_PICKUPS, RARE_PICKUPS, applyPickup } from './pickups.js';
import { isAimed, aimRange, aimPoint, arm, disarm } from './targeting.js';
import { render } from './render.js';
import { updateHud, setDuelHeader, buildAbilityBar } from './hud.js';
import { showScreen, showAnnounce, renderDraft, renderRunSummary } from './ui.js';
import { rollDraft, applyPick } from './draft.js';
import { playAnim, updateAnims, resetAnims } from './anim.js';
import { recordDuel, advanceDuel, duelXp, endRun, draftForAllAI } from './run.js';
import { awardXp } from './progression.js';

/* =========================================================================
   DUEL SETUP
   ========================================================================= */
function spawnSpots(n){
  // ring the arena so nobody starts on top of anyone else
  const spots = [];
  const cx = WORLD_W/2, cy = WORLD_H/2;
  const rx = WORLD_W*0.38, ry = WORLD_H*0.38;
  for(let i=0;i<n;i++){
    const a = (i/n)*Math.PI*2 + Math.random()*0.3;
    let x = clamp(cx + Math.cos(a)*rx, 60, WORLD_W-60);
    let y = clamp(cy + Math.sin(a)*ry, 60, WORLD_H-60);
    // nudge off any wall it happened to land in
    for(let t=0; t<24 && wallBlocked(x,y); t++){
      x = clamp(x + (Math.random()-0.5)*70, 60, WORLD_W-60);
      y = clamp(y + (Math.random()-0.5)*70, 60, WORLD_H-60);
    }
    spots.push({x,y});
  }
  return spots;
}

function spawnEntities(mode){
  const run = state.run;
  const n = mode.entities;
  const spots = spawnSpots(n);

  // team assignment: `split` on the hunting team, rest are prey, then shuffled
  // so the player's side is genuinely randomised each duel
  const teams = [];
  for(let i=0;i<n;i++) teams.push(i < mode.split ? mode.teams[0] : mode.teams[1]);
  for(let i=teams.length-1;i>0;i--){
    const j = Math.floor(Math.random()*(i+1));
    [teams[i],teams[j]] = [teams[j],teams[i]];
  }

  const playerIdx = Math.floor(Math.random()*n);
  state.entities = [];
  let aiIdx = 0;

  for(let i=0;i<n;i++){
    const isPlayer = (i === playerIdx);
    const clsKey = isPlayer ? run.clsKey : run.aiClasses[aiIdx % run.aiClasses.length];
    const build  = isPlayer ? run.player : run.aiBuilds[aiIdx % run.aiBuilds.length];
    const hunting = (teams[i] === mode.teams[0]);
    // role is known up front so the hunter/prey baseline is folded into mods
    const e = makeEntity(spots[i].x, spots[i].y, clsKey, !isPlayer, build, hunting);
    e.id = i;
    e.team = teams[i];
    e.role = teams[i];
    e.hunting = hunting;
    if(isPlayer) state.player = e; else aiIdx++;
    state.entities.push(e);
  }
  state.bot = state.entities.find(e => e.isBot) || null;
}

export function startDuel(){
  const run = state.run;
  const mode = modeForDuel(run.duel);
  state.mode = mode;
  setWorldSize(mode.world.w, mode.world.h);

  const params = mapParams(run.duel, run.mods);
  state.mapParams = params;

  state.walls = buildWalls(params.wallVariant);
  buildPathGrid();
  buildZones(params);
  state.puSpawnPoints = puSpawnPoints();
  state.tempZones = [];
  state.particles = [];
  state.decoys = [];
  state.powerups = [];
  state.puTimer = 3 * (params.pickupRateMult===Infinity ? 1 : params.pickupRateMult);
  state.shockwaveFX = [];
  state.rareSpawnedThisDuel = false;
  resetEffects();
  resetAnims();
  disarm();
  state.wallShiftDone = false;

  spawnEntities(mode);
  snapCamera();

  // bot execution skill scales with run depth (builds scale separately, via drafts)
  const skill = clamp((run.duel-1)/12, 0, 1);
  state.botAI = {
    skill,
    speedMult: 0.85 + skill*0.2,
    jitterDeg: 30*(1-skill),
    reactionT: 0.32 - 0.16*skill,
    predictT: 0.15 + 0.3*skill,
    dashChance: 0.45 + 0.45*skill,
    abilityChance: 0.4 + 0.5*skill,
  };

  const duration = mode.duration || ROUND_TIME;
  state.round = {
    timer: duration, duration, grace: GRACE_TIME, active:true,
    // remaining-time thresholds still to fire, latest first
    draftMarks: draftThresholds(mode),
    awaitingDraft:false,
  };
  state.pingTimer = state.player.hunting ? PING_INTERVAL_TAGGER : PING_INTERVAL_RUNNER;
  state.pingShowT = 0;

  setDuelHeader();
  buildAbilityBar();

  showAnnounce(duelOpeningLine(mode));
  showScreen('screen-game');
  state.lastTime = performance.now();
  if(state.rafId) cancelAnimationFrame(state.rafId);
  state.rafId = requestAnimationFrame(loop);
}

function duelOpeningLine(mode){
  const p = state.player;
  if(mode.key==='zombie') return p.hunting ? 'YOU ARE PATIENT ZERO' : 'SURVIVE THE HORDE';
  if(mode.key==='freeze') return p.hunting ? 'FREEZE THEM ALL' : 'DODGE — AND THAW YOUR TEAM';
  return p.hunting ? 'YOU ARE THE TAGGER' : 'YOU ARE THE RUNNER';
}

/* =========================================================================
   MAIN LOOP
   ========================================================================= */
function loop(now){
  const dt = Math.min(0.05, (now-state.lastTime)/1000);
  state.lastTime = now;
  if(state.hitstopT>0){
    // freeze-frame on impact: keep drawing, skip simulation
    state.hitstopT -= dt;
    if(state.round && state.round.active) render();
  } else if(state.round && state.round.active){
    update(dt);
    render();
  }
  state.rafId = requestAnimationFrame(loop);
}

/* =========================================================================
   PLAYER ABILITY INPUT (with the click-to-target handshake)
   ========================================================================= */
function nearestEnemy(e){
  let best=null, bd=Infinity;
  for(const o of enemiesOf(e, state.entities)){
    const d = dist(e,o);
    if(d<bd){ bd=d; best=o; }
  }
  return best;
}

function handlePlayerAbilities(){
  const p = state.player;
  if(p.frozen) return;
  const foe = nearestEnemy(p);

  if(state.aim.cancel){ disarm(); state.aim.cancel = false; state.aim.clicked = false; }

  if(state.abilityPressed){
    state.abilityPressed = false;
    const src = {kind:'class'};
    if(isAimed(p, src)){
      state.aim.armed = (state.aim.armed && state.aim.armed.kind==='class') ? null : src;
    } else {
      tryClassAbility(p, foe, null);
    }
  }
  for(let s=0;s<MAX_ACTIVE_SLOTS;s++){
    if(!state.slotPressed[s]) continue;
    state.slotPressed[s] = false;
    const src = {kind:'slot', slot:s};
    if(isAimed(p, src)){
      state.aim.armed = (state.aim.armed && state.aim.armed.kind==='slot' && state.aim.armed.slot===s)
        ? null : src;
    } else {
      trySlotAbility(p, s, foe, null);
    }
  }

  if(state.aim.clicked){
    state.aim.clicked = false;
    const armed = state.aim.armed;
    if(armed){
      const pt = aimPoint(p, aimRange(p, armed));
      const ok = armed.kind==='class'
        ? tryClassAbility(p, foe, pt)
        : trySlotAbility(p, armed.slot, foe, pt);
      if(ok) disarm();
    }
  }
}

/* =========================================================================
   PAIRWISE STATUS TRAITS
   ========================================================================= */
function distToSegment(p, a, b){
  const abx = b.x-a.x, aby = b.y-a.y;
  const l2 = abx*abx + aby*aby;
  if(l2 === 0) return dist(p, a);
  let t = ((p.x-a.x)*abx + (p.y-a.y)*aby) / l2;
  t = clamp(t, 0, 1);
  return len(p.x - (a.x + t*abx), p.y - (a.y + t*aby));
}

function debuffCount(e){
  let n = 0;
  if(e.slowDebuffT>0) n++;
  if(e.chillStacks>0) n++;
  if(e.accelDebuffT>0) n++;
  if(e.markedT>0) n++;
  if(e.blindT>0) n++;
  if(e.brandT>0) n++;
  if(e.stunT>0) n++;
  if(e.stumbleT>0) n++;
  return n;
}

function updateStatusTraits(dt){
  for(const e of state.entities){
    const foe = nearestEnemy(e);
    const d = foe ? dist(e,foe) : 9999;

    e.privileged = foe ? debuffCount(foe) >= 2 : false;
    e.closeToFoe = d < 55;
    e.debuffN = debuffCount(e);
    if(e.mods.pressure && foe && d < 60) foe.pressedT = 0.3;

    if(e.mods.bloodyLust && d < 35){
      e.lustTick += dt;
      if(e.lustTick >= 1){ e.lustTick = 0; e.lustStacks = Math.min(5, e.lustStacks+1); }
    } else {
      e.lustTick = 0;
    }

    if(e.frostT>0 && foe && d < 45){
      e.frostTick = (e.frostTick||0) + dt;
      if(e.frostTick >= 0.6){ e.frostTick = 0; addChill(foe, 1); }
    }

    if(e.puddleT>0){
      e.puddleTick -= dt;
      if(e.puddleTick<=0){
        e.puddleTick = 0.45;
        state.tempZones.push({x:e.x, y:e.y, r:22, type:'slow', life:4});
      }
    }

    if(e.mods.divineDash && foe && e.dashBurstT>0 && !e.dashHitApplied &&
       distToSegment(foe, e.dashFrom || e, e) < 22){
      e.dashHitApplied = true;
      applySlow(foe, 1.6, 0.55);
      state.shockwaveFX.push({x:foe.x,y:foe.y,r:0,maxR:26,t:0});
    }

    if(e.beamChargeT>0){
      e.beamChargeT -= dt;
      if(e.beamChargeT<=0){
        const dir = e.beamDir || e.lastMoveDir;
        state.projectiles.push({
          x:e.x, y:e.y, vx:dir.x*520, vy:dir.y*520, owner:e,
          life:0.5, kind:'beam', color:'#ff5ec4',
        });
        e.beamChargeT = 0;
      }
    }

    if(e.brandT>0){
      e.brandT -= dt;
      if(e.brandT<=0){
        e.brandT = 0;
        const by = e.brandBy;
        e.brandBy = null;
        if(by && by.alive!==false && dist(by,e) < 60 && e.intangibleT<=0){
          if(by.hunting){ onTag(by, e); return; }
          applySlow(e, 2.5, 0.45);
        }
      }
    }
  }
}

/* =========================================================================
   TAGGING  (mode-dependent consequences)
   ========================================================================= */
function canTag(hunter, prey){
  if(prey.dashIframe>0 || prey.shieldT>0 || prey.intangibleT>0) return false;
  if(prey.bodyCheckT>0 && dist(hunter,prey) < tagRadius(hunter) && effectiveMass(prey) > effectiveMass(hunter)){
    // a braced / charging heavier body shrugs the tag and knocks the hunter back
    applyStagger(hunter, 0.9);
    applyKnockback(prey, hunter, 200);
    kickShake(2, 0.15);
    return false;
  }
  let reach = tagRadius(hunter);
  if(hunter.mods.opportunist && prey.slowDebuffT>0) reach *= 1.25;
  if(dist(hunter, prey) >= reach) return false;
  if(hunter.pierceT<=0 && segmentBlocked(hunter.x,hunter.y,prey.x,prey.y)) return false;

  if(prey.wardT>0){
    prey.wardT = 0;
    const tx = hunter.x, ty = hunter.y;
    hunter.x = prey.x; hunter.y = prey.y;
    prey.x = tx; prey.y = ty;
    applySlow(hunter, 2.5, 0.4);
    prey.dashIframe = Math.max(prey.dashIframe, 0.8);
    state.shockwaveFX.push({x:hunter.x,y:hunter.y,r:0,maxR:60,t:0});
    return false;
  }
  if(prey.deflectArmed){
    prey.deflectArmed = false;
    applyKnockback(hunter, prey, 260);
    prey.dashIframe = Math.max(prey.dashIframe, 1.0);
    state.shockwaveFX.push({x:prey.x,y:prey.y,r:0,maxR:50,t:0});
    return false;
  }
  if(prey.counterT>0){
    prey.counterT = 0;
    applyStagger(hunter, 1.5);
    applyKnockback(prey, hunter, 200);
    prey.dashIframe = Math.max(prey.dashIframe, 0.8);
    state.shockwaveFX.push({x:prey.x,y:prey.y,r:0,maxR:50,t:0});
    return false;
  }
  return true;
}

function onTag(hunter, prey){
  const mode = state.mode;
  hunter.pounceHit = true;
  hitstop(HITSTOP_TAG);
  kickShake(3, 0.25);
  state.shockwaveFX.push({x:prey.x,y:prey.y,r:0,maxR:44,t:0});
  // the pair: the tagger lunges, the tagged flinches away from the contact
  const impact = norm(prey.x-hunter.x, prey.y-hunter.y);
  playAnim('thrust', hunter, impact);
  playAnim('hit', prey, impact);

  if(mode.convertOnTag){
    // ZOMBIE TAG: the tagged join the horde and keep playing
    prey.team = mode.teams[0];
    prey.role = mode.teams[0];
    prey.hunting = true;
    // switching sides switches your baseline too - you now get the hunter kit
    refreshMods(prey, prey.build, true);
    prey.quarry = null; prey.belief = null; prey.currentPath = null;
    prey.dashIframe = 0.6;                 // a beat to get oriented
    if(prey === state.player) showAnnounce('YOU TURNED — JOIN THE HORDE');
    else if(hunter === state.player) showAnnounce('CONVERTED');
    checkWin();
    return;
  }

  if(mode.freezeOnTag){
    // FREEZE TAG: frozen solid until a team-mate thaws you
    prey.frozen = true;
    prey.thawProgress = 0;
    prey.vx = 0; prey.vy = 0;
    prey.burstActive = false;
    if(prey === state.player) showAnnounce('FROZEN — WAIT FOR A THAW');
    checkWin();
    return;
  }

  // CLASSIC: the tag ends it
  finishDuel(hunter === state.player);
}

function resolveTags(){
  for(const hunter of state.entities){
    if(!hunter.hunting || hunter.frozen || hunter.alive===false) continue;
    for(const prey of state.entities){
      if(prey === hunter || prey.hunting || prey.frozen || prey.alive===false) continue;
      if(canTag(hunter, prey)){ onTag(hunter, prey); return; }
    }
  }
}

/* =========================================================================
   FREEZE TAG: thawing
   ========================================================================= */
function updateThaw(dt){
  const mode = state.mode;
  if(!mode.freezeOnTag) return;
  const beingThawed = new Set();

  for(const rescuer of state.entities){
    if(rescuer.frozen || rescuer.hunting || rescuer.alive===false) continue;
    rescuer.thawCd = Math.max(0, rescuer.thawCd - dt);
    if(rescuer.thawCd > 0) continue;
    for(const f of state.entities){
      if(!f.frozen || f.team !== rescuer.team) continue;
      if(dist(rescuer, f) > RADIUS*3.5) continue;
      beingThawed.add(f);
      f.thawProgress += dt;
      if(f.thawProgress >= mode.thawTime){
        f.frozen = false;
        f.thawProgress = 0;
        f.dashIframe = Math.max(f.dashIframe, 0.5);
        rescuer.thawCd = mode.thawCooldown;
        state.shockwaveFX.push({x:f.x,y:f.y,r:0,maxR:40,t:0});
        if(f === state.player) showAnnounce('THAWED — GO');
        else if(rescuer === state.player) showAnnounce('ALLY FREED');
      }
      break;
    }
  }
  // an interrupted rescue loses its progress
  for(const e of state.entities){
    if(e.frozen && !beingThawed.has(e)) e.thawProgress = Math.max(0, e.thawProgress - dt*1.5);
  }
}

/* =========================================================================
   WIN CONDITIONS
   ========================================================================= */
function checkWin(){
  const mode = state.mode;
  const round = state.round;
  if(!round || !round.active) return;

  if(mode.convertOnTag){
    const survivors = teamOf(state.entities, mode.teams[1]);
    if(survivors.length === 0){
      // the horde got everyone - a win for whoever is currently a zombie
      finishDuel(state.player.team === mode.teams[0]);
    }
    return;
  }
  if(mode.freezeOnTag){
    const runners = teamOf(state.entities, mode.teams[1]);
    if(runners.length && runners.every(r => r.frozen)){
      finishDuel(state.player.hunting);
    }
    return;
  }
}

function onTimeUp(){
  const mode = state.mode;
  if(mode.convertOnTag){
    // survivors outlasted the horde
    finishDuel(state.player.team === mode.teams[1]);
  } else {
    // runners outlasted the taggers
    finishDuel(!state.player.hunting);
  }
}

/* =========================================================================
   UPDATE TICK
   ========================================================================= */
function update(dt){
  const { round, keys, run } = state;
  const player = state.player;

  // ---- player ----
  // WASD is screen-relative in the isometric view: W is "up the screen"
  let dx=0, dy=0;
  if(!player.frozen){
    let sx=0, sy=0;
    if(keys['w']||keys['arrowup']) sy -= 1;
    if(keys['s']||keys['arrowdown']) sy += 1;
    if(keys['a']||keys['arrowleft']) sx -= 1;
    if(keys['d']||keys['arrowright']) sx += 1;
    if(sx || sy){ const w = inputToWorld(sx, sy); dx = w.x; dy = w.y; }
  }
  const pSprint = updateSprint(player, !player.frozen && !!keys['shift'], dt);
  updatePhysics(player, dx, dy, dt, pSprint);
  if(state.dashPressed){ if(!player.frozen) tryDash(player); state.dashPressed=false; }
  handlePlayerAbilities();

  // ---- every AI ----
  for(const e of state.entities){
    if(e === player) continue;
    const intent = updateAI(e, dt);
    const sp = updateSprint(e, intent.sprint, dt);
    updatePhysics(e, intent.x, intent.y, dt, sp, state.botAI.speedMult);
  }

  resolveBodies(dt);
  updateFeel(dt);

  for(const e of state.entities){
    if(e.clsKey==='scout' && e.stamina<=0) e.burstActive=false;
    if(e.pendingRebuild){
      e.pendingRebuild = false;
      refreshMods(e, e.build);
    }
  }

  updateAnims(dt);
  updateStatusTraits(dt);
  if(!round.active) return;

  // ---- world ----
  updateEffects(dt, state.entities, onBoltHit);
  updateDecoys(dt, state.entities);
  updateMagnet(dt, state.entities);
  resolveWarps(state.entities);

  if(state.mapParams.wallShift && !state.wallShiftDone && round.timer < round.duration/2){
    state.wallShiftDone = true;
    state.walls = buildWalls(state.mapParams.wallVariant === 1 ? 0 : 1);
    buildPathGrid();
    for(const e of state.entities) e.currentPath = null;
    showAnnounce('THE WALLS MOVE');
  }

  for(let i=state.tempZones.length-1;i>=0;i--){
    state.tempZones[i].life -= dt;
    if(state.tempZones[i].life<=0) state.tempZones.splice(i,1);
  }

  updatePowerups(dt, state.entities);

  for(let i=state.particles.length-1;i>=0;i--){
    const pt = state.particles[i];
    pt.life -= dt;
    pt.x += pt.vx*dt; pt.y += pt.vy*dt;
    if(pt.life<=0) state.particles.splice(i,1);
  }
  for(let i=state.shockwaveFX.length-1;i>=0;i--){
    const s = state.shockwaveFX[i];
    s.t += dt; s.r = s.maxR * Math.min(1,s.t/0.35);
    if(s.t>0.4) state.shockwaveFX.splice(i,1);
  }

  // ---- clock, tagging, mode rules ----
  if(round.grace>0){
    round.grace -= dt;
  } else {
    round.timer -= dt;

    state.pingTimer -= dt;
    if(state.pingTimer<=0){
      state.pingTimer = player.hunting ? PING_INTERVAL_TAGGER : PING_INTERVAL_RUNNER;
      state.pingShowT = PING_SHOW_TIME;
    }
    state.pingShowT = Math.max(0, state.pingShowT-dt);

    updateThaw(dt);
    resolveTags();
    if(!round.active) return;
    checkWin();
    if(!round.active) return;

    // in-duel upgrade marks (one for Classic, two for the longer modes)
    if(round.draftMarks.length && round.timer <= round.draftMarks[0]){
      round.draftMarks.shift();
      openMidDraft();
      return;
    }

    if(round.timer<=0){
      round.timer = 0;
      onTimeUp();
      return;
    }
  }

  if(state.announceTimer>0){
    state.announceTimer -= dt;
    if(state.announceTimer<=0) document.getElementById('announce').classList.remove('show');
  }

  updateCamera(dt);

  updateHud();
}

function onBoltHit(owner, hit){
  if(owner.team === hit.team) return;
  if(owner.hunting){
    if(!(hit.dashIframe>0 || hit.shieldT>0 || hit.intangibleT>0)){
      if(hit.deflectArmed){
        hit.deflectArmed = false;
        applyKnockback(owner, hit, 260);
        hit.dashIframe = 1.0;
        return;
      }
      onTag(owner, hit);
    }
  } else {
    hit.slowDebuffT = Math.max(hit.slowDebuffT, 1.5);
    hit.slowDebuffMult = 0.6;
  }
}

function updatePowerups(dt, entities){
  const rate = state.mapParams.pickupRateMult;
  const points = state.puSpawnPoints || [];
  if(rate !== Infinity){
    state.puTimer -= dt;
    if(state.puTimer<=0 && state.powerups.length<3){
      state.puTimer = (6 + Math.random()*4) * rate;
      const free = points.filter(sp => !state.powerups.some(p=>len(p.x-sp.x,p.y-sp.y)<10));
      if(free.length){
        const sp = free[Math.floor(Math.random()*free.length)];
        const rare = !state.rareSpawnedThisDuel && Math.random() < RARE_PICKUP_CHANCE;
        let table = COMMON_PICKUPS;
        if(rare){
          // uniform over artifacts the human doesn't own yet; full table once they own them all
          const owned = state.run.player.artifacts;
          const unowned = RARE_PICKUPS.filter(d => !owned.includes(d.id));
          table = unowned.length ? unowned : RARE_PICKUPS;
        }
        const def = table[Math.floor(Math.random()*table.length)];
        if(rare) state.rareSpawnedThisDuel = true;
        state.powerups.push({x:sp.x,y:sp.y,id:def.id,rare,bob:Math.random()*Math.PI*2});
      }
    }
  }
  for(let i=state.powerups.length-1;i>=0;i--){
    const p = state.powerups[i];
    p.bob += dt*3;
    for(const e of entities){
      if(e.frozen) continue;
      if(len(e.x-p.x,e.y-p.y) < RADIUS+6){
        applyPickup(e, p.id);
        state.powerups.splice(i,1);
        break;
      }
    }
  }
}

/* =========================================================================
   DRAFTS
   ========================================================================= */
function openMidDraft(){
  const run = state.run;
  state.round.active = false;
  state.round.awaitingDraft = true;
  disarm();

  const roll = ()=>{
    const options = rollDraft(run.player, state.player.mods, run.duel);
    if(!options.length){ resumeDuel(); return; }
    renderDraft(options, opt=>{
      applyPick(run.player, opt);
      // the upgrade is live for the rest of THIS duel
      refreshMods(state.player, run.player);
      draftForAllAI(run);
      for(const e of state.entities){
        if(e !== state.player) refreshMods(e, e.build);
      }
      buildAbilityBar();
      resumeDuel();
    }, ()=>{
      if(run.rerolls>0){ run.rerolls--; roll(); }
    }, {mid:true});
  };
  roll();
  document.getElementById('draft-result').textContent = 'HALFWAY';
  showScreen('screen-draft');
}

function resumeDuel(){
  state.round.awaitingDraft = false;
  state.round.active = true;
  state.lastTime = performance.now();
  showScreen('screen-game');
  showAnnounce('BACK TO IT');
}

function finishDuel(playerWon){
  const run = state.run;
  if(!state.round.active) return;
  state.round.active = false;
  disarm();

  recordDuel(run, playerWon, state.player.role, state.round.timer, state.mode.name);

  const xp = duelXp(run, playerWon);
  run.xpEarned += xp;
  awardXp(xp);

  if(playerWon) openDraft();
  else {
    const result = endRun(run);
    renderRunSummary(result);
    showScreen('screen-end');
  }
}

function openDraft(){
  const run = state.run;
  const roll = ()=>{
    const options = rollDraft(run.player, state.player.mods, run.duel);
    if(!options.length){ nextDuel(); return; }
    renderDraft(options, opt=>{
      applyPick(run.player, opt);
      nextDuel();
    }, ()=>{
      if(run.rerolls>0){ run.rerolls--; roll(); }
    });
  };
  roll();
  document.getElementById('draft-result').textContent = duelWinLine();
  showScreen('screen-draft');
}

function duelWinLine(){
  const mode = state.mode;
  if(mode.key==='zombie') return state.player.team==='zombie' ? 'HORDE WINS' : 'YOU SURVIVED';
  if(mode.key==='freeze') return state.player.hunting ? 'ALL FROZEN' : 'TEAM SURVIVED';
  return state.player.hunting ? 'TAGGED THEM' : 'SURVIVED';
}

function nextDuel(){
  advanceDuel(state.run);
  startDuel();
}

/**
 * Advance the simulation by one fixed step, independent of requestAnimationFrame.
 * Used by the dev hook in main.js to drive the game deterministically while
 * testing; not referenced by the normal render loop.
 */
export function devStep(dt){
  if(state.round && state.round.active){
    update(dt || 1/60);
    render();
  }
}
