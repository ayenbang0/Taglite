/* =========================================================================
   ABILITY ANIMATION
   Built on the three-beat attack grammar: ANTICIPATION (pull back), STRIKE
   (snap forward), RECOVERY (settle to neutral). Every animation ends back at
   the rest pose, so it chains cleanly into normal movement.

   Two rules this system enforces rather than hopes for:

   1. DIRECTION IS EXPLICIT. Every animation is authored along a direction
      vector passed in at play time - the aim vector, the movement vector, or
      the bearing to a target. Nothing is expressed as "the character's right
      hand", which is exactly the ambiguity that makes attacks swing the wrong
      way. `dir` is a WORLD-space vector; it is projected into the isometric
      view at draw time.

   2. THE STRIKE IS A PEAK, NOT A BEAT. Timing is deliberately uneven: a long
      eased wind-up, a split-second snap, then an eased settle. Linear timing
      would smear the strike into the rest of the motion and lose the punch.

   FX are drawn in world space and reach well past the 10px sprite, so a
   weapon arc never clips at the body's edge.
   ========================================================================= */
import { norm, len, clamp } from './math.js';
import { project, groundRing, pixelLine } from './iso.js';
import { emitEvt } from './relay.js';

/* ---- iso drawing helpers: all world-space, pixel crisp ---- */
function setA(ctx, a){ ctx.globalAlpha = clamp(a, 0, 1); }
function line3(ctx, ox, oy, z, dx0, dy0, dx1, dy1, color){
  const p0 = project(ox+dx0, oy+dy0, z), p1 = project(ox+dx1, oy+dy1, z);
  pixelLine(ctx, p0.x, p0.y, p1.x, p1.y, color);
}
function tip(ctx, x, y, z, color, size=3){
  const p = project(x, y, z);
  ctx.fillStyle = color;
  ctx.fillRect(Math.round(p.x)-1, Math.round(p.y)-1, size, size);
}
function arcAt(ctx, ox, oy, z, R, a0, a1, color){
  ctx.fillStyle = color;
  const n = Math.max(6, Math.ceil(R*1.2));
  for(let i=0;i<=n;i++){
    const a = a0 + (a1-a0)*i/n;
    const p = project(ox+Math.cos(a)*R, oy+Math.sin(a)*R, z);
    ctx.fillRect(Math.round(p.x), Math.round(p.y), 1, 1);
  }
}

export const anims = [];

/* ---------- easing ---------- */
const easeOutCubic  = u => 1 - Math.pow(1-u, 3);
const easeOutQuint  = u => 1 - Math.pow(1-u, 5);
const easeInOutCubic = u => u<0.5 ? 4*u*u*u : 1 - Math.pow(-2*u+2, 3)/2;

/**
 * The three-beat curve. Returns reach in [-1, 1]:
 *   -1 = fully wound up (pulled back)
 *   +1 = full extension (the strike)
 *    0 = neutral stance
 * The strike window is short on purpose - that's the peak.
 */
export function threeBeat(t, antEnd=0.34, strikeEnd=0.48){
  if(t < antEnd){
    return -easeOutCubic(t/antEnd);                       // wind up, decelerating
  }
  if(t < strikeEnd){
    const u = (t-antEnd)/(strikeEnd-antEnd);
    return -1 + 2*easeOutQuint(u);                        // snap through
  }
  const u = (t-strikeEnd)/(1-strikeEnd);
  return 1 - easeInOutCubic(u);                           // settle to rest
}

/** True during the brief strike window - used to fire FX on the peak only. */
function inStrike(a){ return a.t >= a.antEnd && a.t <= a.antEnd + 0.12; }

/* =========================================================================
   ARCHETYPES
   Each defines its own duration, beat split, body pose and world-space FX.
   `reach` is the three-beat curve; `dir` is the explicit direction vector.
   ========================================================================= */
