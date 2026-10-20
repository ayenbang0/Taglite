/* =========================================================================
   MATCH CORE
   A match is: lobby -> N rounds -> results. One peer HOSTS (round.js runs the
   one true simulation there); everyone else is a client. Solo play is the
   same thing with the local human as the only member.

   Per round:  playing -> intermission (result + standings) -> draft (every
   human picks one upgrade at the same time) -> next round.

   UI talks to this module through the exported actions and the `bus` events
   described in local://net-contract.md; `state.match` is the view-model.
   ========================================================================= */
import { CLASSES, REROLL_START, REROLL_EVERY, REROLL_CAP } from './config.js';
import { state } from './state.js';
import { bus } from './bus.js';
import * as net from './net.js';
import { MODES, modeForDuel } from './modes.js';
import { isClassUnlocked, awardXp } from './progression.js';
import { emptyBuildState, computeMods } from './build.js';
import { rollDraft, applyPick } from './draft.js';
import { ABILITY_BY_ID } from './abilities.js';
import { PASSIVE_BY_ID } from './passives.js';
import { startRun, recordDuel, duelXp, endRun, draftForAllAI, rollBotClass } from './run.js';
import { rollMapMods } from './mapmods.js';
import { showScreen, renderDraft, getSelectedClass } from './ui.js';
import { relay, feed } from './relay.js';
import {
  hostOnInput, hostForgetPeer, hostSendFullTo,
  clientOnSnap, clientReset, clientStop, dispatchEvent,
} from './netsync.js';
import { startRound, startRoundClient, stopRound, playerLeft } from './round.js';

const PROTO = 3;
const MAX_PLAYERS = 8;
const INTERMISSION_MS = 5500;
const DRAFT_MS = 20000;
const NAME_KEY = 'taglite.name';
const BOT_NAMES = ['PIP','NOVA','ROOK','JINX','MOCHI','VEX','ZED','KIRA','BOLT','FIZZ'];
const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

/* ------------------------------------------------------------------ *
 * name + helpers
 * ------------------------------------------------------------------ */
export function setName(n){
  const clean = String(n || '').toUpperCase().replace(/[^A-Z0-9 _-]/g, '').trim().slice(0, 12);
  if(clean) localStorage.setItem(NAME_KEY, clean);
  return clean;
}
export function getName(){
  let n = localStorage.getItem(NAME_KEY);
  if(!n){ n = 'RUNNER-' + (100 + Math.floor(Math.random()*900)); localStorage.setItem(NAME_KEY, n); }
  return n;
}

function genCode(){
  let c = '';
  for(let i=0;i<5;i++) c += CODE_CHARS[Math.floor(Math.random()*CODE_CHARS.length)];
  return c;
}

const M = () => state.match;
const meId = () => (M() && M().me);
const isHost = () => !!M() && (M().role === 'host' || M().role === 'solo');
const player = pid => M() && M().players.find(p => p.pid === pid);

function newPlayer(pid, name, clsKey, host){
  return {
    pid, name, clsKey, ready: !!host, isHost: !!host, connected: true,
    score: 0, wins: 0, tags: 0,
    build: emptyBuildState(),     // host-side truth; never broadcast
  };
}

function defaultSettings(){
  return {mode:'classic', rounds:MODES.classic.online.defaultRounds, bots:true, botSkill:'normal', public:false};
}

/** The broadcast-safe projection of the match. */
function view(){
  const m = M();
  return {
    code: m.code, phase: m.phase, settings: m.settings,
    players: m.players.map(({build, ...p}) => p),
    round: m.round, totalRounds: m.totalRounds, modeKey: m.modeKey, teams: m.teams,
    roundResult: m.roundResult, draft: m.draft ? {picked:m.draft.picked, total:m.draft.total} : null,
    results: m.results,
  };
}

function applyView(v){
  const m = M();
  const prevPhase = m.phase;
  m.code = v.code; m.phase = v.phase; m.settings = v.settings;
  m.players = v.players; m.round = v.round; m.totalRounds = v.totalRounds;
  m.modeKey = v.modeKey; m.teams = v.teams || {}; m.roundResult = v.roundResult;
  m.results = v.results;
  if(v.draft){
    m.draft = {deadline: m.draft ? m.draft.deadline : 0, picked: v.draft.picked, total: v.draft.total};
  } else m.draft = null;
  return prevPhase !== m.phase;
}

