/* =========================================================================
   BUILD MODIFIERS
   One entity's effective stats = class baseline + drafted passives +
   run artifacts. Recomputed at duel start (and whenever a rare artifact is
   picked up mid-duel), then cached on the entity as `e.mods`.

   Passives stack additively with no diminishing returns - that is the
   locked "loose / arcade" balance philosophy, not an oversight.
   ========================================================================= */
import {
  CLASSES, HUNTER_SPEED_MULT, HUNTER_SPRINT_MULT, HUNTER_DASH_CD_MULT,
  PREY_ABILITY_CD_MULT,
} from './config.js';
import { PASSIVE_BY_ID } from './passives.js';
import { clamp } from './math.js';
import { RARE_BY_ID, completedSets } from './pickups.js';

export function emptyBuildState(){
  return { abilities:[], passives:[], artifacts:[] };
}

export function computeMods(clsKey, buildState, hunting){
  const cls = CLASSES[clsKey];
  const m = {
    // multiplicative/additive stat stack
    speedMult: 1,
    accelMult: 1,
    dashCdMult: cls.dashCdMult,
    abilityCdMult: 1,
    tagRadiusMult: 1,
    sprintMax: 100,
    sprintRegenMult: 1,
    knockbackTakenMult: 1,
    knockbackDealtMult: 1,
    frictionMult: 1,
    dashCharges: 1,
    dashIframeBonus: 0,
    pickupDurationMult: 1,
    adrenalCharges: 0,
    trapRadiusMult: 1,
    revealRangeBonus: 0,
    sprintDrainMult: 1,
    massMult: 1,
    turnGrip: 0,
    iceSlipMult: 1,
    dashLockMult: 1,
    wellPullMult: 1,
    bumpPowerMult: 1,
    staggerResist: 0,
    momentumReach: 0,

    // flags
    slowZoneImmune: false,
    staticCharge: false,
    camouflage: false,
    nightVision: false,
    bloodhound: false,
    luckyDraw: false,
    chaosTheory: false,
    fatigueDashImmune: false,
    wallPhaseDash: false,
    scavenger: false,
    windUp: false,
    wellImmune: false,
    opportunist: false,
    wallSlide: false,
    lastStand: false,
    coldBlood: false,
    boilingBlood: false,
    deathsTouch: false,
    quicksilver: false,
    compass: false,
    bloodyLust: false,
    privilegedStatus: false,
    divineDash: false,
    brittleBones: false,
    noSprint: false,
    iceAffinity: false,
    startleReflex: false,
    slowburn: false,
    stillnessCharm: false,
    wallKick: false,
    bully: false,
    ironCalves: false,
    grudge: false,
    slingshot: false,
    pressure: false,
    airTime: false,
    cadence: false,
    firstWind: false,
    immovable: false,
    apotheosis: false,
  };

  // ---- class fixed passive (stays separate from the shared pool) ----
  if(clsKey==='scout')     m.speedMult += 0.15;
  if(clsKey==='tank'){     m.knockbackDealtMult += 0.25; m.slowZoneResist = 0.5; m.massMult += 0.6; }
  if(clsKey==='trapper')   m.trapRadiusMult += 0.20;
  if(clsKey==='hunter'){   m.speedMult -= 0.05; m.revealRangeBonus += 90; }
  if(clsKey==='phantom'){  m.fatigueDashImmune = true; m.wallPhaseDash = true; }
  if(clsKey==='anchor'){   m.knockbackTakenMult = 0; m.staticCharge = true; }
  if(clsKey==='brawler'){  m.massMult += 0.5; m.bumpPowerMult += 0.5; }
  if(clsKey==='warden'){   m.knockbackTakenMult -= 0.25; m.wellPullMult = 0.5; }
  if(clsKey==='skater')    m.iceAffinity = true;
  if(clsKey==='chrono')    m.abilityCdMult *= 0.85;

  // ---- role baseline ----
  // Applied before drafted upgrades, so these really are BASE stats that
  // everything else then builds on. Hunters get the legs, prey get the kit.
  if(hunting){
    m.speedMult  *= HUNTER_SPEED_MULT;
    m.sprintMax  *= HUNTER_SPRINT_MULT;
    m.dashCdMult *= HUNTER_DASH_CD_MULT;
  } else {
    m.abilityCdMult *= PREY_ABILITY_CD_MULT;
  }

  // ---- drafted passives ----
  for(const id of buildState.passives){
    const p = PASSIVE_BY_ID[id];
    if(p) p.apply(m);
  }

  // ---- permanent run artifacts ----
  for(const id of buildState.artifacts){
    const a = RARE_BY_ID[id];
    if(a) a.build(m);
  }

  // ---- artifact series: owning every part unlocks the capstone ----
  const doneSets = completedSets(buildState.artifacts);
  for(const s of doneSets) s.build(m);
  m.sets = doneSets.map(s=>s.id);

  // APOTHEOSIS: an Isaac-style transformation - focusing your draft on one
  // kind of trait pays off, so a narrow build beats a scattered one
  if(m.apotheosis){
    const byCat = {};
    for(const id of buildState.passives){
      const p = PASSIVE_BY_ID[id];
      if(p) byCat[p.cat] = (byCat[p.cat]||0) + 1;
    }
    let sets = 0;
    for(const n of Object.values(byCat)) sets += Math.floor(n/3);
    m.speedMult += 0.06 * sets;
    m.apotheosisSets = sets;
  }

  // floors so a wild stack can't invert a stat's sign
  m.speedMult = Math.max(0.35, m.speedMult);
  // rounded: the role multiplier leaves float dust that the HUD bar divides by
  m.sprintMax = Math.max(30, Math.round(m.sprintMax));
  m.tagRadiusMult = Math.max(0.5, m.tagRadiusMult);
  m.staggerResist = clamp(m.staggerResist, 0, 1);
  m.turnGrip = clamp(m.turnGrip, -1, 1);
  m.massMult = Math.max(0.5, m.massMult);
  m.knockbackTakenMult = Math.max(0, m.knockbackTakenMult);
  return m;
}

/**
 * Re-derive and re-apply mods onto a live entity - after a rare pickup, an
 * in-duel upgrade, or a Zombie Tag conversion (which flips your role, and so
 * your whole baseline).
 */
export function refreshMods(e, buildState, hunting){
  const prevMax = e.sprintMax || 100;
  const isHunting = (hunting === undefined) ? e.hunting : hunting;
  e.mods = computeMods(e.clsKey, buildState, isHunting);
  e.sprintMax = e.mods.sprintMax;
  // keep the same *proportion* of sprint when the max changes
  e.sprint = Math.min(e.sprintMax, e.sprint * (e.sprintMax/prevMax));
  e.dashChargesMax = e.mods.dashCharges;
  e.dashCharges = Math.min(e.dashCharges, e.dashChargesMax);
}
