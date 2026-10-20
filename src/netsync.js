/* =========================================================================
   SNAPSHOT SYNC + CLIENT PREDICTION

   HOST    runs the one true simulation (round.js). Every SNAP_MS it ships a
           delta snapshot: per-entity changed fields, the world arrays, newly
           spawned one-shot visuals, queued cosmetic events (relay.js).
   CLIENT  keeps a replica `state` that the unchanged renderer draws:
            - remote fighters are interpolated ~100ms behind the host clock
            - the local fighter is PREDICTED with the same physics the host
              runs, so movement stays sharp; host snapshots nudge it back
              (input sequence acks) instead of snapping
            - abilities are sent as intents and executed on the host
   ========================================================================= */
import { WORLD_W, WORLD_H } from './config.js';
import { state } from './state.js';
import * as net from './net.js';
import { relay, drainEvents } from './relay.js';
import { bus } from './bus.js';
import { makeEntity } from './entity.js';
import { refreshMods } from './build.js';
import { updatePhysics, updateSprint, tryDash } from './physics.js';
import { inputToWorld } from './iso.js';
import { spawnAbilityFX, spawnClassFX, spawnEventFX } from './fx.js';
import { playAnim, updateAnims } from './anim.js';
import { kickShake, updateFeel, updateCamera } from './feel.js';
import { THEME_BY_ID, THEMES, buildDecor } from './themes.js';

const SNAP_MS = 50;           // host snapshot period (20 Hz)
const INPUT_MS = 33;          // client input period (30 Hz)
const INTERP_MS = 110;        // remote render delay
const KEYFRAME_EVERY = 100;   // re-send every field this often (heals any drift)

/* ------------------------------------------------------------------ *
 * shared encoding
 * ------------------------------------------------------------------ */
// Fields that are host-only AI / bookkeeping state: never worth the bandwidth.
const LOCAL_ONLY = new Set([
  'cls','mods','posHistory','posHistoryT','trail','currentPath','pathIdx','pathRecalcT',
  'belief','quarry','quarryLockT','pingT','reactionT','sprintWant','sprintHoldT',
  'aiDir','aiThrottle','aiAbilityThrottle','aiSlotThrottle','brandBy','dashFrom','beamDir',
  'stepPhase','footT','speedLineT','facingIdx','skidCd',
]);
const POS = new Set(['x','y','vx','vy']);
// object-valued entity fields that ARE synced (everything else object-valued is skipped)
const OBJ_FIELDS = new Set(['facing','lastMoveDir','build']);

const r2 = v => Math.round(v*100)/100;

function encVal(v){
  if(typeof v === 'number') return Number.isFinite(v) ? r2(v) : 0;
  if(v === null || typeof v === 'boolean' || typeof v === 'string') return v;
  if(Array.isArray(v)) return v.map(encVal);
  if(typeof v === 'object'){
    const o = {};
    for(const k in v) o[k] = encVal(v[k]);
    return o;
  }
  return undefined;
}

function isEntity(v){ return v && typeof v === 'object' && v.clsKey !== undefined && typeof v.id === 'number' && !v.isDecoy; }

function encWorldObj(o){
  const out = {};
  for(const k in o){
    const v = o[k];
    if(v === undefined || typeof v === 'function' || k === 'cls' || k === '_n' || k === 'bob') continue;
    if(v && typeof v === 'object' && !Array.isArray(v)){
      if(isEntity(v)){ out[k] = {$e:v.id}; continue; }
      if(v.isDecoy) continue;
    }
    const x = encVal(v);
    if(x !== undefined) out[k] = x;
  }
  return out;
}

function decWorldObj(o){
  for(const k in o){
    const v = o[k];
    if(v && typeof v === 'object' && v.$e !== undefined) o[k] = state.entities[v.$e] || null;
  }
  return o;
}

/* ------------------------------------------------------------------ *
 * HOST
 * ------------------------------------------------------------------ */
const host = {
  acc: 0,
  seq: 0,
  cache: new Map(),       // entity id -> { field: jsonString }
  worldCache: {},         // world key -> jsonString
  inputs: new Map(),      // pid -> { seq, x, y, p, t }
  acts: new Map(),        // pid -> [ intent ]
  needFull: new Set(),
};

export function hostReset(){
  host.acc = 0; host.seq = 0;
  host.cache.clear(); host.worldCache = {};
  host.acts.clear();
  host.needFull.clear();
  // anything already in the one-shot arrays predates the round: never relay it
  for(const a of ['shockwaveFX','afterImages']) for(const o of state[a]) o._n = 1;
}

