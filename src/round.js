import {
  WORLD_W, WORLD_H, RADIUS, ROUND_TIME, GRACE_TIME,
  PING_INTERVAL_TAGGER, PING_INTERVAL_RUNNER, PING_SHOW_TIME,
  MAX_ACTIVE_SLOTS, RARE_PICKUP_CHANCE, setWorldSize, HITSTOP_TAG,
} from './config.js';
import { clamp, len, norm, dist } from './math.js';
import { state } from './state.js';
import { makeEntity } from './entity.js';
import { refreshMods } from './build.js';
import { buildWalls, buildZones, wallBlocked, segmentBlocked, puSpawnPoints } from './arena.js';
import { buildPathGrid } from './pathfinding.js';
import { mapParams } from './mapmods.js';
import { MODES, enemiesOf, teamOf, draftThresholds } from './modes.js';
import {
  updatePhysics, updateSprint, tryDash, tryClassAbility, trySlotAbility,
  tagRadius, applyKnockback, applySlow, applyStagger,
} from './physics.js';
import { kickShake, hitstop, updateCamera, updateFeel, snapCamera } from './feel.js';
import { inputToWorld } from './iso.js';
import { themeForDuel, buildDecor } from './themes.js';
import { resetFX, spawnEventFX } from './fx.js';
import { effectiveMass, resolveBodies } from './bodies.js';
import { updateAI } from './ai.js';
import {
  resetEffects, updateEffects, updateMagnet, resolveWarps, addChill, updateDecoys,
} from './effects.js';
import { COMMON_PICKUPS, RARE_PICKUPS, applyPickup } from './pickups.js';
import { isAimed, aimRange, aimPoint, disarm } from './targeting.js';
import { render } from './render.js';
import { updateHud, setDuelHeader, buildAbilityBar } from './hud.js';
import { showScreen, showAnnounce, renderDraft } from './ui.js';
import { rollDraft, applyPick } from './draft.js';
import { playAnim, updateAnims, resetAnims } from './anim.js';
import { draftForAllAI } from './run.js';
import { relay, announceFor, announceAll, feed } from './relay.js';
import {
  hostTick, hostReset, takeRemoteInput, describeRound,
  clientBuildWorld, clientStep, clientIntent,
} from './netsync.js';
import { onRoundEnd } from './match.js';
import { updateMatchHud } from './matchhud.js';

relay.localAnnounce = showAnnounce;

const isClient = () => !!state.match && state.match.role === 'client';
const r2 = v => Math.round(v*100)/100;

/* =========================================================================
   ROUND SETUP
   ========================================================================= */
function spawnSpots(n){
  // ring the arena so nobody starts on top of anyone else
  const spots = [];
  const cx = WORLD_W/2, cy = WORLD_H/2;
  const rx = WORLD_W*0.38, ry = WORLD_H*0.38;
  const phase = Math.random()*Math.PI*2;
  for(let i=0;i<n;i++){
    const a = phase + (i/n)*Math.PI*2 + Math.random()*0.2;
    let x = clamp(cx + Math.cos(a)*rx, 60, WORLD_W-60);
    let y = clamp(cy + Math.sin(a)*ry, 60, WORLD_H-60);
    // nudge off any wall it happened to land in
    for(let t=0; t<24 && wallBlocked(x,y); t++){
      x = clamp(x + (Math.random()-0.5)*70, 60, WORLD_W-60);
      y = clamp(y + (Math.random()-0.5)*70, 60, WORLD_H-60);
    }
    spots.push({x,y});
  }
  // shuffle so the roster order (humans first) says nothing about where you start
  for(let i=spots.length-1;i>0;i--){
    const j = Math.floor(Math.random()*(i+1));
    [spots[i],spots[j]] = [spots[j],spots[i]];
  }
  return spots;
}

function spawnEntities(plan){
  const spots = spawnSpots(plan.entities.length);
  state.entities = [];
  state.player = null;
  plan.entities.forEach((d, i) => {
    const e = makeEntity(spots[i].x, spots[i].y, d.clsKey, d.ctrl === 'ai', d.build, d.hunting);
    e.id = i;
    e.team = d.team;
    e.role = d.team;
    e.hunting = d.hunting;
    e.ctrl = d.ctrl;
    e.pid = d.pid || null;
    e.name = d.name || '';
    if(d.ctrl === 'local') state.player = e;
    state.entities.push(e);
  });
  state.bot = state.entities.find(e => e.ctrl === 'ai') || null;
}

