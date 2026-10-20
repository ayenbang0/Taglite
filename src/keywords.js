/* =========================================================================
   KEYWORDS
   The backbone of synergy. Every ability is tagged with what it GENERATES,
   and passives pay off on those tags. That makes combinations systemic -
   drafting a zone passive improves all eleven zone abilities at once - rather
   than a list of hand-written special cases.

   Generators (abilities carry these):
     zone   - leaves ground surfaces behind
     trap   - armed placements that spring on contact
     chill  - applies stacking chill
     mark   - marks a target, defeating concealment
     burst  - displaces YOU (dash/blink/grapple/warp)
     push   - displaces THEM
     brand  - delayed payload that resolves later
     summon - spawns a decoy, familiar or orb
     guard  - prevention/absorption
     haste  - self tempo
     veil   - concealment
     beam   - line/ranged strike

   Payoffs (passives key off these) live in passives.js as `keys`.
   ========================================================================= */
export const KEYWORDS = {
  zone:   {name:'ZONE',   color:'#a8742a'},
  trap:   {name:'TRAP',   color:'#a8a23f'},
  chill:  {name:'CHILL',  color:'#8fd6ff'},
  mark:   {name:'MARK',   color:'#ff5ec4'},
  burst:  {name:'BURST',  color:'#3fe0c5'},
  push:   {name:'PUSH',   color:'#ff9f45'},
  brand:  {name:'BRAND',  color:'#ff5470'},
  summon: {name:'SUMMON', color:'#9b6bff'},
  guard:  {name:'GUARD',  color:'#ffd23f'},
  haste:  {name:'HASTE',  color:'#3fe0c5'},
  veil:   {name:'VEIL',   color:'#7b83a1'},
  beam:   {name:'BEAM',   color:'#ff5ec4'},
};

export const KEYWORD_LIST = Object.keys(KEYWORDS);

/** Count how many of a build's items carry a given tag. */
export function tagCount(build, tag, ABILITY_BY_ID, PASSIVE_BY_ID){
  let n = 0;
  for(const id of build.abilities){
    const a = ABILITY_BY_ID[id];
    if(a && a.tags && a.tags.includes(tag)) n++;
  }
  for(const id of build.passives){
    const p = PASSIVE_BY_ID[id];
    if(p && p.keys && p.keys.includes(tag)) n++;
  }
  return n;
}

/**
 * Fired whenever an ability generates a keyword, so passives that pay off on
 * it can react at the moment it happens. Handlers are registered by the
 * systems that own the effect (physics/effects), keeping this module free of
 * gameplay imports.
 */
const listeners = [];
export function onKeyword(fn){ listeners.push(fn); }
export function emitKeyword(tag, source, ctx){
  for(const fn of listeners) fn(tag, source, ctx || {});
}
