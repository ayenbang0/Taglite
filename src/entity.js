import { CLASSES, MAX_ACTIVE_SLOTS } from './config.js';
import { computeMods, emptyBuildState } from './build.js';

/**
 * A decoy. Shaped enough like an entity (team, cls, velocity, lastMoveDir)
 * that AI targeting and rendering can treat it as one - which is the whole
 * point of a decoy. Movement lives in effects.js/updateDecoys.
 */
export function makeDecoy(owner, life){
  return {
    x:owner.x, y:owner.y, owner, isDecoy:true,
    team: owner.team, cls: owner.cls,
    vx:0, vy:0, life, t:0,
    heading: Math.random()*Math.PI*2,
    turnT:0, burstT:0, burstCd:0,
    lastMoveDir:{x:1,y:0},
    dir:{x:1,y:0},
  };
}

export function makeEntity(x,y,clsKey,isBot,buildState,hunting){
  const build = buildState || emptyBuildState();
  const mods = computeMods(clsKey, build, hunting);
  return {
    x,y, vx:0, vy:0,
    facing:{x:1,y:0},
    clsKey, cls: CLASSES[clsKey],
    isBot,
    build, mods,
    role:null,        // 'tagger'|'runner'|'zombie'|'survivor'
    team:null,        // same as role; kept separate so mode logic reads clearly
    hunting: !!hunting,
    alive:true,
    frozen:false,     // Freeze Tag
    thawProgress:0,   // how far a rescue on THIS entity has got
    thawCd:0,         // how long until this entity can thaw someone again
    id:0,
    ctrl: isBot ? 'ai' : 'local',   // 'local' (this machine) | 'remote' (another human) | 'ai'
    pid:null, name:'',              // owning human's player id + display name
    stat:{tags:0, freezes:0, thaws:0, converts:0, carryT:0},   // per-round tallies for scoring

    dashCd:0, dashLockT:0, dashIframe:0, dashBurstT:0,
    dashCharges: mods.dashCharges, dashChargesMax: mods.dashCharges,
    pathRecalcT:0, currentPath:null, pathIdx:1,

    abilityCd:0,                                   // class signature ability
    slotCd: new Array(MAX_ACTIVE_SLOTS).fill(0),   // drafted actives, keys 1-4

    stamina:100, burstActive:false,
    sprintMax: mods.sprintMax,
    sprint: mods.sprintMax, sprintActive:false, fatigued:false, fatigueT:0,
    restT: 99,   // start the duel with full breath, not in oxygen debt

    invisT:0,        // trickster passive
    shieldT:0, speedBuffT:0, revealT:0, slowDebuffT:0, slowDebuffMult:1,

    // ---- drafted-ability state ----
    intangibleT:0,        // phase step / ghost step
    tagBuffT:0, tagBuffMult:1,
    pierceT:0,
    surgeT:0, noDashT:0,
    smokeT:0,             // opponent cannot see me
    markedT:0,            // my stealth is disabled
    magnetT:0,
    absorbT:0,            // next debuff/knockback absorbed
    fatigueImmuneT:0,
    accelDebuffT:0, accelDebuffMult:1,
    ghostTrailCharge:false,
    wallbreakCharge:false,
    staticT:0,            // how long we've been ~stationary
    staticReady:false,
    adrenalLeft: mods.adrenalCharges,
    warpRequest:false,
    pendingRebuild:false,
    blindT:0,             // FLASHBANG: no ping, no minimap
    seeThroughT:0,        // PREDATOR SENSE: opponent visible through walls
    sprintHeldT:0,        // WIND UP ramp
    revealedByTrapT:0,
    posHistory:[],        // rolling ~3s trail, powers RECALL
    posHistoryT:0,

    // ---- wave 3: status, curses and growth ----
    brandT:0, brandBy:null,     // BRAND: resolves as a tag if it expires in range
    chillStacks:0, chillT:0,    // FROSTBITE stacks
    frostT:0,                   // FROSTBITE: currently applying stacks
    puddleT:0, puddleTick:0,    // DRUNKARD'S TRAIL
    beamChargeT:0, beamDir:null,// SIPHON BEAM windup
    wardT:0,                    // REVERSAL WARD
    lustStacks:0, lustTick:0,   // BLOODY LUST growth
    pickupStacks:0,             // QUICKSILVER growth
    stunT:0,                    // BRITTLE BONES daze
    dashHitApplied:false,       // DIVINE DASH: once per dash
    privileged:false,           // per-frame flags, recomputed in round.js
    closeToFoe:false,
    // COLD BLOOD starts the duel with a free deflect already armed
    deflectArmed: !!mods.coldBlood,

    trail:[],
    aiDir:{x:0,y:0}, aiThrottle:0, aiAbilityThrottle:0, aiSlotThrottle:0,
    lastMoveDir:{x:1,y:0},

    // ---- AI perception (see perception.js) ----
    // Bots do NOT read true positions. They hold a belief about where their
    // quarry is, refreshed by line of sight and by the same periodic
    // directional ping the player gets.
    belief:null,        // {x,y,confidence,vx,vy}
    quarry:null,        // the entity or decoy currently being chased
    quarryLockT:0,      // committed to this quarry until it expires
    pingT:0,            // countdown to the next bearing update
    reactionT:0,        // human-ish delay before acting on a new sighting
    // sprint is committed to in bursts rather than re-decided every frame,
    // so bots run in human-looking pushes instead of flickering on and off
    sprintWant:false, sprintHoldT:0,

    // ---- realistic running / new abilities ----
    stumbleT:0, slideT:0, airT:0, airT0:0, braceT:0, stampedeT:0, rushT:0,
    bodyCheckT:0, pounceT:0, pounceHit:false, overdriveT:0, pacerT:0, gripT:0,
    counterT:0, startleCd:0, calmT:0, kickT:0, slingT:0, pressedT:0, debuffN:0,
    cadenceStacks:0, cadenceT:0, prevSprintHeld:false, stepPhase:0, skidCd:0,
    slowStillT:0, facingIdx:0, footT:0, speedLineT:0, lastSprintHeldT:0, launchT:0,
  };
}