function roundOpeningLine(mode){
  const p = state.player;
  if(mode.key==='zombie') return p.hunting ? 'YOU ARE PATIENT ZERO' : 'SURVIVE THE HORDE';
  if(mode.key==='freeze') return p.hunting ? 'FREEZE THEM ALL' : 'DODGE — AND THAW YOUR TEAM';
  if(mode.key==='potato') return p.hunting ? 'YOU HAVE THE POTATO' : 'DON\'T GET TAGGED';
  return p.hunting ? 'YOU ARE THE TAGGER' : 'YOU ARE THE RUNNER';
}

function startLoop(){
  state.lastTime = performance.now();
  if(state.rafId) cancelAnimationFrame(state.rafId);
  state.rafId = requestAnimationFrame(loop);
}

/**
 * HOST: build the world and fighters for one round from the match's plan and
 * start simulating. Returns the description clients need to build the same
 * round.  plan = {mode, depth, entities:[{pid,name,clsKey,build,ctrl,hunting,team}],
 *                 skill, duration, midDrafts, seed, remote}
 */
export function startRound(plan){
  const run = state.run;
  const mode = plan.mode;
  state.mode = mode;
  setWorldSize(mode.world.w, mode.world.h);

  const params = mapParams(plan.depth, run.mods);
  state.mapParams = params;

  state.walls = buildWalls(params.wallVariant);
  state.theme = themeForDuel(plan.depth, state.theme && state.theme.id);
  state.decorSeed = plan.seed;
  state.decor = buildDecor(state.theme, state.walls, mode.world.w, mode.world.h, plan.seed);
  buildPathGrid();
  buildZones(params);
  state.puSpawnPoints = puSpawnPoints();
  state.tempZones = [];
  state.particles = [];
  state.decoys = [];
  state.powerups = [];
  state.puTimer = 3 * (params.pickupRateMult===Infinity ? 1 : params.pickupRateMult);
  state.shockwaveFX = [];
  state.afterImages = [];
  state.rareSpawnedThisDuel = false;
  resetEffects();
  resetFX();
  resetAnims();
  disarm();
  state.wallShiftDone = false;

  spawnEntities(plan);
  snapCamera();

  // bot execution skill scales with depth (builds scale separately, via drafts)
  const skill = plan.skill;
  state.botAI = {
    skill,
    speedMult: 0.85 + skill*0.2,
    jitterDeg: 30*(1-skill),
    reactionT: 0.32 - 0.16*skill,
    predictT: 0.15 + 0.3*skill,
    dashChance: 0.45 + 0.45*skill,
    abilityChance: 0.4 + 0.5*skill,
  };

  const duration = plan.duration || mode.duration || ROUND_TIME;
  state.round = {
    timer: duration, duration, grace: GRACE_TIME, active:true,
    // remaining-time thresholds still to fire, latest first (solo gauntlet only)
    draftMarks: plan.midDrafts ? draftThresholds(mode) : [],
    awaitingDraft:false,
  };
  state.pingTimer = state.player.hunting ? PING_INTERVAL_TAGGER : PING_INTERVAL_RUNNER;
  state.pingShowT = 0;

  relay.active = !!plan.remote;
  hostReset();

  setDuelHeader();
  buildAbilityBar();
  showAnnounce(roundOpeningLine(mode));
  showScreen('screen-game');
  startLoop();
  return describeRound();
}

/** CLIENT: build the replica round from the host's description. */
export function startRoundClient(p, selfPid){
  const mode = MODES[p.modeKey];
  state.mode = mode;
  setWorldSize(p.world.w, p.world.h);
  clientBuildWorld(p, selfPid);
  state.mapParams = {pickupRateMult:1, wallShift:false, wallVariant:0};
  state.puSpawnPoints = [];
  resetFX();
  resetAnims();
  disarm();
  state.round = {timer:p.timer, duration:p.duration, grace:GRACE_TIME, active:true, draftMarks:[], awaitingDraft:false};
  state.pingTimer = state.player.hunting ? PING_INTERVAL_TAGGER : PING_INTERVAL_RUNNER;
  state.pingShowT = 0;
  state.hitstopT = 0;
  if(state.run){
    state.run.player = state.player.build;
    state.run.mods = (p.mods || []).map(name => ({name}));
  }
  snapCamera();
  setDuelHeader();
  buildAbilityBar();
  showAnnounce(roundOpeningLine(mode));
  showScreen('screen-game');
  startLoop();
}