function broadcast(){
  if(M().role === 'host') net.send('lobby', {v:view()});
  bus.emit('lobby');
}

function setPhase(p){
  M().phase = p;
  bus.emit('phase', {phase:p});
}

function resetMatchView(role, code, clsKey){
  state.match = {
    role, code, phase:'lobby', settings:defaultSettings(),
    players:[], me:net.selfId, round:0, totalRounds:0, modeKey:'classic',
    teams:{}, roundResult:null, draft:null, results:null,
  };
  state.run = null;
  return state.match;
}

/* ------------------------------------------------------------------ *
 * entering / leaving
 * ------------------------------------------------------------------ */
export function createMatch({name, isPublic} = {}){
  leaveQuiet();
  if(name) setName(name);
  const code = genCode();
  const m = resetMatchView('host', code);
  m.settings.public = !!isPublic;
  m.players = [newPlayer(net.selfId, getName(), getSelectedClass(), true)];
  openHostRoom(code);
  updateAdvert();
  bus.emit('joined', {role:'host'});
  bus.emit('lobby');
  return code;
}

function openHostRoom(code){
  net.openGame(code, {
    onPeerJoin: () => {},
    onPeerLeave: hostPeerLeft,
    onMsg: hostOnMsg,
    onInput: hostOnInput,
    onJoinError: () => bus.emit('error', {message:'COULD NOT REACH THE RELAYS'}),
  });
}

let joinTimer = null;

export function joinMatch(code, {name} = {}){
  leaveQuiet();
  code = String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 5);
  if(code.length !== 5){ bus.emit('error', {message:'CODES ARE 5 CHARACTERS'}); return; }
  if(name) setName(name);
  const m = resetMatchView('client', code);
  m.players = [];
  const hello = id => net.send('hello', {name:getName(), cls:getSelectedClass(), v:PROTO}, id);
  net.openGame(code, {
    onPeerJoin: hello,
    onPeerLeave: clientPeerLeft,
    onMsg: clientOnMsg,
    onSnap: clientOnSnap,
    onJoinError: () => failJoin('COULD NOT REACH THE RELAYS'),
  });
  clearTimeout(joinTimer);
  joinTimer = setTimeout(() => {
    if(M() && M().role === 'client' && !M().players.length) failJoin('NO GAME WITH THAT CODE');
  }, 12000);
}

function failJoin(message){
  clearTimeout(joinTimer);
  teardown();
  bus.emit('error', {message});
  bus.emit('left', {reason:message});
}

function leaveQuiet(){
  clearTimeout(joinTimer);
  if(M()) teardown();
}

function teardown(){
  clearTimeout(phaseTimer); phaseTimer = null;
  clearTimeout(draftTimer); draftTimer = null;
  net.advertise(null);
  net.closeGame();
  relay.active = false;
  stopRound();
  clientStop();
  state.match = null;
}

export function leaveMatch(){
  const m = M();
  if(!m){ bus.emit('left', {reason:'LEFT'}); return; }
  if(m.role === 'host') net.send('closed', {reason:'HOST LEFT'});
  else if(m.role === 'client') net.send('bye', {});
  teardown();
  bus.emit('left', {reason:'LEFT'});
}

export function browsePublic(on){
  if(!on){ net.browse(false); return; }
  net.browse(true, list => {
    state.publicGames = list
      .filter(g => g.code !== (M() && M().code))
      .sort((a, b) => a.age - b.age);
    bus.emit('listing');
  });
}

function updateAdvert(){
  const m = M();
  if(m && m.role === 'host' && m.settings.public && m.phase === 'lobby'){
    const host = m.players.find(p => p.isHost);
    net.advertise({
      code: m.code, host: host ? host.name : '?', mode: m.settings.mode, rounds: m.settings.rounds,
      players: m.players.filter(p => p.connected).length, max: MAX_PLAYERS, v: PROTO,
    });
  } else {
    net.advertise(null);
  }
}

