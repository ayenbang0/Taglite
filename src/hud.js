import { CLASSES, DASH_COOLDOWN, MAX_ACTIVE_SLOTS } from './config.js';
import { clamp } from './math.js';
import { ABILITY_BY_ID } from './abilities.js';
import { RARITY } from './rarity.js';
import { state } from './state.js';
import { iconCanvas, cubeIcon } from './icons.js';

let slotEls = [];
let statusEls = [];
let lastDashPips = '';

/* One entry per status shown in #status-row. `on` decides visibility, `text` the label. */
const sec = t => (t < 10 ? t.toFixed(1) : String(Math.ceil(t)));
const STATUSES = [
  { name:'STUMBLE',   color:'#ff9f45', on:p=>p.stumbleT>0,     text:p=>sec(p.stumbleT) },
  { name:'SLOW',      color:'#a8742a', on:p=>p.slowDebuffT>0,  text:p=>sec(p.slowDebuffT) },
  { name:'CHILL',     color:'#8fd6ff', on:p=>p.chillStacks>0,  text:p=>'x'+p.chillStacks },
  { name:'MARKED',    color:'#ff5470', on:p=>p.markedT>0,      text:p=>sec(p.markedT) },
  { name:'BLIND',     color:'#7b83a1', on:p=>p.blindT>0,       text:p=>sec(p.blindT) },
  { name:'STUN',      color:'#ffd23f', on:p=>p.stunT>0,        text:p=>sec(p.stunT) },
  { name:'SHIELD',    color:'#3fe0c5', on:p=>p.shieldT>0,      text:p=>sec(p.shieldT) },
  { name:'GHOST',     color:'#9b6bff', on:p=>p.intangibleT>0,  text:p=>sec(p.intangibleT) },
  { name:'AIR',       color:'#e9ecf4', on:p=>p.airT>0,         text:p=>sec(p.airT) },
  { name:'COUNTER',   color:'#ff5ec4', on:p=>p.counterT>0,     text:p=>sec(p.counterT) },
  { name:'BRACE',     color:'#7fb069', on:p=>p.braceT>0,       text:p=>sec(p.braceT) },
  { name:'RUSH',      color:'#e0673f', on:p=>p.rushT>0,        text:p=>sec(p.rushT) },
  { name:'STAMPEDE',  color:'#a64b3c', on:p=>p.stampedeT>0,    text:p=>sec(p.stampedeT) },
  { name:'OVERDRIVE', color:'#c7f464', on:p=>p.overdriveT>0,   text:p=>sec(p.overdriveT) },
  { name:'PACER',     color:'#4aa3ff', on:p=>p.pacerT>0,       text:p=>sec(p.pacerT) },
  { name:'GRIP',      color:'#a8a23f', on:p=>p.gripT>0,        text:p=>sec(p.gripT) },
  { name:'FROZEN',    color:'#c9f0ff', on:p=>!!p.frozen,
    text:p=>{
      const m = state.mode;
      return m && m.thawTime ? Math.round(clamp(p.thawProgress/m.thawTime,0,1)*100)+'%' : '';
    } },
];

function buildStatusRow(){
  const row = document.getElementById('status-row');
  row.innerHTML = '';
  statusEls = STATUSES.map(def=>{
    const el = document.createElement('div');
    el.className = 'status';
    el.style.display = 'none';
    el.appendChild(cubeIcon(def.color, 12));
    const name = document.createElement('span');
    name.className = 's-n';
    name.textContent = def.name;
    const t = document.createElement('span');
    t.className = 's-t';
    el.appendChild(name);
    el.appendChild(t);
    row.appendChild(el);
    return { el, t, def, shown:false, label:'' };
  });
}

function setIcon(holderId, canvas){
  const h = document.getElementById(holderId);
  h.innerHTML = '';
  h.appendChild(canvas);
}

/** Rebuild the drafted-ability icons for the current duel. */
export function buildAbilityBar(){
  const wrap = document.getElementById('slot-icons');
  wrap.innerHTML = '';
  slotEls = [];
  const { player } = state;
  const abilities = player.build.abilities;

  // fixed buttons: dash + class signature
  setIcon('ico-dash', iconCanvas('sys', 'dash', 60));
  setIcon('ico-class', iconCanvas('class', player.clsKey, 60));
  const cls = CLASSES[player.clsKey];
  document.getElementById('icon-ability').style.setProperty('--card-color', cls.color);
  document.getElementById('icon-ability').title = `${cls.abilityName} \u2014 ${cls.abilityLabel}`;
  lastDashPips = '';

  for(let i=0;i<abilities.length && i<MAX_ACTIVE_SLOTS;i++){
    const def = ABILITY_BY_ID[abilities[i]];
    if(!def) continue;
    const el = document.createElement('div');
    el.className = 'ability-icon';
    el.style.setProperty('--card-color', RARITY[def.rarity||'common'].color);
    el.innerHTML = `
      <span class="ico"></span>
      <span class="key">${i+1}</span>
      ${def.aimed ? '<span class="aim-dot">◎</span>' : ''}
      <div class="cd-overlay"></div>
      <span class="cd-num"></span>
    `;
    el.querySelector('.ico').appendChild(iconCanvas('ability', def.id, 60));
    el.title = `${def.name} \u2014 ${def.desc}`;
    wrap.appendChild(el);
    slotEls.push({el, overlay:el.querySelector('.cd-overlay'), num:el.querySelector('.cd-num'), def, shown:''});
  }
  buildStatusRow();
}

