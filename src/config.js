export const IW = 640, IH = 400;                 // internal render resolution (isometric view)
export const ISO_X = 2, ISO_Y = 1, ISO_Z = 2;    // screen px per world unit / per voxel of height
export const WALL_H = 14;                        // wall height in voxels

/* World size is per-mode: crowded modes get more room so the chase-to-open-
   space ratio stays similar. These are `let` on purpose - ES module live
   bindings mean every importer sees the current value after setWorldSize(). */
export let WORLD_W = 1500, WORLD_H = 950;
export function setWorldSize(w,h){ WORLD_W = w; WORLD_H = h; }
export const RADIUS = 4.2;                        // collision hitbox - kept smaller than the sprite so near-misses are dodgeable
export const VISUAL_HALF = 5;                     // sprite half-size (drawn slightly bigger than the hitbox)
export const BASE_MAX_SPEED = 85;
export const BASE_ACCEL = 560;
// Halved, for real drift: you carry momentum out of a turn, so committing to a
// direction costs you. Sharp direction changes are no longer free.
export const FRICTION = 2.2;
export const DASH_IMPULSE = 260;                  // a real burst, not a nudge
export const DASH_BURST_TIME = 0.35;              // window where the speed cap is relaxed so the burst actually covers ground
export const DASH_COOLDOWN = 1.6;
export const DASH_IFRAME = 0.28;
export const DASH_LOCK = 0.12;

/* ---- realistic running: stumbles, planted turns, ice, feel ---- */
export const STUMBLE_SPEED_MULT = 0.5;
export const STUMBLE_ACCEL_MULT = 0.4;
export const TURN_BRAKE = 0.5;
export const TURN_ACCEL_PENALTY = 0.6;
export const TURN_COS_START = 0.2;
export const TURN_MIN_SPEED = 60;
export const DASH_STAMINA_COST = 10;
export const FATIGUE_STUMBLE_SPEED = 170;
export const FATIGUE_STUMBLE_TIME = 0.35;
export const ICE_SLIP = 0.7;
export const HITSTOP_TAG = 0.08;
export const CAMERA_FOLLOW_RATE = 7;
export const CAMERA_LOOKAHEAD = 0.22;
// Fallback duel length. Each mode overrides this with its own duration and
// its own in-duel upgrade marks (see modes.js).
export const ROUND_TIME = 120;
export const GRACE_TIME = 2.0;

/* -------------------------------------------------------------------------
   ROLE BASE STATS
   Being "it" is a different job from being hunted, so the two sides get
   different baselines before class and drafted upgrades are applied.
   Hunters get the legs; prey get the toolkit.
   ------------------------------------------------------------------------- */
export const HUNTER_SPEED_MULT   = 1.20;  // +20% top speed
export const HUNTER_SPRINT_MULT  = 1.10;  // +10% sprint stamina
export const HUNTER_DASH_CD_MULT = 0.90;  // -10% dash cooldown
export const PREY_ABILITY_CD_MULT = 0.90; // -10% ability cooldown

/* -------------------------------------------------------------------------
   SPRINT / STAMINA
   Modelled on how sprinting actually feels rather than as a flat linear bar:

   - Sprinting raises BOTH top speed and acceleration, so it's a real burst
     off the line, not just a higher ceiling you slowly drift up to.
   - Cost is non-linear in time. The first stride of a burst is cheap; hold it
     and the per-second cost climbs steeply as you go anaerobic.
   - Output tapers with what's left in the tank. Near-empty, sprinting barely
     beats jogging - you cannot hold top speed while gassed.
   - Recovery is non-linear too. Right after stopping you're in oxygen debt and
     regain almost nothing; the rate ramps up the longer you ease off, and is
     heavily suppressed while you're still running flat out.
   - Blowing the tank fully costs you a hard fatigue state, and you must get
     real breath back (not just wait out a timer) before sprinting again.
   ------------------------------------------------------------------------- */
