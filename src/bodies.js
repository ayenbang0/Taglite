import { RADIUS } from './config.js';
import { state } from './state.js';
import { resolveWalls } from './arena.js';
import { applyStagger } from './physics.js';
import { playAnim } from './anim.js';
import { kickShake } from './feel.js';

/* Soft shoulder-bumps between same-side fighters. Opposing hunter/prey pairs
   are deliberately excluded: tag reach equals contact distance, so they must be
   able to overlap in order to tag. */

export function effectiveMass(e){
  return e.mods.massMult
    * (e.braceT>0 ? 3 : 1)
    * (e.stampedeT>0 ? 2.5 : 1)
    * (e.rushT>0 ? 3 : 1)
    * (e.mods.immovable && e.staticT>=0.5 ? 3 : 1);
}

function bumpable(e){
  return !(e.frozen || e.alive===false || e.intangibleT>0 || e.airT>0 || e.dashIframe>0);
}

export function resolveBodies(dt){
  const list = state.entities;
  const minD = RADIUS*2;
  for(let i=0;i<list.length;i++){
    const a = list[i];
    if(!bumpable(a)) continue;
    for(let j=i+1;j<list.length;j++){
      const b = list[j];
      if(!bumpable(b) || a.hunting !== b.hunting) continue;
      const dx = b.x-a.x, dy = b.y-a.y;
      const d = Math.hypot(dx,dy);
      if(d >= minD || d <= 0.001) continue;
      const nx = dx/d, ny = dy/d;
      const ma = effectiveMass(a), mb = effectiveMass(b);
      const overlap = minD - d;
      a.x -= nx*overlap*mb/(ma+mb); a.y -= ny*overlap*mb/(ma+mb);
      b.x += nx*overlap*ma/(ma+mb); b.y += ny*overlap*ma/(ma+mb);

      const cs = (a.vx-b.vx)*nx + (a.vy-b.vy)*ny;   // closing speed
      if(cs > 0){
        const power = Math.sqrt(a.mods.bumpPowerMult * b.mods.bumpPowerMult);
        const j2 = (1+0.45)*cs/(1/ma + 1/mb)*power;
        a.vx -= nx*j2/ma; a.vy -= ny*j2/ma;
        b.vx += nx*j2/mb; b.vy += ny*j2/mb;
        if(cs > 140){
          playAnim('hit', a, {x:-nx,y:-ny});
          playAnim('hit', b, {x:nx,y:ny});
          kickShake(1, 0.1);
          // BULLY: the heavier side's bump staggers the lighter one
          if(ma>mb && a.mods.bully) applyStagger(b, 0.4);
          else if(mb>ma && b.mods.bully) applyStagger(a, 0.4);
        }
      }
      resolveWalls(a); resolveWalls(b);
    }
  }
}