/** Tear down the running round (leaving a match). */
export function stopRound(){
  if(state.rafId) cancelAnimationFrame(state.rafId);
  state.rafId = null;
  state.round = null;
  relay.active = false;
  disarm();
}

/** HOST: a remote human dropped mid-round - their fighter becomes a bot. */
export function playerLeft(pid){
  const e = state.entities.find(x => x.pid === pid);
  if(!e) return;
  e.ctrl = 'ai';
  e.isBot = true;
}

/* =========================================================================
   MAIN LOOP
   ========================================================================= */
function tickAnnounce(dt){
  if(state.announceTimer>0){
    state.announceTimer -= dt;
    if(state.announceTimer<=0) document.getElementById('announce').classList.remove('show');
  }
}

function tickPing(dt){
  const player = state.player;
  state.pingTimer -= dt;
  if(state.pingTimer<=0){
    state.pingTimer = player.hunting ? PING_INTERVAL_TAGGER : PING_INTERVAL_RUNNER;
    state.pingShowT = PING_SHOW_TIME;
  }
  state.pingShowT = Math.max(0, state.pingShowT-dt);
}

function loop(now){
  const dt = Math.min(0.05, (now-state.lastTime)/1000);
  state.lastTime = now;
  const rd = state.round;
  if(isClient()){
    if(rd && rd.active && state.player){
      clientStep(dt);
      handlePlayerAbilities();
      if(rd.grace <= 0) tickPing(dt);
      tickAnnounce(dt);
      updateHud();
      updateMatchHud();
      render();
    }
  } else if(state.hitstopT>0){
    // freeze-frame on impact: keep drawing, skip simulation
    state.hitstopT -= dt;
    if(rd && rd.active) render();
  } else if(rd && rd.active){
    update(dt);
    hostTick(dt);
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

// On a client the cast is only an intent: the host runs it and the result comes back in a snapshot.
function castClass(p, foe, pt){
  if(isClient()){
    if(p.abilityCd>0 && p.clsKey!=='scout') return false;
    clientIntent({k:'c', pt: pt ? {x:r2(pt.x), y:r2(pt.y)} : null});
    return true;
  }
  return tryClassAbility(p, foe, pt);
}
function castSlot(p, s, foe, pt){
  if(isClient()){
    if(!p.build.abilities[s] || p.slotCd[s]>0) return false;
    clientIntent({k:'s', slot:s, pt: pt ? {x:r2(pt.x), y:r2(pt.y)} : null});
    return true;
  }
  return trySlotAbility(p, s, foe, pt);
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
      castClass(p, foe, null);
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
      castSlot(p, s, foe, null);
    }
  }

  if(state.aim.clicked){
    state.aim.clicked = false;
    const armed = state.aim.armed;
    if(armed){
      const pt = aimPoint(p, aimRange(p, armed));
      const ok = armed.kind==='class'
        ? castClass(p, foe, pt)
        : castSlot(p, armed.slot, foe, pt);
      if(ok) disarm();
    }
  }
}

