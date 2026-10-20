/* =========================================================================
   RUN LIFECYCLE  (DESIGN.md section 2)
   A run is an endless string of duels. Class is locked at run start; role is
   re-rolled every duel; the run ends on your first loss.
   ========================================================================= */
import { REROLL_START, REROLL_EVERY, REROLL_CAP, CLASSES } from './config.js';
import { emptyBuildState } from './build.js';
import { rollMapMods } from './mapmods.js';
import { botDraft } from './draft.js';
import { awardXp, unlockedClasses } from './progression.js';
import { state } from './state.js';

// enough independent AI builds for the largest mode (Freeze Tag: 6 bots)
export const MAX_AI = 6;

export function startRun(clsKey){
  state.run = {
    clsKey,
    duel: 1,
    rerolls: REROLL_START,
    player: emptyBuildState(),
    // every AI carries its own build and re-rolls its own class, so a horde
    // is a mix of kits rather than five clones
    aiBuilds: Array.from({length:MAX_AI}, ()=>emptyBuildState()),
    aiClasses: Array.from({length:MAX_AI}, ()=>rollBotClass()),
    mods: rollMapMods(1),
    history: [],
    botTaggerLosses: 0,
    xpEarned: 0,
  };
  return state.run;
}

export function rollBotClass(){
  // the bot re-rolls its class every duel but keeps its drafted picks
  const pool = unlockedClasses();
  return pool[Math.floor(Math.random()*pool.length)];
}

/** Record the outcome of the duel that just finished. */
export function recordDuel(run, playerWon, playerRole, timeLeft, modeName){
  run.history.push({
    duel: run.duel,
    role: playerRole,
    mode: modeName || 'CLASSIC',
    won: playerWon,
    timeLeft: Math.max(0, Math.round(timeLeft)),
    mods: run.mods.map(m=>m.name),
  });
  if(!playerWon && playerRole === 'runner') run.botTaggerLosses = 0;
  if(playerWon && playerRole === 'runner') run.botTaggerLosses++;
}

/**
 * Advance to the next duel. Every AI drafts here (so their power curve tracks
 * yours), each re-rolls its class, and the map re-rolls modifiers.
 */
export function advanceDuel(run){
  draftForAllAI(run);
  run.duel++;
  run.aiClasses = run.aiClasses.map(()=>rollBotClass());
  run.mods = rollMapMods(run.duel);
  if(run.duel % REROLL_EVERY === 1 && run.duel > 1){
    run.rerolls = Math.min(REROLL_CAP, run.rerolls + 1);
  }
}

/** One draft pick for each AI in the roster. */
export function draftForAllAI(run){
  for(const build of run.aiBuilds){
    botDraft(run, build);
  }
}

/** XP for one completed duel. */
export function duelXp(run, playerWon){
  let xp = 40 + run.duel*10;
  if(playerWon) xp += 60;
  return xp;
}

export function endRun(run){
  const survived = run.duel - 1;   // duels actually won
  const bonus = survived * 25;
  run.xpEarned += bonus;
  awardXp(bonus);
  if(!state.account.best || survived > state.account.best){
    state.account.best = survived;
  }
  return { survived, xpEarned: run.xpEarned };
}
