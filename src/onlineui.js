/* =========================================================================
   ONLINE UI
   Menu entry buttons, online hub, lobby, draft countdown strip and results
   screen. Reads the `state.match` view-model and the bus events; mutates
   match state only through the match.js action API.
   ========================================================================= */
import { state } from './state.js';
import { bus } from './bus.js';
import { CLASSES } from './config.js';
import { MODES, ONLINE_MODES } from './modes.js';
import { isClassUnlocked, xpProgress } from './progression.js';
import {
  showScreen, refreshLevelBadge, renderClassGrid, getSelectedClass, setSelectedClass, setPreviews, renderBuildStrip,
} from './ui.js';
import {
  createMatch, joinMatch, browsePublic, leaveMatch, setMyClass, setReady, setSettings, startMatch,
  startSolo, rematch, setName, getName,
} from './match.js';
import { initMatchHud } from './matchhud.js';
import { pixIcon, esc } from './pixicons.js';

export { updateMatchHud } from './matchhud.js';

const $ = id => document.getElementById(id);
const clsColor = key => (CLASSES[key] && CLASSES[key].color) || '#9b6bff';
const clsName = key => (CLASSES[key] && CLASSES[key].name) || String(key || '').toUpperCase();
const activeScreen = () => { const s = document.querySelector('.screen.active'); return s ? s.id : ''; };
const meOf = m => m.players.find(p => p.pid === m.me);

/* ------------------------------------------------------------------- toast */
let toastTimer = null;
export function showToast(message, kind){
  const el = $('toast');
  el.textContent = String(message || '').toUpperCase();
  el.className = 'pixel-font show' + (kind ? ' ' + kind : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 3800);
}

/* -------------------------------------------------------------- name field */
const cleanName = s => String(s || '').toUpperCase().replace(/[^A-Z0-9 _-]/g, '').slice(0, 12);

/** Persist whatever is in the name box (falling back to the saved name) and return it. */
function commitName(){
  const input = $('name-input');
  const n = cleanName(input.value).trim();
  if(n) setName(n);
  input.value = getName();
  return input.value;
}

/** Typing in an input must never reach the game's window-level key handlers (space is preventDefault'ed there). */
function isolateKeys(el){
  el.addEventListener('keydown', e => e.stopPropagation());
  el.addEventListener('keyup', e => e.stopPropagation());
}

/* ------------------------------------------------------------- menu wiring */
let quickMode = 'classic';

function renderQuickModes(){
  const wrap = $('quick-modes');
  wrap.innerHTML = '';
  for(const mo of ONLINE_MODES){
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'mode-chip' + (mo.key === quickMode ? ' on' : '');
    b.style.setProperty('--c', mo.color);
    b.textContent = mo.name;
    b.title = mo.blurb;
    b.onclick = () => { quickMode = mo.key; renderQuickModes(); };
    wrap.appendChild(b);
  }
}

/* -------------------------------------------------------------- online hub */
let hubOpen = false;
let createPublic = false;
let pending = false;
let pendingTimer = null;

function setPending(on){
  pending = on;
  clearTimeout(pendingTimer);
  if(on) pendingTimer = setTimeout(() => setPending(false), 15000);
  $('btn-create').disabled = on;
  syncJoinButton();
  renderPublicList();
}

function syncJoinButton(){
  $('btn-join').disabled = pending || $('join-code').value.length !== 5;
}

function openHub(){
  hubOpen = true;
  $('online-name').textContent = getName();
  showScreen('screen-online');
  syncJoinButton();
  renderPublicList();
  browsePublic(true);
}

function closeHub(){
  if(!hubOpen) return;
  hubOpen = false;
  browsePublic(false);
}

function tryJoin(code){
  code = String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if(code.length !== 5){ showToast('ROOM CODES ARE 5 CHARACTERS'); return; }
  if(pending) return;
  const name = commitName();
  setPending(true);
  joinMatch(code, { name });
}