/* ------------------------------------------------------------------ *
 * lobby actions
 * ------------------------------------------------------------------ */
export function setMyClass(clsKey){
  const m = M();
  if(!m || !CLASSES[clsKey] || !isClassUnlocked(clsKey)) return;
  if(m.role === 'client'){ net.send('cls', {cls:clsKey}); return; }
  const p = player(m.me);
  if(p){ p.clsKey = clsKey; broadcast(); }
}

export function setReady(ready){
  const m = M();
  if(!m) return;
  if(m.role === 'client'){ net.send('ready', {ready:!!ready}); return; }
  const p = player(m.me);
  if(p){ p.ready = true; broadcast(); }
}

export function setSettings(part){
  const m = M();
  if(!m || m.role !== 'host' || m.phase !== 'lobby') return;
  const s = m.settings;
  if(part.mode && (MODES[part.mode] || part.mode === 'gauntlet') && part.mode !== s.mode){
    s.mode = part.mode;
    s.rounds = part.mode === 'gauntlet' ? 0 : MODES[part.mode].online.defaultRounds;
  }
  if(part.rounds !== undefined && s.mode !== 'gauntlet'){
    const ok = MODES[s.mode].online.rounds;
    if(ok.includes(part.rounds)) s.rounds = part.rounds;
  }
  if(part.bots !== undefined) s.bots = !!part.bots;
  if(part.botSkill && ['easy','normal','hard'].includes(part.botSkill)) s.botSkill = part.botSkill;
  if(part.public !== undefined) s.public = !!part.public;
  updateAdvert();
  broadcast();
}

export function startMatch(){
  const m = M();
  if(!m || m.role !== 'host' || m.phase !== 'lobby') return;
  const humans = m.players.filter(p => p.connected);
  const mode = MODES[m.settings.mode];
  if(!mode){ bus.emit('error', {message:'PICK A MODE'}); return; }
  if(humans.length > mode.online.maxHumans){
    bus.emit('error', {message:`${mode.online.name} FITS ${mode.online.maxHumans} PLAYERS`});
    return;
  }
  if(humans.some(p => !p.ready)){ bus.emit('error', {message:'NOT EVERYONE IS READY'}); return; }
  beginMatch();
}

/** Solo vs bots. `opts` (cls, round, build) lets the dev hook start from a prepared state. */
export function startSolo(kind, opts = {}){
  leaveQuiet();
  const m = resetMatchView('solo', null);
  m.players = [newPlayer(net.selfId, getName(), opts.cls || getSelectedClass(), true)];
  m.settings.mode = kind === 'gauntlet' ? 'gauntlet' : (MODES[kind] ? kind : 'classic');
  m.settings.rounds = m.settings.mode === 'gauntlet' ? 0 : MODES[m.settings.mode].online.defaultRounds;
  bus.emit('joined', {role:'solo'});
  beginMatch(opts);
}

export function rematch(){
  const m = M();
  if(!m || m.phase !== 'results') return;
  if(m.role === 'solo'){ startSolo(m.settings.mode); return; }
  if(m.role !== 'host') return;
  for(const p of m.players){ p.ready = p.isHost; }
  m.results = null; m.roundResult = null; m.draft = null; m.round = 0;
  m.players = m.players.filter(p => p.connected);
  setPhase('lobby');
  updateAdvert();
  broadcast();
}

/* ------------------------------------------------------------------ *
 * HOST: message handling
 * ------------------------------------------------------------------ */
