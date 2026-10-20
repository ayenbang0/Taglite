import '@fontsource/press-start-2p';
import '@fontsource/vt323';
import { MAX_ACTIVE_SLOTS, IW, IH } from './config.js';
import { state } from './state.js';
import { loadAccount } from './progression.js';
import { renderClassGrid, refreshLevelBadge, showScreen, getSelectedClass } from './ui.js';
import { startRun } from './run.js';
import { startDuel, devStep } from './round.js';
import { initTargeting } from './targeting.js';
import { canvas } from './render.js';

/* =========================================================================
   BOOT
   ========================================================================= */
loadAccount();
renderClassGrid();
refreshLevelBadge();
initTargeting(canvas);

/** Integer-multiple canvas scale so the 640x400 pixel grid never shimmers. */
function fitCanvas(){
  const maxW = window.innerWidth*0.96, maxH = (window.innerHeight - 48)*(IW/IH);
  const fit = Math.min(maxW, maxH);
  // integer multiples keep the pixel grid crisp; below 2x they'd waste too much of the window
  const raw = fit/IW;
  const scale = raw >= 2 ? Math.floor(raw) : raw;
  const w = Math.round(IW*scale);
  canvas.style.width = w + 'px';
  canvas.style.height = Math.round(IH*scale) + 'px';
  document.documentElement.style.setProperty('--ui', String(w/960));
}
fitCanvas();
window.addEventListener('resize', fitCanvas);

document.getElementById('btn-start').onclick = ()=>{
  startRun(getSelectedClass());
  startDuel();
};
document.getElementById('btn-menu').onclick = ()=>{
  if(state.rafId) cancelAnimationFrame(state.rafId);
  state.rafId = null;
  state.round = null;
  refreshLevelBadge();
  renderClassGrid();
  showScreen('screen-menu');
};
document.getElementById('btn-again').onclick = ()=>{
  startRun(state.run ? state.run.clsKey : getSelectedClass());
  startDuel();
};

/* =========================================================================
   INPUT
   ========================================================================= */
window.addEventListener('keydown', e=>{
  const k = e.key.toLowerCase();
  state.keys[k] = true;
  if(k===' '){ state.dashPressed = true; e.preventDefault(); }
  if(k==='e'){ state.abilityPressed = true; }
  if(k==='escape'){ state.aim.cancel = true; }
  // drafted actives bind to 1-4
  const n = parseInt(k,10);
  if(!isNaN(n) && n>=1 && n<=MAX_ACTIVE_SLOTS) state.slotPressed[n-1] = true;
});
window.addEventListener('keyup', e=>{
  state.keys[e.key.toLowerCase()] = false;
});
window.addEventListener('blur', ()=>{ state.keys={}; });

/* =========================================================================
   DEV HOOK
   Exposed only under `vite dev` (stripped from production builds) so the
   game can be driven from the console while testing the run loop.
   ========================================================================= */
if(import.meta.env && import.meta.env.DEV){
  const setup = ({cls='rogue', duel=1, abilities=[], passives=[], artifacts=[]} = {})=>{
    startRun(cls);
    Object.assign(state.run.player, {abilities, passives, artifacts});
    state.run.duel = duel;
    startDuel();
  };
  const sim = (seconds)=>{
    const n = Math.round(seconds*60);
    for(let i=0;i<n;i++) devStep(1/60);
    return {ok:true};
  };
  window.__taglite = { state, devStep, setup, sim };
}
