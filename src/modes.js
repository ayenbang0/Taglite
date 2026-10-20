/* =========================================================================
   GAME MODES
   Modes are variant duels inside a single run, on a fixed announced cycle so
   the draft screen can tell you what's coming and you can build for it.

   Every mode is described declaratively here - participant count, team split,
   arena size, duration, upgrade marks and win condition - so round.js stays
   one code path rather than branching per mode everywhere.

   `online` describes how the mode plays as a multi-round online match:
   human limits, round-count choices, and the per-round clock (longer than a
   solo-run duel, since a match is several rounds).

   `duration` is the duel length in seconds. `draftMarks` are ELAPSED-time
   points at which an in-duel upgrade fires.
   ========================================================================= */

export const MODES = {
  classic: {
    key:'classic', name:'CLASSIC', color:'#3fe0c5',
    blurb:'1v1 - tag them, or survive the clock.',
    entities: 2,
    teams: ['tagger','runner'],
    split: 1,               // how many start on the first team
    world: {w:1500, h:950},
    duration: 120,          // 2:00
    draftMarks: [60],       // one upgrade, dead centre
    online: {name:'CLASSIC DUEL', minHumans:1, maxHumans:2, rounds:[3,5,7], defaultRounds:5, roundTime:120},
  },
  zombie: {
    key:'zombie', name:'ZOMBIE TAG', color:'#a8a23f',
    blurb:'The tagged join the horde. Convert everyone, or outlast it.',
    entities: 6,
    teams: ['zombie','survivor'],
    split: 1,               // one patient zero
    world: {w:2000, h:1250},
    duration: 300,          // 5:00
    draftMarks: [120, 240], // upgrades at the 2:00 and 4:00 marks
    convertOnTag: true,     // being tagged switches you to the zombie team
    online: {name:'INFECTION', minHumans:1, maxHumans:8, rounds:[3,4,5], defaultRounds:3, roundTime:180},
  },
  freeze: {
    key:'freeze', name:'FREEZE TAG', color:'#8fd6ff',
    blurb:'3 hunt 4. Frozen allies stay rescuable - thaw them or lose.',
    entities: 7,
    teams: ['tagger','runner'],
    split: 3,               // 3 taggers vs 4 runners
    world: {w:2100, h:1300},
    duration: 300,          // 5:00
    draftMarks: [120, 240], // upgrades at the 2:00 and 4:00 marks
    freezeOnTag: true,
    thawTime: 0.5,          // hold this long to free an ally
    thawCooldown: 3,        // ...then you can't thaw again for this long
    online: {name:'FREEZE SQUADS', minHumans:1, maxHumans:8, rounds:[2,4,6], defaultRounds:4, roundTime:180},
  },
  potato: {
    key:'potato', name:'HOT POTATO', color:'#ff9a3c',
    blurb:'One carrier at a time. Tag to pass the potato - whoever holds it longest loses.',
    entities: 6,
    teams: ['carrier','runner'],
    split: 1,
    world: {w:1800, h:1150},
    duration: 120,
    draftMarks: [],
    swapOnTag: true,        // a tag trades roles: the tagger is safe, the tagged is the carrier
    online: {name:'HOT POTATO', minHumans:1, maxHumans:8, rounds:[3,4,6], defaultRounds:4, roundTime:120},
  },
};

/** Remaining-time thresholds for a mode's upgrade marks, latest first. */
export function draftThresholds(mode){
  return (mode.draftMarks || [])
    .map(elapsed => mode.duration - elapsed)
    .sort((a,b) => b-a);
}

export const MODE_LIST = Object.values(MODES);

/** The four online round formats, in menu order. */
export const ONLINE_MODES = ['classic','zombie','freeze','potato'].map(k => {
  const m = MODES[k];
  return {key:k, name:m.online.name, color:m.color, blurb:m.blurb, ...m.online, entities:m.entities};
});

/** Solo roguelike run: endless, escalating rounds cycling through the modes. */
export const SOLO_MODE = {
  key:'gauntlet', name:'SOLO GAUNTLET', color:'#ffd23f',
  blurb:'Endless escalating rounds against bots. One loss ends the run.',
};

/**
 * Fixed, announced rotation: every 3rd duel is Zombie, every 5th is Freeze,
 * everything else is Classic. Freeze wins ties so both still show up.
 */
export function modeForDuel(duel){
  if(duel % 7 === 0) return MODES.potato;
  if(duel % 5 === 0) return MODES.freeze;
  if(duel % 3 === 0) return MODES.zombie;
  return MODES.classic;
}

/** What the draft screen advertises as coming next. */
export function nextModeLabel(duel){
  const m = modeForDuel(duel+1);
  return m.key==='classic'
    ? `NEXT: ${m.name}`
    : `NEXT: ${m.name} — ${m.entities} FIGHTERS`;
}

/** Which team is "it" (the side that tags) for a mode. */
export function huntingTeam(mode){ return mode.teams[0]; }
export function preyTeam(mode){ return mode.teams[1]; }

export function enemiesOf(e, entities){
  return entities.filter(o => o !== e && o.alive !== false && o.team !== e.team);
}
export function alliesOf(e, entities){
  return entities.filter(o => o !== e && o.alive !== false && o.team === e.team);
}
export function teamOf(entities, team){
  return entities.filter(o => o.alive !== false && o.team === team);
}