export function hostOnInput(d, peerId){
  if(!d) return;
  host.inputs.set(peerId, {seq:d.s|0, x:+d.x||0, y:+d.y||0, p:!!d.p, t:performance.now()});
  if(Array.isArray(d.ev)){
    let q = host.acts.get(peerId);
    if(!q){ q = []; host.acts.set(peerId, q); }
    for(const ev of d.ev) if(q.length < 16) q.push(ev);
  }
}

export function hostForgetPeer(pid){ host.inputs.delete(pid); host.acts.delete(pid); }

/** Latest held input (and queued intents) for a remote human. */
export function takeRemoteInput(pid){
  const inp = host.inputs.get(pid);
  const stale = !inp || performance.now() - inp.t > 600;
  const acts = host.acts.get(pid);
  if(acts && acts.length) host.acts.set(pid, []);
  const mag = inp ? Math.hypot(inp.x, inp.y) : 0;
  const k = mag > 1.001 ? 1/mag : 1;            // never trust the client's vector length
  return {
    x: stale ? 0 : inp.x*k, y: stale ? 0 : inp.y*k, sprint: stale ? false : inp.p,
    acts: acts || [],
  };
}

export function hostSendFullTo(peerId){ host.needFull.add(peerId); }

function syncable(k, v){
  if(LOCAL_ONLY.has(k) || v === undefined || typeof v === 'function') return false;
  if(v && typeof v === 'object' && !Array.isArray(v) && !OBJ_FIELDS.has(k)) return false;
  return true;
}

function entityDelta(e, full){
  let cache = host.cache.get(e.id);
  if(!cache){ cache = {}; host.cache.set(e.id, cache); }
  const delta = {};
  let any = false;
  for(const k in e){
    const v = e[k];
    if(!syncable(k, v)) continue;
    const enc = encVal(v);
    const js = JSON.stringify(enc);
    if(full || cache[k] !== js){ cache[k] = js; delta[k] = enc; any = true; }
  }
  return any ? delta : null;
}

function entityFull(e){
  const d = {};
  for(const k in e){
    const v = e[k];
    if(syncable(k, v)) d[k] = encVal(v);
  }
  return d;
}

function worldDelta(full){
  const out = {};
  const sets = {
    pr: state.projectiles, tr: state.traps, wl: state.wells, bc: state.beacons,
    tw: state.tempWalls, dc: state.decoys, pu: state.powerups, tz: state.tempZones,
    fm: state.familiars,
  };
  for(const k in sets){
    const enc = sets[k].map(encWorldObj);
    const js = JSON.stringify(enc);
    if(full || host.worldCache[k] !== js){ host.worldCache[k] = js; out[k] = enc; }
  }
  return out;
}

function drainNew(arr, pick){
  const out = [];
  for(const o of arr){
    if(o._n) continue;
    o._n = 1;
    out.push(pick(o));
  }
  return out;
}

/** Called once per host simulation step. */
export function hostTick(dt){
  if(!relay.active) return;
  host.acc += dt*1000;
  if(host.acc < SNAP_MS && !host.needFull.size) return;
  const lateComers = [...host.needFull];
  host.needFull.clear();
  host.acc = 0;
  host.seq++;

  const keyframe = host.seq % KEYFRAME_EVERY === 0;
  const r = state.round;
  const msg = {
    k: host.seq, t: Math.round(performance.now()),
    r: [r2(r.timer), r2(Math.max(0, r.grace)), r.active ? 1 : 0],
    e: [], ack: {},
  };
  for(const e of state.entities){
    const d = entityDelta(e, keyframe);
    if(d) msg.e.push([e.id, d]);
  }
  for(const [pid, inp] of host.inputs) msg.ack[pid] = inp.seq;
  const w = worldDelta(keyframe);
  if(Object.keys(w).length) msg.w = w;
  const sh = drainNew(state.shockwaveFX, s => [r2(s.x), r2(s.y), r2(s.maxR)]);
  if(sh.length) msg.sh = sh;
  const ai = drainNew(state.afterImages, a => ({
    x:r2(a.x), y:r2(a.y), life:r2(a.life), maxLife:r2(a.maxLife), color:a.color, owner:a.owner ? a.owner.id : -1,
  }));
  if(ai.length) msg.ai = ai;

  const shared = [];
  for(const ev of drainEvents()){
    if(ev.to) net.send('ann', {text:ev.a[0]}, ev.to);
    else shared.push(ev);
  }
  if(shared.length) msg.ev = shared;

  net.sendSnap(msg);

  if(lateComers.length){
    // a late-comer gets every field regardless of what the stream already carried
    const full = {...msg, full:1, e: state.entities.map(e => [e.id, entityFull(e)]), w: worldDelta(true)};
    delete full.ev;
    for(const p of lateComers) net.sendSnap(full, p);
  }
}

