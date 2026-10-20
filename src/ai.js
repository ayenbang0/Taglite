import { WORLD_W, WORLD_H, RADIUS, PATH_CELL, CLASSES, MAX_ACTIVE_SLOTS } from './config.js';
import { len, norm, clamp, dist, rotateVec } from './math.js';
import { wallBlocked } from './arena.js';
import { worldToCell, nearestFreeCell, bfsPath } from './pathfinding.js';
import { tryDash, tryClassAbility, trySlotAbility } from './physics.js';
import { ABILITY_BY_ID } from './abilities.js';
import { botAimPoint } from './targeting.js';
import { updatePerception, chooseQuarry, commitTime, canSee } from './perception.js';
import { enemiesOf, alliesOf } from './modes.js';
import { state } from './state.js';

const AI_DIRS = (()=>{
  const arr = [];
  const n = 24;
  for(let i=0;i<n;i++){
    const a = (i/n)*Math.PI*2;
    arr.push({x:Math.cos(a), y:Math.sin(a)});
  }
  return arr;
})();

// checks several distances along each candidate direction so the bot can "see" past a
// long wall and find the way around it, instead of only sampling one point right next to it
const STEER_LOOKS = [16, 32, 55, 82];

function pickSteerDir(e, desired, prevDir){
  let best = null, bestScore = -Infinity;
  for(const d of AI_DIRS){
    let score = d.x*desired.x + d.y*desired.y;
    // continuity bonus: prefer directions close to what it was already doing, so it
    // commits to sliding along a wall instead of flip-flopping every reaction tick
    if(prevDir) score += 0.35*(d.x*prevDir.x + d.y*prevDir.y);
    for(let k=0;k<STEER_LOOKS.length;k++){
      const look = STEER_LOOKS[k];
      const px = e.x + d.x*look, py = e.y + d.y*look;
      if(wallBlocked(px,py)) score -= (1.7 - k*0.32);
    }
    if(score>bestScore){ bestScore=score; best=d; }
  }
  return best || desired;
}

/**
 * Everything a bot may currently be chasing: living enemies, plus every decoy
 * belonging to an enemy. Decoys are deliberately indistinguishable here - the
 * filtering happens in chooseQuarry, which can be fooled.
 */
function candidatesFor(bot){
  const foes = enemiesOf(bot, state.entities).filter(o => !o.frozen);
  const fakes = state.decoys.filter(d => d.owner && d.owner.team !== bot.team);
  return [...foes, ...fakes];
}

function quarryStillValid(bot){
  const q = bot.quarry;
  if(!q) return false;
  if(q.isDecoy) return state.decoys.includes(q);
  return q.alive !== false && !q.frozen && q.team !== bot.team;
}

/** Should this bot detour to thaw a frozen ally? (Freeze Tag) */
function rescueTarget(bot){
  if(!state.mode || !state.mode.freezeOnTag) return null;
  if(bot.hunting || bot.frozen) return null;
  const frozen = alliesOf(bot, state.entities).filter(a => a.frozen);
  if(!frozen.length) return null;
  let best=null, bd=Infinity;
  for(const f of frozen){
    const d = dist(bot,f);
    if(d < bd){ bd = d; best = f; }
  }
  // only worth it if the rescue isn't obviously suicidal
  if(bd > 420) return null;
  const hunterNear = enemiesOf(bot, state.entities)
    .some(h => dist(h, best) < 90);
  if(hunterNear && bd > 140) return null;
  return best;
}

