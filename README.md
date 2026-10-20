# TAGLITE

An online **isometric voxel pixel-art** tag game. Pick a class, join or host a lobby of up to 8 players, and play multi-round matches in four modes — Classic Duel, Infection, Freeze Squads and Hot Potato — drafting upgrades between rounds. Prefer to go it alone? Solo Run is the original endless roguelike climb against ever-stronger bots.

**Play it online:** the game is deployed to GitHub Pages — open the site, hit **PLAY ONLINE**, then **CREATE GAME** and send the room code (or the copy-link button) to a friend. Anyone can also **BROWSE** public games.

## Run it locally

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

To test online play on one machine, open two tabs of the dev server: create a game in one, join with its code in the other. In dev, `window.__taglite` exposes `state`, `setup()`, `sim()` and the `match` actions for scripting.

## Deploying

`.github/workflows/deploy.yml` builds the site and publishes it to GitHub Pages on every push to `main`. One-time setup in the repo: **Settings → Pages → Build and deployment → Source: GitHub Actions**. The site is then served at `https://<user>.github.io/<repo>/`. `vite.config.js` sets `base: './'` so assets resolve under that sub-path, and `?join=CODE` links work from there.

## Controls

| Key | Action |
|---|---|
| `W A S D` | Move (screen-relative: `W` runs up the screen) |
| `SHIFT` | Sprint (hold) |
| `SPACE` | Dash |
| `E` | Class ability |
| `1` – `4` | Drafted abilities |
| Left click | Fire an aimed ability (marked ◎) |
| Right click / `ESC` | Cancel aiming |

Aimed abilities arm on keypress and show a reticle plus range ring; click to fire.

## Online matches

