/* =========================================================================
   EVENT RELAY  (host -> clients)
   The host runs every ability and impact; clients only render. Cosmetic calls
   that originate in the simulation (fx spawns, body animations, screen shake,
   announcements) are recorded here and shipped to the clients alongside the
   next snapshot, where netsync.js replays them through the same functions.

   `relay.active` is only true on a host that has at least one remote human.
   ========================================================================= */
import { state } from './state.js';
import { bus } from './bus.js';

export const relay = {
  active: false,
  queue: [],               // [{n, a, to?}]  to = pid of a single recipient
  localAnnounce: null,     // (text) => void, set by round.js
};

function enc(v, depth){
  if(v === null || v === undefined) return v;
  const t = typeof v;
  if(t === 'number') return Math.round(v*100)/100;
  if(t !== 'object') return v;
  if(depth > 3) return undefined;
  if(Array.isArray(v)) return v.map(x => enc(x, depth+1));
  if(v.clsKey !== undefined && typeof v.id === 'number' && !v.isDecoy) return {$e:v.id};
  if(v.isDecoy) return undefined;
  const o = {};
  for(const k in v){
    const x = enc(v[k], depth+1);
    if(x !== undefined) o[k] = x;
  }
  return o;
}

/** Record a cosmetic call for the clients. No-op unless hosting for remote humans. */
export function emitEvt(name, ...args){
  if(!relay.active) return;
  relay.queue.push({n:name, a:args.map(a => enc(a, 0))});
}

function showLocal(text){ if(relay.localAnnounce) relay.localAnnounce(text); }

/** Announce to whoever controls `e` (the local player, a remote human, or nobody). */
export function announceFor(e, text){
  if(!e) return;
  if(e === state.player) showLocal(text);
  else if(e.pid && relay.active) relay.queue.push({n:'ann', a:[text], to:e.pid});
}

/** Announce to every human. */
export function announceAll(text){
  showLocal(text);
  if(relay.active) relay.queue.push({n:'ann', a:[text]});
}

/** Kill-feed line for every human. */
export function feed(text, color){
  bus.emit('feed', {text, color: color || '#e8ecff', t: performance.now()});
  if(relay.active) relay.queue.push({n:'feed', a:[text, color || '#e8ecff']});
}

/** Drain queued events for one recipient (null pid = broadcast stream). */
export function drainEvents(){
  const q = relay.queue;
  relay.queue = [];
  return q;
}