function hostOnMsg(d, peer){
  const m = M();
  if(!m || m.role !== 'host' || !d) return;
  switch(d.t){
    case 'hello': {
      if(d.v !== PROTO){ net.send('deny', {reason:'VERSION MISMATCH - REFRESH THE PAGE'}, peer); return; }
      if(m.phase !== 'lobby'){ net.send('deny', {reason:'MATCH ALREADY IN PROGRESS'}, peer); return; }
      let p = player(peer);
      if(!p){
        if(m.players.filter(x => x.connected).length >= MAX_PLAYERS){ net.send('deny', {reason:'GAME IS FULL'}, peer); return; }
        const name = uniqueName(String(d.name || 'RUNNER').toUpperCase().replace(/[^A-Z0-9 _-]/g, '').slice(0, 12) || 'RUNNER');
        p = newPlayer(peer, name, CLASSES[d.cls] ? d.cls : 'rogue', false);
        m.players.push(p);
      }
      p.connected = true;
      net.send('welcome', {v:view(), pid:peer}, peer);
      broadcast();
      updateAdvert();
      break;
    }
    case 'cls': {
      const p = player(peer);
      if(p && m.phase === 'lobby' && CLASSES[d.cls]){ p.clsKey = d.cls; broadcast(); }
      break;
    }
    case 'ready': {
      const p = player(peer);
      if(p && m.phase === 'lobby'){ p.ready = !!d.ready; broadcast(); }
      break;
    }
    case 'pick': hostOnPick(peer, d.opt, false); break;
    case 'bye': hostPeerLeft(peer); break;
    case 'full': hostSendFullTo(peer); break;
    default: break;
  }
}

function uniqueName(n){
  const taken = new Set(M().players.map(p => p.name));
  if(!taken.has(n)) return n;
  for(let i=2;i<10;i++){ const c = n.slice(0, 10) + i; if(!taken.has(c)) return c; }
  return n + '*';
}

function hostPeerLeft(peer){
  const m = M();
  if(!m || m.role !== 'host') return;
  const p = player(peer);
  if(!p) return;
  hostForgetPeer(peer);
  if(m.phase === 'lobby'){
    m.players = m.players.filter(x => x.pid !== peer);
    updateAdvert();
  } else {
    p.connected = false;
    playerLeft(peer);
    feed(`${p.name} LEFT`, '#9aa3c7');
    if(m.phase === 'draft' && m.draft && !m.draft.picked.includes(peer)){
      m.draft.picked.push(peer);
      checkDraftDone();
    }
    refreshRelay();
  }
  broadcast();
}

function refreshRelay(){
  const m = M();
  relay.active = !!m && m.role === 'host' && m.players.some(p => !p.isHost && p.connected);
}

/* ------------------------------------------------------------------ *
 * CLIENT: message handling
 * ------------------------------------------------------------------ */
function clientOnMsg(d, peer){
  const m = M();
  if(!m || m.role !== 'client' || !d) return;
  switch(d.t){
    case 'welcome': {
      clearTimeout(joinTimer);
      m.me = d.pid || net.selfId;
      applyView(d.v);
      state.run = clientRun(myClass());
      bus.emit('joined', {role:'client'});
      bus.emit('lobby');
      break;
    }
    case 'deny':
      failJoin(d.reason || 'JOIN REFUSED');
      break;
    case 'lobby': {
      if(!m.players.length) return;      // not welcomed yet
      const changed = applyView(d.v);
      if(m.phase === 'lobby') stopRound();
      if(changed) bus.emit('phase', {phase:m.phase});
      if(state.run) state.run.clsKey = myClass();
      bus.emit('lobby');
      break;
    }
    case 'round': clientRoundStart(d); break;
    case 'rend': {
      applyView(d.v);
      setPhase('intermission');
      bus.emit('roundend');
      break;
    }
    case 'draft': clientDraftStart(d); break;
    case 'dprog': {
      if(m.draft){ m.draft.picked = d.picked; bus.emit('draftprog', m.draft); }
      break;
    }
    case 'end': clientEnd(d); break;
    case 'ann': if(relay.localAnnounce) relay.localAnnounce(d.text); break;
    case 'ev': for(const ev of d.list || []) dispatchEvent(ev); break;
    case 'closed': failJoin(d.reason || 'HOST LEFT'); break;
    default: break;
  }
}

function clientPeerLeft(peer){
  const m = M();
  if(!m || m.role !== 'client') return;
  const p = player(peer);
  if(p && p.isHost) failJoin('HOST LEFT');
}

const myPlayer = () => player(meId());
const myClass = () => { const p = myPlayer(); return p ? p.clsKey : getSelectedClass(); };