/** Clamp a client-supplied aim point to the caster's real range. */
function clampAim(e, src, pt){
  if(!pt || !Number.isFinite(pt.x) || !Number.isFinite(pt.y)) return null;
  const range = aimRange(e, src);
  const dx = pt.x - e.x, dy = pt.y - e.y, d = len(dx, dy);
  if(d > range && d > 0) return {x:e.x + dx*range/d, y:e.y + dy*range/d};
  return {x:pt.x, y:pt.y};
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
    spawnEventFX('deflect', prey.x, prey.y, {dir:norm(prey.x-hunter.x, prey.y-hunter.y)});
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

function setSide(e, hunting){
  const mode = state.mode;
  e.team = hunting ? mode.teams[0] : mode.teams[1];
  e.role = e.team;
  e.hunting = hunting;
  // switching sides switches your baseline too - you now get the other kit
  refreshMods(e, e.build, hunting);
  e.quarry = null; e.belief = null; e.currentPath = null;
}

function onTag(hunter, prey){
  const mode = state.mode;
  hunter.pounceHit = true;
  hunter.stat.tags++;
  hitstop(HITSTOP_TAG);
  kickShake(3, 0.25);
  state.shockwaveFX.push({x:prey.x,y:prey.y,r:0,maxR:44,t:0});
  spawnEventFX('tag', prey.x, prey.y, {color:prey.cls.color, hunterColor:hunter.cls.color});
  // the pair: the tagger lunges, the tagged flinches away from the contact
  const impact = norm(prey.x-hunter.x, prey.y-hunter.y);
  playAnim('thrust', hunter, impact);
  playAnim('hit', prey, impact);
  const hn = hunter.name || hunter.cls.name, pn = prey.name || prey.cls.name;

  if(mode.convertOnTag){
    // ZOMBIE TAG: the tagged join the horde and keep playing
    hunter.stat.converts++;
    setSide(prey, true);
    prey.dashIframe = 0.6;                 // a beat to get oriented
    announceFor(prey, 'YOU TURNED — JOIN THE HORDE');
    announceFor(hunter, 'CONVERTED');
    feed(`${hn} INFECTED ${pn}`, '#a8a23f');
    checkWin();
    return;
  }

  if(mode.freezeOnTag){
    // FREEZE TAG: frozen solid until a team-mate thaws you
    hunter.stat.freezes++;
    prey.frozen = true;
    prey.thawProgress = 0;
    prey.vx = 0; prey.vy = 0;
    prey.burstActive = false;
    announceFor(prey, 'FROZEN — WAIT FOR A THAW');
    feed(`${hn} FROZE ${pn}`, '#8fd6ff');
    checkWin();
    return;
  }

  if(mode.swapOnTag){
    // HOT POTATO: the tag trades roles. The one who just passed it is briefly untouchable.
    setSide(hunter, false);
    setSide(prey, true);
    hunter.dashIframe = Math.max(hunter.dashIframe, 1.4);
    announceFor(prey, 'YOU HAVE THE POTATO');
    announceFor(hunter, 'PASSED IT');
    feed(`${hn} PASSED IT TO ${pn}`, '#ff9a3c');
    return;
  }

  // CLASSIC: the tag ends it
  feed(`${hn} TAGGED ${pn}`, '#ff5470');
  finishRound(hunter.team);
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
        rescuer.stat.thaws++;
        spawnEventFX('thaw', f.x, f.y, {color:'#8fd6ff'});
        f.thawProgress = 0;
        f.dashIframe = Math.max(f.dashIframe, 0.5);
        rescuer.thawCd = mode.thawCooldown;
        state.shockwaveFX.push({x:f.x,y:f.y,r:0,maxR:40,t:0});
        announceFor(f, 'THAWED — GO');
        announceFor(rescuer, 'ALLY FREED');
        feed(`${rescuer.name || rescuer.cls.name} THAWED ${f.name || f.cls.name}`, '#3fe0c5');
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
    if(survivors.length === 0) finishRound(mode.teams[0]);   // the horde got everyone
    return;
  }
  if(mode.freezeOnTag){
    const runners = teamOf(state.entities, mode.teams[1]);
    if(runners.length && runners.every(r => r.frozen)) finishRound(mode.teams[0]);
    return;
  }
}

function onTimeUp(){
  const mode = state.mode;
  // prey outlasted the hunters (hot potato has no winning side: the scoring reads carry times)
  finishRound(mode.swapOnTag ? null : mode.teams[1]);
}

/** Decide the round: who won, per-fighter tallies, then hand over to the match. */
function finishRound(winnerTeam){
  const round = state.round;
  if(!round || !round.active) return;
  round.active = false;
  disarm();
  const outcome = {
    winnerTeam,
    elapsed: round.duration - round.timer,
    timeLeft: round.timer,
    entities: state.entities.map(e => ({
      id:e.id, pid:e.pid, name:e.name, team:e.team, hunting:e.hunting,
      tags:e.stat.tags, freezes:e.stat.freezes, thaws:e.stat.thaws,
      converts:e.stat.converts, carryT:e.stat.carryT,
    })),
  };
  // ship the deciding frame (and the final clock) to the clients
  hostTick(10);
  onRoundEnd(outcome);
}

/* =========================================================================
   UPDATE TICK  (HOST / SOLO)
   ========================================================================= */