function renderPublicList(){
  const list = $('public-list');
  if(!list) return;
  const games = state.publicGames || [];
  if(!games.length){
    list.innerHTML = '<div class="public-empty">NO PUBLIC GAMES - CREATE ONE</div>';
    return;
  }
  list.innerHTML = '';
  for(const g of games){
    const mode = MODES[g.mode];
    const full = g.max > 0 && g.players >= g.max;
    const row = document.createElement('div');
    row.className = 'pub-row';
    row.style.setProperty('--c', mode ? mode.color : '#3fe0c5');
    row.innerHTML = `<div class="pub-main"><div class="pub-host">${esc(g.host)}</div>`
      + `<div class="pub-meta"><b>${esc(mode ? mode.online.name : g.mode)}</b> &middot; ${esc(g.rounds)} ROUNDS &middot; ${esc(g.code)}</div></div>`
      + `<div class="pub-count">${esc(g.players)}/${esc(g.max)}</div>`;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'pixel-btn small';
    btn.textContent = full ? 'FULL' : 'JOIN';
    btn.disabled = full || pending;
    btn.onclick = () => tryJoin(g.code);
    row.appendChild(btn);
    list.appendChild(row);
  }
}

function setToggle(el, on){ el.setAttribute('aria-checked', on ? 'true' : 'false'); }

/* ------------------------------------------------------------------- lobby */
function copyText(text, label){
  const done = () => showToast(label + ' COPIED', 'info');
  const fallback = () => {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;opacity:0;pointer-events:none;';
    document.body.appendChild(ta);
    ta.select();
    try{ document.execCommand('copy'); done(); }catch(err){ showToast('COPY FAILED'); }
    ta.remove();
  };
  if(navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, fallback);
  else fallback();
}

function lobbyIssue(m){
  const mode = ONLINE_MODES.find(x => x.key === m.settings.mode);
  const humans = m.players.length;
  if(mode && humans > mode.maxHumans) return `TOO MANY PLAYERS - ${mode.name} MAX ${mode.maxHumans}`;
  if(!m.settings.bots && humans < 2) return 'NEED 2+ PLAYERS OR TURN BOTS ON';
  const waiting = m.players.filter(p => !p.isHost && !p.ready).length;
  if(waiting) return `WAITING FOR ${waiting} PLAYER${waiting === 1 ? '' : 'S'} TO READY UP`;
  return '';
}

function renderLobbyPlayers(m){
  const mode = ONLINE_MODES.find(x => x.key === m.settings.mode);
  const slots = Math.max(m.players.length, Math.min(8, Math.max(2, mode ? mode.maxHumans : 4)));
  const wrap = $('lobby-players');
  let html = '';
  for(let i = 0; i < slots; i++){
    const p = m.players[i];
    if(!p){ html += '<div class="pcard empty">OPEN</div>'; continue; }
    const lost = p.connected === false;
    html += `<div class="pcard${p.pid === m.me ? ' me' : ''}${lost ? ' lost' : ''}" style="--card-color:${clsColor(p.clsKey)}">`
      + (p.isHost ? `<img class="pix pbadge l" src="${pixIcon('crown', '#ffd23f')}" alt="" title="HOST">` : '')
      + `<div class="pready" title="${p.ready || p.isHost ? 'READY' : 'NOT READY'}">${p.ready || p.isHost ? `<img src="${pixIcon('tick', '#3fe0c5')}" alt="">` : ''}</div>`
      + '<canvas class="preview" width="48" height="64"></canvas>'
      + `<div class="pname">${esc(p.name)}</div>`
      + `<div class="pcls">${lost ? 'DISCONNECTED' : esc(clsName(p.clsKey))}</div></div>`;
  }
  wrap.innerHTML = html;
  const canvases = wrap.querySelectorAll('.pcard:not(.empty) canvas.preview');
  setPreviews('lobby', [...canvases].map((canvas, i) => ({ canvas, key:m.players[i].clsKey, color:clsColor(m.players[i].clsKey), locked:false })));
  $('lobby-count').textContent = `${m.players.length}`;
}