function clientRun(clsKey){
  return {
    clsKey, duel:1, rerolls:REROLL_START, player:emptyBuildState(),
    aiBuilds:[], aiClasses:[], mods:[], history:[], botTaggerLosses:0, xpEarned:0,
  };
}

function clientRoundStart(d){
  const m = M();
  applyView(d.v);
  m.draft = null;
  const run = state.run || (state.run = clientRun(myClass()));
  run.clsKey = myClass();
  run.duel = m.round;
  if(m.round > 1 && m.round % REROLL_EVERY === 1) run.rerolls = Math.min(REROLL_CAP, run.rerolls + 1);
  clientReset();
  startRoundClient(d.round, net.selfId);
  net.send('full', {});
  setPhase('playing');
}

function clientDraftStart(d){
  const m = M();
  applyView(d.v);
  m.draft = {deadline: Date.now() + d.ms, picked: d.v.draft ? d.v.draft.picked : [], total: d.v.draft ? d.v.draft.total : 1};
  setPhase('draft');
  openLocalDraft(d.depth, d.ms);
  bus.emit('draft', m.draft);
}

function clientEnd(d){
  const m = M();
  applyView(d.v);
  finishResults();
  setPhase('results');
  bus.emit('results', m.results);
}

function finishResults(){
  const m = M();
  const mine = m.results && m.results.standings.find(s => s.pid === m.me);
  if(mine && mine.xp && !(m.role === 'host' || m.role === 'solo')) awardXp(mine.xp);
}

/* ------------------------------------------------------------------ *
 * draft (both sides pick locally; the host owns the authoritative build)
 * ------------------------------------------------------------------ */
let autoPickTimer = null;

function openLocalDraft(depth, ms){
  const run = state.run;
  const roll = () => {
    const mods = state.player && state.player.mods ? state.player.mods : computeMods(run.clsKey, run.player, false);
    const options = rollDraft(run.player, mods, depth);
    if(!options.length){ submitPick(null); return; }
    clearTimeout(autoPickTimer);
    autoPickTimer = setTimeout(() => {
      // time's up: take the first card rather than stalling everyone
      if(M() && M().phase === 'draft'){ applyPick(run.player, options[0]); submitPick(options[0]); }
    }, Math.max(1000, ms - 600));
    renderDraft(options, opt => {
      clearTimeout(autoPickTimer);
      applyPick(run.player, opt);
      submitPick(opt);
    }, () => {
      if(run.rerolls > 0){ run.rerolls--; roll(); }
    });
  };
  roll();
  const title = document.getElementById('draft-result');
  if(title) title.textContent = 'PICK AN UPGRADE';
  showScreen('screen-draft');
}

function submitPick(opt){
  const m = M();
  if(!m) return;
  const slim = opt ? {kind:opt.kind, id:opt.id} : null;
  if(m.role === 'client') net.send('pick', {opt:slim});
  else hostOnPick(m.me, slim, true);
  // the card stays up until the host moves everyone on
  const grid = document.getElementById('draft-options');
  if(grid) grid.classList.add('picked');
}

function hostOnPick(pid, opt, alreadyApplied){
  const m = M();
  if(!m || m.phase !== 'draft' || !m.draft || m.draft.picked.includes(pid)) return;
  const p = player(pid);
  if(!p) return;
  if(opt && !alreadyApplied){
    const def = opt.kind === 'ability' ? ABILITY_BY_ID[opt.id] : (opt.kind === 'passive' ? PASSIVE_BY_ID[opt.id] : null);
    const dup = p.build.abilities.includes(opt.id) || p.build.passives.includes(opt.id);
    if(def && !dup) applyPick(p.build, opt);
  }
  m.draft.picked.push(pid);
  net.send('dprog', {picked:m.draft.picked});
  bus.emit('draftprog', m.draft);
  checkDraftDone();
}

function checkDraftDone(){
  const m = M();
  if(!m || m.phase !== 'draft' || !m.draft) return;
  const waiting = m.players.filter(p => p.connected && !m.draft.picked.includes(p.pid));
  if(!waiting.length){
    clearTimeout(draftTimer); draftTimer = null;
    // a beat so the last pick registers on screen
    phaseTimer = setTimeout(beginRound, 700);
  }
}

