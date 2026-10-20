/* =========================================================================
   SHARED PASSIVE POOL  (DESIGN.md section 6, expanded)
   60 passives, draftable by any class, additive to the class's own fixed
   passive. Duplicates stack plainly - no diminishing returns, per the
   locked "loose / arcade" balance philosophy.

   Each entry's apply(m) mutates the build-modifier object built in build.js.
   `rarity` drives both the draft odds and the card colour (see rarity.js).
   ========================================================================= */
export const PASSIVES = [
  /* ---------------- COMMON: small, always-useful numbers ---------------- */
  { id:'p_swift',    name:'SWIFT SOLE',      desc:'+8% max speed',                  cat:'mobility', rarity:'common',
    apply:m=>{ m.speedMult += 0.08; } },
  { id:'p_lungs',    name:'IRON LUNGS',      desc:'+25 max sprint stamina',         cat:'stamina', rarity:'common',
    apply:m=>{ m.sprintMax += 25; } },
  { id:'p_breath',   name:'SECOND BREATH',   desc:'+20% sprint regen',              cat:'stamina', rarity:'common',
    apply:m=>{ m.sprintRegenMult += 0.20; } },
  { id:'p_reach',    name:'LONG REACH',      desc:'+15% tag radius',                cat:'tagrange', rarity:'common',
    apply:m=>{ m.tagRadiusMult += 0.15; } },
  { id:'p_feather',  name:'FEATHERWEIGHT',   desc:'-10% dash cooldown',             cat:'mobility', rarity:'common',
    apply:m=>{ m.dashCdMult *= 0.90; } },
  { id:'p_momentum', name:'MOMENTUM KEEPER', desc:'-15% friction (longer slides)',  cat:'mobility', rarity:'common',
    apply:m=>{ m.frictionMult *= 0.85; } },
  { id:'p_edge',     name:"SPRINTER'S EDGE", desc:'Sprint drains 20% slower',       cat:'stamina', rarity:'common',
    apply:m=>{ m.sprintDrainMult *= 0.80; } },
  { id:'p_escape',   name:'ESCAPE ARTIST',   desc:'+0.1s dash invulnerability',     cat:'defense', rarity:'common',
    apply:m=>{ m.dashIframeBonus += 0.10; } },

  /* ---------------- UNCOMMON: conditional or utility ---------------- */
  { id:'p_skin',     name:'THICK SKIN',      desc:'-30% incoming knockback',        cat:'defense', rarity:'uncommon',
    apply:m=>{ m.knockbackTakenMult *= 0.70; } },
  { id:'p_quick',    name:'QUICKDRAW',       desc:'-12% all ability cooldowns',     cat:'utility', rarity:'uncommon',
    apply:m=>{ m.abilityCdMult *= 0.88; } },
  { id:'p_packrat',  name:'PACK RAT',        desc:'+25% pickup effect duration',    cat:'utility', rarity:'uncommon',
    apply:m=>{ m.pickupDurationMult += 0.25; } },
  { id:'p_hound',    name:'BLOODHOUND',      desc:'Ping shows exact distance',      cat:'utility', rarity:'uncommon',
    apply:m=>{ m.bloodhound = true; } },
  { id:'p_static',   name:'STATIC CHARGE',   desc:'Stand 1.5s: next dash +30% far', cat:'mobility', rarity:'uncommon',
    apply:m=>{ m.staticCharge = true; } },
  { id:'p_adrenal',  name:'ADRENAL RUSH',    desc:'Cancel fatigue once per duel',   cat:'stamina', rarity:'uncommon',
    apply:m=>{ m.adrenalCharges += 1; } },
  { id:'p_scav',     name:'SCAVENGER',       desc:'Pickups also refund 15 sprint',  cat:'utility', rarity:'uncommon',
    apply:m=>{ m.scavenger = true; } },
  { id:'p_windup',   name:'WIND UP',         desc:'Sprint 2s straight: +15% speed', cat:'stamina', rarity:'uncommon',
    apply:m=>{ m.windUp = true; } },
  { id:'p_boots',    name:'HEAVY BOOTS',     desc:'Immune to gravity well pulls',   cat:'defense', rarity:'uncommon',
    apply:m=>{ m.wellImmune = true; } },
  { id:'p_instinct', name:"TRAPPER'S EYE",   desc:'Your traps trigger 30% wider',   cat:'zone', rarity:'uncommon',
    apply:m=>{ m.trapRadiusMult += 0.30; } },

  /* ---------------- RARE: build-shaping ---------------- */
  { id:'p_double',   name:'DOUBLE STEP',     desc:'Gain a 2nd dash charge',         cat:'mobility', rarity:'rare',
    apply:m=>{ m.dashCharges += 1; } },
  { id:'p_zonerun',  name:'ZONE RUNNER',     desc:'Immune to slow-zone penalty',    cat:'mobility', rarity:'rare',
    apply:m=>{ m.slowZoneImmune = true; } },
  { id:'p_camo',     name:'CAMOUFLAGE',      desc:'Stand 2s: partial invisibility', cat:'stealth', rarity:'rare',
    apply:m=>{ m.camouflage = true; } },
  { id:'p_night',    name:'NIGHT VISION',    desc:'Decoys never fool you',          cat:'antistealth', rarity:'rare',
    apply:m=>{ m.nightVision = true; } },
  { id:'p_lucky',    name:'LUCKY DRAW',      desc:'Draft leans toward your kit',    cat:'random', rarity:'rare',
    apply:m=>{ m.luckyDraw = true; } },
  { id:'p_oppo',     name:'OPPORTUNIST',     desc:'+25% tag reach on slowed prey',  cat:'tagrange', rarity:'rare',
    apply:m=>{ m.opportunist = true; } },
  { id:'p_ghostwt',  name:'GHOST WEIGHT',    desc:'Walls no longer kill your speed',cat:'mobility', rarity:'rare',
    apply:m=>{ m.wallSlide = true; } },
  { id:'p_laststand',name:'LAST STAND',      desc:'Final 30s: +20% speed',          cat:'identity', rarity:'rare',
    apply:m=>{ m.lastStand = true; } },

  /* ---------------- LEGENDARY: run-defining ---------------- */
  { id:'p_glass',    name:'GLASS CANNON',    desc:'+20% speed, -20% stamina',       cat:'identity', rarity:'legendary',
    apply:m=>{ m.speedMult += 0.20; m.sprintMax -= 20; } },
  { id:'p_anchorpt', name:'ANCHOR POINT',    desc:'Knockback immune, -10% speed',   cat:'identity', rarity:'legendary',
    apply:m=>{ m.knockbackTakenMult = 0; m.speedMult -= 0.10; } },
  { id:'p_chaos',    name:'CHAOS THEORY',    desc:'Draft options span 3 categories',cat:'random', rarity:'legendary',
    apply:m=>{ m.chaosTheory = true; } },
  { id:'p_cold',     name:'COLD BLOOD',      desc:'Auto-deflect the first tag',     cat:'defense', rarity:'legendary',
    apply:m=>{ m.coldBlood = true; } },

  /* =======================================================================
     EXPANSION WAVE 3
     Traits that change a rule or grow during the duel, rather than adding a
     flat number - including two deliberately cursed trade-offs.
     ======================================================================= */
  { id:'p_boiling',  name:'BOILING BLOOD',   desc:'+25% accel while right on them',  cat:'identity', rarity:'common',
    apply:m=>{ m.boilingBlood = true; } },
  { id:'p_deaths',   name:"DEATH'S TOUCH",   desc:'Tag reach grows as the duel runs',cat:'tagrange', rarity:'uncommon',
    apply:m=>{ m.deathsTouch = true; } },
  { id:'p_quicksil', name:'QUICKSILVER',     desc:'Each pickup: +3% speed this duel', cat:'utility', rarity:'uncommon',
    apply:m=>{ m.quicksilver = true; } },
  { id:'p_compass',  name:'THE COMPASS',     desc:'They never leave your minimap',   cat:'antistealth', rarity:'uncommon',
    apply:m=>{ m.compass = true; } },
  { id:'p_lust',     name:'BLOODY LUST',     desc:'Close quarters stacks +4% speed', cat:'identity', rarity:'rare',
    apply:m=>{ m.bloodyLust = true; } },
  { id:'p_privil',   name:'PRIVILEGED STATUS',desc:'2+ debuffs on them: +18% speed', cat:'identity', rarity:'rare',
    apply:m=>{ m.privilegedStatus = true; } },
  { id:'p_divine',   name:'DIVINE DASH',     desc:'Dashing through them slows them', cat:'mobility', rarity:'rare',
    apply:m=>{ m.divineDash = true; } },
  { id:'p_brittle',  name:'BRITTLE BONES',   desc:'+25% speed, but walls daze you',  cat:'identity', rarity:'rare',
    apply:m=>{ m.speedMult += 0.25; m.brittleBones = true; } },
  { id:'p_momsgrip', name:"MOM'S GRIP",      desc:'+40% tag reach, but no sprinting',cat:'tagrange', rarity:'legendary',
    apply:m=>{ m.tagRadiusMult += 0.40; m.noSprint = true; } },
  { id:'p_apoth',    name:'APOTHEOSIS',      desc:'+6% speed per 3 same-type traits',cat:'identity', rarity:'legendary',
    apply:m=>{ m.apotheosis = true; } },

  /* =======================================================================
     EXPANSION WAVE 4: RUNNING FEEL
     Passives that plug into the stumble / planted-turn / mass / ice
     systems (physics.js, bodies.js, arena.js) rather than adding flat stats.
     ======================================================================= */
  { id:'p_grip',     name:'GRIPPED SOLES',   desc:'Sharp turns cost 40% less; ice slips half as much', cat:'mobility', rarity:'common',
    apply:m=>{ m.turnGrip += 0.4; m.iceSlipMult *= 0.5; } },
  { id:'p_pacing',   name:'STEADY PACE',     desc:'-10% sprint drain, +10% regen',   cat:'stamina', rarity:'common',
    apply:m=>{ m.sprintDrainMult *= 0.9; m.sprintRegenMult += 0.1; } },
  { id:'p_quickstart',name:'QUICK STARTS',   desc:'+15% acceleration',               cat:'mobility', rarity:'common',
    apply:m=>{ m.accelMult += 0.15; } },
  { id:'p_ballast',  name:'BALLAST',         desc:'+25% mass, -10% knockback taken', cat:'defense', rarity:'common',
    apply:m=>{ m.massMult += 0.25; m.knockbackTakenMult -= 0.1; } },
  { id:'p_footwork', name:'FOOTWORK',        desc:'Steer sooner after a dash',       cat:'mobility', rarity:'common',
    apply:m=>{ m.dashLockMult *= 0.6; } },
  { id:'p_shakeoff', name:'SHAKE IT OFF',    desc:'Stumbles last 30% shorter',       cat:'defense', rarity:'common',
    apply:m=>{ m.staggerResist += 0.3; } },
  { id:'p_lunge',    name:'MOMENTUM STRIKE', desc:'Tag reach grows up to +3 at full speed', cat:'tagrange', rarity:'uncommon',
    apply:m=>{ m.momentumReach += 1; } },
  { id:'p_startle',  name:'STARTLE REFLEX',  desc:'On being shoved or stumbled: 0.6s dodge + burst (6s cooldown)', cat:'defense', rarity:'uncommon',
    apply:m=>{ m.startleReflex = true; } },
  { id:'p_slowburn', name:'SLOWBURN',        desc:'-15% speed; +30% after 6s uninterrupted', cat:'mobility', rarity:'uncommon',
    apply:m=>{ m.slowburn = true; } },
  { id:'p_stillness',name:'STILL WATERS',    desc:'Cooldowns tick twice as fast while standing still', cat:'utility', rarity:'uncommon',
    apply:m=>{ m.stillnessCharm = true; } },
  { id:'p_wallkick', name:'WALL KICK',       desc:'Hit a wall hard: bounce and a quick-start boost', cat:'mobility', rarity:'uncommon',
    apply:m=>{ m.wallKick = true; } },
  { id:'p_bully',    name:'BULLY',           desc:'Your bumps stagger lighter fighters', cat:'identity', rarity:'uncommon',
    apply:m=>{ m.bully = true; } },
  { id:'p_ironcalves',name:'IRON CALVES',    desc:'Fatigue only slows you 15%',      cat:'stamina', rarity:'uncommon',
    apply:m=>{ m.ironCalves = true; } },
  { id:'p_grudge',   name:'GRUDGE',          desc:'+5% speed per debuff on you (max 5)', cat:'identity', rarity:'rare',
    apply:m=>{ m.grudge = true; } },
  { id:'p_slingshot',name:'SLINGSHOT',       desc:'Release a 1.5s+ sprint for a 0.4s burst', cat:'mobility', rarity:'rare',
    apply:m=>{ m.slingshot = true; } },
  { id:'p_pressure', name:'PRESSURE',        desc:'Foes within 60 of you move 10% slower', cat:'identity', rarity:'rare',
    apply:m=>{ m.pressure = true; } },
  { id:'p_airtime',  name:'AIR TIME',        desc:'Dashing hops over ground effects and traps', cat:'mobility', rarity:'rare',
    apply:m=>{ m.airTime = true; } },
  { id:'p_glide',    name:'GLIDE',           desc:'-25% friction, -0.3 turn grip',   cat:'mobility', rarity:'rare',
    apply:m=>{ m.frictionMult *= 0.75; m.turnGrip -= 0.3; } },
  { id:'p_juggernaut',name:'JUGGERNAUT',     desc:'x2 mass, immune to stagger, -12% speed, -60% knockback', cat:'identity', rarity:'legendary',
    apply:m=>{ m.massMult += 1; m.staggerResist = 1; m.speedMult -= 0.12; m.bumpPowerMult += 1; m.knockbackTakenMult -= 0.6; } },
  { id:'p_cadence',  name:'CADENCE',         desc:'Every 3s of hard running: +4% speed (max 5 stacks); stopping resets', cat:'stamina', rarity:'legendary',
    apply:m=>{ m.cadence = true; } },
];

export const PASSIVE_BY_ID = Object.fromEntries(PASSIVES.map(p=>[p.id,p]));
