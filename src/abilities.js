/* =========================================================================
   SHARED ABILITY POOL  (DESIGN.md section 5, expanded)
   60 abilities, draftable by any class, stacked on top of the class's own
   fixed signature ability. Drafted actives bind to number keys 1-4.
   `rarity` drives both the draft odds and the card colour (see rarity.js).

   `aimed:true` abilities need a world-space target point and go through the
   click-to-target layer (targeting.js). `range` clamps how far that point
   can be from the caster.

   cast(e, ctx) -> bool   ctx = {opponent, aim:{x,y}, mods}
   Returning false means "nothing happened", so the cooldown is not paid.
   ========================================================================= */
import { len, norm, clamp } from './math.js';
import { WORLD_W, WORLD_H, RADIUS, ZONE_CELL } from './config.js';
import { wallBlocked } from './arena.js';
import { state } from './state.js';
import { kickShake } from './feel.js';
import { makeDecoy } from './entity.js';
import { applyStagger, applyKnockback } from './physics.js';

function spawnBurst(x,y,color,n=6,speed=26){
  for(let i=0;i<n;i++){
    particlesPush(x,y,(Math.random()-0.5)*speed,(Math.random()-0.5)*speed,color);
  }
}
function particlesPush(x,y,vx,vy,color,life=0.4,size=2){
  state.particles.push({x,y,vx,vy,life,maxLife:life,color,size});
}

// paint a temporary circular zone patch into the world
function paintZone(x,y,r,type,life){
  state.tempZones.push({x,y,r,type,life});
}

// anyone `o` that `e` could meaningfully shove, trip or snag
function isFoe(e, o){
  return o!==e && o.team!==e.team && o.alive!==false && !o.frozen && o.intangibleT<=0;
}