/* ------------------------------------------------------------------ *
 * HOST: match + round flow
 * ------------------------------------------------------------------ */
let phaseTimer = null;
let draftTimer = null;

function beginMatch(opts = {}){
  const m = M();
  const s = m.settings;
  const gaunt = s.mode === 'gauntlet';
  m.round = Math.max(0, (opts.round || 1) - 1);
  m.totalRounds = gaunt ? 0 : s.rounds;
  m.results = null; m.roundResult = null; m.draft = null;
  for(const p of m.players){ p.score = 0; p.wins = 0; p.tags = 0; p.build = emptyBuildState(); }

  const host = m.players.find(p => p.isHost);
  const run = startRun(host.clsKey);
  run.player = host.build;            // the host's own build IS the run build
  if(opts.build) Object.assign(host.build, opts.build);
  run.coin = Math.floor(Math.random()*2);
  run.matchId = Math.random().toString(36).slice(2, 8);
  clearTimeout(draftTimer);
  refreshRelay();
  beginRound();
}

function nameForBot(i){ return 'BOT-' + BOT_NAMES[(i + (M().round*3)) % BOT_NAMES.length]; }

function huntingFlags(mode, n, round0, coin){
  const flags = new Array(n).fill(false);
  if(mode.key === 'classic'){
    flags[(round0 + coin) % 2] = true;
  } else if(mode.key === 'freeze'){
    const k = Math.max(mode.split, Math.round(n*3/7));
    for(let i=0;i<k;i++) flags[(round0*k + coin + i) % n] = true;
  } else {
    flags[(round0 + coin) % n] = true;              // zombie patient zero / potato carrier
  }
  return flags;
}

function buildPlan(){
  const m = M(), run = state.run, s = m.settings;
  const gaunt = s.mode === 'gauntlet';
  const mode = gaunt ? modeForDuel(m.round) : MODES[s.mode];
  const humans = m.players.filter(p => p.connected);
  const depth = gaunt ? m.round : 2*m.round - 1;

  let n;
  if(gaunt) n = mode.entities;
  else if(s.bots) n = Math.max(mode.entities, humans.length);
  else n = Math.max(humans.length, 2);

  const slots = humans.map(p => ({
    pid: p.pid, name: p.name, clsKey: p.clsKey, build: p.build,
    ctrl: p.pid === m.me ? 'local' : 'remote',
  }));
  for(let i=0; slots.length < n; i++){
    slots.push({pid:null, name:nameForBot(i), clsKey:run.aiClasses[i % run.aiClasses.length],
      build:run.aiBuilds[i % run.aiBuilds.length], ctrl:'ai'});
  }

  let flags;
  if(gaunt){
    flags = slots.map((_, i) => i < mode.split);
    for(let i=flags.length-1;i>0;i--){ const j = Math.floor(Math.random()*(i+1)); [flags[i],flags[j]] = [flags[j],flags[i]]; }
  } else {
    flags = huntingFlags(mode, slots.length, m.round-1, run.coin);
  }
  slots.forEach((sl, i) => { sl.hunting = flags[i]; sl.team = flags[i] ? mode.teams[0] : mode.teams[1]; });

  const base = {easy:0.15, normal:0.4, hard:0.75}[s.botSkill] || 0.4;
  const skill = gaunt ? Math.min(1, (m.round-1)/12) : Math.min(1, base + (m.round-1)*0.04);
  return {
    mode, depth, entities: slots, skill,
    duration: gaunt ? mode.duration : mode.online.roundTime,
    midDrafts: gaunt,
    seed: Math.floor(Math.random()*1e9),
    remote: humans.some(p => p.pid !== m.me),
  };
}