function renderLobbyClasses(m){
  const me = meOf(m);
  const cur = (me && me.clsKey) || getSelectedClass();
  const wrap = $('lobby-classes');
  wrap.innerHTML = '';
  const list = [];
  for(const c of Object.values(CLASSES)){
    if(!isClassUnlocked(c.key)) continue;
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'cpick' + (c.key === cur ? ' on' : '');
    b.style.setProperty('--card-color', c.color);
    b.title = `${c.name} - ${c.abilityName}: ${c.abilityLabel}`;
    b.innerHTML = '<canvas class="preview" width="48" height="64"></canvas>' + `<span>${esc(c.name)}</span>`;
    b.onclick = () => { setSelectedClass(c.key); setMyClass(c.key); };
    wrap.appendChild(b);
    list.push({ canvas:b.querySelector('canvas'), key:c.key, color:c.color, locked:false });
  }
  setPreviews('lobbyPick', list);
}

function segHtml(attr, options, cur, disabled){
  return '<div class="seg">' + options.map(o =>
    `<button type="button" data-${attr}="${esc(o.value)}" class="${String(o.value) === String(cur) ? 'on' : ''}"${disabled ? ' disabled' : ''}>${esc(o.label)}</button>`).join('') + '</div>';
}

function renderLobbySettings(m){
  const host = m.role === 'host';
  const s = m.settings;
  const mode = ONLINE_MODES.find(x => x.key === s.mode) || ONLINE_MODES[0];
  const dis = host ? '' : ' disabled';
  const chips = ONLINE_MODES.map(mo =>
    `<button type="button" class="mode-chip${mo.key === mode.key ? ' on' : ''}" style="--c:${mo.color}" data-mode="${mo.key}"${dis}>${esc(mo.name)}</button>`).join('');
  const hint = mode.minHumans === mode.maxHumans ? `${mode.maxHumans} PLAYERS` : `${mode.minHumans}-${mode.maxHumans} PLAYERS`;
  const el = $('lobby-settings');
  el.innerHTML =
    '<div class="set-label">MODE</div>'
    + `<div class="mode-chips">${chips}</div>`
    + `<div class="mode-info">${esc(mode.blurb)}<span class="mp">${hint}${s.bots ? ' &middot; BOTS FILL THE REST' : ''}</span></div>`
    + '<div class="set-label">ROUNDS</div>'
    + segHtml('rounds', mode.rounds.map(r => ({ value:r, label:String(r) })), s.rounds, !host)
    + `<button type="button" class="toggle" id="tg-bots" role="switch" aria-checked="${s.bots}"${dis}><i></i><span>FILL WITH BOTS</span></button>`
    + '<div class="set-label">BOT SKILL</div>'
    + segHtml('skill', ['easy', 'normal', 'hard'].map(v => ({ value:v, label:v.toUpperCase() })), s.botSkill, !host || !s.bots)
    + `<button type="button" class="toggle" id="tg-public" role="switch" aria-checked="${!!s.public}"${dis}><i></i><span>PUBLIC GAME</span></button>`;
  if(!host) return;
  el.querySelectorAll('[data-mode]').forEach(b => b.onclick = () => {
    const mo = ONLINE_MODES.find(x => x.key === b.dataset.mode);
    setSettings({ mode:mo.key, rounds:mo.rounds.includes(s.rounds) ? s.rounds : mo.defaultRounds });
  });
  el.querySelectorAll('[data-rounds]').forEach(b => b.onclick = () => setSettings({ rounds:Number(b.dataset.rounds) }));
  el.querySelectorAll('[data-skill]').forEach(b => b.onclick = () => setSettings({ botSkill:b.dataset.skill }));
  $('tg-bots').onclick = () => setSettings({ bots:!s.bots });
  $('tg-public').onclick = () => setSettings({ public:!s.public });
}

