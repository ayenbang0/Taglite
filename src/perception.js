/* =========================================================================
   AI PERCEPTION
   Bots never read a true position. They hold a BELIEF about where their
   quarry is, fed by exactly two sources - the same two the player has:

     1. Line of sight, when the target is close enough and not concealed.
     2. The periodic directional ping, which gives a BEARING and no distance.

   Between updates the belief drifts and decays, so a bot that loses you
   commits to a stale guess and can be baited. This is what makes stealth,
   smoke, camouflage and decoys actually worth drafting.
   ========================================================================= */
import { RADIUS, WORLD_W, WORLD_H, PING_INTERVAL_TAGGER, PING_INTERVAL_RUNNER } from './config.js';
import { len, norm, clamp, dist } from './math.js';
import { segmentBlocked } from './arena.js';

const VISION_RANGE = 175;      // how far a bot can genuinely see
const STEALTH_RANGE = 42;      // concealment fails inside this bubble

/** Can `observer` actually see `target` right now? */
export function canSee(observer, target){
  if(!target) return false;
  if(target.alive === false) return false;
  const d = dist(observer, target);
  const range = VISION_RANGE + (observer.mods ? observer.mods.revealRangeBonus : 0);
  if(d > range) return false;
  if(segmentBlocked(observer.x, observer.y, target.x, target.y)) return false;

  // marks and sprung traps defeat every form of concealment
  if(target.markedT > 0 || target.revealedByTrapT > 0) return true;
  if(target.intangibleT > 0 && d > STEALTH_RANGE) return false;

  const concealed =
    target.invisT > 0 ||
    target.smokeT > 0 ||
    (target.mods && target.mods.camouflage && target.staticT >= 2);
  if(concealed && d > STEALTH_RANGE) return false;
  return true;
}

function pingInterval(bot){
  // hunters get refreshed more often than prey, exactly like the player's HUD ping
  return bot.hunting ? PING_INTERVAL_TAGGER : PING_INTERVAL_RUNNER;
}

/**
 * A ping gives a bearing only - never a distance. The bot projects along that
 * bearing using its own (wrong) distance estimate, so error compounds the
 * longer it goes without a clean look.
 */
function applyPing(bot, target, skill){
  const trueBearing = Math.atan2(target.y - bot.y, target.x - bot.x);
  const spread = 0.45 * (1 - skill) + 0.08;          // radians of bearing error
  const bearing = trueBearing + (Math.random()*2 - 1) * spread;

  const prev = bot.belief;
  let est = prev ? len(prev.x - bot.x, prev.y - bot.y) : 280;
  est *= 0.7 + Math.random()*0.6;                     // the distance is a guess
  est = clamp(est, 70, 620);

  bot.belief = {
    x: clamp(bot.x + Math.cos(bearing)*est, RADIUS, WORLD_W - RADIUS),
    y: clamp(bot.y + Math.sin(bearing)*est, RADIUS, WORLD_H - RADIUS),
    vx: 0, vy: 0,
    confidence: 0.5 + 0.2*skill,
    fresh: false,
  };
}

/** Belief goes stale: it coasts along the last known heading and decays. */
function decayBelief(bot, dt){
  const b = bot.belief;
  if(!b) return;
  b.x = clamp(b.x + b.vx*dt, RADIUS, WORLD_W - RADIUS);
  b.y = clamp(b.y + b.vy*dt, RADIUS, WORLD_H - RADIUS);
  b.vx *= 0.96; b.vy *= 0.96;
  b.confidence = Math.max(0, b.confidence - dt*0.22);
  b.fresh = false;
}

/**
 * Refresh `bot.belief` for this frame.
 * Returns true if the bot currently has eyes on its quarry.
 */
export function updatePerception(bot, dt, skill){
  const q = bot.quarry;
  bot.pingT -= dt;

  if(!q){ decayBelief(bot, dt); return false; }

  if(canSee(bot, q)){
    // direct sight: exact, and it also resets the ping cadence
    bot.belief = {
      x:q.x, y:q.y, vx:q.vx||0, vy:q.vy||0,
      confidence:1, fresh:true,
    };
    bot.pingT = pingInterval(bot);
    return true;
  }

  if(bot.pingT <= 0){
    bot.pingT = pingInterval(bot);
    applyPing(bot, q, skill);
    return false;
  }

  decayBelief(bot, dt);
  return false;
}

/* =========================================================================
   QUARRY SELECTION
   Decoys are indistinguishable from real fighters to a bot that hasn't had a
   good look. It picks one, then COMMITS - chasing it for a couple of seconds
   rather than re-evaluating every frame, which is what makes a decoy actually
   buy the player time.
   ========================================================================= */
function nearestTo(bot, list){
  let best=null, bd=Infinity;
  for(const c of list){
    const d = dist(bot,c);
    if(d<bd){ bd=d; best=c; }
  }
  return best;
}

export function chooseQuarry(bot, candidates, skill){
  if(!candidates.length) return null;
  const visible = candidates.filter(c => canSee(bot,c));
  const pool = visible.length ? visible : candidates;

  const decoys = pool.filter(c => c.isDecoy);
  const reals  = pool.filter(c => !c.isDecoy);

  if(decoys.length && reals.length){
    // low-skill bots are badly fooled; even a maxed-out bot bites sometimes
    const foolChance = 0.62*(1-skill) + 0.18;
    if(Math.random() < foolChance){
      return decoys[Math.floor(Math.random()*decoys.length)];
    }
    return nearestTo(bot, reals);
  }
  if(decoys.length && !reals.length) return nearestTo(bot, decoys);
  return nearestTo(bot, pool);
}

/** How long a bot sticks with a chosen quarry before reconsidering. */
export function commitTime(skill){
  // sharper bots re-evaluate sooner, but everyone follows through for a beat
  return 1.4 + Math.random()*1.8 - skill*0.5;
}