/** Everything a client needs to build the round before snapshots stream in. */
export function describeRound(){
  const zones = [];
  for(const [k, t] of state.zoneGrid) zones.push([k, t]);
  return {
    walls: state.walls.map(w => ({...w})),
    zones,
    themeId: state.theme.id,
    decorSeed: state.decorSeed,
    world: {w: WORLD_W, h: WORLD_H},
    roster: state.entities.map(e => ({
      id: e.id, pid: e.pid || null, name: e.name, clsKey: e.clsKey, isBot: !!e.isBot,
      x: r2(e.x), y: r2(e.y), team: e.team, hunting: e.hunting, build: e.build,
    })),
  };
}

/* ------------------------------------------------------------------ *
 * CLIENT
 * ------------------------------------------------------------------ */
const cli = {
  seq: 0,
  sendT: 0,
  outEvents: [],
  hist: [],               // predicted state at each sent input
  offset: null,           // host clock - local clock (ms)
  lastSnapAt: 0,
  active: false,
  held: {x:0, y:0, p:false},
};

export function clientReset(){
  cli.seq = 0; cli.sendT = 0; cli.outEvents = []; cli.hist = [];
  cli.offset = null; cli.active = true;
}
export function clientStop(){ cli.active = false; }

/** Build the replica world from the host's round description. Sets state. */
export function clientBuildWorld(p, selfPid){
  state.walls = p.walls;
  state.zoneGrid = new Map(p.zones);
  state.tempZones = []; state.tempWalls = []; state.traps = []; state.projectiles = [];
  state.wells = []; state.beacons = []; state.decoys = []; state.powerups = []; state.familiars = [];
  state.afterImages = []; state.particles = []; state.shockwaveFX = [];
  state.theme = THEME_BY_ID[p.themeId] || THEMES[0];
  state.decorSeed = p.decorSeed;
  state.decor = buildDecor(state.theme, state.walls, p.world.w, p.world.h, p.decorSeed);

  state.entities = [];
  state.player = null;
  for(const d of p.roster){
    const e = makeEntity(d.x, d.y, d.clsKey, d.isBot, d.build, d.hunting);
    e.id = d.id; e.pid = d.pid; e.name = d.name;
    e.team = d.team; e.role = d.team; e.hunting = d.hunting;
    e._buf = [];
    e._h = {x:d.x, y:d.y, vx:0, vy:0};
    state.entities.push(e);
    if(d.pid && d.pid === selfPid) state.player = e;
  }
  state.bot = null;
}

function inputWorld(){
  const k = state.keys;
  let sx = 0, sy = 0;
  if(k['w'] || k['arrowup']) sy -= 1;
  if(k['s'] || k['arrowdown']) sy += 1;
  if(k['a'] || k['arrowleft']) sx -= 1;
  if(k['d'] || k['arrowright']) sx += 1;
  if(!sx && !sy) return {x:0, y:0};
  return inputToWorld(sx, sy);
}

/** Queue an intent for the host (dash / class ability / slot ability). */
export function clientIntent(ev){
  if(cli.outEvents.length < 12) cli.outEvents.push(ev);
}

function flushInput(){
  const me = state.player;
  cli.seq++;
  cli.hist.push({seq:cli.seq, x:me.x, y:me.y, vx:me.vx, vy:me.vy});
  if(cli.hist.length > 120) cli.hist.shift();
  net.sendInput({
    s:cli.seq, x:r2(cli.held.x), y:r2(cli.held.y), p:cli.held.p ? 1 : 0,
    ev:cli.outEvents.length ? cli.outEvents : undefined,
  });
  cli.outEvents = [];
}

const RECON_SNAP = 40;       // px of drift before we apply the whole correction at once
const RECON_BLEND = 0.22;    // otherwise bleed it in per snapshot