export const SPRINT_BOOST_MAX = 1.40;    // top-speed multiplier on fresh legs
export const SPRINT_BOOST_MIN = 1.12;    // ...and when running on fumes
export const SPRINT_ACCEL_MAX = 1.55;    // acceleration multiplier, fresh
export const SPRINT_ACCEL_MIN = 1.08;    // ...and when gassed
export const SPRINT_TAPER_AT  = 0.55;    // stamina fraction where output starts fading

export const SPRINT_DRAIN_BASE   = 17;   // cost/sec at the start of a burst
export const SPRINT_DRAIN_RAMP   = 28;   // extra cost/sec once it's sustained
export const SPRINT_DRAIN_RAMP_T = 2.5;  // seconds to reach full cost

export const SPRINT_REGEN_MIN    = 5;    // recovery/sec immediately after stopping
export const SPRINT_REGEN_MAX    = 32;   // ...once you've actually caught your breath
export const SPRINT_REGEN_RAMP_T = 2.0;  // seconds of easing off to reach full recovery
export const SPRINT_REGEN_MOVE_PENALTY = 0.55; // recovery lost while still running hard

export const SPRINT_FATIGUE_MULT = 0.70; // speed penalty while fatigued
export const SPRINT_FATIGUE_TIME = 2.4;  // minimum time the tired penalty lasts
export const SPRINT_RECOVER_FRAC = 0.28; // breath you must regain before sprinting again

// direction pings - periodic compass blips toward the opponent
export const PING_INTERVAL_TAGGER = 1.0;  // tagger gets a ping toward the runner every 1s
export const PING_INTERVAL_RUNNER = 3.0;  // runner gets a ping toward the tagger every 3s
export const PING_SHOW_TIME = 0.9;

// zone grid - randomized irregular slow/speed patches
export const ZONE_CELL = 30;

// pathfinding grid
export const PATH_CELL = 24;

/* =========================================================================
   RUN CONFIG  (roguelike outer loop)
   ========================================================================= */
export const DRAFT_OPTIONS = 3;        // "pick 1 of 3"
export const MAX_ACTIVE_SLOTS = 4;     // drafted actives bound to keys 1-4
export const REROLL_START = 1;         // charges at run start
export const REROLL_EVERY = 3;         // +1 charge every N duels survived
export const REROLL_CAP = 3;
export const RARE_PICKUP_CHANCE = 0.08; // per-duel roll for a rare artifact spawn

/* =========================================================================
   CLASSES
   The four originals keep their signature ability + passive permanently and
   separately from the shared draft pool (locked design decision). The four
   new classes follow the same contract.
   ========================================================================= */