/** Show ceil(seconds) on an icon, or hide the number at 0. */
function setCdNum(el, secs){
  const txt = secs > 0.001 ? String(Math.ceil(secs)) : '';
  if(el.textContent !== txt) el.textContent = txt;
}

function updateDashPips(player){
  const el = document.getElementById('dash-charges');
  if(player.dashChargesMax > 1){
    const key = player.dashCharges + '/' + player.dashChargesMax;
    if(key !== lastDashPips){
      lastDashPips = key;
      el.innerHTML = '';
      for(let i=0;i<player.dashChargesMax;i++){
        const pip = document.createElement('i');
        pip.className = 'pip' + (i < player.dashCharges ? ' on' : '');
        el.appendChild(pip);
      }
    }
    el.style.display = 'flex';
  } else {
    el.style.display = 'none';
    lastDashPips = '';
  }
}

export function updateHud(){
  const { round, player, run } = state;
  const mm = Math.floor(round.timer/60), ss = Math.floor(round.timer%60);
  const timerEl = document.getElementById('timer');
  timerEl.textContent = `${mm}:${ss.toString().padStart(2,'0')}`;
  timerEl.classList.toggle('low', round.timer<20);

  // dash (with charges)
  const dashPct = clamp(1 - player.dashCd/(DASH_COOLDOWN*player.mods.dashCdMult), 0, 1);
  document.getElementById('cd-dash').style.height = (100-dashPct*100)+'%';
  setCdNum(document.getElementById('cdn-dash'), player.dashCharges<=0 ? player.dashCd : 0);
  updateDashPips(player);

  // class signature ability
  const abilCd = CLASSES[player.clsKey].abilityCooldown;
  let abilPct;
  if(player.clsKey==='scout'){ abilPct = player.stamina/100; }
  else { abilPct = abilCd<=0 ? 1 : clamp(1-player.abilityCd/(abilCd*player.mods.abilityCdMult),0,1); }
  document.getElementById('cd-ability').style.height = (100-abilPct*100)+'%';
  setCdNum(document.getElementById('cdn-ability'), player.clsKey==='scout' ? 0 : player.abilityCd);

  // drafted actives
  for(let i=0;i<slotEls.length;i++){
    const s = slotEls[i];
    const total = s.def.cd * player.mods.abilityCdMult;
    const pct = clamp(1 - player.slotCd[i]/total, 0, 1);
    s.overlay.style.height = (100-pct*100)+'%';
    setCdNum(s.num, player.slotCd[i]);
    s.el.classList.toggle('armed',
      !!(state.aim.armed && state.aim.armed.kind==='slot' && state.aim.armed.slot===i));
  }
  document.getElementById('icon-ability').classList.toggle('armed',
    !!(state.aim.armed && state.aim.armed.kind==='class'));

  if(player.clsKey==='scout'){
    document.getElementById('stamina-bar').style.width = player.stamina+'%';
  }

  // sprint: 10 pips (the pip gaps are a CSS mask over a continuous fill)
  const sprintBar = document.getElementById('sprint-bar');
  const frac = player.sprint/player.sprintMax;
  sprintBar.style.width = (clamp(frac,0,1)*100)+'%';
  sprintBar.classList.toggle('fatigued', player.fatigued);
  // amber once you're into the taper zone, where sprinting stops paying off
  sprintBar.classList.toggle('winded', !player.fatigued && frac < 0.55);
  document.getElementById('sprint-bar-bg').classList.toggle('fatigued', player.fatigued);

  // status row
  for(const s of statusEls){
    const on = s.def.on(player);
    if(on !== s.shown){ s.shown = on; s.el.style.display = on ? 'flex' : 'none'; }
    if(on){
      const label = s.def.text(player);
      if(label !== s.label){ s.label = label; s.t.textContent = label; }
    }
  }

  document.getElementById('duel-num').textContent = run.duel;
  document.getElementById('team-status').textContent = teamStatusLine();

  // frozen players lose their controls, so grey the whole bar out
  document.getElementById('hud-bl').classList.toggle('frozen', !!player.frozen);
}

/** Called at duel start: role banner, duel counter, mode + map modifier tags. */
export function setDuelHeader(){
  const { player, run, mode } = state;
  const banner = document.getElementById('role-banner');
  banner.textContent = player.role.toUpperCase();
  // reuse the existing two banner styles: hunters read danger, prey read safe
  banner.className = 'pixel-font ' + (player.hunting ? 'tagger' : 'runner');

  document.getElementById('stamina-wrap').style.display =
    (player.clsKey==='scout') ? 'block' : 'none';

  const modeEl = document.getElementById('mode-badge');
  modeEl.textContent = mode.name;
  modeEl.style.color = mode.color;
  modeEl.style.display = mode.key==='classic' ? 'none' : 'block';

  const modWrap = document.getElementById('map-mods');
  modWrap.innerHTML = run.mods.map(m=>`<span class="mod-tag">${m.name}</span>`).join('');
}

/** Live side-count for the crowded modes ("3 LEFT", "2/4 FROZEN"). */
function teamStatusLine(){
  const { mode, entities, player } = state;
  if(!mode || mode.key==='classic') return '';
  if(mode.convertOnTag){
    const survivors = entities.filter(e=>e.team==='survivor').length;
    return `${survivors} SURVIVOR${survivors===1?'':'S'} LEFT`;
  }
  if(mode.freezeOnTag){
    const runners = entities.filter(e=>e.team===mode.teams[1]);
    const frozen = runners.filter(e=>e.frozen).length;
    return `${frozen}/${runners.length} FROZEN`;
  }
  return '';
}