function wantsAbility(bot, def, d){
  const chasing = bot.hunting;
  switch(def.cat){
    case 'movement':
      if(def.id==='a_beacon') return d < 90;
      if(def.id==='a_slide')    return chasing && d>28 && d<100;
      if(def.id==='a_sidestep') return d < 70;
      if(def.id==='a_cleats')   return d < 200;
      if(def.id==='a_hover')    return !chasing ? d < 150 : false;
      if(def.id==='a_stampede') return d < 140;
      return chasing ? d>60 && d<260 : d<120;
    case 'taginteraction':
      if(def.id==='a_brand') return chasing && d < 110;
      if(def.id==='a_pounce')   return chasing && d>25 && d<70;
      if(def.id==='a_lasso')    return chasing && d>40 && d<165;
      if(def.id==='a_beam')  return d > 40 && d < 150;
      return chasing && d < 70;
    case 'zone':
      if(def.id==='a_thunder') return d < 190;
      if(def.id==='a_powderkeg')   return chasing && d < 120;
      if(def.id==='a_springboard') return d>60 && d<200;
      if(def.id==='a_trail')   return !chasing && d < 160;
      return chasing ? d<130 : d<90;
    case 'physics':
      if(def.id==='a_shove')  return d < 85;
      if(def.id==='a_boomerang') return d>40 && d<170;
      if(def.id==='a_ricochet')  return d < 150;
      if(def.id==='a_stomp')     return d < 80;
      if(def.id==='a_frost')  return d < 120;
      return chasing && d>40 && d<170;
    case 'buff':
      if(def.id==='a_overdrive') return d < 220;
      return bot.sprint < bot.sprintMax*0.35;
    case 'defense':
      if(def.id==='a_brace')       return !chasing ? d<60 : d<40;
      if(def.id==='a_orbitblades') return d < 90;
      if(def.id==='a_counter')     return !chasing && d < 90;
      if(def.id==='a_shade') return d < 140;
      return !chasing && d < 110;
    case 'utility':
      if(def.id==='a_dustkick')  return !chasing && d < 130;
      if(def.id==='a_shellgame') return !chasing && d < 100;
      if(def.id==='a_mark') return d < 380;
      if(def.id==='a_magnet') return state.powerups.length>0 && d>100;
      if(def.id==='a_seeker') return d < 260;
      if(def.id==='a_dice') return chasing ? d > 260 : d < 45;
      return d < 200;
    default:
      return d < 150;
  }
}

/**
 * Sprint intent, committed to in bursts.
 *
 * Bots used to almost never sprint: the decision keyed off distance to their
 * BELIEF, which is 9999 when they have no idea where anyone is - so a fleeing
 * bot that had lost track (the exact moment it most needs to run) failed the
 * `d < 200` test and jogged. It's now framed as reasons TO run, and the
 * stamina curve does the rationing: sprinting drains 18->44/s, so anyone who
 * leans on it fatigues and is forced to rest. That produces the bursts.
 */
function decideSprint(bot, dt, d, rescue){
  bot.sprintHoldT -= dt;

  if(bot.sprintHoldT <= 0){
    const frac = bot.sprint / bot.sprintMax;
    const desperate = bot.hunting ? d < 60 : d < 110;
    const hasGas = frac > 0.3 || (desperate && frac > 0.08);

    let want = false;
    if(hasGas){
      if(rescue){
        want = true;                                   // a rescue is always urgent
      } else if(bot.hunting){
        want = d > 30;                                 // close the gap unless already on them
      } else {
        // prey: run when the threat is believed near, AND when it has lost
        // track entirely - a runner who can't see the tagger should be making
        // distance, not strolling
        const lost = !bot.belief || bot.belief.confidence < 0.45;
        want = d < 320 || lost;
      }
    }

    if(want !== bot.sprintWant){
      bot.sprintWant = want;
      // commit to the push (or the breather) so it reads as a decision
      bot.sprintHoldT = want ? (0.7 + Math.random()*0.9) : (0.5 + Math.random()*0.8);
    } else {
      bot.sprintHoldT = 0.25;
    }
  }

  return bot.sprintWant && !bot.fatigued && bot.sprint > 3;
}

/**
 * One bot's think-and-steer for this frame.
 * Returns {x, y, sprint} - a movement intent, not a position.
 */