const ARCHETYPES = {
  // a committed lunge along dir - tag-extending abilities
  thrust: {
    dur:0.42, ant:0.34, strike:0.48,
    pose(r){ return {ox:r*4, oy:0, sx:1+Math.max(0,r)*0.15, sy:1-Math.max(0,r)*0.1}; },
    fx(ctx, a, o, r){
      if(r <= 0.15) return;
      const d = a.dir, L = 8 + r*16;
      setA(ctx, r);
      line3(ctx, o.x, o.y, 8, d.x*6, d.y*6, d.x*L, d.y*L, a.color);
      line3(ctx, o.x, o.y, 9, d.x*6, d.y*6, d.x*L, d.y*L, a.color);
      // leading tip, so the reach reads at the far end
      tip(ctx, o.x+d.x*L, o.y+d.y*L, 8, '#fff');
      ctx.globalAlpha = 1;
    },
  },

  // overhand throw: wind back, release along dir
  throw: {
    dur:0.38, ant:0.38, strike:0.5,
    pose(r){ return {ox:r*2.5, oy:0, sx:1+Math.max(0,r)*0.1, sy:1+Math.max(0,-r)*0.1}; },
    fx(ctx, a, o, r){
      if(r <= 0.2) return;
      const d = a.dir, base = Math.atan2(d.y,d.x);
      setA(ctx, clamp(1-r, 0.15, 1));
      // release arc, swept forward off the hand
      arcAt(ctx, o.x, o.y, 9, 7, base-0.9, base+0.35, a.color);
      ctx.globalAlpha = 1;
    },
  },

  // crouch and slam: everything that puts something on the ground
  slam: {
    dur:0.44, ant:0.4, strike:0.52,
    pose(r){ return {ox:0, oy:0, sx:1+Math.max(0,r)*0.15, sy:1-Math.max(0,r)*0.15-Math.max(0,-r)*0.08}; },
    fx(ctx, a, o, r){
      if(r <= 0.2) return;
      const R = 4 + r*14;
      groundRing(ctx, o.x, o.y, R, a.color, clamp(1.1-r, 0, 1));
      groundRing(ctx, o.x, o.y, R*0.6, '#fff', clamp(0.9-r, 0, 1)*0.7);
    },
  },

  // draw inward, then burst outward - self-buffs and utility
  cast: {
    dur:0.5, ant:0.42, strike:0.56,
    pose(r){ const c = Math.max(0,-r); return {ox:0, oy:0, sx:1-c*0.1+Math.max(0,r)*0.12, sy:1-c*0.12+Math.max(0,r)*0.15}; },
    fx(ctx, a, o, r){
      if(r <= 0) return;
      const al = clamp(1-r, 0, 1);
      const R = 3 + r*12;
      groundRing(ctx, o.x, o.y, R, a.color, al);
      // four spokes, so the burst reads at low resolution
      setA(ctx, al);
      for(let i=0;i<4;i++){
        const ang = i*Math.PI/2 + a.seed;
        line3(ctx, o.x, o.y, 2, Math.cos(ang)*(R-2), Math.sin(ang)*(R-2), Math.cos(ang)*(R+2), Math.sin(ang)*(R+2), '#fff');
      }
      ctx.globalAlpha = 1;
    },
  },

  // reach out and haul - wells, tethers, grapples
  pull: {
    dur:0.46, ant:0.36, strike:0.5,
    pose(r){ return {ox:r*3, oy:0, sx:1+Math.max(0,-r)*0.1, sy:1+Math.max(0,r)*0.08}; },
    fx(ctx, a, o, r){
      const d = a.dir;
      setA(ctx, clamp(Math.abs(r), 0, 1));
      // a line that shoots out on the strike then reels back in
      const L = 8 + Math.max(0,r)*22;
      line3(ctx, o.x, o.y, 8, 0, 0, d.x*L, d.y*L, a.color);
      // barb at the far end
      if(r > 0.3) tip(ctx, o.x+d.x*L, o.y+d.y*L, 8, '#fff', 4);
      ctx.globalAlpha = 1;
    },
  },

  // compress then streak - movement abilities
  dash: {
    dur:0.34, ant:0.28, strike:0.4,
    pose(r){ return {ox:r*3, oy:0, sx:1+Math.max(0,r)*0.2, sy:1-Math.max(0,r)*0.1}; },
    fx(ctx, a, o, r){
      if(r <= 0.1) return;
      const d = a.dir;
      setA(ctx, clamp(r, 0, 1)*0.9);
      for(let i=1;i<=3;i++){
        const back = i*4;
        const bx = -d.x*back, by = -d.y*back;
        line3(ctx, o.x, o.y, 5, bx - d.y*2.5, by + d.x*2.5, bx + d.y*2.5, by - d.x*2.5, a.color);
        line3(ctx, o.x, o.y, 9, bx - d.y*2.5, by + d.x*2.5, bx + d.y*2.5, by - d.x*2.5, a.color);
      }
      ctx.globalAlpha = 1;
    },
  },

  // wind up and shove a cone forward
  shove: {
    dur:0.4, ant:0.42, strike:0.54,
    pose(r){ return {ox:r*4, oy:0, sx:1+Math.max(0,r)*0.2, sy:1-Math.max(0,r)*0.08}; },
    fx(ctx, a, o, r){
      if(r <= 0.15) return;
      const d = a.dir, base = Math.atan2(d.y,d.x);
      setA(ctx, clamp(1.1-r, 0, 1));
      for(const spread of [-0.45, 0, 0.45]){
        const R = 8 + r*18;
        line3(ctx, o.x, o.y, 6, Math.cos(base+spread)*5, Math.sin(base+spread)*5, Math.cos(base+spread)*R, Math.sin(base+spread)*R, a.color);
      }
      ctx.globalAlpha = 1;
    },
  },

  // the recipient's half of the pair: flinch back along the impact vector
  hit: {
    dur:0.3, ant:0.14, strike:0.26,
    pose(r){ return {ox:-Math.max(0,r)*3, oy:0, sx:1-Math.max(0,r)*0.12, sy:1+Math.max(0,r)*0.15}; },
    fx(ctx, a, o, r){
      if(r <= 0.2) return;
      setA(ctx, clamp(1-r, 0, 1));
      // impact chevrons, opposite the knockback
      const d = a.dir, base = Math.atan2(-d.y,-d.x);
      for(const off of [-0.5, 0.5]){
        line3(ctx, o.x, o.y, 11, Math.cos(base+off)*4, Math.sin(base+off)*4, Math.cos(base+off)*8, Math.sin(base+off)*8, '#fff');
      }
      ctx.globalAlpha = 1;
    },
  },
};