function renderLobby(){
  const m = state.match;
  if(!m) return;
  const host = m.role === 'host';
  const me = meOf(m);
  const hostP = m.players.find(p => p.isHost);
  $('lobby-code').textContent = m.code || '-----';
  $('lobby-tag').textContent = (m.settings.public ? 'PUBLIC GAME' : 'PRIVATE GAME')
    + (host ? ' \u00b7 YOU ARE HOST' : hostP ? ' \u00b7 HOST: ' + hostP.name.toUpperCase() : '');
  renderLobbyPlayers(m);
  renderLobbyClasses(m);
  renderLobbySettings(m);

  const issue = lobbyIssue(m);
  const ready = $('btn-ready');
  const start = $('btn-start-match');
  ready.style.display = host ? 'none' : '';
  start.style.display = host ? '' : 'none';
  const isReady = !!(me && me.ready);
  ready.textContent = isReady ? 'READY!' : 'READY';
  ready.classList.toggle('ready-on', isReady);
  start.disabled = !!issue;
  $('lobby-hint').textContent = host ? issue : (isReady ? 'WAITING FOR HOST TO START' : 'PRESS READY WHEN YOU ARE SET');
}

/* ------------------------------------------------------------ draft strip */
let draftTimer = null;
let draftDeadline = 0;
let draftDur = 1;

function stopDraftTimer(){ if(draftTimer){ clearInterval(draftTimer); draftTimer = null; } }

function tickDraft(){
  const m = state.match;
  const d = m && m.draft;
  if(!d || !d.deadline){ stopDraftTimer(); return; }
  const rem = Math.max(0, d.deadline - Date.now());
  $('draft-timer-fill').style.width = Math.min(100, rem / draftDur * 100) + '%';
  $('draft-timer-fill').classList.toggle('low', rem < 5000);
  $('draft-timer-secs').textContent = Math.ceil(rem / 1000) + 'S';
}

function updateDraftStrip(){
  const el = $('draft-timer');
  const m = state.match;
  const d = m && m.draft;
  if(!d){ el.classList.remove('show'); stopDraftTimer(); return; }
  el.classList.add('show');
  const picked = (d.picked || []).length;
  $('draft-timer-wait').textContent = picked >= d.total ? 'ALL PICKED' : `WAITING ${picked}/${d.total} PICKED`;
  const timed = !!d.deadline;
  $('draft-timer').querySelector('.dt-bar').style.visibility = timed ? '' : 'hidden';
  $('draft-timer-secs').style.display = timed ? '' : 'none';
  if(!timed){ stopDraftTimer(); return; }
  if(d.deadline !== draftDeadline){
    draftDeadline = d.deadline;
    draftDur = Math.max(1000, d.deadline - Date.now());
  }
  tickDraft();
  if(!draftTimer) draftTimer = setInterval(tickDraft, 100);
}

