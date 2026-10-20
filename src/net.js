/* =========================================================================
   TRANSPORT  (Trystero / WebRTC, serverless)
   Peers find each other through public Nostr relays (signalling only - game
   data travels peer-to-peer). One game = one Trystero room 'g-<CODE>'. A
   second, shared room advertises public games for the browser.

   Three channels per game room:
     m  reliable control messages  { t:<type>, ... }
     i  client -> host input stream
     s  host -> client snapshots
   ========================================================================= */
import { joinRoom, selfId } from 'trystero';

export const APP_ID = 'taglite-iso-voxel-v1';
export { selfId };

let game = null;     // { room, code, m, i, s, handlers }
let pub = null;      // { room, ad, listings:Map, timer, ad:{info}, cb }

/** Open (host or client) the game room for a code. */
export function openGame(code, handlers){
  closeGame();
  const room = joinRoom({appId: APP_ID}, 'g-' + code, {
    onJoinError: d => handlers.onJoinError && handlers.onJoinError(d),
  });
  const m = room.makeAction('m');
  const i = room.makeAction('i');
  const s = room.makeAction('s');
  m.onMessage = (d, meta) => handlers.onMsg && handlers.onMsg(d, meta.peerId);
  i.onMessage = (d, meta) => handlers.onInput && handlers.onInput(d, meta.peerId);
  s.onMessage = (d, meta) => handlers.onSnap && handlers.onSnap(d, meta.peerId);
  room.onPeerJoin = id => handlers.onPeerJoin && handlers.onPeerJoin(id);
  room.onPeerLeave = id => handlers.onPeerLeave && handlers.onPeerLeave(id);
  game = {room, code, m, i, s};
  return game;
}

export function closeGame(){
  if(!game) return;
  try{ game.room.leave(); }catch(_){ /* already gone */ }
  game = null;
}

export function inGame(){ return !!game; }
export function peerIds(){ return game ? Object.keys(game.room.getPeers()) : []; }

/** Reliable control message. `to` = peer id, array of ids, or omitted for everyone. */
export function send(type, data, to){
  if(!game) return;
  game.m.send({t:type, ...(data||{})}, to ? {target:to} : undefined);
}
export function sendInput(data, to){
  if(game) game.i.send(data, to ? {target:to} : undefined);
}
export function sendSnap(data, to){
  if(game) game.s.send(data, to ? {target:to} : undefined);
}
export function pingPeer(id){
  return game ? game.room.ping(id) : Promise.resolve(0);
}

/* ------------------------------------------------------------------ *
 * Public game list
 * ------------------------------------------------------------------ */
const AD_EVERY = 3000, AD_TTL = 10000;

function ensurePublic(){
  if(pub) return pub;
  const room = joinRoom({appId: APP_ID}, 'public-lobby-v1');
  const ad = room.makeAction('ad');
  pub = {room, ad, listings:new Map(), info:null, timer:null, cb:null, browsing:false};
  ad.onMessage = (info, meta) => {
    if(!pub || !pub.browsing || !info || !info.code) return;
    pub.listings.set(info.code, {...info, seen:Date.now()});
    pub.cb && pub.cb(currentListings());
  };
  room.onPeerJoin = id => { if(pub && pub.info) pub.ad.send(pub.info, {target:id}); };
  pub.timer = setInterval(() => {
    if(!pub) return;
    if(pub.info) pub.ad.send(pub.info);
    if(pub.browsing && pub.cb) pub.cb(currentListings());   // also expires stale rows
  }, AD_EVERY);
  return pub;
}

function currentListings(){
  const now = Date.now(), out = [];
  for(const [code, l] of pub.listings){
    if(now - l.seen > AD_TTL){ pub.listings.delete(code); continue; }
    out.push({...l, age: now - l.seen});
  }
  return out;
}

function maybeClosePublic(){
  if(!pub || pub.info || pub.browsing) return;
  clearInterval(pub.timer);
  try{ pub.room.leave(); }catch(_){ /* already gone */ }
  pub = null;
}

/** Advertise the hosted game (or pass null to stop). */
export function advertise(info){
  if(!info){ if(pub) pub.info = null; maybeClosePublic(); return; }
  const p = ensurePublic();
  p.info = info;
  p.ad.send(info);
}

/** Listen for public games. cb receives the live array. */
export function browse(on, cb){
  if(!on){ if(pub){ pub.browsing = false; pub.cb = null; pub.listings.clear(); } maybeClosePublic(); return; }
  const p = ensurePublic();
  p.browsing = true;
  p.cb = cb;
  cb(currentListings());
}