export function updateAI(bot, dt){
  const botAI = state.botAI;
  const skill = botAI.skill;

  if(bot.frozen){
    bot.aiDir = {x:0,y:0};
    return {x:0, y:0, sprint:false};
  }

  bot.aiThrottle -= dt;
  bot.aiAbilityThrottle -= dt;
  bot.aiSlotThrottle -= dt;
  bot.pathRecalcT -= dt;
  bot.quarryLockT -= dt;
  bot.reactionT -= dt;

  // ---- 1. pick something to chase, and commit to it ----
  if(!quarryStillValid(bot) || bot.quarryLockT <= 0){
    const next = chooseQuarry(bot, candidatesFor(bot), skill);
    if(next !== bot.quarry){
      // a human-ish beat before acting on the new read
      bot.reactionT = botAI.reactionT * (0.8 + Math.random()*0.8);
      bot.belief = null;
      bot.pingT = 0;
    }
    bot.quarry = next;
    bot.quarryLockT = commitTime(skill);
  }

  // ---- 2. update what it BELIEVES about that quarry ----
  const hasEyes = updatePerception(bot, dt, skill);

  // ---- 3. turn belief into a concrete destination ----
  const rescue = rescueTarget(bot);
  const belief = bot.belief;

  if(bot.aiThrottle<=0){
    bot.aiThrottle = botAI.reactionT;
    let targetPoint;

    if(rescue){
      targetPoint = {x:rescue.x, y:rescue.y};      // allies are always visible to their own team
    } else if(!belief){
      // nothing to go on - sweep toward the middle so it doesn't idle in a corner
      targetPoint = {
        x: clamp(WORLD_W/2 + (Math.random()-0.5)*500, RADIUS*2, WORLD_W-RADIUS*2),
        y: clamp(WORLD_H/2 + (Math.random()-0.5)*400, RADIUS*2, WORLD_H-RADIUS*2),
      };
    } else if(bot.hunting){
      const lead = hasEyes ? botAI.predictT : 0;   // only lead a target it can actually watch
      targetPoint = {
        x: clamp(belief.x + belief.vx*lead, RADIUS*2, WORLD_W-RADIUS*2),
        y: clamp(belief.y + belief.vy*lead, RADIUS*2, WORLD_H-RADIUS*2),
      };
    } else {
      // fleeing: run from where it THINKS the threat is, biased off the walls
      let fx = bot.x-belief.x, fy = bot.y-belief.y;
      const dd = len(fx,fy)||1;
      fx/=dd; fy/=dd;
      const margin = 90;
      let ex=0,ey=0;
      if(bot.x<margin) ex += 1;
      if(bot.x>WORLD_W-margin) ex -= 1;
      if(bot.y<margin) ey += 1;
      if(bot.y>WORLD_H-margin) ey -= 1;
      let wx = fx*1.4 + ex*0.9;
      let wy = fy*1.4 + ey*0.9;
      if(dd>170 && state.powerups.length){
        let nearest=null, nd=Infinity;
        for(const p of state.powerups){
          const pd = len(p.x-bot.x,p.y-bot.y);
          if(pd<nd){nd=pd; nearest=p;}
        }
        if(nearest && nd<160){
          const pn = norm(nearest.x-bot.x, nearest.y-bot.y);
          wx += pn.x*0.6; wy += pn.y*0.6;
        }
      }
      const fleeDir = norm(wx,wy);
      targetPoint = {
        x: clamp(bot.x+fleeDir.x*240, RADIUS*2, WORLD_W-RADIUS*2),
        y: clamp(bot.y+fleeDir.y*240, RADIUS*2, WORLD_H-RADIUS*2),
      };
    }
    bot.targetPoint = targetPoint;

    // ---- 4. (re)plan a path toward it ----
    if(bot.pathRecalcT<=0 || !bot.currentPath){
      // stagger recalcs so a 7-entity duel doesn't BFS everyone on one frame
      bot.pathRecalcT = 0.35 + Math.random()*0.25;
      const sc = worldToCell(bot.x,bot.y);
      const tc = worldToCell(targetPoint.x,targetPoint.y);
      const startCell = nearestFreeCell(sc.c,sc.r);
      const endCell = nearestFreeCell(tc.c,tc.r);
      bot.currentPath = bfsPath(startCell.c,startCell.r, endCell.c,endCell.r, 2600);
      bot.pathIdx = 1;
    }

    // ---- 5. steer toward a waypoint a little ahead on the path ----
    let desired;
    if(bot.currentPath && bot.currentPath.length>1){
      bot.pathIdx = Math.min(bot.pathIdx, bot.currentPath.length-1);
      const curWp = bot.currentPath[bot.pathIdx];
      const cwx = curWp.c*PATH_CELL+PATH_CELL/2, cwy = curWp.r*PATH_CELL+PATH_CELL/2;
      if(len(bot.x-cwx, bot.y-cwy) < PATH_CELL*0.7 && bot.pathIdx < bot.currentPath.length-1) bot.pathIdx++;
      const lookIdx = Math.min(bot.pathIdx+2, bot.currentPath.length-1);
      const wp = bot.currentPath[lookIdx];
      const wx2 = wp.c*PATH_CELL+PATH_CELL/2, wy2 = wp.r*PATH_CELL+PATH_CELL/2;
      desired = norm(wx2-bot.x, wy2-bot.y);
    } else {
      desired = norm(targetPoint.x-bot.x, targetPoint.y-bot.y);
    }

    // aim gets sloppier the less certain it is about where the quarry even is
    const uncertainty = belief ? (1 - belief.confidence) : 1;
    const jitter = botAI.jitterDeg + uncertainty*22;
    if(jitter>0.5) desired = rotateVec(desired, (Math.random()*2-1)*jitter);
    bot.aiDir = pickSteerDir(bot, desired, bot.aiDir);
  }

  // distance to what it BELIEVES, not to the truth
  const d = belief ? len(belief.x-bot.x, belief.y-bot.y) : 9999;
  const confident = belief && belief.confidence > 0.75;
  const sprintIntent = decideSprint(bot, dt, d, rescue);

  // still processing what it saw - keep running, but don't act on it yet.
  // (reaction delay gates aiming and abilities, never whether the legs work)
  if(bot.reactionT > 0){
    return {x:bot.aiDir.x, y:bot.aiDir.y, sprint:sprintIntent};
  }

  // ---- dash ----
  if(bot.dashCharges>0){
    if(bot.hunting && confident && d<70 && d>18 && Math.random()<botAI.dashChance){
      tryDash(bot);
    } else if(!bot.hunting && d<55 && Math.random()<botAI.dashChance){
      tryDash(bot);
    } else if(Math.random() < 0.003+0.004*skill){
      tryDash(bot);
    }
  }

  // ---- class signature ability ----
  if(bot.aiAbilityThrottle<=0){
    bot.aiAbilityThrottle = 0.6;
    const cls = CLASSES[bot.clsKey];
    const canAbility = bot.clsKey==='scout' ? bot.stamina>30 && !bot.burstActive : bot.abilityCd<=0;
    if(canAbility && Math.random()<botAI.abilityChance){
      const aimTarget = bot.quarry && !bot.quarry.isDecoy ? bot.quarry : (belief || bot);
      const aim = cls.aimed ? botAimPoint(bot, aimTarget, {kind:'class'}) : null;
      let fire = false;
      if(!bot.hunting){
        if(bot.clsKey==='scout') fire = d<140;
        else if(bot.clsKey==='trapper') fire = d<110;
        else if(bot.clsKey==='phantom') fire = d<90;
        else if(bot.clsKey==='hunter') fire = d<140;
        else if(bot.clsKey==='anchor') fire = d<130;
        else if(bot.clsKey==='brawler') fire = d<60;
        else if(bot.clsKey==='warden') fire = d<70;
        else if(bot.clsKey==='skater') fire = d<110;
        else if(bot.clsKey==='chrono') fire = d<100;
        else fire = d<55;
      } else {
        if(bot.clsKey==='scout') fire = d>90 && d<300;
        else if(bot.clsKey==='hunter') fire = confident && d<145 && d>20;
        else if(bot.clsKey==='anchor') fire = d<160 && d>25;
        else if(bot.clsKey==='trapper') fire = d<70;
        else if(bot.clsKey==='brawler') fire = d<95 && d>30;
        else if(bot.clsKey==='warden') fire = d<80 && d>20;
        else if(bot.clsKey==='skater') fire = d<140 && d>40;
        else if(bot.clsKey==='chrono') fire = d<90 && d>20;
        else fire = d<95 && d>25;
      }
      if(fire) tryClassAbility(bot, bot.quarry && !bot.quarry.isDecoy ? bot.quarry : null, aim);
    }
  }

  // ---- drafted abilities ----
  if(bot.aiSlotThrottle<=0){
    bot.aiSlotThrottle = 0.45;
    for(let s=0; s<Math.min(MAX_ACTIVE_SLOTS, bot.build.abilities.length); s++){
      if(bot.slotCd[s]>0) continue;
      const def = ABILITY_BY_ID[bot.build.abilities[s]];
      if(!def) continue;
      if(!wantsAbility(bot, def, d)) continue;
      if(Math.random() > botAI.abilityChance) continue;
      const aimTarget = bot.quarry && !bot.quarry.isDecoy ? bot.quarry : (belief || bot);
      const aim = def.aimed ? botAimPoint(bot, aimTarget, {kind:'slot', slot:s}) : null;
      const foe = bot.quarry && !bot.quarry.isDecoy ? bot.quarry : null;
      if(trySlotAbility(bot, s, foe, aim)) break;
    }
  }

  if(bot.clsKey==='scout' && bot.burstActive && bot.stamina<=0) bot.burstActive=false;
  if(bot.burstActive){
    if(bot.hunting && d<30) bot.burstActive=false;
    if(!bot.hunting && d>220) bot.burstActive=false;
  }

  return {x:bot.aiDir.x, y:bot.aiDir.y, sprint:sprintIntent};
}