/* Which archetype each ability animates with, and the colour it throws. */
const ABILITY_ANIM = {
  // reach / tag-extending
  a_longarm:'thrust', a_blinkstrike:'thrust', a_pierce:'thrust',
  a_brand:'thrust', a_leech:'thrust',
  // thrown
  a_mud:'throw', a_sticky:'throw', a_seeker:'throw', a_flash:'throw',
  a_thunder:'throw', a_stasis:'throw',
  // ground-placed
  a_snare:'slam', a_spring:'slam', a_mines:'slam', a_zonepaint:'slam',
  a_trail:'slam', a_barricade:'slam',
  // self / utility
  a_adren:'cast', a_overclock:'cast', a_smoke:'cast', a_sense:'cast',
  a_magnet:'cast', a_ghosttrail:'cast', a_deflect:'cast', a_ward:'cast',
  a_shade:'cast', a_surge:'cast', a_frost:'cast', a_mark:'cast',
  // hauling
  a_well:'pull', a_tether:'pull', a_grapple:'pull',
  // movement
  a_phase:'dash', a_wallbreak:'dash', a_recall:'dash', a_beacon:'dash',
  a_swap:'dash', a_dice:'dash', a_beam:'thrust',
  // displacement
  a_shove:'shove',
  // wave 4 (running feel)
  a_slide:'dash', a_sidestep:'dash', a_pounce:'dash', a_hover:'dash', a_stampede:'dash',
  a_boomerang:'throw', a_ricochet:'throw', a_powderkeg:'throw',
  a_stomp:'slam', a_tripwire:'slam', a_springboard:'slam',
  a_brace:'cast', a_pacer:'cast', a_cleats:'cast', a_overdrive:'cast', a_counter:'cast',
  a_dustkick:'cast', a_shellgame:'cast', a_orbitblades:'cast',
  a_lasso:'pull',
};