export function clientOnSnap(msg){
  if(!cli.active || !state.round || !state.player) return;
  const now = performance.now();
  const off = msg.t - now;
  cli.offset = cli.offset === null ? off : cli.offset*0.9 + off*0.1;
  cli.lastSnapAt = now;

  const me = state.player;
  for(const [id, delta] of msg.e){
    const e = state.entities[id];
    if(!e) continue;
    let rebuild = false;
    for(const k in delta){
      const v = delta[k];
      if(POS.has(k)){ e._h[k] = v; continue; }
      if(k === 'build' || k === 'hunting') rebuild = true;
      e[k] = v;
    }
    if(rebuild) refreshMods(e, e.build);
  }
  // every remote gets a sample per snapshot, changed or not (a stationary fighter has no delta)
  for(const e of state.entities){
    if(e === me) continue;
    e._buf.push({t:msg.t, x:e._h.x, y:e._h.y, vx:e._h.vx, vy:e._h.vy});
    if(e._buf.length > 14) e._buf.shift();
  }

  const rd = state.round;
  rd.timer = msg.r[0]; rd.grace = msg.r[1]; rd.active = !!msg.r[2];

  if(msg.w){
    const w = msg.w;
    if(w.pr) state.projectiles = w.pr.map(decWorldObj);
    if(w.tr) state.traps = w.tr.map(decWorldObj);
    if(w.wl) state.wells = w.wl.map(decWorldObj);
    if(w.bc) state.beacons = w.bc.map(decWorldObj);
    if(w.tw) state.tempWalls = w.tw.map(decWorldObj);
    if(w.dc){
      const old = state.decoys;
      state.decoys = w.dc.map(decWorldObj).map((d, i) => {
        d.isDecoy = true;
        if(old[i] && old[i].stepPhase !== undefined) d.stepPhase = old[i].stepPhase;
        if(d.owner){ d.cls = d.owner.cls; d.team = d.owner.team; }
        d.lastMoveDir = d.lastMoveDir || {x:1, y:0};
        d.dir = d.dir || {x:1, y:0};
        return d;
      });
    }
    if(w.pu){
      const old = state.powerups;
      state.powerups = w.pu.map(decWorldObj).map((p, i) => { p.bob = old[i] ? old[i].bob : i*1.7; return p; });
    }
    if(w.tz) state.tempZones = w.tz.map(decWorldObj);
    if(w.fm) state.familiars = w.fm.map(decWorldObj);
  }
  if(msg.sh) for(const s of msg.sh) state.shockwaveFX.push({x:s[0], y:s[1], r:0, maxR:s[2], t:0});
  if(msg.ai) for(const a of msg.ai){ a.owner = state.entities[a.owner] || null; state.afterImages.push(a); }
  if(msg.ev) for(const ev of msg.ev) dispatchEvent(ev);

  // ---- reconcile the predicted local fighter ----
  if(cli.hist.length){
    const ack = msg.ack ? msg.ack[net.selfId] : undefined;
    if(ack !== undefined){
      const i = cli.hist.findIndex(h => h.seq === ack);
      if(i >= 0){
        const h = cli.hist[i];
        const ex = me._h.x - h.x, ey = me._h.y - h.y;
        const err = Math.hypot(ex, ey);
        if(err > 1.2){
          const k = err > RECON_SNAP ? 1 : RECON_BLEND;
          me.x += ex*k; me.y += ey*k;
          if(err > RECON_SNAP){ me.vx += me._h.vx - h.vx; me.vy += me._h.vy - h.vy; }
        }
        cli.hist.splice(0, i);
      }
    }
  }
}

// The client already predicts these for its own fighter; the host's copy would double them.
const SELF_PREDICTED = new Set(['dash','skid','landing']);

function decArg(a){
  if(a && typeof a === 'object'){
    if(a.$e !== undefined) return state.entities[a.$e] || null;
    if(Array.isArray(a)) return a.map(decArg);
    const o = {};
    for(const k in a) o[k] = decArg(a[k]);
    return o;
  }
  return a;
}