function beginRound(){
  const m = M();
  if(!m) return;
  clearTimeout(phaseTimer); phaseTimer = null;
  clearTimeout(draftTimer); draftTimer = null;
  const run = state.run;
  m.round++;
  run.duel = m.round;
  const gaunt = m.settings.mode === 'gauntlet';
  const depth = gaunt ? m.round : 2*m.round - 1;
  // from round 2 on, the field re-rolls its kits (the map modifiers re-roll below)
  if(m.round > 1) run.aiClasses = run.aiClasses.map(() => rollBotClass());
  run.mods = rollMapMods(depth);
  if(m.round > 1 && m.round % REROLL_EVERY === 1) run.rerolls = Math.min(REROLL_CAP, run.rerolls + 1);

  refreshRelay();
  const plan = buildPlan();
  m.modeKey = plan.mode.key;
  m.teams = {};
  m.roundResult = null; m.draft = null;
  const payload = startRound(plan);        // builds the world + entities, returns the client description
  for(const e of state.entities) if(e.pid) m.teams[e.pid] = e.team;
  setPhase('playing');
  if(m.role === 'host'){
    net.send('round', {v:view(), round:{...payload, modeKey:plan.mode.key, depth, duration:plan.duration,
      mods:run.mods.map(x => x.name), timer:plan.duration}});
  }
  bus.emit('lobby');
}

/** round.js calls this when a round is decided. */
export function onRoundEnd(outcome){
  const m = M();
  if(!m) return;
  const gaunt = m.settings.mode === 'gauntlet';
  const mode = state.mode;
  const run = state.run;

  const scored = scoreRound(mode, outcome);
  for(const l of scored.lines){
    const p = player(l.pid);
    if(p){ p.score += l.pts; p.tags += l.tags || 0; if(scored.winners.includes(l.pid)) p.wins++; }
  }
  m.roundResult = {
    round: m.round, title: scored.title, subtitle: scored.subtitle,
    winnerTeam: outcome.winnerTeam, winners: scored.winners, lines: scored.lines,
    standings: standings(),
  };

  const me = player(m.me);
  const iWon = scored.winners.includes(m.me);
  if(gaunt){
    recordDuel(run, iWon, state.player ? state.player.role : '', outcome.timeLeft, mode.name);
    const xp = duelXp(run, iWon);
    run.xpEarned += xp;
    awardXp(xp);
    if(!iWon){ return finishMatch(); }
  }

  const last = !gaunt && m.round >= m.totalRounds;
  const clinched = !gaunt && mode.key === 'classic' && shouldClinch();
  setPhase('intermission');
  m.draft = null;
  if(m.role === 'host') net.send('rend', {v:view()});
  bus.emit('roundend');

  phaseTimer = setTimeout(() => {
    if(last || clinched) return finishMatch();
    openDraftPhase();
  }, gaunt ? 2500 : INTERMISSION_MS);
}

function shouldClinch(){
  const m = M();
  const rounds = m.totalRounds;
  const wins = m.players.map(p => p.wins).sort((a, b) => b - a);
  const best = wins[0] || 0, second = wins[1] || 0;
  const left = rounds - m.round;
  return best > second + left;
}

function openDraftPhase(){
  const m = M(), run = state.run;
  const depth = m.settings.mode === 'gauntlet' ? m.round + 1 : 2*(m.round+1) - 1;
  draftForAllAI(run, depth);
  m.draft = {deadline: Date.now() + DRAFT_MS, picked:[], total: m.players.filter(p => p.connected).length};
  m.draft.depth = depth;
  setPhase('draft');
  if(m.role === 'host') net.send('draft', {v:view(), ms:DRAFT_MS, depth});
  openLocalDraft(depth, DRAFT_MS);
  bus.emit('draft', m.draft);
  clearTimeout(draftTimer);
  draftTimer = setTimeout(() => { phaseTimer = setTimeout(beginRound, 300); }, DRAFT_MS + 2500);
  checkDraftDone();
}

function standings(){
  const rows = M().players.map(p => ({
    pid:p.pid, name:p.name, clsKey:p.clsKey, score:p.score, wins:p.wins, tags:p.tags,
    connected:p.connected,
  }));
  rows.sort((a, b) => b.score - a.score || b.wins - a.wins || b.tags - a.tags);
  rows.forEach((r, i) => { r.rank = i + 1; });
  return rows;
}

