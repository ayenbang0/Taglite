/* =========================================================================
   MATCH HUD
   Scorebar + event feed inside the game screen, and the between-rounds
   intermission overlay. Everything reads the read-only `state.match`
   view-model; the core only has to call updateMatchHud() each frame.
   ========================================================================= */
import { state } from './state.js';
import { bus } from './bus.js';
import { CLASSES } from './config.js';
import { MODES, modeForDuel } from './modes.js';
import { roleIcon, esc } from './pixicons.js';

const $ = id => document.getElementById(id);
const clsColor = key => (CLASSES[key] && CLASSES[key].color) || '#9b6bff';

let barEl, feedEl, gameEl, imEl, imHead, imSub, imRows, imNext;
let sig = '';
let barShown = false;

/* ---------------------------------------------------------------- scorebar */
function modeOf(m){
  const key = m.modeKey || (m.settings && m.settings.mode);
  return MODES[key] || null;
}

/** Cheap enough to call every frame: one string compare unless something changed. */
export function updateMatchHud(){
  const m = state.match;
  if(!m){
    if(barShown){
      barEl.classList.remove('show');
      gameEl.classList.remove('has-match');
      barShown = false;
      sig = '';
    }
    return;
  }
  let s = m.round + '/' + m.totalRounds + '|' + m.modeKey + '|' + m.me;
  for(const p of m.players){
    s += '|' + p.pid + ':' + p.name + ':' + p.clsKey + ':' + p.score + ':' + ((m.teams && m.teams[p.pid]) || '') + ':' + (p.connected === false ? 0 : 1);
  }
  if(s === sig && barShown) return;
  sig = s;

  if(!barShown){
    barEl.classList.add('show');
    gameEl.classList.add('has-match');
    barShown = true;
  }

  const mode = modeOf(m);
  const round = m.totalRounds > 0 ? `R ${m.round}/${m.totalRounds}` : `R ${m.round}`;
  const players = m.players.slice().sort((a, b) => (b.score || 0) - (a.score || 0));
  let html = `<div class="mb-head" style="--c:${mode ? mode.color : '#e9ecf4'}">`
    + `<span class="mb-round">${round}</span><span class="mb-mode">${esc(mode ? mode.name : '')}</span></div>`;
  for(const p of players){
    const team = m.teams && m.teams[p.pid];
    html += `<div class="mb-chip${p.pid === m.me ? ' me' : ''}${p.connected === false ? ' out' : ''}" style="--c:${clsColor(p.clsKey)}">`
      + `<img class="pix mb-role" src="${roleIcon(team)}" alt="" title="${esc(team ? team.toUpperCase() : '')}">`
      + `<span class="mb-name">${esc(p.name)}</span><b class="mb-score">${p.score || 0}</b></div>`;
  }
  barEl.innerHTML = html;
}

/* -------------------------------------------------------------------- feed */
const FEED_MAX = 6;

function onFeed(ev){
  if(!ev || !ev.text) return;
  const line = document.createElement('div');
  line.className = 'feed-line';
  if(ev.color) line.style.setProperty('--fc', ev.color);
  line.textContent = String(ev.text).toUpperCase();
  line.addEventListener('animationend', () => line.remove());
  feedEl.appendChild(line);
  while(feedEl.childElementCount > FEED_MAX) feedEl.firstElementChild.remove();
}

function clearFeed(){ feedEl.textContent = ''; }

/* ------------------------------------------------------------ intermission */
let wantShow = false;
let imTimer = null;
let imCount = 3;

function stopImTimer(){ if(imTimer){ clearInterval(imTimer); imTimer = null; } }

function paintNext(){
  const m = state.match;
  if(!m) return;
  const r = m.roundResult;
  const round = (r && r.round) || m.round;
  if(m.totalRounds > 0 && round >= m.totalRounds){
    imNext.innerHTML = 'FINAL RESULTS NEXT';
    return;
  }
  const next = m.settings.mode === 'gauntlet' ? modeForDuel(round + 1) : MODES[m.settings.mode];
  const name = next ? next.name : '';
  const color = next ? next.color : '#3fe0c5';
  imNext.style.setProperty('--c', color);
  imNext.innerHTML = `NEXT: <b>${esc(name)}</b><br>${imCount > 0 ? `DRAFT IN ${imCount}..` : 'DRAFT...'}`;
}

export function renderIntermission(){
  const m = state.match;
  const r = m && m.roundResult;
  if(!r) return;
  const t = m.teams && m.teams[m.me];
  const win = (r.winnerTeam && t) ? t === r.winnerTeam : null;
  imHead.textContent = r.title || (win === true ? 'ROUND WON' : win === false ? 'ROUND LOST' : 'ROUND OVER');
  imHead.className = 'pixel-font' + (win === true ? ' win' : win === false ? ' lose' : '');
  imSub.textContent = (`ROUND ${r.round || m.round}` + (r.subtitle ? ' - ' + r.subtitle : '')).toUpperCase();

  const lines = new Map();
  for(const l of (r.lines || [])) lines.set(l.pid, l);
  const rows = (r.standings && r.standings.length)
    ? r.standings
    : (r.lines || []).map((l, i) => ({ pid:l.pid, name:l.name, score:l.pts || 0, rank:i + 1 }));
  let html = '';
  rows.forEach((s, i) => {
    const l = lines.get(s.pid);
    const pl = m.players.find(p => p.pid === s.pid);
    const key = s.clsKey || (pl && pl.clsKey);
    const pts = (l && l.pts) || 0;
    html += `<div class="im-row${s.pid === m.me ? ' me' : ''}" style="--c:${clsColor(key)};--i:${i}">`
      + `<span class="im-rank">${s.rank || i + 1}</span>`
      + `<span class="im-name">${esc(s.name || (l && l.name) || '')}</span>`
      + `<span class="im-text">${esc((l && l.text) || '')}</span>`
      + `<span class="im-pts${pts ? '' : ' zero'}">${pts ? '+' + pts : '-'}</span>`
      + `<span class="im-total">${s.score || 0}</span></div>`;
  });
  imRows.innerHTML = html;
  paintNext();
}

function revealIntermission(){
  const m = state.match;
  if(!m || !m.roundResult) return;
  renderIntermission();
  imEl.classList.add('show');
  imCount = 3;
  paintNext();
  stopImTimer();
  imTimer = setInterval(() => {
    imCount = Math.max(0, imCount - 1);
    paintNext();
    if(imCount === 0) stopImTimer();
  }, 1000);
}

function hideIntermission(){
  wantShow = false;
  stopImTimer();
  imEl.classList.remove('show');
}

/* -------------------------------------------------------------------- init */
export function initMatchHud(){
  barEl = $('match-bar'); feedEl = $('match-feed'); gameEl = $('screen-game');
  imEl = $('intermission'); imHead = $('im-head'); imSub = $('im-sub'); imRows = $('im-rows'); imNext = $('im-next');

  bus.on('feed', onFeed);
  bus.on('roundend', () => {
    renderIntermission();
    if(wantShow) revealIntermission();
  });
  bus.on('phase', p => {
    const ph = (p && p.phase) || (state.match && state.match.phase);
    if(ph === 'intermission'){ wantShow = true; revealIntermission(); }
    else hideIntermission();
    if(ph === 'lobby' || ph === 'results') clearFeed();
  });
  bus.on('left', () => { hideIntermission(); clearFeed(); sig = ''; });
}