export const ABILITIES = [
  {
    id:'a_grapple', name:'GRAPPLE HOOK', flavor:'"Distance is negotiable."',
    desc:'Yank yourself to the aimed point', cd:6, aimed:true, range:170, cat:'movement', rarity:'uncommon',
    cast(e,ctx){
      const d = norm(ctx.aim.x-e.x, ctx.aim.y-e.y);
      const maxD = len(ctx.aim.x-e.x, ctx.aim.y-e.y);
      let travel=0; const step=4;
      while(travel<maxD){
        const nx=e.x+d.x*step, ny=e.y+d.y*step;
        if(wallBlocked(nx,ny)) break;
        e.x=nx; e.y=ny; travel+=step;
      }
      e.vx = d.x*150; e.vy = d.y*150;
      e.dashBurstT = Math.max(e.dashBurstT, 0.25);
      spawnBurst(e.x,e.y,e.cls.color);
      return true;
    },
  },
  {
    id:'a_snare', name:'SNARE TRAP', flavor:'"Patience, weaponised."',
    desc:'Hidden trap: roots + reveals', cd:9, aimed:true, range:120, cat:'zone', rarity:'uncommon',
    cast(e,ctx){
      if(state.traps.filter(t=>t.owner===e && t.kind==='snare').length>=1) return false;
      state.traps.push({x:ctx.aim.x,y:ctx.aim.y,r:14,owner:e,life:20,kind:'snare'});
      return true;
    },
  },
  {
    id:'a_phase', name:'PHASE STEP', flavor:'"Briefly, a rumour."',
    desc:'0.4s intangible - no collisions', cd:10, aimed:false, cat:'movement', rarity:'rare',
    cast(e){ e.intangibleT = Math.max(e.intangibleT, 0.4); spawnBurst(e.x,e.y,'#8fd6ff'); return true; },
  },
  {
    id:'a_deflect', name:'TAG DEFLECT', flavor:'"Not today."',
    desc:'Survive one tag: knockback + iframe', cd:25, aimed:false, cat:'taginteraction', rarity:'rare',
    cast(e){ e.deflectArmed = true; return true; },
  },
  {
    id:'a_longarm', name:'LONG ARM', flavor:'"Closer than it looks."',
    desc:'+40% tag radius for 4s', cd:8, aimed:false, cat:'taginteraction', rarity:'common',
    cast(e){ e.tagBuffT = 4; e.tagBuffMult = 1.4; return true; },
  },
  {
    id:'a_pierce', name:'PIERCING TOUCH', flavor:'"Corners are not cover."',
    desc:'3s: tag reaches through a corner', cd:12, aimed:false, cat:'taginteraction', rarity:'rare',
    cast(e){ e.pierceT = 3; return true; },
  },
  {
    id:'a_well', name:'GRAVITY WELL', flavor:'"Everything falls somewhere."',
    desc:'Pulls both fighters inward, 3s', cd:14, aimed:true, range:150, cat:'physics', rarity:'uncommon',
    cast(e,ctx){
      state.wells.push({x:ctx.aim.x,y:ctx.aim.y,r:55,life:3,strength:120,owner:e,kind:'pull'});
      return true;
    },
  },
  {
    id:'a_surge', name:'RECKLESS SURGE', flavor:'"Brakes are optional."',
    desc:'+50% speed 2s, dash locked out', cd:10, aimed:false, cat:'movement', rarity:'common',
    cast(e){ e.surgeT = 2; e.noDashT = 2; return true; },
  },
  {
    id:'a_zonepaint', name:'ZONE PAINT', flavor:'"Make your own luck. Literally."',
    desc:'Speed pad at your feet', cd:15, aimed:false, cat:'zone', rarity:'common',
    cast(e){ paintZone(e.x,e.y,40,'speed',8); return true; },
  },
  {
    id:'a_mud', name:'MUD BOMB', flavor:'"Ground control."',
    desc:'Throws a 6s slow patch', cd:11, aimed:true, range:160, cat:'zone', rarity:'common',
    cast(e,ctx){
      const d = norm(ctx.aim.x-e.x, ctx.aim.y-e.y);
      state.projectiles.push({
        x:e.x,y:e.y,vx:d.x*220,vy:d.y*220,owner:e,life:1.2,kind:'mud',
        tx:ctx.aim.x,ty:ctx.aim.y,color:'#a8742a',
      });
      return true;
    },
  },
  {
    id:'a_adren', name:'ADRENALINE', flavor:'"Borrowed, at interest."',
    desc:'Refill sprint + 4s fatigue immunity', cd:20, aimed:false, cat:'buff', rarity:'common',
    cast(e){ e.sprint = e.sprintMax; e.fatigued=false; e.fatigueT=0; e.fatigueImmuneT=4; return true; },
  },
  {
    id:'a_smoke', name:'SMOKESCREEN', flavor:'"Now you don\'t."',
    desc:'2.5s: they lose sight of you', cd:13, aimed:false, cat:'defense', rarity:'uncommon',
    cast(e){ e.smokeT = 2.5; spawnBurst(e.x,e.y,'#7b83a1',10,18); return true; },
  },
  {
    id:'a_magnet', name:'MAGNET PULSE', flavor:'"Finders, keepers."',
    desc:'Drags nearby pickups to you', cd:16, aimed:false, cat:'utility', rarity:'common',
    cast(e){ e.magnetT = 4; return true; },
  },
  {
    id:'a_overclock', name:'OVERCLOCK', flavor:'"Cheating the clock."',
    desc:'Cut all your cooldowns by half', cd:30, aimed:false, cat:'utility', rarity:'rare',
    cast(e){
      e.dashCd *= 0.5; e.abilityCd *= 0.5;
      for(const k in e.slotCd) e.slotCd[k] *= 0.5;
      spawnBurst(e.x,e.y,'#ffd23f');
      return true;
    },
  },
  {
    id:'a_sticky', name:'STICKY GLOB', flavor:'"One step. That\'s all it needs."',
    desc:'Aimed glob: halves their accel', cd:10, aimed:true, range:150, cat:'zone', rarity:'uncommon',
    cast(e,ctx){
      const d = norm(ctx.aim.x-e.x, ctx.aim.y-e.y);
      state.projectiles.push({
        x:e.x,y:e.y,vx:d.x*260,vy:d.y*260,owner:e,life:1.0,kind:'sticky',
        tx:ctx.aim.x,ty:ctx.aim.y,color:'#9b6bff',
      });
      return true;
    },
  },
  {
    id:'a_blinkstrike', name:'BLINK STRIKE', flavor:'"Arrive rude."',
    desc:'Dash that also extends your reach', cd:8, aimed:false, cat:'taginteraction', rarity:'uncommon',
    cast(e){
      const dir = len(e.vx,e.vy)>5 ? norm(e.vx,e.vy) : e.lastMoveDir;
      e.vx += dir.x*240; e.vy += dir.y*240;
      e.dashBurstT = 0.35; e.dashIframe = 0.28;
      e.tagBuffT = 0.5; e.tagBuffMult = 1.5;
      spawnBurst(e.x,e.y,e.cls.color);
      return true;
    },
  },
  {
    id:'a_ghosttrail', name:'GHOST TRAIL', flavor:'"Chase that instead."',
    desc:'Next dash leaves a false echo', cd:12, aimed:false, cat:'defense', rarity:'uncommon',
    cast(e){ e.ghostTrailCharge = true; return true; },
  },
  {
    id:'a_wallbreak', name:'WALLBREAKER', flavor:'"Shortcut."',
    desc:'Next dash passes through a wall', cd:9, aimed:false, cat:'movement', rarity:'uncommon',
    cast(e){ e.wallbreakCharge = true; return true; },
  },
  {
    id:'a_beacon', name:'WARP BEACON', flavor:'"Leave a way back."',
    desc:'Drop it, recast within 5s to return', cd:15, aimed:true, range:140, cat:'movement', rarity:'rare',
    cast(e,ctx){
      const mine = state.beacons.find(b=>b.owner===e);
      if(mine){
        e.x = mine.x; e.y = mine.y; e.vx*=0.3; e.vy*=0.3;
        state.beacons.splice(state.beacons.indexOf(mine),1);
        spawnBurst(e.x,e.y,'#3fe0c5');
        return true;
      }
      state.beacons.push({x:ctx.aim.x,y:ctx.aim.y,owner:e,life:5});
      return true;
    },
  },
  {
    id:'a_mark', name:"HUNTER'S MARK", flavor:'"Tagged, in the other sense."',
    desc:'5s: their stealth stops working', cd:14, aimed:true, range:400, cat:'utility', rarity:'rare',
    cast(e,ctx){
      const o = ctx.opponent;
      if(!o) return false;
      o.markedT = 5;
      return true;
    },
  },

  /* =======================================================================
     EXPANSION WAVE 2
     ======================================================================= */
  {
    id:'a_mines', name:'SCATTER MINES', flavor:'"Mind your step. All of them."',
    desc:'Rings you with 3 slow mines', cd:13, aimed:false, cat:'zone', rarity:'common',
    cast(e){
      for(let i=0;i<3;i++){
        const a = (i/3)*Math.PI*2 + Math.random();
        const x = e.x + Math.cos(a)*30, y = e.y + Math.sin(a)*30;
        if(wallBlocked(x,y)) continue;
        state.traps.push({x,y,r:12,owner:e,life:14,kind:'mine'});
      }
      return true;
    },
  },
  {
    id:'a_spring', name:'SPRING TRAP', flavor:'"Up you go."',
    desc:'Trap that flings whoever trips it', cd:11, aimed:true, range:130, cat:'zone', rarity:'common',
    cast(e,ctx){
      if(state.traps.filter(t=>t.owner===e && t.kind==='spring').length>=1) return false;
      state.traps.push({x:ctx.aim.x,y:ctx.aim.y,r:16,owner:e,life:18,kind:'spring'});
      return true;
    },
  },
  {
    id:'a_leech', name:'LEECH TAG', flavor:'"Their legs, your legs."',
    desc:'Drain 35 sprint from them at range', cd:14, aimed:false, cat:'utility', rarity:'uncommon',
    cast(e,ctx){
      const o = ctx.opponent;
      if(!o || len(o.x-e.x, o.y-e.y) > 120) return false;
      const stolen = Math.min(35, o.sprint);
      o.sprint = Math.max(0, o.sprint - stolen);
      e.sprint = Math.min(e.sprintMax, e.sprint + stolen);
      spawnBurst(o.x,o.y,'#ff5470',8,30);
      return true;
    },
  },
  {
    id:'a_flash', name:'FLASHBANG', flavor:'"Look away. Too late."',
    desc:'4s: kills their ping and minimap', cd:16, aimed:true, range:200, cat:'utility', rarity:'uncommon',
    cast(e,ctx){
      const o = ctx.opponent;
      if(!o) return false;
      if(len(o.x-ctx.aim.x, o.y-ctx.aim.y) > 70) return false;  // has to land near them
      o.blindT = 4;
      spawnBurst(ctx.aim.x,ctx.aim.y,'#ffffff',12,40);
      return true;
    },
  },
  {
    id:'a_sense', name:'PREDATOR SENSE', flavor:'"Walls stopped helping."',
    desc:'6s: see them through walls', cd:18, aimed:false, cat:'utility', rarity:'uncommon',
    cast(e){ e.seeThroughT = 6; return true; },
  },
  {
    id:'a_tether', name:'TETHER', flavor:'"On a short leash."',
    desc:'3s: they cannot leave the area', cd:20, aimed:true, range:160, cat:'physics', rarity:'rare',
    cast(e,ctx){
      state.wells.push({x:ctx.aim.x,y:ctx.aim.y,r:95,life:3,strength:520,owner:e,kind:'tether'});
      return true;
    },
  },
  {
    id:'a_barricade', name:'BARRICADE', flavor:'"You shall not, etc."',
    desc:'Drops a wall for 6s', cd:17, aimed:true, range:130, cat:'zone', rarity:'rare',
    cast(e,ctx){
      // orient the slab across the caster's line of sight to the target point
      const dx = ctx.aim.x-e.x, dy = ctx.aim.y-e.y;
      const horiz = Math.abs(dx) < Math.abs(dy);
      const w = horiz ? 76 : 14, h = horiz ? 14 : 76;
      state.tempWalls.push({
        x:ctx.aim.x-w/2, y:ctx.aim.y-h/2, w, h, life:6,
      });
      return true;
    },
  },
  {
    id:'a_recall', name:'RECALL', flavor:'"Take that back."',
    desc:'Snap back to where you were 3s ago', cd:16, aimed:false, cat:'movement', rarity:'rare',
    cast(e){
      const past = e.posHistory && e.posHistory[0];
      if(!past) return false;
      e.x = past.x; e.y = past.y;
      e.vx *= 0.2; e.vy *= 0.2;
      spawnBurst(e.x,e.y,'#3fe0c5',10,34);
      return true;
    },
  },
  {
    id:'a_stasis', name:'STASIS FIELD', flavor:'"Everything slows but you."',
    desc:'3s: they crawl at 35% speed', cd:26, aimed:true, range:190, cat:'physics', rarity:'legendary',
    cast(e,ctx){
      const o = ctx.opponent;
      if(!o) return false;
      if(len(o.x-ctx.aim.x, o.y-ctx.aim.y) > 85) return false;
      o.slowDebuffT = Math.max(o.slowDebuffT, 3);
      o.slowDebuffMult = 0.35;
      state.shockwaveFX.push({x:ctx.aim.x,y:ctx.aim.y,r:0,maxR:85,t:0});
      return true;
    },
  },
  {
    id:'a_swap', name:'SWAP', flavor:'"Trading places. No refunds."',
    desc:'Instantly swap places with them', cd:28, aimed:false, cat:'movement', rarity:'legendary',
    cast(e,ctx){
      const o = ctx.opponent;
      if(!o) return false;
      const ex=e.x, ey=e.y;
      e.x=o.x; e.y=o.y;
      o.x=ex;  o.y=ey;
      spawnBurst(e.x,e.y,'#ff5ec4',10,34);
      spawnBurst(o.x,o.y,'#ff5ec4',10,34);
      return true;
    },
  },

  /* =======================================================================
     EXPANSION WAVE 3
     Roguelike-flavoured picks: delayed inevitability, stacking status,
     telegraphed hazards, familiars and risk-reward gambles - translated into
     tag verbs (reach, tempo, positioning) rather than combat ones.
     ======================================================================= */
  {
    id:'a_brand', name:'BRAND', flavor:'"It only has to finish counting."',
    desc:'3s: if they are still near you when it ends, it lands as a tag',
    cd:22, aimed:false, cat:'taginteraction', rarity:'rare',
    cast(e,ctx){
      const o = ctx.opponent;
      if(!o || len(o.x-e.x, o.y-e.y) > 130) return false;
      o.brandT = 3;
      o.brandBy = e;
      state.shockwaveFX.push({x:o.x,y:o.y,r:0,maxR:40,t:0});
      return true;
    },
  },
  {
    id:'a_thunder', name:'THUNDER CALL', flavor:'"Mind the sky."',
    desc:'Telegraphed strike lands after 1.2s: slows and shoves',
    cd:12, aimed:true, range:200, cat:'zone', rarity:'uncommon',
    cast(e,ctx){
      state.projectiles.push({
        x:ctx.aim.x, y:ctx.aim.y, vx:0, vy:0, owner:e,
        life:1.2, kind:'strike', radius:52, color:'#ffd23f',
        fuse:1.2,
      });
      return true;
    },
  },
  {
    id:'a_trail', name:"DRUNKARD'S TRAIL", flavor:'"Everywhere you\'ve been is worse for it."',
    desc:'5s: you leave slow puddles behind you',
    cd:15, aimed:false, cat:'zone', rarity:'uncommon',
    cast(e){ e.puddleT = 5; e.puddleTick = 0; return true; },
  },
  {
    id:'a_frost', name:'FROSTBITE', flavor:'"Proximity has a price."',
    desc:'8s: staying near them stacks a slow, up to 5',
    cd:18, aimed:false, cat:'physics', rarity:'uncommon',
    cast(e){ e.frostT = 8; return true; },
  },
  {
    id:'a_shove', name:'TIDAL SHOVE', flavor:'"Out of my lane."',
    desc:'Cone blast: heavy shove and a daze',
    cd:11, aimed:false, cat:'physics', rarity:'uncommon',
    cast(e,ctx){
      const o = ctx.opponent;
      const dir = e.lastMoveDir;
      state.shockwaveFX.push({x:e.x,y:e.y,r:0,maxR:95,t:0});
      if(!o) return true;
      const d = len(o.x-e.x, o.y-e.y);
      if(d > 95) return true;
      const n = norm(o.x-e.x, o.y-e.y);
      if(n.x*dir.x + n.y*dir.y < 0.35) return true;   // outside the cone
      o.vx += n.x*300; o.vy += n.y*300;
      o.slowDebuffT = Math.max(o.slowDebuffT, 1.2);
      o.slowDebuffMult = 0.6;
      return true;
    },
  },
  {
    id:'a_dice', name:'DICE SHARD', flavor:'"Roll it. See what happens."',
    desc:'Teleports BOTH of you somewhere random',
    cd:19, aimed:false, cat:'utility', rarity:'uncommon',
    cast(e,ctx){
      e.warpRequest = true;
      if(ctx.opponent) ctx.opponent.warpRequest = true;
      return true;
    },
  },
  {
    id:'a_seeker', name:'SEEKER ORB', flavor:'"It knows where you live."',
    desc:'A slow homing orb that chills on contact',
    cd:14, aimed:false, cat:'utility', rarity:'rare',
    cast(e,ctx){
      const o = ctx.opponent;
      const d = o ? norm(o.x-e.x, o.y-e.y) : e.lastMoveDir;
      state.projectiles.push({
        x:e.x, y:e.y, vx:d.x*90, vy:d.y*90, owner:e,
        life:5, kind:'seeker', color:'#3fe0c5', turn:2.4, speed:110,
      });
      return true;
    },
  },
  {
    id:'a_beam', name:'SIPHON BEAM', flavor:'"Hold still. Both of you."',
    desc:'Root yourself 0.6s, then fire a rooting line',
    cd:16, aimed:false, cat:'taginteraction', rarity:'rare',
    cast(e){
      e.beamChargeT = 0.6;
      e.beamDir = {x:e.lastMoveDir.x, y:e.lastMoveDir.y};
      e.noDashT = Math.max(e.noDashT, 0.6);
      return true;
    },
  },
  {
    id:'a_shade', name:'HUNGRY SHADE', flavor:'"It followed you home."',
    desc:'8s: an orbiting familiar that chills on touch',
    cd:20, aimed:false, cat:'defense', rarity:'rare',
    cast(e){
      state.familiars.push({kind:'shade', owner:e, angle:Math.random()*Math.PI*2, life:8, cd:0});
      return true;
    },
  },
  {
    id:'a_ward', name:'REVERSAL WARD', flavor:'"Wrong way round."',
    desc:'4s: their next tag swaps you and punishes them',
    cd:26, aimed:false, cat:'defense', rarity:'legendary',
    cast(e){ e.wardT = 4; return true; },
  },

  /* =======================================================================
     EXPANSION WAVE 4: RUNNING FEEL
     Abilities built on the stumble / mass / planted-turn / ice systems:
     timing, telegraphs and risk-reward rather than flat numbers.
     ======================================================================= */
  {
    id:'a_slide', name:'SLIDE TACKLE', flavor:'"Low and fast."',
    desc:'Skid forward along the ground: longer reach, no steering', cd:6, aimed:false, cat:'movement', rarity:'common',
    cast(e){
      const dir = len(e.vx,e.vy)>5 ? norm(e.vx,e.vy) : e.lastMoveDir;
      e.vx += dir.x*190; e.vy += dir.y*190;
      e.slideT = 0.55;
      e.dashLockT = Math.max(e.dashLockT, 0.25);
      spawnBurst(e.x,e.y,'#8b93b8',6,24);
      return true;
    },
  },
  {
    id:'a_sidestep', name:'SIDESTEP', flavor:'"Olé."',
    desc:'Hop sideways, away from them, with a brief dodge', cd:3.5, aimed:false, cat:'movement', rarity:'common',
    cast(e,ctx){
      const dir = len(e.vx,e.vy)>5 ? norm(e.vx,e.vy) : e.lastMoveDir;
      const perp = {x:-dir.y, y:dir.x};
      const o = ctx.opponent;
      let s;
      if(o){
        const cross = dir.x*(o.y-e.y) - dir.y*(o.x-e.x);
        s = cross>0 ? -1 : 1;
      } else {
        s = Math.random()<0.5 ? -1 : 1;
      }
      e.vx += perp.x*s*210; e.vy += perp.y*s*210;
      e.dashIframe = Math.max(e.dashIframe, 0.14);
      spawnBurst(e.x,e.y,e.cls.color,5,22);
      return true;
    },
  },
  {
    id:'a_dustkick', name:'DUST KICK', flavor:'"Eat my dust. Literally."',
    desc:'Kick up a cloud behind you: anyone inside is hidden, foes crawl', cd:9, aimed:false, cat:'utility', rarity:'common',
    cast(e){
      state.tempZones.push({
        x:e.x-e.lastMoveDir.x*20, y:e.y-e.lastMoveDir.y*20,
        r:30, type:'dust', life:3.5, owner:e,
      });
      return true;
    },
  },
  {
    id:'a_tripwire', name:'TRIP WIRE', flavor:'"Mind the step."',
    desc:'Hidden wire: a hard stumble. Max 2 out at once', cd:8, aimed:true, range:110, cat:'zone', rarity:'common',
    cast(e,ctx){
      if(state.traps.filter(t=>t.owner===e && t.kind==='trip').length>=2) return false;
      state.traps.push({x:ctx.aim.x,y:ctx.aim.y,r:16,owner:e,life:20,kind:'trip'});
      return true;
    },
  },
  {
    id:'a_brace', name:'BRACE', flavor:'"Come on, then."',
    desc:'1.4s: shoves barely move you, you shrug off stumbles and bodycheck', cd:7, aimed:false, cat:'defense', rarity:'common',
    cast(e){ e.braceT = 1.4; return true; },
  },
  {
    id:'a_pacer', name:'PACER', flavor:'"Even breaths. Even strides."',
    desc:'5s: sprint drains 40% slower, recovers 50% faster', cd:14, aimed:false, cat:'buff', rarity:'common',
    cast(e){ e.pacerT = 5; return true; },
  },
  {
    id:'a_cleats', name:'CLEATS', flavor:'"Dig in."',
    desc:'4s: no sharp-turn penalty, no ice slip, +10% accel', cd:12, aimed:false, cat:'movement', rarity:'common',
    cast(e){ e.gripT = 4; return true; },
  },
  {
    id:'a_boomerang', name:'BOOMERANG DISC', flavor:'"It always comes back. So do I."',
    desc:'Throw a disc out and back: shoves and slows what it clips', cd:9, aimed:true, range:160, cat:'physics', rarity:'uncommon',
    cast(e,ctx){
      const d = norm(ctx.aim.x-e.x, ctx.aim.y-e.y);
      state.projectiles.push({
        x:e.x,y:e.y,vx:d.x*260,vy:d.y*260,owner:e,kind:'boomerang',phase:'out',
        tx:ctx.aim.x,ty:ctx.aim.y,speed:260,life:4,color:'#ffd23f',hit:new Set(),
      });
      return true;
    },
  },
  {
    id:'a_ricochet', name:'RICOCHET SHOT', flavor:'"Angles are a love language."',
    desc:'Bolt that bounces off walls up to 3 times: shoves and slows', cd:8, aimed:true, range:150, cat:'physics', rarity:'uncommon',
    cast(e,ctx){
      const d = norm(ctx.aim.x-e.x, ctx.aim.y-e.y);
      state.projectiles.push({
        x:e.x,y:e.y,vx:d.x*280,vy:d.y*280,owner:e,kind:'ricochet',
        speed:280,life:1.8,bounces:3,color:'#9b6bff',
      });
      return true;
    },
  },
  {
    id:'a_orbitblades', name:'ORBIT BLADES', flavor:'"Personal space, enforced."',
    desc:'5s: three blades orbit you, shoving and slowing foes', cd:14, aimed:false, cat:'defense', rarity:'uncommon',
    cast(e){
      for(let i=0;i<3;i++){
        state.familiars.push({kind:'blade',owner:e,angle:i*2.0944,life:5,cd:0,x:e.x,y:e.y});
      }
      return true;
    },
  },
  {
    id:'a_hover', name:'HOVER BOOTS', flavor:'"The floor is lava. Not for me."',
    desc:'2.5s airborne: ignore ground effects, traps and bumps', cd:12, aimed:false, cat:'movement', rarity:'uncommon',
    cast(e){ e.airT = 2.5; e.airT0 = 2.5; return true; },
  },
  {
    id:'a_powderkeg', name:'POWDER KEG', flavor:'"Everyone is on the guest list."',
    desc:'Telegraphed blast: shoves EVERYONE in the ring, including you', cd:12, aimed:true, range:130, cat:'zone', rarity:'uncommon',
    cast(e,ctx){
      state.projectiles.push({
        x:ctx.aim.x,y:ctx.aim.y,vx:0,vy:0,owner:e,life:1.2,fuse:1.2,
        kind:'strike',radius:55,indiscriminate:true,color:'#ff9f45',
      });
      return true;
    },
  },
  {
    id:'a_pounce', name:'POUNCE', flavor:'"Commit."',
    desc:'Leap with +50% reach. Miss and you eat dirt', cd:9, aimed:false, cat:'taginteraction', rarity:'uncommon',
    cast(e){
      const dir = len(e.vx,e.vy)>5 ? norm(e.vx,e.vy) : e.lastMoveDir;
      e.vx += dir.x*280; e.vy += dir.y*280;
      e.pounceT = 0.4; e.pounceHit = false;
      e.dashLockT = Math.max(e.dashLockT, 0.2);
      return true;
    },
  },
  {
    id:'a_stomp', name:'SEISMIC STOMP', flavor:'"The ground remembers."',
    desc:'Stagger and shove everyone within 80. You stumble too, briefly', cd:13, aimed:false, cat:'physics', rarity:'rare',
    cast(e){
      for(const o of state.entities){
        if(!isFoe(e,o) || len(o.x-e.x, o.y-e.y) > 80) continue;
        applyStagger(o, 1.2);
        applyKnockback(e, o, 160);
      }
      applyStagger(e, 0.4);
      state.shockwaveFX.push({x:e.x,y:e.y,r:0,maxR:80,t:0});
      kickShake(3, 0.3);
      return true;
    },
  },
  {
    id:'a_overdrive', name:'OVERDRIVE', flavor:'"Redline. Pay later."',
    desc:'6s: +50% accel, sprint burns faster. Ends in a stumble', cd:20, aimed:false, cat:'buff', rarity:'rare',
    cast(e){ e.overdriveT = 6; return true; },
  },
  {
    id:'a_springboard', name:'SPRINGBOARD', flavor:'"Bouncy. For everyone."',
    desc:'Pad that launches whoever steps on it, 3 uses', cd:10, aimed:true, range:140, cat:'zone', rarity:'rare',
    cast(e,ctx){
      state.traps.push({x:ctx.aim.x,y:ctx.aim.y,r:14,owner:e,life:12,kind:'pad',uses:3,cd:0});
      return true;
    },
  },
  {
    id:'a_counter', name:'COUNTER STANCE', flavor:'"Hit me. I dare you."',
    desc:'6s: the next tag on you fails and floors the tagger', cd:16, aimed:false, cat:'defense', rarity:'rare',
    cast(e){ e.counterT = 6; return true; },
  },
  {
    id:'a_lasso', name:'LASSO', flavor:'"Yeehaw. Now come here."',
    desc:'Yank foes near the aimed point toward you and trip them', cd:11, aimed:true, range:170, cat:'taginteraction', rarity:'rare',
    cast(e,ctx){
      let caught = 0;
      for(const o of state.entities){
        if(!isFoe(e,o) || len(o.x-ctx.aim.x, o.y-ctx.aim.y) > 26) continue;
        const n = norm(e.x-o.x, e.y-o.y);
        o.vx = n.x*280; o.vy = n.y*280;
        applyStagger(o, 0.6);
        caught++;
      }
      return caught>0;
    },
  },
  {
    id:'a_stampede', name:'STAMPEDE', flavor:'"Make way."',
    desc:'5s: +25% speed, 2.5x mass, bodycheck anyone, immune to stagger', cd:22, aimed:false, cat:'movement', rarity:'legendary',
    cast(e){ e.stampedeT = 5; return true; },
  },
  {
    id:'a_shellgame', name:'SHELL GAME', flavor:'"Keep your eye on the ball. Which one is it?"',
    desc:'Three decoys scatter while you vanish for a moment', cd:18, aimed:false, cat:'utility', rarity:'legendary',
    cast(e){
      const base = Math.random()*Math.PI*2;
      for(let i=0;i<3;i++){
        const d = makeDecoy(e, 5);
        d.heading = base + i*2.0944;
        state.decoys.push(d);
      }
      e.invisT = 1.2;
      e.dashIframe = Math.max(e.dashIframe, 0.2);
      const a = Math.random()*Math.PI*2;
      e.vx += Math.cos(a)*160; e.vy += Math.sin(a)*160;
      return true;
    },
  },
];

export const ABILITY_BY_ID = Object.fromEntries(ABILITIES.map(a=>[a.id,a]));