function finishMatch(){
  const m = M();
  clearTimeout(draftTimer); clearTimeout(phaseTimer);
  const gaunt = m.settings.mode === 'gauntlet';
  const rows = standings();
  let title, subtitle, modeName;
  if(gaunt){
    const survived = Math.max(0, m.round - 1);
    const res = endRun(state.run);
    title = 'RUN OVER';
    subtitle = `ROUNDS WON: ${survived}`;
    modeName = 'SOLO GAUNTLET';
    rows[0].xp = res.xpEarned;
    rows[0].rounds = survived;
  } else {
    const mode = MODES[m.settings.mode];
    modeName = mode.online.name;
    title = rows.length > 1 && rows[0].score === rows[1].score ? 'DRAW' : `${rows[0].name} WINS`;
    subtitle = `${m.round} ROUNDS`;
    rows.forEach(r => {
      r.xp = 60 + m.round*15 + r.score*10 + (r.rank === 1 ? 150 : r.rank === 2 ? 75 : r.rank === 3 ? 40 : 0);
    });
  }
  m.results = {winnerPid: rows[0] ? rows[0].pid : null, standings: rows, modeName, title, subtitle, kind: gaunt ? 'gauntlet' : 'series'};
  const mine = rows.find(r => r.pid === m.me);
  if(mine && mine.xp && !gaunt) awardXp(mine.xp);
  setPhase('results');
  if(m.role === 'host'){ net.send('end', {v:view()}); }
  bus.emit('results', m.results);
  bus.emit('lobby');
}

/* ------------------------------------------------------------------ *
 * scoring
 * ------------------------------------------------------------------ */
function scoreRound(mode, o){
  const humans = o.entities.filter(e => e.pid);
  const nameOf = e => (player(e.pid) || {name:'?'}).name;
  const lines = [];
  const winners = [];
  let title = '', subtitle = '';

  const add = (e, pts, text, tags) => {
    lines.push({pid:e.pid, name:nameOf(e), text, pts, tags: tags || 0});
  };

  if(mode.key === 'potato'){
    const all = o.entities.slice().sort((a, b) => a.carryT - b.carryT);
    const best = all[0];
    for(const e of humans){
      const safe = Math.max(0, o.elapsed - e.carryT);
      let pts = Math.floor(safe/15);
      const won = e === best || e.carryT <= best.carryT + 0.01;
      if(won){ pts += 3; winners.push(e.pid); }
      add(e, pts, `${Math.round(e.carryT)}S HOLDING` + (won ? ' - SAFEST' : ''), e.tags);
    }
    const bn = best.pid ? nameOf(best) : (best.name || 'A BOT');
    title = `${bn} HELD IT LEAST`;
    subtitle = 'POTATO LEFT THE BUILDING';
  } else {
    const winTeam = o.winnerTeam;
    for(const e of humans){
      let pts = 0, text = '';
      const won = e.team === winTeam;
      if(mode.key === 'classic'){
        pts = won ? 3 : 0;
        text = won ? (e.hunting ? 'TAGGED THEM' : 'SURVIVED') : (e.hunting ? 'RAN OUT OF TIME' : 'GOT TAGGED');
      } else if(mode.key === 'zombie'){
        pts = e.converts + (won && e.team === 'survivor' ? 3 : 0) + (won && e.team === 'zombie' ? 2 : 0);
        text = e.team === 'survivor' ? (won ? 'SURVIVED THE HORDE' : 'TURNED') : `${e.converts} CONVERTED`;
        if(e.team === 'zombie' && !won && e.converts) text = `${e.converts} CONVERTED`;
      } else if(mode.key === 'freeze'){
        pts = (won ? 3 : 0) + e.freezes + e.thaws;
        text = `${e.freezes} FROZEN - ${e.thaws} THAWED`;
      }
      if(won) winners.push(e.pid);
      add(e, pts, text, e.tags);
    }
    const label = {tagger:'TAGGERS', runner:'RUNNERS', zombie:'THE HORDE', survivor:'SURVIVORS'}[winTeam] || 'NOBODY';
    title = `${label} WIN`;
    subtitle = mode.online ? mode.online.name : mode.name;
  }
  lines.sort((a, b) => b.pts - a.pts);
  return {lines, winners, title, subtitle};
}