function stepLocal(e, dt){
  // WASD is screen-relative in the isometric view: W is "up the screen"
  const keys = state.keys;
  let dx=0, dy=0;
  if(!e.frozen){
    let sx=0, sy=0;
    if(keys['w']||keys['arrowup']) sy -= 1;
    if(keys['s']||keys['arrowdown']) sy += 1;
    if(keys['a']||keys['arrowleft']) sx -= 1;
    if(keys['d']||keys['arrowright']) sx += 1;
    if(sx || sy){ const w = inputToWorld(sx, sy); dx = w.x; dy = w.y; }
  }
  const sp = updateSprint(e, !e.frozen && !!keys['shift'], dt);
  updatePhysics(e, dx, dy, dt, sp);
  if(state.dashPressed){ if(!e.frozen) tryDash(e); state.dashPressed=false; }
  handlePlayerAbilities();
}

function stepRemote(e, dt){
  const inp = takeRemoteInput(e.pid);
  const frozen = e.frozen;
  const sp = updateSprint(e, !frozen && inp.sprint, dt);
  updatePhysics(e, frozen ? 0 : inp.x, frozen ? 0 : inp.y, dt, sp);
  if(frozen) return;
  const foe = nearestEnemy(e);
  for(const a of inp.acts){
    if(a.k === 'd') tryDash(e);
    else if(a.k === 'c') tryClassAbility(e, foe, clampAim(e, {kind:'class'}, a.pt));
    else if(a.k === 's'){
      const s = a.slot|0;
      if(s >= 0 && s < MAX_ACTIVE_SLOTS) trySlotAbility(e, s, foe, clampAim(e, {kind:'slot', slot:s}, a.pt));
    }
  }
}

function update(dt){
  const { round } = state;
  const mode = state.mode;

  // ---- every fighter: local human, remote human or AI ----
  for(const e of state.entities){
    if(e.ctrl === 'local') stepLocal(e, dt);
    else if(e.ctrl === 'remote') stepRemote(e, dt);
    else {
      const intent = updateAI(e, dt);
      const sp = updateSprint(e, intent.sprint, dt);
      updatePhysics(e, intent.x, intent.y, dt, sp, state.botAI.speedMult);
    }
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
    state.decorSeed = state.decorSeed + 13;
    state.decor = buildDecor(state.theme, state.walls, WORLD_W, WORLD_H, state.decorSeed);
    buildPathGrid();
    for(const e of state.entities) e.currentPath = null;
    if(relay.active) relay.queue.push({n:'walls', a:[state.walls.map(w => ({...w})), state.decorSeed]});
    announceAll('THE WALLS MOVE');
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
    tickPing(dt);

    if(mode.swapOnTag){
      for(const e of state.entities) if(e.hunting) e.stat.carryT += dt;
    }

    updateThaw(dt);
    resolveTags();
    if(!round.active) return;
    checkWin();
    if(!round.active) return;

    // in-duel upgrade marks (solo gauntlet only: online rounds draft between rounds)
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

  tickAnnounce(dt);
  updateCamera(dt);
  updateHud();
  updateMatchHud();
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
          // uniform over artifacts the local human doesn't own yet; full table once they own them all
          const owned = state.player.build.artifacts;
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
   MID-ROUND UPGRADE  (solo gauntlet only: the clock pauses for the pick)
   ========================================================================= */
function openMidDraft(){
  const run = state.run;
  state.round.active = false;
  state.round.awaitingDraft = true;
  disarm();

  const roll = ()=>{
    const options = rollDraft(run.player, state.player.mods, run.duel);
    if(!options.length){ resumeRound(); return; }
    renderDraft(options, opt=>{
      applyPick(run.player, opt);
      // the upgrade is live for the rest of THIS round
      refreshMods(state.player, run.player);
      draftForAllAI(run);
      for(const e of state.entities){
        if(e !== state.player) refreshMods(e, e.build);
      }
      buildAbilityBar();
      resumeRound();
    }, ()=>{
      if(run.rerolls>0){ run.rerolls--; roll(); }
    }, {mid:true});
  };
  roll();
  document.getElementById('draft-result').textContent = 'HALFWAY';
  showScreen('screen-draft');
}

function resumeRound(){
  state.round.awaitingDraft = false;
  state.round.active = true;
  state.lastTime = performance.now();
  showScreen('screen-game');
  showAnnounce('BACK TO IT');
}

/**
 * Advance the simulation by one fixed step, independent of requestAnimationFrame.
 * Used by the dev hook in main.js to drive the game deterministically while
 * testing; not referenced by the normal render loop.
 */
export function devStep(dt){
  if(state.round && state.round.active){
    update(dt || 1/60);
    hostTick(dt || 1/60);
    render();
  }
}