Taglite is a peer-to-peer online game. **One player hosts** — their browser runs the one true simulation — and everyone else joins by room code or from the public list. There is no game server to run: players find each other through public Nostr relays (via [Trystero](https://trystero.dev)) and then talk directly over WebRTC, so the whole thing deploys as a static site.

A **match** is longer than a single duel: lobby → several rounds → results.

1. **Lobby** — pick your class, ready up; the host picks the mode, number of rounds, bot fill and bot difficulty, and can list the game publicly. Up to **8 humans**; bots fill the rest of the roster.
2. **Rounds** — each round is a full tag game on a freshly rolled map (see Modes). Roles rotate between rounds so everyone plays both sides.
3. **Intermission** — the round result, points earned, and live standings.
4. **Draft** — every human picks one of three upgrades at the same time (20s; if you stall you get the first card). Rerolls work as in solo. Bots draft too, so the field keeps pace with you.
5. **Results** — final standings, XP for your account (placing higher pays more), and a one-click rematch.

Your build is yours for the whole match. Map pickups and rare artifacts persist across its rounds.

**Netcode.** The host streams 20 Hz delta snapshots; clients interpolate other fighters about 110 ms behind and **predict their own movement locally** with the same physics the host runs, so steering and dashing stay sharp. The host reconciles you through input-sequence acks and only nudges you when you drift. Abilities are sent as intents and resolved on the host (aimed ones carry their target point, clamped to the ability's real range). Visual effects, animations, shakes and kill-feed lines are relayed as events, so every screen shows the same fight. A client that disconnects mid-round is replaced by a bot; if the host leaves, the match ends.

Practical notes: the **host's tab must stay visible** (browsers throttle hidden tabs and the round would crawl), and strict NATs can block peer-to-peer connections since no TURN relay is configured.

### Solo

- **Solo Run** is the original roguelike: an endless escalating string of rounds against bots, one loss ends the run. It runs on the same match engine (as a one-player match), so it keeps the mid-round upgrade marks and the mode rotation (Classic → Infection every 3rd → Freeze every 5th → Hot Potato every 7th).
- **Quick Bots** plays any online mode as a full multi-round match against bots.

## Modes

| Mode | Fighters | Round | Rounds | Rules |
|---|---|---|---|---|
| **Classic Duel** | 2 | 2:00 | 3 / **5** / 7 | 1v1. The tagger wins by tagging, the runner by surviving. Roles swap every round; a match can end early once it's mathematically decided. Round win = 3 pts. |
| **Infection** (Zombie Tag) | 6+ | 3:00 | 3 / **4** / 5 | One starts infected. Tagged players **turn and keep playing**. Points: +1 per conversion, +3 for surviving to the clock, +2 for each zombie when the horde wins. Patient zero rotates. |
| **Freeze Squads** | 7+ | 3:00 | 2 / **4** / 6 | About 3 hunt 4. Tagged runners freeze solid and stay rescuable — stand on a frozen ally for 0.5s to thaw them (3s cooldown). Hunters win **only** if every runner is frozen at once. Team win = 3 pts, +1 per freeze, +1 per thaw. Sides rotate. |
| **Hot Potato** | 6+ | 2:00 | 3 / **4** / 6 | Free-for-all. One carrier at a time; **tag someone to pass it** (the one who just passed it is untouchable for 1.4s). Safe time scores (1 pt per 15s not holding it) and the player who held it least earns +3. |

Solo Run uses the original single-player pacing instead (Classic 2:00, Infection 5:00, Freeze 5:00, Potato 2:00 with in-round upgrade marks at 1:00 / 2:00 + 4:00).

## The run (Solo Run)

- **Class is locked at run start.** Your side is re-rolled every round.
- **Win → draft.** Pick 1 of 3 upgrades. Rerolls are limited (1 to start, +1 every 3 rounds, cap 3).
- **Every AI drafts too**, each with its own independent build and re-rolled class.
- **The arena evolves.** Denser hazards from round 4, one map modifier from round 7, two from round 10.
- **Lose once and the run ends**, with a summary of your build and the rounds you won.

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

- **12 classes** — Rogue, Tank, Scout, Trickster (starters) plus Trapper, Hunter, Phantom, Anchor, Brawler, Warden, Skater, Chrono (unlocked by account level). Each keeps its signature ability permanently; drafts stack on top.
- **60 draftable abilities** and **60 draftable passives**, shared across all classes — 120 upgrades in total.
- **28 pickups** — 12 temporary, plus 16 rare artifacts that persist for the rest of the run. Two artifact series (**STRIDER KIT**, **BULWARK PLATE**) complete into a capstone passive when you collect all three pieces.
- **Upgrade rarity** — Common / Uncommon / Rare / Legendary. Deeper duels shift the odds upward, so long runs start surfacing build-defining picks instead of small stat bumps.

Upgrades aim to **change a rule** rather than add a number — a brand that becomes a tag if you can't break away, a slow that stacks the longer you stay close, a familiar that orbits you, a curse that trades sprinting away for reach, and a transformation that rewards focusing your draft on one kind of trait. Duplicates stack plainly, so two copies of a reach passive really is double reach.

## Progression

Account level persists in `localStorage`. It never buys raw stats — it **widens the draft pool** and unlocks classes, so new players read a smaller, clearer set of options:

| Level | Unlocks |
|---|---|
| 1 | 4 starter classes; Common + Uncommon upgrades |
| ~7 | Rare upgrades |
| ~16 | Legendary upgrades |
| 6 / 10 / 14 / 18 / 22 / 26 / 30 / 34 | Trapper / Hunter / Phantom / Anchor / Brawler / Warden / Skater / Chrono |
| ~55 | Full 120-upgrade pool |

## Ability animation

Every ability runs a **three-beat** motion — anticipation (pull back), strike (snap forward), recovery (settle to neutral) — and always ends at the rest pose so it chains cleanly back into movement.

Timing is deliberately uneven. The wind-up takes ~30% of the animation and decelerates into it; the **strike fires in a 15% window**; the recovery eases out over the rest. Even timing would smear the strike into the surrounding motion and lose the impact.

Direction is always **explicit and in world space** — every animation is authored along a vector passed in at play time (where you aimed, else the bearing to the target, else where you're moving) and projected into the isometric view when drawn. Nothing is expressed body-relatively, which is what stops a lunge going the wrong way when your aim and your facing disagree. FX reach well past the fighter sprite, so a swing never clips at the body's edge.

Seven archetypes cover all 60 abilities plus the 12 class signatures:

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

Every ability, class signature, passive, artifact and status also has its own voxel-particle effect (`src/fx.js`) — bursts, rune circles, orbiting cubes, speed lines. Several build-defining passives carry a persistent tell, so you can read someone's build before it hits you — Bloody Lust's heat ring grows with its stacks, Apotheosis orbits golden cubes per completed set, Cold Blood shows its unspent guard, Brittle Bones flashes a fracture when dazed, Quicksilver ticks off absorbed pickups.

## The world

The game is drawn as isometric voxel pixel art on a 640×400 canvas; gameplay stays top-down underneath (walls are plain rectangles, fighters are circles), so the art never changes the movement rules. Every duel is set on one of six animated maps — **Glade**, **Crystal Caverns**, **Sunken Ruins**, **Frostfall**, **Neon Foundry** and **Emberfall** — each with its own floor, voxel obstacles (swaying oaks, pulsing crystals, flickering braziers, blinking server racks, glinting ice, glowing lava veins), decor and ambient particles. Slow, speed and ice tiles look the same on every map so the rules stay readable. Fighters standing behind an obstacle show an x-ray silhouette. Every class has a distinct voxel model with its own 4-frame idle animation, a run cycle and dash / slide / stumble / cast / hit poses.

## Movement & drift

Friction is low (`FRICTION = 2.2`), so you carry real momentum. Coasting from full speed takes about **1.4s** to a crawl, and fully reversing direction takes **~0.4s** — and the reversal is a *planted turn*: it also bleeds speed and steering bite unless you have grip (Gripped Soles, Grip Chalk, Cleats, the Skater). Chases are about reading angles and cutting corners, not twitch reversals.

Running is physical rather than a free slide:

- **Stumbles** — being staggered halves your speed and steering for a moment and locks your dash. Blowing your stamina at high speed also trips you.
- **Dashing costs breath** — each dash spends a little stamina (never enough to fatigue you by itself).
- **Shoulder-bumps** — same-side fighters push each other apart by mass; opposing hunter and prey never bump (tag reach equals contact distance).
- **Body-checks and counters** — a braced or charging heavier runner shrugs a tag and staggers the hunter; Counter Stance turns a tag into a stagger.
- **Ice** — slippery ground that cuts friction; Skaters run faster on it.
- **Feel** — hit-stop on tags, screen shake on big impacts, footfall dust, sprint speed lines and a smoothed, lookahead camera.

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
| `src/abilities.js` | 60 draftable abilities and their effects |
| `src/passives.js` | 60 draftable passives and their modifiers |
| `src/pickups.js` | Map pickups (common + rare artifacts) |
| `src/build.js` | Folds class + passives + artifacts into one modifier object |
| `src/entity.js` | Player/bot entity factory |
| `src/progression.js` | Account XP, class unlocks, draft-pool width, save/load |
| `src/arena.js` | Wall layouts, hazard zones, collision queries |
| `src/anim.js` | Three-beat ability animation, archetypes, hit reactions |
| `src/modes.js` | Mode definitions (incl. online metadata), rotation, team helpers |
| `src/perception.js` | AI belief model — sight, bearing pings, decoy targeting |
| `src/mapmods.js` | Map evolution bands and modifiers |
| `src/pathfinding.js` | Walkability grid + bounded BFS for the bot |
| `src/physics.js` | Movement, dash, abilities, sprint/stamina |
| `src/effects.js` | Traps, projectiles, wells, beacons, barricades |
| `src/targeting.js` | Click-to-target layer |
| `src/ai.js` | Bot steering, pathing, ability decisions |
| `src/draft.js` | Draft rolling, rarity weighting, bot counter-drafting |
| `src/run.js` | Bot builds, per-round bot kit re-rolls, solo-gauntlet XP |
| `src/render.js` | Isometric depth-sorted scene renderer and minimap |
| `src/iso.js` | Isometric projection, picking and pixel-crisp ground primitives |
| `src/voxel.js` | Voxel model format and sprite baker |
| `src/voxelmodels.js` | Class fighter and prop voxel models, idle/run/pose frames |
| `src/themes.js`, `src/themeart.js` | The six animated map themes: floors, obstacles, decor, ambient |
| `src/fx.js` | Voxel-particle ability, passive and status effects |
| `src/bodies.js` | Soft shoulder-bump resolution and effective mass |
| `src/feel.js` | Camera follow, hit-stop, shake, footfall and speed-line effects |
| `src/icons.js` | Voxel icon tiles for abilities, passives, artifacts and classes |
| `src/hud.js` | In-game HUD |
| `src/ui.js` | Menu, class grid, draft screen |
| `src/onlineui.js`, `src/matchhud.js` | Online hub, lobby, scorebar/feed, intermission, results |
| `src/pixicons.js` | Tiny pixel glyphs for the online UI |
| `src/round.js` | Round setup (host and client) and the per-frame update tick |
| `src/match.js` | Match core: lobby, rounds, scoring, drafts, results, host/client messages |
| `src/net.js` | Trystero (WebRTC) transport, rooms, public game list |
| `src/netsync.js` | Snapshot deltas, interpolation, client-side prediction, input intents |
| `src/relay.js` | Host-to-client cosmetic event relay (FX, animations, announcements, kill feed) |
| `src/bus.js` | Tiny event bus between the match core and the UI |
| `src/main.js` | Entry point and input wiring |

Full design rationale, the multiplayer roadmap, and balance guidelines are in [docs/DESIGN.md](docs/DESIGN.md).