/* ----------------------------------------------------------------- results */
function renderResults(){
  const m = state.match;
  const r = m && m.results;
  if(!r) return;
  const gaunt = m.settings.mode === 'gauntlet';
  const solo = m.role === 'solo';
  const st = r.standings || [];
  const me = st.find(s => s.pid === m.me);

  const title = $('results-title');
  title.textContent = gaunt ? 'RUN OVER' : (r.winnerPid === m.me ? 'VICTORY!' : 'MATCH OVER');
  title.className = 'pixel-font' + (gaunt ? ' lose' : '');
  const winner = st.find(s => s.pid === r.winnerPid);
  if(gaunt){
    const survived = typeof r.rounds === 'number' ? r.rounds : Math.max(0, (m.round || 1) - 1);
    $('results-sub').textContent = `${me ? clsName(me.clsKey) + ' \u00b7 ' : ''}SURVIVED ${survived} ROUND${survived === 1 ? '' : 'S'}`;
  } else {
    $('results-sub').textContent = `${r.modeName || ''}${winner ? ' \u00b7 ' + winner.name.toUpperCase() + ' WINS' : ''}`.replace(/^ \u00b7 /, '');
  }

  // podium: 2nd | 1st | 3rd
  const pod = $('podium');
  const previews = [];
  if(st.length >= 2){
    const top = st.slice(0, 3);
    const order = top.length === 3 ? [1, 0, 2] : [1, 0];
    const heights = [56, 40, 28];
    pod.style.display = 'flex';
    pod.innerHTML = order.map(i => {
      const s = top[i];
      return `<div class="pod${i === 0 ? ' first' : ''}" style="--c:${clsColor(s.clsKey)};--h:${heights[i]}px">`
        + (i === 0 ? `<img class="pix" width="21" height="21" style="margin-bottom:4px" src="${pixIcon('crown', '#ffd23f')}" alt="">` : '')
        + '<canvas class="preview" width="48" height="64"></canvas>'
        + `<div class="pod-name">${esc(s.name)}</div><div class="pod-cls">${esc(clsName(s.clsKey))}</div>`
        + `<div class="pod-base">#${s.rank || i + 1}<span>${s.score || 0} PTS</span></div></div>`;
    }).join('');
    pod.querySelectorAll('canvas.preview').forEach((canvas, k) => {
      const s = top[order[k]];
      previews.push({ canvas, key:s.clsKey, color:clsColor(s.clsKey), locked:false });
    });
  } else {
    pod.style.display = 'none';
    pod.innerHTML = '';
  }
  setPreviews('results', previews);

  // full standings
  let rows = '<div class="st-row head"><span>#</span><span>NAME</span><span>CLASS</span>'
    + '<span class="st-num">SCORE</span><span class="st-num">WINS</span><span class="st-num">TAGS</span><span class="st-num">XP</span></div>';
  for(const s of st){
    rows += `<div class="st-row${s.pid === m.me ? ' me' : ''}" style="--c:${clsColor(s.clsKey)}">`
      + `<span class="st-rank">${s.rank}</span><span class="st-name">${esc(s.name)}</span><span class="st-cls">${esc(clsName(s.clsKey))}</span>`
      + `<span class="st-num st-score">${s.score || 0}</span><span class="st-num">${s.wins || 0}</span><span class="st-num">${s.tags || 0}</span>`
      + `<span class="st-num st-xp">${s.xp != null ? '+' + s.xp : ''}</span></div>`;
  }
  $('results-table').innerHTML = rows;

  // XP + level
  refreshLevelBadge();
  const prog = xpProgress(state.account.xp);
  $('results-xp').innerHTML = (me && me.xp != null ? `XP <b>+${me.xp}</b> &nbsp;|&nbsp; ` : '')
    + `LV <b>${prog.lv}</b> &nbsp;|&nbsp; XP <b>${prog.into}/${prog.need}</b> &nbsp;|&nbsp; BEST <b>${state.account.best || 0}</b>`;

  // the solo run keeps its build recap
  const build = $('results-build');
  if(state.run && state.run.player){ build.style.display = ''; renderBuildStrip('results-build', state.run.player); }
  else { build.style.display = 'none'; build.innerHTML = ''; }

  // buttons
  const again = $('btn-rematch');
  if(solo){
    again.textContent = gaunt ? 'RUN AGAIN' : 'PLAY AGAIN';
    again.disabled = false;
  } else if(m.role === 'host'){
    again.textContent = 'REMATCH';
    again.disabled = false;
  } else {
    again.textContent = 'WAITING FOR HOST';
    again.disabled = true;
  }
}