const CLASS_ANIM = {
  rogue:'dash', tank:'slam', scout:'cast', trickster:'cast',
  trapper:'slam', hunter:'throw', phantom:'dash', anchor:'pull',
  brawler:'dash', warden:'cast', skater:'slam', chrono:'cast',
};

export function archetypeForAbility(id){ return ABILITY_ANIM[id] || 'cast'; }
export function archetypeForClass(clsKey){ return CLASS_ANIM[clsKey] || 'cast'; }

/**
 * Start an animation.
 * `dir` MUST be an explicit direction vector - aim, movement, or bearing to a
 * target. Never inferred from the entity's facing, so a lunge always goes
 * where the ability actually went.
 */
export function playAnim(kind, owner, dir, color){
  const arch = ARCHETYPES[kind];
  if(!arch || !owner) return;
  emitEvt('playAnim', kind, owner, dir, color);
  const d = dir && (dir.x || dir.y) ? norm(dir.x, dir.y) : {x:1, y:0};
  // one animation per entity at a time: a new cast overrides a stale recovery
  for(let i=anims.length-1;i>=0;i--){
    if(anims[i].owner === owner && anims[i].kind !== 'hit') anims.splice(i,1);
  }
  anims.push({
    kind, owner, dir:d, t:0,
    dur: arch.dur, antEnd: arch.ant, strikeEnd: arch.strike,
    color: color || (owner.cls ? owner.cls.color : '#fff'),
    seed: Math.random()*Math.PI,
  });
}

export function resetAnims(){ anims.length = 0; }

export function updateAnims(dt){
  for(let i=anims.length-1;i>=0;i--){
    const a = anims[i];
    a.t += dt / a.dur;
    if(a.t >= 1) anims.splice(i,1);
  }
}

/** Combined body pose for an entity this frame, or null at rest. */
export function poseFor(entity){
  let pose = null;
  for(const a of anims){
    if(a.owner !== entity) continue;
    const arch = ARCHETYPES[a.kind];
    if(!arch) continue;
    const r = threeBeat(a.t, a.antEnd, a.strikeEnd);
    const p = arch.pose(r);
    const ox = (p.ox||0), oy = (p.oy||0);
    // offsets are applied along the animation's own direction vector
    const dx = a.dir.x*ox - a.dir.y*oy;
    const dy = a.dir.y*ox + a.dir.x*oy;
    if(!pose) pose = {ox:0, oy:0, sx:1, sy:1, rot:0};
    pose.ox += dx;
    pose.oy += dy;
    pose.sx *= (p.sx||1);
    pose.sy *= (p.sy||1);
    pose.rot += (p.rot||0);
  }
  return pose;
}

/** World-space FX, drawn after the sprites so reach overlays the body. */
export function drawAnimFX(ctx){
  for(const a of anims){
    const arch = ARCHETYPES[a.kind];
    if(!arch || !arch.fx) continue;
    const o = a.owner;
    if(o.alive === false) continue;
    const r = threeBeat(a.t, a.antEnd, a.strikeEnd);
    arch.fx(ctx, a, o, r);
  }
}

/** Kind of the most recent non-'hit' animation currently playing on an entity (or 'hit'), else null. */
export function activeAnimKind(entity){
  let hit = null;
  for(let i=anims.length-1;i>=0;i--){
    const a = anims[i];
    if(a.owner !== entity) continue;
    if(a.kind === 'hit'){ hit = hit || 'hit'; continue; }
    return a.kind;
  }
  return hit;
}
