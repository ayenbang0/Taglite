/* =========================================================================
   UPGRADE RARITY
   Applies to draftable upgrades (abilities + passives). Distinct from the
   pickup tiers in pickups.js, which describe map spawns rather than drafts.

   Deeper duels tilt the odds upward, so a long run starts surfacing the
   build-defining picks instead of endless small stat bumps.
   ========================================================================= */
export const RARITY = {
  common:    { key:'common',    name:'COMMON',    color:'#7b83a1', base:56 },
  uncommon:  { key:'uncommon',  name:'UNCOMMON',  color:'#3fe0c5', base:27 },
  rare:      { key:'rare',      name:'RARE',      color:'#9b6bff', base:13 },
  legendary: { key:'legendary', name:'LEGENDARY', color:'#ffd23f', base:4  },
};

export const RARITY_ORDER = ['common','uncommon','rare','legendary'];

/** Weights for a given duel depth. t ramps 0 -> 1 across the first ~15 duels. */
export function rarityWeights(duel){
  const t = Math.min(1, Math.max(0, (duel-1)/15));
  return {
    common:    56 - 30*t,
    uncommon:  27 +  3*t,
    rare:      13 + 14*t,
    legendary:  4 + 13*t,
  };
}

export function rollRarity(duel){
  const w = rarityWeights(duel);
  const total = RARITY_ORDER.reduce((a,k)=>a+w[k], 0);
  let r = Math.random()*total;
  for(const k of RARITY_ORDER){
    r -= w[k];
    if(r <= 0) return k;
  }
  return 'common';
}