/* -------------------------------------------------------------------- init */
export function initOnlineUi(){
  initMatchHud();

  // ---- menu
  const nameInput = $('name-input');
  nameInput.value = getName();
  isolateKeys(nameInput);
  nameInput.addEventListener('input', () => {
    const pos = nameInput.selectionStart;
    nameInput.value = cleanName(nameInput.value);
    nameInput.setSelectionRange(pos, pos);
  });
  nameInput.addEventListener('change', commitName);
  nameInput.addEventListener('blur', commitName);
  nameInput.addEventListener('keydown', e => { if(e.key === 'Enter') nameInput.blur(); });
  renderQuickModes();
  $('btn-online').onclick = () => { commitName(); openHub(); };
  $('btn-solo').onclick = () => { commitName(); startSolo('gauntlet'); };
  $('btn-quick').onclick = () => { commitName(); startSolo(quickMode); };

  // ---- hub
  const codeInput = $('join-code');
  isolateKeys(codeInput);
  codeInput.addEventListener('input', () => {
    codeInput.value = codeInput.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 5);
    syncJoinButton();
  });
  codeInput.addEventListener('keydown', e => { if(e.key === 'Enter' && !$('btn-join').disabled) tryJoin(codeInput.value); });
  $('btn-join').onclick = () => tryJoin(codeInput.value);
  setToggle($('tg-create-public'), createPublic);
  $('tg-create-public').onclick = () => { createPublic = !createPublic; setToggle($('tg-create-public'), createPublic); };
  $('btn-create').onclick = () => {
    if(pending) return;
    const name = commitName();
    setPending(true);
    createMatch({ name, isPublic:createPublic });
  };
  $('btn-online-back').onclick = () => {
    closeHub();
    showScreen('screen-menu');
  };

  // ---- lobby
  $('btn-copy-code').onclick = () => { if(state.match && state.match.code) copyText(state.match.code, 'CODE'); };
  $('btn-copy-link').onclick = () => {
    if(state.match && state.match.code) copyText(location.origin + location.pathname + '?join=' + state.match.code, 'LINK');
  };
  $('btn-lobby-leave').onclick = () => leaveMatch();
  $('btn-ready').onclick = () => {
    const m = state.match;
    const me = m && meOf(m);
    if(me) setReady(!me.ready);
  };
  $('btn-start-match').onclick = () => startMatch();

  // ---- results
  $('btn-results-menu').onclick = () => leaveMatch();
  $('btn-rematch').onclick = () => {
    const m = state.match;
    if(!m) return;
    if(m.role === 'solo') startSolo(m.settings.mode);
    else if(m.role === 'host') rematch();
  };

  // ---- bus
  bus.on('listing', renderPublicList);
  bus.on('error', e => { setPending(false); showToast((e && e.message) || 'SOMETHING WENT WRONG'); });
  bus.on('joined', () => {
    setPending(false);
    closeHub();
    showScreen('screen-lobby');
    setMyClass(getSelectedClass());
    renderLobby();
  });
  bus.on('lobby', () => {
    if(state.match && (state.match.phase === 'lobby' || activeScreen() === 'screen-lobby')) renderLobby();
  });
  bus.on('left', e => {
    setPending(false);
    closeHub();
    stopDraftTimer();
    $('draft-timer').classList.remove('show');
    refreshLevelBadge();
    renderClassGrid();
    showScreen('screen-menu');
    const reason = e && e.reason;
    if(reason && reason !== 'LEFT') showToast(reason);
  });
  bus.on('phase', e => {
    const ph = (e && e.phase) || (state.match && state.match.phase);
    if(ph === 'lobby'){ showScreen('screen-lobby'); renderLobby(); }
    else if(ph === 'results'){ renderResults(); showScreen('screen-results'); }
    if(ph !== 'draft'){ stopDraftTimer(); $('draft-timer').classList.remove('show'); }
  });
  bus.on('draft', updateDraftStrip);
  bus.on('draftprog', updateDraftStrip);
  bus.on('results', () => { renderResults(); showScreen('screen-results'); });

  // ---- ?join=CODE deep link
  const params = new URLSearchParams(location.search);
  if(params.has('join')){
    const code = params.get('join').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 5);
    history.replaceState(null, '', location.pathname + location.hash);
    openHub();
    codeInput.value = code;
    syncJoinButton();
    tryJoin(code);
  }

  if(import.meta.env && import.meta.env.DEV){
    // main.js assigns window.__taglite later in the same tick; merge afterwards.
    setTimeout(() => { window.__taglite = Object.assign(window.__taglite || {}, { bus }); }, 0);
  }
}