export const CLASSES = {
  rogue: {
    key:'rogue', name:'ROGUE', color:'#9b6bff',
    flavor:'"Gone before you finish blinking."',
    passiveLabel:'-30% dash cooldown',
    abilityName:'BLINK', abilityLabel:'Short teleport burst',
    abilityCooldown:8, dashCdMult:0.7, aimed:false,
    difficulty:'EASY',
  },
  tank: {
    key:'tank', name:'TANK', color:'#ff9f45',
    flavor:'"Moves like weather. Arrives like weather."',
    passiveLabel:'+25% knockback power, resists slow zones',
    abilityName:'SHOCKWAVE', abilityLabel:'Push + slow nearby foe',
    abilityCooldown:10, dashCdMult:1, aimed:false,
    difficulty:'EASY',
  },
  scout: {
    key:'scout', name:'SCOUT', color:'#3fe0c5',
    flavor:'"Outrun it. Solve it later."',
    passiveLabel:'+15% max speed',
    abilityName:'BURST', abilityLabel:'Stamina speed surge',
    abilityCooldown:0, dashCdMult:1, aimed:false,
    difficulty:'EASY',
  },
  trickster: {
    key:'trickster', name:'TRICKSTER', color:'#ff5ec4',
    flavor:'"Which one of us did you say you were chasing?"',
    passiveLabel:'Brief invisibility after dash',
    abilityName:'DECOY', abilityLabel:'Spawn a mimic clone',
    abilityCooldown:11, dashCdMult:1, aimed:false,
    difficulty:'MEDIUM',
  },
  trapper: {
    key:'trapper', name:'TRAPPER', color:'#a8a23f',
    flavor:'"Doesn\'t chase. Doesn\'t need to."',
    passiveLabel:'Trap trigger radius +20%',
    abilityName:'SNARE FIELD', abilityLabel:'Wide root trap at your feet',
    abilityCooldown:12, dashCdMult:1, aimed:false,
    difficulty:'MEDIUM',
  },
  hunter: {
    key:'hunter', name:'HUNTER', color:'#e0673f',
    flavor:'"You don\'t have to catch what you can already touch from here."',
    passiveLabel:'-5% speed, sees through stealth further',
    abilityName:"HUNTER'S BOLT", abilityLabel:'Aimed ranged tag attempt',
    abilityCooldown:7, dashCdMult:1, aimed:true, abilityRange:150,
    difficulty:'HARD',
  },
  phantom: {
    key:'phantom', name:'PHANTOM', color:'#8fd6ff',
    flavor:'"Walls are a suggestion."',
    passiveLabel:'Fatigue never weakens your dash',
    abilityName:'PHASE WALK', abilityLabel:'Dash straight through walls',
    abilityCooldown:9, dashCdMult:1, aimed:false,
    difficulty:'HARD',
  },
  anchor: {
    key:'anchor', name:'ANCHOR', color:'#5c6b9b',
    flavor:'"Come here."',
    passiveLabel:'Knockback immune; standing still charges a burst',
    abilityName:'GRAVITY ANCHOR', abilityLabel:'Aimed pull well',
    abilityCooldown:11, dashCdMult:1, aimed:true, abilityRange:170,
    difficulty:'MEDIUM',
  },
  brawler: {
    key:'brawler', name:'BRAWLER', color:'#a64b3c',
    flavor:'"Doors are just walls that haven\'t met me."',
    passiveLabel:'Heavier: bumps hit harder',
    abilityName:'BULL RUSH', abilityLabel:'Unstoppable charge, stagger on impact',
    abilityCooldown:9, dashCdMult:1, aimed:false,
    difficulty:'MEDIUM',
  },
  warden: {
    key:'warden', name:'WARDEN', color:'#7fb069',
    flavor:'"Nothing gets past. Including you."',
    passiveLabel:'-25% knockback, wells pull half',
    abilityName:'BULWARK', abilityLabel:'Two orbiting guards block and shove',
    abilityCooldown:11, dashCdMult:1, aimed:false,
    difficulty:'MEDIUM',
  },
  skater: {
    key:'skater', name:'SKATER', color:'#4aa3ff',
    flavor:'"Friction is a rumour."',
    passiveLabel:'Ice is your ground: no slip, +25% speed on it',
    abilityName:'SLICK', abilityLabel:'Lay down a patch of ice',
    abilityCooldown:10, dashCdMult:1, aimed:false,
    difficulty:'HARD',
  },
  chrono: {
    key:'chrono', name:'CHRONO', color:'#c7f464',
    flavor:'"Slow for everyone but me."',
    passiveLabel:'-15% ability cooldowns',
    abilityName:'TIMEWARP', abilityLabel:'Bubble that slows everyone else inside',
    abilityCooldown:13, dashCdMult:1, aimed:false,
    difficulty:'HARD',
  },
};

export const STARTER_CLASSES = ['rogue','tank','scout','trickster'];

// account level at which each locked class unlocks (see DESIGN.md section 9)
export const CLASS_UNLOCK_LEVEL = {
  trapper: 6,
  hunter: 10,
  phantom: 14,
  anchor: 18,
  brawler: 22,
  warden: 26,
  skater: 30,
  chrono: 34,
};

/* =========================================================================
   DRAFT POOL WIDTH  (account progression widens the pool, not raw stats)
   ========================================================================= */
export const POOL_BASE = 8;      // draftable abilities/passives at account level 1
export const POOL_PER_STEP = 3;  // +3 each step
export const POOL_LEVELS_PER_STEP = 3;

export function poolWidth(level){
  return POOL_BASE + Math.floor((level-1)/POOL_LEVELS_PER_STEP)*POOL_PER_STEP;
}

/* =========================================================================
   PICKUPS
   ========================================================================= */
export const RARITY = { COMMON:'common', RARE:'rare' };
