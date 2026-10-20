/* =========================================================================
   CLICK-TO-TARGET LAYER  (DESIGN.md section 3)
   TAGLITE was keyboard-only; aimed abilities need a world-space point.

   Flow: press the ability's key -> if it's aimed, the ability becomes ARMED
   and a reticle + range ring draw in-world -> left-click fires at the cursor
   -> right-click or Escape cancels. Non-aimed abilities fire immediately on
   keypress and never arm.
   ========================================================================= */
import { IW, IH, CLASSES } from './config.js';
import { len, clamp } from './math.js';
import { ABILITY_BY_ID } from './abilities.js';
import { state } from './state.js';
import { screenToWorld } from './iso.js';

/** Wire canvas mouse events. Called once from main.js. */
export function initTargeting(canvas){
  canvas.addEventListener('mousemove', ev=>{
    const r = canvas.getBoundingClientRect();
    // the canvas renders at IWxIH internally but is displayed scaled up
    const cx = (ev.clientX - r.left) * (IW / r.width);
    const cy = (ev.clientY - r.top)  * (IH / r.height);
    state.aim.mouse.x = clamp(cx, 0, IW);
    state.aim.mouse.y = clamp(cy, 0, IH);
    const w = screenToWorld(state.aim.mouse.x, state.aim.mouse.y);
    state.aim.world.x = w.x;
    state.aim.world.y = w.y;
  });
  canvas.addEventListener('mousedown', ev=>{
    if(ev.button===0) state.aim.clicked = true;
    if(ev.button===2) state.aim.cancel = true;
  });
  canvas.addEventListener('contextmenu', ev=>{ ev.preventDefault(); });
}

/** Is a given ability source aimed? source = {kind:'class'} | {kind:'slot', slot:n} */
export function isAimed(e, source){
  if(source.kind==='class') return !!CLASSES[e.clsKey].aimed;
  const id = e.build.abilities[source.slot];
  const def = id && ABILITY_BY_ID[id];
  return !!(def && def.aimed);
}

export function aimRange(e, source){
  if(source.kind==='class') return CLASSES[e.clsKey].abilityRange || 150;
  const id = e.build.abilities[source.slot];
  const def = id && ABILITY_BY_ID[id];
  return (def && def.range) || 150;
}

export function arm(source){ state.aim.armed = source; }
export function disarm(){ state.aim.armed = null; }

/** The current cursor point, clamped to the caster's ability range. */
export function aimPoint(e, range){
  const dx = state.aim.world.x - e.x;
  const dy = state.aim.world.y - e.y;
  const d = len(dx,dy);
  if(d <= range || d === 0) return {x:state.aim.world.x, y:state.aim.world.y};
  return {x: e.x + (dx/d)*range, y: e.y + (dy/d)*range};
}

/**
 * The bot doesn't use a cursor - it solves for a point analytically, reusing
 * the same lead-prediction the chase AI already does.
 */
export function botAimPoint(bot, target, source){
  const range = aimRange(bot, source);
  const lead = 0.18;
  const tx = target.x + target.vx*lead;
  const ty = target.y + target.vy*lead;
  const dx = tx-bot.x, dy = ty-bot.y;
  const d = len(dx,dy);
  if(d <= range || d === 0) return {x:tx, y:ty};
  return {x: bot.x + (dx/d)*range, y: bot.y + (dy/d)*range};
}
