// Single shared mutable state object. Every module that needs to read or
// reassign one of these fields imports `state` and touches it through this
// object, since plain ES module `let` bindings can't be reassigned from
// outside the module that declares them.
export const state = {
  // arena / world
  walls: null,
  zoneGrid: null,      // Map "col,row" -> 'slow' | 'speed'
  tempZones: [],        // dynamic circular patches, e.g. Tank's aftershock

  // pathfinding grid
  pathGrid: null,
  pathCols: 0,
  pathRows: 0,

  // ---- account-level meta progression (persists across runs, see progression.js)
  account: {
    xp: 0,
    level: 1,
  },

  // ---- the current run (a string of escalating duels)
  run: null,
  /* run shape:
     {
       clsKey,            locked class for the whole run
       duel,              1-based duel number
       rerolls,           banked reroll charges
       player: BuildState,
       bot:    BuildState,
       botClsKey,         re-rolled every duel
       mods: [],          active map modifiers this duel
       history: [],       per-duel log for the summary
       botTaggerLosses,   fuel for the bot's adaptive counter-draft
       xpEarned,
     }
     BuildState = { abilities:[id], passives:[id], artifacts:[id] }
  */

  // pending draft between duels
  draft: null,          // {options:[{kind,id}], forBot:false}

  // round entities
  // `entities` is the authoritative list for every mode (2 in Classic, 6 in
  // Zombie, 7 in Freeze). `player` is the human-controlled one; `bot` is kept
  // as a convenience alias for the single opponent in Classic.
  entities: [],
  player: null,
  bot: null,
  mode: null,        // the MODES entry for the current duel
  round: null,       // {timer, grace, active, midDraftDone, paused}

  // round-scoped dynamic objects
  particles: [],
  decoys: [],
  powerups: [],
  puTimer: 0,
  shockwaveFX: [], // visual rings

  // ---- world effects spawned by drafted abilities
  traps: [],        // {x,y,r,owner,life,kind:'snare'|'spring'|'mine'}
  tempWalls: [],    // {x,y,w,h,life} - BARRICADE slabs
  projectiles: [],  // {x,y,vx,vy,owner,life,kind,range,traveled}
  wells: [],        // {x,y,r,life,strength,owner,kind}
  beacons: [],      // {x,y,owner,life}
  afterImages: [],  // {x,y,life,maxLife,color}
  familiars: [],    // {owner,angle,life,cd} - HUNGRY SHADE orbiters

  camera: {x:0,y:0},   // world point at the centre of the screen (isometric view)
  theme: null,         // current map theme (themes.js)
  decor: [],           // non-colliding floor decor for this map
  shake: {t:0, mag:0},   // screen shake (feel.js)
  hitstopT: 0,           // freeze-frame time remaining (round.js loop)
  keys: {},
  dashPressed: false,
  abilityPressed: false,
  slotPressed: [false,false,false,false],

  // ---- click-to-target layer
  aim: {
    armed: null,     // {source:'class'|'slot', slot:number} while awaiting a click
    mouse: {x:0,y:0},   // canvas-space (internal 640x400) cursor
    world: {x:0,y:0},   // world-space cursor
    clicked: false,
    cancel: false,
  },

  lastTime: 0,
  rafId: null,
  announceTimer: 0,

  pingTimer: 0,
  pingShowT: 0, // direction-ping HUD

  // AI tuning - derived from duel depth each round so bots stay beatable early on
  botAI: {skill:0, speedMult:0.85, jitterDeg:30, reactionT:0.32, predictT:0.15, dashChance:0.45, abilityChance:0.4},
};
