import { CLASSES, MAX_ACTIVE_SLOTS, CLASS_UNLOCK_LEVEL } from './config.js';
import { ABILITY_BY_ID } from './abilities.js';
import { PASSIVE_BY_ID } from './passives.js';
import { RARE_BY_ID, ARTIFACT_SETS } from './pickups.js';
import { RARITY } from './rarity.js';
import { optionInfo } from './draft.js';
import { isClassUnlocked, xpProgress, nextUnlockHint } from './progression.js';
import { modeForDuel, nextModeLabel } from './modes.js';
import { state } from './state.js';
import { iconCanvas } from './icons.js';
import { previewSprite } from './voxelmodels.js';
import { tint } from './voxel.js';

let selectedClass = 'rogue';
export function getSelectedClass(){ return selectedClass; }

/* =========================================================================
   CLASS SELECT
   ========================================================================= */
/* ---- class-card turntables: ONE shared interval repaints every preview canvas ----
   idle frames animate at ~4.4 fps; the facing advances every second tick (450ms). */
const TURN_TICK_MS = 225;
let previews = [];          // { canvas, key, color, locked }
let turnTick = 0;
let turnTimer = null;
const silhouetteCache = new Map();

function silhouetteOf(spr, id, facing, frame){
  const k = `${id}|${facing}|${frame}`;
  let c = silhouetteCache.get(k);
  if(!c){ c = tint(spr.canvas, '#5a6385', 0.85); silhouetteCache.set(k, c); }
  return c;
}

function paintPreview(p){
  const ctx = p.canvas.getContext('2d');
  const W = p.canvas.width, H = p.canvas.height;
  const facing = Math.floor(turnTick/2) % 4;
  const frame = 'idle' + (turnTick % 4);
  const spr = previewSprite(p.key, facing, frame);
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, W, H);
  // pixel ground disc under the footprint centre
  const gx = W>>1, gy = H - 12;
  ctx.fillStyle = p.locked ? '#1b2036' : p.color;
  ctx.globalAlpha = p.locked ? 1 : 0.28;
  for(let k=-4;k<=4;k++){
    const w = Math.round(17*Math.sqrt(1 - (k*k)/25));
    ctx.fillRect(gx-w, gy+k, w*2, 1);
  }
  ctx.globalAlpha = 1;
  const img = p.locked ? silhouetteOf(spr, p.key, facing, frame) : spr.canvas;
  ctx.drawImage(img, Math.round(gx - spr.ax), Math.round(gy - spr.ay));
}

function ensureTurntable(){
  if(turnTimer) return;
  turnTimer = setInterval(()=>{
    if(!previews.length) return;
    const menu = document.getElementById('screen-menu');
    if(!menu || !menu.classList.contains('active')) return;
    turnTick++;
    for(const p of previews) paintPreview(p);
  }, TURN_TICK_MS);
}

export function renderClassGrid(){
  const grid = document.getElementById('class-grid');
  grid.innerHTML = '';
  previews = [];
  Object.values(CLASSES).forEach(c=>{
    const unlocked = isClassUnlocked(c.key);
    const card = document.createElement('div');
    card.className = 'class-card'
      + (selectedClass===c.key && unlocked ? ' selected':'')
      + (unlocked ? '' : ' locked');
    card.style.setProperty('--card-color', c.color);
    card.innerHTML = unlocked ? `
      <div class="chead">
        <canvas class="preview" width="48" height="64"></canvas>
        <div class="cmeta">
          <div class="cname">${c.name}</div>
          <div class="cdiff">${c.difficulty}</div>
          <div class="cline cpassive"><span class="swatch" style="background:${c.color}"></span>${c.passiveLabel}</div>
        </div>
      </div>
      <div class="clabel">ABILITY${c.aimed?' · AIMED ◎':''}</div>
      <div class="cline">${c.abilityName} &mdash; ${c.abilityLabel}</div>
      <div class="cflavor">${c.flavor}</div>
    ` : `
      <div class="chead">
        <canvas class="preview" width="48" height="64"></canvas>
        <div class="cmeta">
          <div class="cname">${c.name}</div>
          <div class="clocked">UNLOCKS AT LV ${CLASS_UNLOCK_LEVEL[c.key]}</div>
        </div>
      </div>
      <div class="cline">Reach account level ${CLASS_UNLOCK_LEVEL[c.key]} to unlock.</div>
    `;
    if(unlocked) card.onclick = ()=>{ selectedClass = c.key; renderClassGrid(); };
    grid.appendChild(card);
    const p = { canvas:card.querySelector('canvas.preview'), key:c.key, color:c.color, locked:!unlocked };
    previews.push(p);
    paintPreview(p);
  });
  ensureTurntable();
}