export function dispatchEvent(ev){
  const me = state.player;
  const args = ev.a.map(decArg);
  switch(ev.n){
    case 'spawnAbilityFX': spawnAbilityFX(args[0], args[1], args[2]); break;
    case 'spawnClassFX': spawnClassFX(args[0], args[1], args[2]); break;
    case 'spawnEventFX':
      if(SELF_PREDICTED.has(args[0]) && me && Math.hypot(args[1]-me.x, args[2]-me.y) < 28) break;
      spawnEventFX(args[0], args[1], args[2], args[3]);
      break;
    case 'playAnim':
      if(args[0] === 'dash' && args[1] === me) break;
      playAnim(args[0], args[1], args[2], args[3]);
      break;
    case 'kickShake': kickShake(args[0], args[1]); break;
    case 'walls':
      state.walls = args[0];
      state.decorSeed = args[1];
      state.decor = buildDecor(state.theme, state.walls, WORLD_W, WORLD_H, args[1]);
      break;
    case 'ann': if(relay.localAnnounce) relay.localAnnounce(args[0]); break;
    case 'feed': bus.emit('feed', {text:args[0], color:args[1], t:performance.now()}); break;
    default: break;
  }
}

function interpolateRemotes(){
  if(cli.offset === null) return;
  const rt = performance.now() + cli.offset - INTERP_MS;
  const me = state.player;
  for(const e of state.entities){
    if(e === me) continue;
    const b = e._buf;
    if(!b || !b.length) continue;
    let a = null, c = null;
    for(let i=b.length-1;i>=0;i--){
      if(b[i].t <= rt){ a = b[i]; c = b[i+1] || null; break; }
    }
    if(!a){ a = b[0]; e.x = a.x; e.y = a.y; e.vx = a.vx; e.vy = a.vy; continue; }
    if(c){
      const u = (rt - a.t)/Math.max(1, c.t - a.t);
      e.x = a.x + (c.x - a.x)*u; e.y = a.y + (c.y - a.y)*u;
      e.vx = a.vx + (c.vx - a.vx)*u; e.vy = a.vy + (c.vy - a.vy)*u;
    } else {
      const ahead = Math.min(0.12, (rt - a.t)/1000);
      e.x = a.x + a.vx*ahead; e.y = a.y + a.vy*ahead;
      e.vx = a.vx; e.vy = a.vy;
    }
  }
}

/** One client frame of cosmetic + predicted simulation (replaces round.update on clients). */
export function clientStep(dt){
  const me = state.player;
  const rd = state.round;
  if(!me || !rd) return;

  // ---- predicted local movement ----
  const w = me.frozen ? {x:0, y:0} : inputWorld();
  const sprintHeld = !me.frozen && !!state.keys['shift'];
  cli.held.x = w.x; cli.held.y = w.y; cli.held.p = sprintHeld;
  const sp = updateSprint(me, sprintHeld, dt);
  updatePhysics(me, w.x, w.y, dt, sp);
  if(state.dashPressed){
    state.dashPressed = false;
    if(!me.frozen){ tryDash(me); clientIntent({k:'d'}); }
  }
  cli.sendT += dt*1000;
  if(cli.sendT >= INPUT_MS || cli.outEvents.length){ cli.sendT = 0; flushInput(); }

  interpolateRemotes();

  // ---- cosmetics ----
  if(rd.active){
    if(rd.grace > 0) rd.grace = Math.max(0, rd.grace - dt);
    else rd.timer = Math.max(0, rd.timer - dt);
  }
  for(const p of state.projectiles){ p.x += (p.vx||0)*dt; p.y += (p.vy||0)*dt; }
  for(const d of state.decoys){ d.x += (d.vx||0)*dt; d.y += (d.vy||0)*dt; d.t = (d.t||0) + dt; }
  for(const p of state.powerups) p.bob += dt*3;
  for(let i=state.afterImages.length-1;i>=0;i--){
    state.afterImages[i].life -= dt;
    if(state.afterImages[i].life <= 0) state.afterImages.splice(i,1);
  }
  for(let i=state.particles.length-1;i>=0;i--){
    const pt = state.particles[i];
    pt.life -= dt; pt.x += pt.vx*dt; pt.y += pt.vy*dt;
    if(pt.life <= 0) state.particles.splice(i,1);
  }
  for(let i=state.shockwaveFX.length-1;i>=0;i--){
    const s = state.shockwaveFX[i];
    s.t += dt; s.r = s.maxR*Math.min(1, s.t/0.35);
    if(s.t > 0.4) state.shockwaveFX.splice(i,1);
  }
  updateAnims(dt);
  updateFeel(dt);
  updateCamera(dt);
}

/** Debug counters for the dev hook. */
export function netStats(){
  return {seq: cli.seq, offset: cli.offset, hist: cli.hist.length, sinceSnap: performance.now() - cli.lastSnapAt};
}
