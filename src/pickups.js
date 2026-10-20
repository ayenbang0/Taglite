/* =========================================================================
   PICKUPS  (DESIGN.md section 7)
   Two rarity tiers (locked decision):
     COMMON - instant, duel-scoped, spawns on the existing timer/point system
     RARE   - a permanent "artifact": persists for the REST OF THE RUN.
              Rares are collected into run.<side>.artifacts and re-applied to
              the build every duel by build.js.
   ========================================================================= */
import { RARITY } from './config.js';
import { norm } from './math.js';
import { makeDecoy } from './entity.js';
import { state } from './state.js';
import { showAnnounce } from './ui.js';
import { spawnEventFX } from './fx.js';

function burst(e,color){
  state.particles.push({x:e.x,y:e.y-4,vx:0,vy:-14,life:0.5,maxLife:0.5,color,size:3});
}

/* ---------------- COMMON: temporary, duel-scoped ---------------- */
export const COMMON_PICKUPS = [
  { id:'u_adren',  label:'ADRN', color:'#ffd23f', name:'ADRENALINE VIAL',
    apply(e,d){ e.sprint=e.sprintMax; e.fatigued=false; e.fatigueT=0; e.fatigueImmuneT=3*d; } },
  { id:'u_smoke',  label:'SMOK', color:'#7b83a1', name:'SMOKE POD',
    apply(e,d){ e.smokeT = 2.5*d; } },
  { id:'u_mud',    label:'MUD',  color:'#a8742a', name:'MUD FLASK',
    apply(e,d){ state.tempZones.push({x:e.x,y:e.y,r:38,type:'slow',life:6*d}); } },
  { id:'u_ghost',  label:'GHST', color:'#8fd6ff', name:'GHOST STEP',
    apply(e,d){ e.intangibleT = 3*d; } },
  { id:'u_clock',  label:'RST',  color:'#9b6bff', name:'OVERCLOCK CELL',
    apply(e){ e.dashCd*=0.5; e.abilityCd*=0.5; for(const k in e.slotCd) e.slotCd[k]*=0.5; } },
  { id:'u_magnet', label:'MAG',  color:'#3fe0c5', name:'MAGNET CHARM',
    apply(e,d){ e.magnetT = 4*d; } },
  { id:'u_hide',   label:'HIDE', color:'#ff9f45', name:'THICK HIDE',
    apply(e,d){ e.absorbT = 6*d; } },
  { id:'u_drone',  label:'EYE',  color:'#ff5ec4', name:'SPOTTER DRONE',
    apply(e,d){ e.revealT = 8*d; } },
  { id:'u_flare',  label:'DCOY', color:'#ff5ec4', name:'DECOY FLARE',
    apply(e,d){ state.decoys.push(makeDecoy(e, 5*d)); } },
  { id:'u_root',   label:'ROOT', color:'#a8a23f', name:'ROOT POD',
    apply(e){ state.traps.push({x:e.x,y:e.y,r:14,owner:e,life:20,kind:'snare'}); } },
  { id:'u_wind',   label:'WIND', color:'#3fe0c5', name:'WIND VIAL',
    apply(e){ const d=e.lastMoveDir; e.vx+=d.x*230; e.vy+=d.y*230; e.dashBurstT=Math.max(e.dashBurstT,0.3); } },
  { id:'u_warp',   label:'WARP', color:'#9b6bff', name:'WARP CRYSTAL',
    apply(e){ e.warpRequest = true; } },
];