export function refreshLevelBadge(){
  const p = xpProgress(state.account.xp);
  document.getElementById('lv-num').textContent = p.lv;
  document.getElementById('xp-num').textContent = `${p.into}/${p.need}`;
  document.getElementById('best-num').textContent = state.account.best || 0;
  document.getElementById('next-unlock').textContent = nextUnlockHint();
}

export function showScreen(id){
  document.querySelectorAll('.screen').forEach(s=>s.classList.remove('active'));
  document.getElementById(id).classList.add('active');
}

/* =========================================================================
   DRAFT SCREEN
   Reuses .class-card so the draft reads as the same component family as
   class select - same bevel, same accent-colour treatment.
   ========================================================================= */
const CAT_COLOR = {
  movement:'#3fe0c5', taginteraction:'#ff5470', zone:'#a8742a', physics:'#9b6bff',
  buff:'#ffd23f', defense:'#8fd6ff', utility:'#ff5ec4', mobility:'#3fe0c5',
  stamina:'#ffd23f', tagrange:'#ff5470', stealth:'#9b6bff', antistealth:'#8fd6ff',
  identity:'#ff9f45', random:'#ff5ec4',
};

export function renderDraft(options, onPick, onReroll, opts){
  const wrap = document.getElementById('draft-options');
  wrap.innerHTML = '';
  options.forEach((opt, idx)=>{
    const info = optionInfo(opt);
    const card = document.createElement('div');
    card.className = `class-card draft-card rar-${info.rarity}`;
    // the card's accent is its RARITY; category shows as a small tag instead
    card.style.setProperty('--card-color', info.color);
    card.style.setProperty('--i', idx);
    const catColor = CAT_COLOR[info.cat] || '#7b83a1';
    card.innerHTML = `
      <div class="dhead">
        <div class="dicon"></div>
        <div class="dtitle">
          <div class="rarity-line">${info.rarityName}</div>
          <div class="cname">${info.name}${info.aimed?' <span class="aim-dot">◎</span>':''}</div>
        </div>
      </div>
      <div class="clabel">${info.meta}
        <span class="cat-tag" style="color:${catColor}">${info.cat.toUpperCase()}</span>
      </div>
      <div class="cline">${info.desc}</div>
      ${info.flavor?`<div class="cflavor">${info.flavor}</div>`:''}
    `;
    card.querySelector('.dicon').appendChild(iconCanvas(opt.kind, opt.id, 80));
    card.onclick = ()=>onPick(opt);
    wrap.appendChild(card);
  });

  const rr = document.getElementById('btn-reroll');
  rr.textContent = `REROLL (${state.run.rerolls})`;
  rr.disabled = state.run.rerolls<=0;
  rr.onclick = onReroll;

  renderBuildStrip('draft-build', state.run.player);

  // a mid-duel pick resumes the same duel; an end-of-duel pick previews what's
  // coming, so you can draft deliberately for the next mode
  const mid = !!(opts && opts.mid);
  const sub = document.getElementById('draft-sub-line');
  sub.innerHTML = mid
    ? `DUEL <b>${state.run.duel}</b> HALFTIME &mdash; TAKE ONE, THEN BACK IN`
    : `DUEL <b>${state.run.duel}</b> CLEARED &mdash; TAKE ONE`;

  const nextEl = document.getElementById('draft-next');
  if(mid){
    nextEl.textContent = '';
    nextEl.style.display = 'none';
  } else {
    const m = modeForDuel(state.run.duel + 1);
    nextEl.textContent = nextModeLabel(state.run.duel);
    nextEl.style.color = m.color;
    nextEl.style.display = 'block';
  }
}

/* Looked up lazily: pickups.js and ui.js import each other, so module-level reads are unsafe. */
function setOfPart(id){ return ARTIFACT_SETS.find(s => s.parts.includes(id)); }

/** Compact "here's your build so far" strip, used on the draft + summary screens. */

