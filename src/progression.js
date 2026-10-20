/* =========================================================================
   ACCOUNT PROGRESSION  (DESIGN.md section 9)
   The old per-class XP-bought upgrade tree is gone, replaced by in-run
   drafts. Account level survives, but with a different job: it WIDENS THE
   DRAFT POOL and unlocks classes - it never buys raw stats.
   ========================================================================= */
import { CLASS_UNLOCK_LEVEL, STARTER_CLASSES, poolWidth, CLASSES } from './config.js';
import { ABILITIES } from './abilities.js';
import { PASSIVES } from './passives.js';
import { RARITY_ORDER, RARITY } from './rarity.js';
import { state } from './state.js';

const SAVE_KEY = 'taglite.account.v1';

export function xpForNextLevel(lv){ return 300 + (lv-1)*150; }

export function totalXpToLevel(xp){
  let lv=1, need=xpForNextLevel(1), remaining=xp;
  while(remaining >= need){ remaining -= need; lv++; need = xpForNextLevel(lv); }
  return lv;
}

export function xpProgress(xp){
  let lv=1, need=xpForNextLevel(1), remaining=xp;
  while(remaining >= need){ remaining -= need; lv++; need = xpForNextLevel(lv); }
  return {lv, into:remaining, need};
}

export function loadAccount(){
  try{
    const raw = localStorage.getItem(SAVE_KEY);
    if(raw){
      const data = JSON.parse(raw);
      if(data && typeof data.xp === 'number'){
        state.account.xp = data.xp;
        state.account.level = totalXpToLevel(data.xp);
        state.account.best = data.best || 0;
        return;
      }
    }
  }catch(err){ /* private mode / blocked storage - fall through to defaults */ }
  state.account.xp = 0;
  state.account.level = 1;
  state.account.best = 0;
}

export function saveAccount(){
  try{
    localStorage.setItem(SAVE_KEY, JSON.stringify({
      xp: state.account.xp,
      best: state.account.best || 0,
    }));
  }catch(err){ /* non-fatal: progression just won't persist this session */ }
}

export function awardXp(amount){
  state.account.xp += amount;
  state.account.level = totalXpToLevel(state.account.xp);
  saveAccount();
}

export function isClassUnlocked(key){
  if(STARTER_CLASSES.includes(key)) return true;
  const need = CLASS_UNLOCK_LEVEL[key];
  return need === undefined || state.account.level >= need;
}

export function unlockedClasses(){
  return Object.keys(CLASSES).filter(isClassUnlocked);
}

/**
 * The draft pool available to this account. Pool width grows with account
 * level, so new players read a smaller, clearer set of options and veterans
 * get more variety - without anyone getting bigger numbers for free.
 *
 * The slice is taken PER RARITY TIER rather than off the front of the list:
 * the content arrays happen to be ordered by rarity, so a flat slice would
 * make rare and legendary upgrades unreachable at every level. Higher tiers
 * also stay gated until the pool is wide enough, which is what actually paces
 * progression - the rarity roll then controls how often they show up.
 */
const TIER_GATE = { common:0, uncommon:0.15, rare:0.35, legendary:0.55 };

function sliceByRarity(list, ratio){
  const out = [];
  for(const tier of RARITY_ORDER){
    if(ratio < TIER_GATE[tier]) continue;
    const inTier = list.filter(x => (x.rarity||'common') === tier);
    if(!inTier.length) continue;
    const take = Math.max(1, Math.round(inTier.length * ratio));
    out.push(...inTier.slice(0, take));
  }
  return out;
}

export function poolRatio(){
  const w = poolWidth(state.account.level);
  return Math.min(1, w / Math.max(ABILITIES.length, PASSIVES.length));
}

export function unlockedPool(){
  const ratio = poolRatio();
  return {
    abilities: sliceByRarity(ABILITIES, ratio),
    passives:  sliceByRarity(PASSIVES, ratio),
  };
}

/** Lowest account level whose pool ratio clears a given rarity tier's gate. */
function levelForTier(tier){
  for(let lv=1; lv<=60; lv++){
    const ratio = Math.min(1, poolWidth(lv) / Math.max(ABILITIES.length, PASSIVES.length));
    if(ratio >= TIER_GATE[tier]) return lv;
  }
  return null;
}

export function nextUnlockHint(){
  const lv = state.account.level;
  const upcoming = [];

  for(const [key,need] of Object.entries(CLASS_UNLOCK_LEVEL)){
    if(lv < need) upcoming.push({at:need, what:`${CLASSES[key].name} CLASS`});
  }
  for(const tier of RARITY_ORDER){
    const need = levelForTier(tier);
    if(need && lv < need) upcoming.push({at:need, what:`${RARITY[tier].name} UPGRADES`});
  }
  if(upcoming.length){
    upcoming.sort((a,b)=>a.at-b.at);
    return `LV ${upcoming[0].at}: ${upcoming[0].what}`;
  }

  const w = poolWidth(lv);
  if(w < Math.max(ABILITIES.length, PASSIVES.length)){
    const step = 3 - ((lv-1) % 3);
    return `LV ${lv+step}: WIDER DRAFT POOL`;
  }
  return 'ALL CONTENT UNLOCKED';
}