/* ---------------- RARE: permanent for the rest of the run ---------------- */
export const RARE_PICKUPS = [
  { id:'x_heart', label:'HRT', color:'#ff5470', name:"RUNNER'S HEART",
    desc:'+6% max speed, permanently',
    build:m=>{ m.speedMult += 0.06; } },
  { id:'x_claw',  label:'CLAW', color:'#ffd23f', name:"TAGGER'S CLAW",
    desc:'+10% tag radius, permanently',
    build:m=>{ m.tagRadiusMult += 0.10; } },
  { id:'x_latch', label:'LTCH', color:'#8fd6ff', name:'PHANTOM LATCH',
    desc:'+0.15s dash iframe, permanently',
    build:m=>{ m.dashIframeBonus += 0.15; } },
  { id:'x_flask', label:'FLSK', color:'#3fe0c5', name:'ENDLESS FLASK',
    desc:'+15 max sprint, permanently',
    build:m=>{ m.sprintMax += 15; } },
  { id:'x_stopwatch', label:'STOP', color:'#ffd23f', name:'STOPWATCH',
    desc:'-10% ability cooldowns',
    build:m=>{ m.abilityCdMult *= 0.9; } },
  { id:'x_chalk', label:'CHLK', color:'#e9ecf4', name:'GRIP CHALK',
    desc:'+35% turn grip, ice slips 40% less',
    build:m=>{ m.turnGrip += 0.35; m.iceSlipMult *= 0.6; } },
  { id:'x_ironlung', label:'LUNG', color:'#3fe0c5', name:'IRON LUNG',
    desc:'-15% sprint drain',
    build:m=>{ m.sprintDrainMult *= 0.85; } },
  { id:'x_spurs', label:'SPUR', color:'#ff9f45', name:"RIDER'S SPURS",
    desc:'Tag reach grows with speed',
    build:m=>{ m.momentumReach += 1; } },
  { id:'x_horseshoe', label:'SHOE', color:'#7fb069', name:'LUCKY HORSESHOE',
    desc:'+30% pickup duration',
    build:m=>{ m.pickupDurationMult += 0.3; } },
  { id:'x_gland', label:'GLND', color:'#ff5470', name:'ADRENAL GLAND',
    desc:'Cancel your next fatigue',
    build:m=>{ m.adrenalCharges += 1; } },

  /* ---- series: STRIDER KIT ---- */
  { id:'x_stridespikes', label:'SPKE', color:'#4aa3ff', name:'STRIDER SPIKES',
    desc:'+8% acceleration',
    build:m=>{ m.accelMult += 0.08; } },
  { id:'x_stridevest', label:'VEST', color:'#4aa3ff', name:'STRIDER VEST',
    desc:'+12 max sprint',
    build:m=>{ m.sprintMax += 12; } },
  { id:'x_stridebands', label:'BAND', color:'#4aa3ff', name:'STRIDER BANDS',
    desc:'-20% post-dash steering lock',
    build:m=>{ m.dashLockMult *= 0.8; } },

  /* ---- series: BULWARK PLATE ---- */
  { id:'x_bulwarkpad', label:'PAUL', color:'#7b83a1', name:'BULWARK PAULDRONS',
    desc:'+20% mass',
    build:m=>{ m.massMult += 0.2; } },
  { id:'x_bulwarkplate', label:'PLTE', color:'#7b83a1', name:'BULWARK BREASTPLATE',
    desc:'-15% knockback taken',
    build:m=>{ m.knockbackTakenMult -= 0.15; } },
  { id:'x_bulwarkgreave', label:'GRV', color:'#7b83a1', name:'BULWARK GREAVES',
    desc:'+25% stagger resistance',
    build:m=>{ m.staggerResist += 0.25; } },
];

/* ---------------- ARTIFACT SERIES: own every part, earn the capstone ---------------- */
export const ARTIFACT_SETS = [
  { id:'strider', name:'STRIDER KIT',
    parts:['x_stridespikes','x_stridevest','x_stridebands'],
    desc:'FIRST WIND: the first 1.5s of each sprint is free',
    build:m=>{ m.firstWind = true; } },
  { id:'bulwark', name:'BULWARK PLATE',
    parts:['x_bulwarkpad','x_bulwarkplate','x_bulwarkgreave'],
    desc:'IMMOVABLE: standing still for 0.5s triples your mass',
    build:m=>{ m.immovable = true; } },
];

/** Series whose every part appears at least once in `artifacts`. */
export function completedSets(artifacts){
  return ARTIFACT_SETS.filter(s => s.parts.every(p => artifacts.includes(p)));
}

export const PICKUP_BY_ID = Object.fromEntries(
  [...COMMON_PICKUPS, ...RARE_PICKUPS].map(p=>[p.id,p])
);
export const RARE_BY_ID = Object.fromEntries(RARE_PICKUPS.map(p=>[p.id,p]));

/**
 * Apply a pickup to an entity.
 * Commons resolve immediately. Rares are banked as run artifacts and take
 * effect through the build system from this moment on.
 */
export function applyPickup(e, id){
  const def = PICKUP_BY_ID[id];
  if(!def) return;
  const dur = e.mods ? e.mods.pickupDurationMult : 1;
  const setsBefore = (def.build && e.build) ? completedSets(e.build.artifacts).length : 0;
  if(def.build){
    // Rare artifact -> permanent for the run. e.build IS the run's build
    // object for this fighter (run.player, or one of run.aiBuilds), so
    // pushing here persists it for the rest of the run.
    if(e.build){
      e.build.artifacts.push(id);
      if(e===state.player && completedSets(e.build.artifacts).length > setsBefore){
        const done = completedSets(e.build.artifacts);
        showAnnounce('SET COMPLETE: ' + done[done.length-1].name);
      }
      e.pendingRebuild = true;
    }
    burst(e, def.color);
    spawnEventFX('rare', e.x, e.y, {color:def.color});
    state.shockwaveFX.push({x:e.x,y:e.y,r:0,maxR:60,t:0});
  } else {
    def.apply(e, dur);
    burst(e, def.color);
    spawnEventFX('pickup', e.x, e.y, {color:def.color});
  }
  // SCAVENGER passive: every pickup is also a small breather
  if(e.mods && e.mods.scavenger){
    e.sprint = Math.min(e.sprintMax, e.sprint + 15);
  }
  // QUICKSILVER passive: pickups compound into speed for the rest of the duel
  if(e.mods && e.mods.quicksilver){
    e.pickupStacks = (e.pickupStacks||0) + 1;
  }
}
