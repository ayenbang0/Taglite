# TAGLITE

A roguelike tag game. Pick a class, then survive an endless string of escalating 5-minute duels against opponents that build themselves up alongside you. Win a duel, draft an upgrade, face something harder. Lose once and the run is over.

## Play it

**Double-click `PLAY.bat`.** It installs dependencies on first run, starts the local server, and opens your browser automatically. Keep the window open while you play.

`PLAY (no console).vbs` does the same with no console window (use `PLAY.bat` for the first run so you can see install progress).

Requires [Node.js](https://nodejs.org). Or from a terminal:

```bash
npm install
npm start
```

The game can't be opened by double-clicking `index.html` — it's split into ES modules, which browsers refuse to load over `file://`.

```bash
npm run dev      # dev server without auto-opening a browser
npm run build    # production build to dist/
npm run preview  # serve the production build
```

## Controls

| Key | Action |
|---|---|
| `W A S D` | Move |
| `SHIFT` | Sprint (hold) |
| `SPACE` | Dash |
| `E` | Class ability |
| `1` – `4` | Drafted abilities |
| Left click | Fire an aimed ability (marked ◎) |
| Right click / `ESC` | Cancel aiming |

Aimed abilities arm on keypress and show a reticle plus range ring; click to fire.

## The run

- **Class is locked at run start.** Your side is re-rolled every duel — you might defend a six-duel lead as prey, then have to close out the next one as the hunter.
- **Duel length and upgrade timing depend on the mode** (see the table below) — you get picks *during* a duel as well as after winning one.
- **Win → draft.** Pick 1 of 3 upgrades. Rerolls are limited (1 to start, +1 every 3 duels, cap 3).
- **Every AI drafts too**, every duel, from the same pool — each with its own independent build and its own re-rolled class. A deep-run horde is a mix of kits, not five clones.
- **The arena evolves.** Denser hazards from duel 4, one map modifier from duel 7, two from duel 10.
- **Lose once and the run ends**, with a summary of your build and every duel you played.

## Modes

Modes are variant duels inside a single run, on a fixed cycle. The draft screen tells you what's coming next, so you can pick upgrades for it.

| Mode | When | Fighters | Length | Upgrades | Rules |
|---|---|---|---|---|---|
| **Classic** | default | 2 | 2:00 | at 1:00 | Tag them, or survive the clock. |
| **Zombie Tag** | every 3rd duel | 6 | 5:00 | at 2:00 and 4:00 | One starts infected. Tagged players **turn and keep playing** — you can still win the duel from inside the horde. Zombies win by converting everyone; survivors win on the clock. |
| **Freeze Tag** | every 5th duel | 7 | 5:00 | at 2:00 and 4:00 | 3 hunt 4. Tagged runners freeze solid and stay rescuable — stand on a frozen ally for 0.5s to thaw them (3s cooldown between rescues). Hunters win **only** if all 4 are frozen at once, so one free runner keeps the team alive. |

In-duel upgrades pause play, apply immediately for the rest of that duel, and resume with the clock preserved. Every AI drafts at the same marks, so the sides stay symmetric.

## The two sides

Being "it" is a different job from being hunted, so the roles have different **base** stats — applied before class traits and drafted upgrades:

| | Speed | Sprint stamina | Dash cooldown | Ability cooldown |
|---|---|---|---|---|
| **Hunter** (Tagger / Zombie) | +20% | +10% | −10% | — |
| **Prey** (Runner / Survivor) | — | — | — | −10% |

Hunters get the legs; prey get the toolkit. In Zombie Tag this flips live — the moment you're converted, your baseline switches to the hunter's.

While frozen you keep full vision and get a directional arrow toward your nearest free ally, so you can watch the rescue develop.

## What the AI can actually see

Bots have **no access to your true position**. They work from a belief, fed by exactly the two sources you get:

- **Line of sight** — within range, unobstructed, and not defeated by stealth. Belief snaps to exact.
- **The directional ping** — a *bearing only*, on the same cadence your own HUD ping uses. The bot projects along it with a guessed distance, so error compounds.

Between updates the belief drifts and confidence decays to zero. In testing, a blinded bot's belief sat ~1000px from the truth while it hunted a stale guess — but it still caught a fleeing player in 2 of 3 live chases, so it's fooled, not broken.

This is what makes concealment worth drafting. **Decoys** are indistinguishable from real fighters to a bot that hasn't had a clean look: it picks one, **commits** to the chase for a beat rather than re-evaluating every frame, and is fooled 78% of the time early in a run — falling to ~10% once its skill maxes out. Decoys move like players too: momentum, committed heading changes, wall avoidance, dash-like bursts, and a flee bias away from whoever is hunting their owner.

## Content

- **8 classes** — Rogue, Tank, Scout, Trickster (starters) plus Trapper, Hunter, Phantom, Anchor (unlocked by account level). Each keeps its signature ability permanently; drafts stack on top.
- **40 draftable abilities** and **40 draftable passives**, shared across all classes — 80 upgrades in total.
- **16 pickups** — 12 temporary, plus 4 rare artifacts that persist for the rest of the run.
- **Upgrade rarity** — Common / Uncommon / Rare / Legendary. Deeper duels shift the odds upward, so long runs start surfacing build-defining picks instead of small stat bumps.

Upgrades aim to **change a rule** rather than add a number — a brand that becomes a tag if you can't break away, a slow that stacks the longer you stay close, a familiar that orbits you, a curse that trades sprinting away for reach, and a transformation that rewards focusing your draft on one kind of trait. Duplicates stack plainly, so two copies of a reach passive really is double reach.

## Progression

Account level persists in `localStorage`. It never buys raw stats — it **widens the draft pool** and unlocks classes, so new players read a smaller, clearer set of options:

| Level | Unlocks |
|---|---|
| 1 | 4 starter classes; Common + Uncommon upgrades |
| ~7 | Rare upgrades |
| ~16 | Legendary upgrades |
| 6 / 10 / 14 / 18 | Trapper / Hunter / Phantom / Anchor |
| ~34 | Full 60-upgrade pool |

## Ability animation

Every ability runs a **three-beat** motion — anticipation (pull back), strike (snap forward), recovery (settle to neutral) — and always ends at the rest pose so it chains cleanly back into movement.

Timing is deliberately uneven. The wind-up takes ~30% of the animation and decelerates into it; the **strike fires in a 15% window**; the recovery eases out over the rest. Even timing would smear the strike into the surrounding motion and lose the impact.

Direction is always **explicit and in screen space** — every animation is authored along a vector passed in at play time (where you aimed, else the bearing to the target, else where you're moving). Nothing is expressed body-relatively, which is what stops a lunge going the wrong way when your aim and your facing disagree. FX are drawn in world space and reach well past the 10px sprite, so a swing never clips at the body's edge.

Seven archetypes cover all 40 abilities plus the 8 class signatures:

| Archetype | Used by | Motion |
|---|---|---|
| `thrust` | reach/tag abilities | lunge along the aim, trailing tip |
| `throw` | thrown projectiles | wind back, release arc off the hand |
| `slam` | ground placements | crouch, slam, expanding ring |
| `cast` | self-buffs and utility | draw inward, burst outward |
| `pull` | wells, tethers, grapple | line shoots out, reels back |
| `dash` | movement abilities | compress, streak, settle |
| `shove` | Tidal Shove | wind back, three-line cone |

**Attacks and hit reactions are built as a pair.** Anything that lands — a tag, knockback, a slow, a chill stack, a spring trap — triggers a matching flinch on the recipient. The two poses are complementary: the attacker stretches *into* the blow (1.45× along the action axis, 0.80× across), the victim compresses *away* from it (0.86× on the impact axis, 1.17× across, with a lean).

Several build-defining passives also carry a persistent tell, so you can read someone's build before it hits you — Bloody Lust's heat ring grows with its stacks, Apotheosis orbits one mote per completed set, Cold Blood shows its unspent guard, Brittle Bones flashes a fracture when dazed, Quicksilver ticks off absorbed pickups.

## Movement & drift

Friction is low (`FRICTION = 2.2`), so you carry real momentum. Coasting from full speed takes **1.15s and 62px**, and fully reversing direction takes **0.45s** — committing to a heading costs you, and snap turns aren't free. Chases are about reading angles and cutting corners, not twitch reversals.

Note that friction also sets the effective top speed: at this setting entities cruise around 200 px/s and sprint to ~293.

## Sprint & stamina

Sprinting is modelled on real exertion rather than a linear bar:

- It raises **both top speed and acceleration** — a genuine burst off the line, not just a higher ceiling.
- **Cost climbs the longer you hold it** (~18/s at the start of a burst, ~44/s once sustained).
- **Output tapers as the tank empties** — below ~55% the boost degrades toward nothing, so you can't sprint at top speed while gassed.
- **Recovery is non-linear**: right after stopping you're in oxygen debt (~6/s), ramping to full (~32/s) after a couple of seconds of easing off — and it's roughly halved while you're still running flat out.
- **Blowing the tank** costs a hard fatigue state, and you must get real breath back (not just wait out a timer) before sprinting again.

Bots sprint too, in committed bursts rather than per-frame flickering — roughly **37% uptime** across a duel. They push to close a gap, to break away, and to reach a frozen ally, then ease off to recover.

## Project layout

Originally one HTML file; split into ES modules under `src/`, wired through a single shared mutable `state` object (`src/state.js`) since so much per-duel state is both read and reassigned across systems.

| File | Responsibility |
|---|---|
| `src/config.js` | Tunable constants, class definitions, run/pool config |
| `src/math.js` | Vector helpers |
| `src/state.js` | The shared mutable state object |
| `src/rarity.js` | Upgrade rarity tiers and the depth-scaled roll |
| `src/abilities.js` | 40 draftable abilities and their effects |
| `src/passives.js` | 40 draftable passives and their modifiers |
| `src/pickups.js` | Map pickups (common + rare artifacts) |
| `src/build.js` | Folds class + passives + artifacts into one modifier object |
| `src/entity.js` | Player/bot entity factory |
| `src/progression.js` | Account XP, class unlocks, draft-pool width, save/load |
| `src/arena.js` | Wall layouts, hazard zones, collision queries |
| `src/anim.js` | Three-beat ability animation, archetypes, hit reactions |
| `src/modes.js` | Mode definitions, rotation, team helpers |
| `src/perception.js` | AI belief model — sight, bearing pings, decoy targeting |
| `src/mapmods.js` | Map evolution bands and modifiers |
| `src/pathfinding.js` | Walkability grid + bounded BFS for the bot |
| `src/physics.js` | Movement, dash, abilities, sprint/stamina |
| `src/effects.js` | Traps, projectiles, wells, beacons, barricades |
| `src/targeting.js` | Click-to-target layer |
| `src/ai.js` | Bot steering, pathing, ability decisions |
| `src/draft.js` | Draft rolling, rarity weighting, bot counter-drafting |
| `src/run.js` | Run lifecycle: duels, escalation, XP |
| `src/render.js` | Canvas rendering |
| `src/hud.js` | In-game HUD |
| `src/ui.js` | Menu, draft screen, run summary |
| `src/round.js` | Duel setup and the per-frame update tick |
| `src/main.js` | Entry point and input wiring |

Full design rationale, the multiplayer roadmap, and balance guidelines are in [docs/DESIGN.md](docs/DESIGN.md).
