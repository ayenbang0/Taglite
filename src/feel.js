import { WORLD_W, WORLD_H, CAMERA_FOLLOW_RATE, CAMERA_LOOKAHEAD } from './config.js';
import { clamp } from './math.js';
import { state } from './state.js';
import { screenToWorld } from './iso.js';
import { updateFX } from './fx.js';
import { updateAmbient } from './themes.js';

/* Game-feel helpers: screen shake, hit-stop, smoothed camera, and the small
   ambient motion that makes running read as running (footfalls, speed lines). */

export function kickShake(mag, t){
  const s = state.shake;
  if(s.t > 0 && s.mag > mag) return;   // never downgrade a bigger shake in progress
  state.shake = {t, mag};
}

export function hitstop(t){
  state.hitstopT = Math.max(state.hitstopT, t);
}

/** Snap the camera onto the player (duel start). */
export function snapCamera(){
  const p = state.player;
  if(!p) return;
  state.camera.x = clamp(p.x, 0, WORLD_W);
  state.camera.y = clamp(p.y, 0, WORLD_H);
}

/**
 * Camera = the world point at screen centre. Follows the player with a
 * velocity lookahead so you can see where you're headed, then the cursor's
 * world position is refreshed against the new camera.
 */
export function updateCamera(dt){
  const p = state.player;
  const c = state.camera;
  const tx = p.x + p.vx*CAMERA_LOOKAHEAD, ty = p.y + p.vy*CAMERA_LOOKAHEAD;
  const k = 1 - Math.exp(-CAMERA_FOLLOW_RATE*dt);
  c.x = clamp(c.x + (tx - c.x)*k, 0, WORLD_W);
  c.y = clamp(c.y + (ty - c.y)*k, 0, WORLD_H);
  const w = screenToWorld(state.aim.mouse.x, state.aim.mouse.y);
  state.aim.world.x = w.x; state.aim.world.y = w.y;
}

/** Footfall dust, sprint speed lines, stride phase for run animation, shake decay. */
export function updateFeel(dt){
  for(const e of state.entities){
    if(e.alive === false) continue;
    const sp = Math.hypot(e.vx, e.vy);
    e.stepPhase += sp*dt/16;
    if(e.frozen) continue;

    if(sp > 110 && e.airT <= 0){
      e.footT -= dt;
      if(e.footT <= 0){
        e.footT = 0.14;
        state.particles.push({
          x:e.x - (e.vx/sp)*3, y:e.y - (e.vy/sp)*3,
          vx:(Math.random()-0.5)*12, vy:(Math.random()-0.5)*12,
          life:0.3, maxLife:0.3, color:'#6b7390', size:2, z:1,
        });
      }
    }
    if(e.sprintActive && sp > 60){
      e.speedLineT -= dt;
      if(e.speedLineT <= 0){
        e.speedLineT = 0.05;
        state.particles.push({
          x:e.x - (e.vx/sp)*6 + (Math.random()-0.5)*4, y:e.y - (e.vy/sp)*6 + (Math.random()-0.5)*4,
          vx:-e.vx*0.25, vy:-e.vy*0.25,
          life:0.22, maxLife:0.22, color:e.cls.color, size:1, z:4 + Math.random()*6,
        });
      }
    }
  }
  if(state.shake.t > 0) state.shake.t = Math.max(0, state.shake.t - dt);
  updateFX(dt);
  if(state.theme) updateAmbient(state.theme, dt, state.camera, WORLD_W, WORLD_H);
}
