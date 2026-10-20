/* =========================================================================
   DRAFT  (DESIGN.md sections 2, 5, 6, 8)
   After every duel the player picks 1 of 3. The bot drafts every duel too,
   so going into duel N both sides hold N-1 picks.

   Slot rule: once all MAX_ACTIVE_SLOTS active slots are full, the pool stops
   offering abilities and offers passives instead. That avoids needing a
   slot-swap UI while keeping every draft meaningful.
   ========================================================================= */
import { DRAFT_OPTIONS, MAX_ACTIVE_SLOTS } from './config.js';
import { ABILITY_BY_ID } from './abilities.js';
import { PASSIVE_BY_ID } from './passives.js';
import { unlockedPool } from './progression.js';
import { rollRarity, RARITY_ORDER, RARITY } from './rarity.js';
import { state } from './state.js';

function pick(arr){ return arr[Math.floor(Math.random()*arr.length)]; }

/**
 * Build the candidate list for one side.
 * Abilities already drafted are excluded (no duplicate actives); passives may
 * repeat, since stacking duplicates is intended (loose/arcade balance).
 */
function candidates(build, mods){
  const pool = unlockedPool();
  const out = [];
  const slotsFull = build.abilities.length >= MAX_ACTIVE_SLOTS;
  if(!slotsFull){
    for(const a of pool.abilities){
      if(!build.abilities.includes(a.id)) out.push({kind:'ability', id:a.id, cat:a.cat, rarity:a.rarity||'common'});
    }
  }
  for(const p of pool.passives){
    out.push({kind:'passive', id:p.id, cat:p.cat, rarity:p.rarity||'common'});
  }
  return out;
}

/**
 * Draw one option at a rolled rarity, stepping down tiers if that tier has
 * nothing left to offer (a legendary roll shouldn't produce an empty slot).
 */
function pickAtRarity(pool, duel, reject){
  const rolled = rollRarity(duel);
  const from = RARITY_ORDER.indexOf(rolled);
  for(let i=from; i>=0; i--){
    const tier = pool.filter(o=>o.rarity===RARITY_ORDER[i] && !reject(o));
    if(tier.length) return pick(tier);
  }
  for(let i=from+1; i<RARITY_ORDER.length; i++){
    const tier = pool.filter(o=>o.rarity===RARITY_ORDER[i] && !reject(o));
    if(tier.length) return pick(tier);
  }
  return null;
}

/**
 * Roll DRAFT_OPTIONS distinct options.
 * CHAOS THEORY forces all three to come from different categories.
 * LUCKY DRAW biases one option toward a category already in the build.
 */
export function rollDraft(build, mods, duel){
  const pool = candidates(build, mods);
  if(!pool.length) return [];
  const d = duel || (state.run ? state.run.duel : 1);
  const chaos = mods && mods.chaosTheory;
  const lucky = mods && mods.luckyDraw;

  const chosen = [];
  const usedCats = new Set();
  const usedKeys = new Set();
  const seen = o => usedKeys.has(o.kind+o.id);

  if(lucky){
    const ownedCats = new Set([
      ...build.abilities.map(id=>ABILITY_BY_ID[id]?.cat).filter(Boolean),
      ...build.passives.map(id=>PASSIVE_BY_ID[id]?.cat).filter(Boolean),
    ]);
    const biased = pool.filter(o=>ownedCats.has(o.cat));
    if(biased.length){
      const o = pick(biased);
      chosen.push(o); usedCats.add(o.cat); usedKeys.add(o.kind+o.id);
    }
  }

  // each remaining slot rolls its own rarity, so a draft can mix tiers
  while(chosen.length < DRAFT_OPTIONS){
    const o = pickAtRarity(pool, d, x => seen(x) || (chaos && usedCats.has(x.cat)));
    if(!o) break;
    chosen.push(o);
    usedCats.add(o.cat);
    usedKeys.add(o.kind+o.id);
  }
  // if the chaos constraint starved the roll, top up without it
  while(chosen.length < DRAFT_OPTIONS){
    const o = pickAtRarity(pool, d, seen);
    if(!o) break;
    chosen.push(o);
    usedKeys.add(o.kind+o.id);
  }
  return chosen;
}

export function applyPick(build, option){
  if(option.kind==='ability'){
    if(build.abilities.length < MAX_ACTIVE_SLOTS) build.abilities.push(option.id);
  } else {
    build.passives.push(option.id);
  }
}

export function optionInfo(option){
  if(option.kind==='ability'){
    const a = ABILITY_BY_ID[option.id];
    const r = RARITY[a.rarity||'common'];
    return {
      name:a.name, desc:a.desc, flavor:a.flavor, aimed:a.aimed,
      meta:`ACTIVE · ${a.cd}s CD`, cat:a.cat, kind:'ability',
      rarity:r.key, rarityName:r.name, color:r.color,
    };
  }
  const p = PASSIVE_BY_ID[option.id];
  const r = RARITY[p.rarity||'common'];
  return {
    name:p.name, desc:p.desc, flavor:'', aimed:false,
    meta:'PASSIVE', cat:p.cat, kind:'passive',
    rarity:r.key, rarityName:r.name, color:r.color,
  };
}

/* =========================================================================
   BOT DRAFTING  (adaptive - DESIGN.md section 8)
   A light heuristic, not opponent modelling: the bot leans toward tag tools
   when it keeps losing as tagger, and toward anti-stealth when the player is
   visibly stacking stealth.
   ========================================================================= */
const TAG_TOOLS = ['a_longarm','a_blinkstrike','a_pierce','a_grapple','a_pounce','a_lasso','a_slide'];
const ANTI_STEALTH = ['a_mark','p_night','p_hound'];
const PLAYER_STEALTH = ['p_camo','a_smoke','a_ghosttrail','a_dustkick'];

export function botDraft(run, build, depth){
  const target = build || run.aiBuilds[0];
  const options = rollDraft(target, null, depth || run.duel);
  if(!options.length) return null;

  const playerStealth = [...run.player.abilities, ...run.player.passives]
    .filter(id=>PLAYER_STEALTH.includes(id)).length;

  let best = options[0], bestScore = -Infinity;
  for(const o of options){
    let score = Math.random();
    if(run.botTaggerLosses >= 2 && TAG_TOOLS.includes(o.id)) score += 1.2;
    if(playerStealth >= 1 && ANTI_STEALTH.includes(o.id)) score += 1.0 * playerStealth;
    if(score > bestScore){ bestScore = score; best = o; }
  }
  applyPick(target, best);
  return best;
}