function chip(cls, kind, id, label, title, extra=''){
  const el = document.createElement('span');
  el.className = `chip ${cls}`;
  el.title = title;
  el.appendChild(iconCanvas(kind, id, 40));
  const t = document.createElement('span');
  t.className = 'chip-label';
  t.textContent = label;
  el.appendChild(t);
  if(extra){
    const m = document.createElement('i');
    m.className = 'set-pip';
    m.title = extra;
    el.appendChild(m);
  }
  return el;
}

export function renderBuildStrip(elId, build){
  const el = document.getElementById(elId);
  el.innerHTML = '';
  let n = 0;
  for(const id of build.abilities){
    const a = ABILITY_BY_ID[id];
    if(!a) continue;
    const r = RARITY[a.rarity||'common'];
    el.appendChild(chip(`chip-ability rar-${r.key}`, 'ability', id, a.name,
      `${a.name} (${r.name} ACTIVE, ${a.cd}s) \u2014 ${a.desc}`));
    n++;
  }
  const counts = {};
  for(const id of build.passives) counts[id] = (counts[id]||0)+1;
  for(const [id,c] of Object.entries(counts)){
    const p = PASSIVE_BY_ID[id];
    if(!p) continue;
    const r = RARITY[p.rarity||'common'];
    el.appendChild(chip(`chip-passive rar-${r.key}`, 'passive', id, `${p.name}${c>1?` x${c}`:''}`,
      `${p.name} (${r.name} PASSIVE${c>1?` x${c}`:''}) \u2014 ${p.desc}`));
    n++;
  }
  for(const id of build.artifacts){
    const a = RARE_BY_ID[id];
    if(!a) continue;
    const s = setOfPart(id);
    el.appendChild(chip('chip-artifact', 'artifact', id, a.name,
      `${a.name} (ARTIFACT) \u2014 ${a.desc}${s?` \u2014 part of ${s.name}`:''}`, s ? s.name : ''));
    n++;
  }
  // one chip per artifact series you've started
  for(const s of ARTIFACT_SETS){
    const have = s.parts.filter(p => build.artifacts.includes(p)).length;
    if(!have) continue;
    const done = have === s.parts.length;
    const c = document.createElement('span');
    c.className = 'chip chip-set' + (done ? ' done' : '');
    c.title = done ? `${s.name} complete \u2014 ${s.desc}` : `${s.name}: ${have}/${s.parts.length} parts \u2014 ${s.desc}`;
    c.textContent = `${s.name} ${have}/${s.parts.length}`;
    el.appendChild(c);
    n++;
  }
  if(!n){
    const e = document.createElement('span');
    e.className = 'chip chip-empty';
    e.textContent = 'NO PICKS YET';
    el.appendChild(e);
  }
}

/* =========================================================================
   RUN SUMMARY
   ========================================================================= */
export function renderRunSummary(result){
  const run = state.run;
  document.getElementById('end-result').textContent = 'RUN OVER';
  document.getElementById('end-result').className = 'pixel-font lose';
  document.getElementById('end-sub').textContent =
    `${CLASSES[run.clsKey].name} · survived ${result.survived} duel${result.survived===1?'':'s'}`;
  document.getElementById('xp-row').textContent =
    `+${run.xpEarned} XP earned  ·  best run: ${state.account.best||0}`;

  renderBuildStrip('end-build', run.player);

  const log = document.getElementById('run-log');
  log.innerHTML = '';
  run.history.slice().reverse().forEach(h=>{
    const row = document.createElement('div');
    row.className = 'tier' + (h.won?' owned':'');
    row.innerHTML = `
      <div class="tinfo">
        <div class="tname">DUEL ${h.duel} — ${h.won?'WON':'LOST'} as ${h.role.toUpperCase()}</div>
        <div class="tdesc">${h.mode||'CLASSIC'}${h.mods.length?' · '+h.mods.join(', '):''}</div>
      </div>
      <div class="tinfo tright">${h.won? h.timeLeft+'s left' : '—'}</div>
    `;
    log.appendChild(row);
  });
}

/* =========================================================================
   ANNOUNCE
   ========================================================================= */
export function showAnnounce(text){
  const el = document.getElementById('announce');
  el.textContent = text;
  el.classList.add('show');
  state.announceTimer = 2.2;
}
