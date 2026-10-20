/* =========================================================================
   MAP EVOLUTION  (DESIGN.md section 8)
   Arena escalation is banded by duel number rather than continuous, so each
   band reads as a distinct "the map changed" moment instead of a slow drift
   the player never notices.

     duels 1-3   base arena
     duels 4-6   denser hazard field, second wall variant available
     duels 7-9   one rotating map modifier per duel
     duels 10+   two modifiers at once
   ========================================================================= */
export const MAP_MODS = [
  { id:'m_slick',   name:'SLICK GROUND',   desc:'No slow zones. Double speed pads.',
    zoneBias:'speed', extraBlobs:4 },
  { id:'m_mire',    name:'THE MIRE',       desc:'Slow patches everywhere.',
    zoneBias:'slow',  extraBlobs:6 },
  { id:'m_ring',    name:'DEAD PERIMETER', desc:'The outer ring drags you down.',
    outerRing:true },
  { id:'m_shift',   name:'SHIFTING WALLS', desc:'The maze rearranges at 1:30.',
    wallShift:true },
  { id:'m_bounty',  name:'RICH GROUND',    desc:'Pickups spawn twice as fast.',
    pickupRate:0.5 },
  { id:'m_sparse',  name:'BARE ARENA',     desc:'No pickups at all.',
    pickupRate:Infinity },
  { id:'m_glaze',   name:'GLAZE',          desc:'Slick ice patches.',
    zoneBias:'ice',   extraBlobs:5 },
];

export function bandFor(duel){
  if(duel<=3) return 0;
  if(duel<=6) return 1;
  if(duel<=9) return 2;
  return 3;
}

/** Pick the modifiers active for a given duel. */
export function rollMapMods(duel){
  const band = bandFor(duel);
  if(band<=1) return [];
  const count = band===2 ? 1 : 2;
  const pool = MAP_MODS.slice();
  const out = [];
  for(let i=0;i<count && pool.length;i++){
    const idx = Math.floor(Math.random()*pool.length);
    out.push(pool.splice(idx,1)[0]);
  }
  return out;
}

/** Aggregate the active modifiers into arena-build parameters. */
export function mapParams(duel, mods){
  const band = bandFor(duel);
  const p = {
    blobCount: band>=1 ? 9 + Math.floor(Math.random()*4) : 6 + Math.floor(Math.random()*3),
    zoneBias: null,
    outerRing: false,
    wallShift: false,
    wallVariant: band>=1 && Math.random()<0.5 ? 1 : 0,
    pickupRateMult: 1,
  };
  for(const m of mods){
    if(m.extraBlobs) p.blobCount += m.extraBlobs;
    if(m.zoneBias) p.zoneBias = m.zoneBias;
    if(m.outerRing) p.outerRing = true;
    if(m.wallShift) p.wallShift = true;
    if(m.pickupRate !== undefined) p.pickupRateMult = m.pickupRate;
  }
  return p;
}
