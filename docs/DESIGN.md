# TAGLITE — Roguelike Expansion Design Document

This document expands TAGLITE from a single fixed-difficulty 1v1 duel into an endless roguelike **run**: a string of escalating duels, each followed by a draft pick, against a bot that grows its own build in parallel with you.

> **Status: built.** This started as a design reference written before any code. All eight implementation phases in §12 are shipped and verified running; multiplayer (§11) remains design-only by scope. §13 and §14 record what changed during implementation — including three design errors this document originally contained, and a later pass that moved to **5-minute duels, a halftime upgrade, belief-based AI perception, and two new modes (Zombie and Freeze Tag)**. Where this document and the code disagree, **the code is authoritative** — several statements below (3-minute duels, a single bot opponent) are superseded by §14.

Every new screen, icon, and interaction proposed below is designed to slot into the existing pixel-arcade visual language ([`src/style.css`](../src/style.css)) as-is — no new fonts, colors, or component styles. See §16 for exactly how each new UI piece maps onto existing CSS classes and canvas-drawing patterns.

Every open design fork below was resolved in conversation; those decisions are recorded as they were made, not re-litigated here. A handful of details had no strong opinion attached — those are marked **[RECOMMENDATION]** and are mine to defend, not settled fact.

---

## 1. Locked Decisions (from design Q&A)

| Question | Decision |
|---|---|
| Deliverable | This markdown doc first; implementation scope chosen afterward |
| Content volume | Literal targets: 5–10 classes (existing 4 count toward it), 20+ abilities, 20+ passives, 15+ pickups — all **new** content, additive to what exists. *(Shipped: 12 classes, 60 abilities, 60 passives, 28 pickups (12 temporary + 16 artifacts, including two 3-piece series) — see §13 and §17.)* |
| Multiplayer | Roadmap/architecture only in this pass — no networking gets built now |
| Upgrade structure | The old per-class, XP-bought, fixed 3-tier tree is **replaced** by in-run "pick 1 of 3" drafts |
| Run structure | The game becomes **runs only** (no separate quickplay mode) — a run is an endless string of duels, ends on your first loss, role (Tagger/Runner) stays randomized every duel |
| Class lock | Class is picked once, at run start, and locked for the whole run |
| Class identity | **Fully fluid** — drafts can end up taking a run far from the starting class's original feel |
| Existing class kit | The 4 existing signature abilities/passives (Blink, Shockwave, Burst, Decoy, and their passives) **stay separate and fixed** — not folded into the shared pool. The new 20+/20+ pool is additional and available to any class |
| Bot scaling | Bot **drafts from the same shared pool** as it escalates, so late-run bots are meaningfully different, not just faster |
| Bot class | Bot **re-rolls a random class every duel**, while keeping its accumulated drafted abilities/passives layered on top of whatever class it rolls |
| Map evolution | Arena evolves across the run — new layouts/hazards/modifiers as duels progress, not static |
| Pickups | Mostly temporary (today's model), plus a few rare, clearly-telegraphed **permanent artifact** pickups that persist for the rest of the run |
| Balance philosophy | **Loose/arcade** — no hard mathematical caps required, occasional blowouts are acceptable; basic stacking notes only |
| Draft rerolls | Yes — a limited reroll currency/charge so a bad set of 3 isn't a dead end |
| Flavor tone | Light — a one-line blurb per class/ability in today's terse arcade voice, no world-building |
| Pickup rarity | Two tiers: Common (temporary) and Rare (permanent artifact) |
| Meta-progression fate (old `session.xp`/`session.level`) | **[RECOMMENDATION — see §9]** |

One more input landed mid-design and is folded in throughout: **abilities can be click-to-target**, not just self-cast. TAGLITE currently has zero mouse involvement (WASD + Space + E only) — see §3 for the new input layer this requires.

---

## 2. Core Loop: The Run

```
CLASS SELECT (once)
      │
      ▼
┌──── DUEL N (role randomized, timer 3:00, arena reflects run depth) ────┐
│                                                                          │
│   WIN  ──────────────────────────────────────────────────────────►  DRAFT: pick 1 of 3
│                                                                          │   (or spend a reroll charge
│   LOSE ──► RUN ENDS ──► RUN SUMMARY                                     │    for a new set of 3)
│                                                                          │
└──────────────────────────────────────────────────────────────────────┘
      ▲                                                                   │
      └───────────────────────────── DUEL N+1 (harder) ◄──────────────────┘
```

- **A duel** is unchanged in the moment-to-moment sense: 3-minute timer, Tagger catches Runner to win, Runner survives to win. Role is still a coin flip each duel — you might defend a 6-duel lead as Runner, then have to close it out as Tagger next.
- **A run** is the new outer loop. It starts at class select, and every duel you win feeds you a draft; every duel you lose ends it.
- **Escalation** happens on two axes simultaneously, both scaling with duel number `N`:
  - The bot's build (§7) — it also drafts, and re-rolls its class each duel.
  - The arena (§8) — layout/hazard changes.
- **Ending a run** produces a **Run Summary**: duels survived, final build (your drafted abilities/passives + artifacts found), the bot's final build for duel N+1 (the one that beat you), and — if §9's recommendation is taken — the account-level reward for the run.

### Draft pacing
Offering a pick after *every* win keeps the build growing at a steady, readable pace and matches the "3 choices per upgrade event" ask directly. There's no draft after a loss (the run is over) and no draft before duel 1 (you start at your class baseline).

### Rerolls
Player holds reroll charges (**[RECOMMENDATION]**: start each run with 1, gain 1 more every 3 duels survived, cap at 3 banked). Spending one discards the current 3 options and draws a fresh 3. Rerolled-away options don't return to the pool for that same draft event.

---

## 3. New Input Layer: Click-to-Target

Today's input is entirely keyboard (`WASD` move, `SPACE` dash, `E` ability). Several new abilities (§5) are aimed — you click a point or the opponent, not just yourself. This needs:

- A **reticle/cursor** rendered in-world while an aimable ability is "armed" (press `E` to arm if you have an aimable ability equipped, then left-click to fire at the cursor's world position; right-click or `Esc` cancels). Drawn on-canvas at the same 640×400 internal resolution as everything else (see §16 and §17), projected onto the isometric ground plane, not as an HTML overlay — it needs to feel like it belongs to the same pixel world as the sprites.
- A **range indicator** (a ground-plane ring in the isometric view, matching the pixel-art style) so aiming reads clearly at the game's small internal resolution (640×400).
- Aimable abilities are clearly marked in the draft UI (a small target-reticle icon next to the name) so players know before picking whether it's self-cast or aimed.
- Bots "aim" by picking the optimal point analytically (e.g., lead the target's predicted position) — no literal cursor needed on the AI side, same predictive math the existing tagger-role AI already does in `updateBotAI`.

---

## 4. Classes (8 total: 4 existing + 4 new)

The existing four are unchanged and reproduced here only for reference; full mechanical detail is already in [`src/config.js`](../src/config.js).

| Class | Movement | Tag Mechanic | Passive | Signature Ability | Difficulty |
|---|---|---|---|---|---|
| Rogue *(existing)* | Blink-dash | Standard touch | −30% dash cooldown | BLINK — short teleport | Easy |
| Tank *(existing)* | Standard | Standard + knockback | +25% knockback, slow-zone resistant | SHOCKWAVE — push + slow | Easy |
| Scout *(existing)* | +15% top speed | Standard | — | BURST — stamina speed surge | Easy |
| Trickster *(existing)* | Standard | Standard + stealth | Brief invis after dash | DECOY — spawn a mimic | Medium |
| **Trapper** *(new)* | Standard | **Trap-tag** | Trap trigger radius +20% | SNARE FIELD — wide root trap | Medium |
| **Hunter** *(new)* | −5% speed, no mobility tools | **Ranged tag** | Extended reveal radius (spots stealth early) | HUNTER'S BOLT — click-target tag-attempt at range | Hard |
| **Phantom** *(new)* | Wall-phasing dash | Standard + post-phase iframe | Sprint fatigue doesn't weaken dash | PHASE WALK — dash through the nearest wall | Hard |
| **Anchor** *(new)* | Standard, knockback-immune | Standard + drag-on-hit | Standing still 1s+ grants a burst on next move | GRAVITY ANCHOR — click-target pull well | Medium |

### Trapper
*"Doesn't chase. Doesn't need to."*
Wins by controlling chokepoints in the maze rather than out-running anyone. SNARE FIELD (CD 12s) drops a wide root-and-reveal trap; the passive makes all of Trapper's traps (including drafted/pickup ones) trigger 20% wider. **Strength:** dominant in tight corridors. **Weakness:** poor in open ground with no traffic to bottleneck.

### Hunter
*"You don't have to catch what you can already touch from here."*
The prompt's "ranged tag" archetype. HUNTER'S BOLT (CD 7s, click-target) is a short-range tag-attempt bolt — if it connects within its band (just past melee touch range), it resolves as an actual tag. As Runner, landing it on the Tagger instead applies a brief slow (a defensive parry rather than a game-ending hit, since a Runner-initiated "tag" would be a non sequitur). **Strength:** ends chases other classes can't. **Weakness:** no mobility kit; a Hunter that whiffs its bolt or gets rushed in melee has nothing left.

### Phantom
*"Walls are a suggestion."*
PHASE WALK (CD 9s) turns the dash into a short wall-crossing burst with intangibility for its duration. Passive removes the usual fatigue speed penalty specifically from dashing, so Phantom stays mobile even sprint-starved. **Strength:** escapes/flanks no other class can pull off; unpredictable in the maze-heavy arena. **Weakness:** zero raw stat advantages — entirely positioning-dependent, punished hard by prediction-heavy Hunter/Trapper play.

### Anchor
*"Come here."*
GRAVITY ANCHOR (CD 11s, click-target) drops a well that pulls anyone caught in it inward over 2 seconds — devastating in a corridor, useless in open ground. Innately immune to knockback (not draftable — it's baseline to the class, the mirror of Tank's resistance but absolute). **Strength:** turns the maze's chokepoints into kill zones. **Weakness:** telegraphed and exploitable by anyone with room to route around it (Phantom and Scout especially).

---

## 5. Abilities (shared draft pool — any class can draft any of these)

Legend: 🎯 = click-to-target (aimed).

| # | Name | 🎯 | Effect | Cooldown | Category |
|---|---|:-:|---|---|---|
| 1 | Grapple Hook | 🎯 | Fire a hook at the clicked point; yank yourself toward it | 6s | Movement |
| 2 | Snare Trap | 🎯 | Place a hidden trap; first to step on it is rooted 1.2s + revealed | 9s (1 active) | Zone / Tag interaction |
| 3 | Phase Step | — | 0.4s full intangibility — no wall or opponent collision | 10s | Movement / Defense |
| 4 | Tag Deflect | — | If about to be tagged while armed, survive once with a knockback + 1s iframe instead | 25s | Tag interaction |
| 5 | Long Arm | — | +40% tag radius for 4s | 8s | Tag interaction |
| 6 | Piercing Touch | — | For 3s, tag registers through a single thin wall corner | 12s | Tag interaction |
| 7 | Gravity Well | 🎯 | Drop a well pulling both entities gently toward it for 3s | 14s | Physics |
| 8 | Reckless Surge | — | +50% max speed for 2s; dash disabled during it | 10s | Movement (buff) |
| 9 | Zone Paint | — | Instantly paint a speed-zone patch at your current position | 15s | Zone |
| 10 | Mud Bomb | 🎯 | Throws a bomb; creates a 6s slow zone on impact | 11s | Zone / Debuff |
| 11 | Adrenaline | — | Instantly refill stamina/sprint; immune to fatigue for 4s | 20s | Buff |
| 12 | Smokescreen | — | Emit a cloud around you; opponent's on-screen reveal check fails for 2.5s | 13s | Defense |
| 13 | Magnet Pulse | — | Instantly pull all nearby map pickups toward you | 16s | Utility |
| 14 | Overclock | — | Instantly cut all your active cooldowns by 50% | 30s | Utility |
| 15 | Sticky Glob | 🎯 | Throws a glob; the zone cell it lands in halves acceleration for whoever enters it next, once, within 3s | 10s | Zone / Debuff |
| 16 | Blink Strike | — | Short dash that also grants +tag radius during its iframe window | 8s | Tag interaction |
| 17 | Ghost Trail | — | Your next dash leaves a lingering after-image (2s) that reads as a false positive for on-screen reveal | 12s | Defense |
| 18 | Wallbreaker | — | Your next dash ignores one thin wall segment | 9s | Movement |
| 19 | Warp Beacon | 🎯 | Drop a beacon; reactivate within 5s to teleport back to it | 15s | Movement |
| 20 | Hunter's Mark | 🎯 | Marks the opponent at range; ignores invisibility for 5s | 14s | Utility / Debuff |

**Synergy notes [RECOMMENDATION]:**
- *Grapple Hook + Long Arm*: close distance then extend reach — a strong Tagger opener.
- *Phase Step / Wallbreaker + Anchor's Gravity Anchor*: counters Anchor's whole gameplan by ignoring the geometry it depends on.
- *Snare Trap + Trapper's passive*: a Trapper with this draft gets two independently-cooling traps instead of one.
- *Tag Deflect + Reckless Surge*: bait a tag, survive it, then burn the surge to put real distance down before the Tagger's next cooldown is up.
- *Smokescreen + Ghost Trail*: stacking anti-detection tools is exactly the kind of "some jank is fine" build the loose balance philosophy accepts — it's strong, not broken, since neither stops a Tagger who's already in melee range.

---

## 6. Passives (shared draft pool)

| # | Name | Effect | Category |
|---|---|---|---|
| 1 | Swift Sole | +8% max speed | Mobility |
| 2 | Iron Lungs | +25 max stamina/sprint | Stamina |
| 3 | Second Breath | +20% sprint regen rate | Stamina |
| 4 | Long Reach | +15% tag radius | Tag range |
| 5 | Featherweight | −10% dash cooldown | Mobility |
| 6 | Double Step | Gain a 2nd dash charge | Mobility |
| 7 | Thick Skin | −30% incoming knockback | Defense |
| 8 | Zone Runner | No speed/accel penalty from slow zones | Mobility |
| 9 | Static Charge | Standing still 1.5s+ grants next dash +30% distance | Mobility (positional) |
| 10 | Lucky Draw | Your next 2 draft events guarantee one pickup-synergy option | Randomness |
| 11 | Adrenal Rush | Entering fatigue is auto-cancelled once per duel | Stamina |
| 12 | Camouflage | Standing still 2s+ grants partial invisibility until you move | Stealth |
| 13 | Momentum Keeper | −15% friction (you slide further) | Mobility |
| 14 | Quickdraw | −12% on all ability cooldowns | Utility |
| 15 | Pack Rat | +25% duration on all map pickup effects | Utility |
| 16 | Night Vision | Decoys and after-images never fool your on-screen checks | Anti-stealth |
| 17 | Bloodhound | Direction ping shows exact distance, not just a heading | Utility |
| 18 | Glass Cannon | +20% max speed, −20% max stamina/sprint | Identity (risk/reward) |
| 19 | Anchor Point | Immune to knockback, −10% max speed | Identity (risk/reward) |
| 20 | Chaos Theory | Your 3 draft options are always drawn from 3 different categories | Randomness (meta) |

**Stacking notes [loose balance, per §10]:** duplicates of the same passive simply add (e.g. two Swift Soles = +16%). No dedup, no diminishing returns — the arcade-jank philosophy accepts that a run that showers you in Swift Sole is just a fast run. The two "Identity" passives (18, 19) are the intentional exception: they're drafted trade-offs, not pure upside, so they self-balance by design rather than needing a cap.

---

## 7. New Pickups (16: 12 Common + 4 Rare)

Common pickups follow the existing model exactly — instant effect on contact, duel-scoped, respawn logic identical to today's (`puTimer`, max 3 concurrent, `PU_SPAWN_POINTS`). Rare pickups are visually distinct (larger sprite, particle emitter, slower respawn) and grant a **permanent, run-scoped** bonus the instant they're picked up.

### Common (temporary)
| # | Name | Effect |
|---|---|---|
| 1 | Adrenaline Vial | Full stamina/sprint refill + 3s fatigue immunity |
| 2 | Smoke Pod | 2.5s Smokescreen effect (see ability #12) |
| 3 | Mud Flask | Leaves a slow zone at your current position |
| 4 | Ghost Step | 3s intangibility, single wall-pass |
| 5 | Overclock Cell | Refresh all your cooldowns by 50% |
| 6 | Magnet Charm | Pulls all nearby pickups toward you for 4s |
| 7 | Thick Hide | Absorbs the next knockback or slow debuff applied to you within 6s |
| 8 | Spotter Drone | Reveals the opponent for 8s (stronger than the existing Reveal pickup) |
| 9 | Decoy Flare | Spawns one wandering decoy at your position, 5s lifetime |
| 10 | Root Pod | Plants a one-shot Snare Trap at the pickup's location |
| 11 | Wind Vial | A hard forward burst — a free mini-dash, doesn't touch your dash cooldown |
| 12 | Warp Crystal | Teleports you to a random safe point on the map |

### Rare (permanent artifact — persists for the rest of the run)
| # | Name | Effect |
|---|---|---|
| 13 | Runner's Heart | +6% max speed, permanently |
| 14 | Tagger's Claw | +10% tag radius, permanently |
| 15 | Phantom Latch | Dashes permanently grant +0.15s bonus iframe |
| 16 | Endless Flask | +15 max stamina/sprint, permanently |

**Spawn logic [RECOMMENDATION]:** Commons spawn on the existing timer/point system unchanged. Rares spawn at most once per duel, at a fixed low chance (~8%) checked once per duel start, at a `PU_SPAWN_POINTS` location weighted toward the map's newest/most dangerous modifier (rewarding players for engaging with the evolving hazard rather than turtling).

---

## 8. Progression & Difficulty Scaling

### Bot scaling (per locked decisions)
Each duel, the bot:
1. Re-rolls a random class from the full roster (independent of what it played last duel).
2. Keeps every ability/passive it has drafted in past duels, layered on top of whatever class it rolled.
3. Gets one new draft pick **after every duel**, win or lose.

   > **Correction (found during implementation).** This originally read "one pick after each duel *it* wins — i.e. the ones you lose." That rule is unimplementable: the run ends on your *first* loss, so a bot that only drafts on its own wins would never draft at all, and the section's own example (a duel-5 bot holding 3 picks) contradicts it. Drafting every duel makes the two tracks symmetric — going into duel N, you and the bot each hold N−1 picks — which is what the example always described.
4. The existing `botAI` skill-scaling (`speedMult`, `jitterDeg`, `reactionT`, `predictT`, `dashChance`, `abilityChance`) continues to scale off duel number `N` the way it currently scales off player level — this stays as the "aim/execution" layer *underneath* the build-power layer the drafts add.

### Map evolution
**[RECOMMENDATION]** Tie map changes to duel number in bands rather than continuously:
- Duels 1–3: today's arena, unmodified.
- Duels 4–6: zone blob count increases (today's 6–8 → 9–12), one additional temp-zone-generating structure.
- Duels 7–9: introduce a rotating **map modifier** per duel (drawn from a small pool: "no slow zones, 2x speed pads," "outer ring is a permanent slow zone," "walls shift 20% partway through the duel").
- Duels 10+: modifiers can combine (two active at once); wall layout gets a second symmetric variant to swap in.

Duel timer stays fixed at 3:00 throughout — escalation pressure comes from bot build + map, not from giving the player less time. **[RECOMMENDATION — flagged, revisit after playtesting]**

### Adaptive AI behavior patterns
Beyond raw stat scaling, the bot's *choices* should reflect what's beating it:
- If the bot has lost its last 2 duels as Tagger specifically, weight its next draft toward tag-interaction abilities (Long Arm, Blink Strike, Piercing Touch).
- If the player has stacked stealth (Camouflage, Ghost Trail, Smokescreen), weight the bot's draft toward Night Vision / Hunter's Mark / Spotter-style counters.
This is a light heuristic layer on top of random draft — not full opponent-modeling — consistent with "some jank is fine."

---

## 9. Meta-Progression — Recommendation

This was left open in Q&A. **Recommendation:** keep a persistent account-level track, but change its job entirely.

Today, `session.xp`/`session.level` buys fixed upgrade tiers *within* a class (removed by this expansion — see §1). Repurpose the same underlying data (XP earned per run, banked permanently) to **widen the pools**, not to buy stat upgrades directly:

| Account milestone | Unlocks |
|---|---|
| Start | Base 4 classes, base ability/passive pool of ~8 each (a curated subset, not all 20) |
| Every ~3 levels | 1–2 more shared-pool abilities/passives become draftable in future runs |
| ~Level 6 | First new class (Trapper) unlocked |
| ~Level 10, 14, 18 | Remaining new classes (Hunter, Phantom, Anchor) |
| Ongoing | XP awarded scales with duels survived in a run, same shape as today's `xpGain` formula in `endRound` |

**Why:** it preserves a sense of long-term account progression (which "not sure, recommend one" suggests is still wanted) without reintroducing a stat-buying system that would conflict with the loose, drafted, in-run power curve — new players face a slightly smaller draft pool (easier to read, less overwhelming) and grow the pool's breadth as they log more runs, rather than growing raw numbers.

---

## 10. Balance & Meta Guidelines

Philosophy is explicitly **loose/arcade** (locked decision) — this section is guidance, not hard rules.

- **Stacking:** duplicate passives add plainly (§6). No hidden diminishing returns.
- **Class interaction:** no class should be *unable* to interact with another's kit — e.g. Anchor's pull still works on a Phantom, it just gives Phantom's Phase Walk a clean answer. Counters should exist (§8's adaptive AI leans on this) without being mandatory picks.
- **Anti-snowball, lightly:** the only structural guardrail is the bot's counter-drafting heuristic (§8) — it exists so the *bot* stays a threat late-run, not to cap the player's power. The player is allowed to snowball; that's the intended power fantasy of an endless roguelike run.
- **Fairness rules for future multiplayer (§11):** the loose single-player philosophy does **not** carry over 1:1 to PvP — see the multiplayer section's own balance note. Human-vs-human is where hard caps become worth revisiting.
- **Cooldown floors:** none currently enforced (consistent with "loose"), but if playtesting finds a specific stacked-cooldown-reduction build genuinely unfun to play against, a floor is the cheapest fix and should be revisited then rather than pre-emptively designed now.

---

## 11. Multiplayer Roadmap (architecture only — not built in this pass)

### Modes
| Mode | Notes |
|---|---|
| 1v1 (ranked/casual) | Direct extension of today's core loop; the one to build first since it reuses the most existing logic (`round.js` already assumes exactly one tagger + one runner) |
| 2v2 team tag | Requires a team-tag-state model (a team wins if *either* tagger-side member tags *any* runner-side member) — bigger change to `round.js`'s win-condition check than to physics/rendering |
| Free-for-all | One or more Taggers vs. many Runners in a larger arena; needs arena scaling rules (bigger `WORLD_W`/`WORLD_H` per player count) and a spectator/elimination flow for tagged-out Runners |
| Co-op challenge | All-Runner team vs. bot Tagger(s) — reuses the bot-drafting AI from §8 as the "monster," making that system's investment pay off twice |

### Netcode approach [RECOMMENDATION]
Given the physics model (client-predicted movement, discrete dash impulses, tight tag-radius checks), a **client-authoritative-with-server-reconciliation** model is the pragmatic starting point over full lockstep: each client simulates its own entity locally for responsiveness, the server is authoritative for tag resolution and pickup pickup-order (to prevent two clients both claiming a tag/pickup in the same frame), and opponent positions are interpolated between server snapshots. A relay-style WebSocket server is sufficient for 1v1/2v2; FFA at higher player counts would need snapshot-rate tuning to control bandwidth.

### Matchmaking rules [RECOMMENDATION]
- Match by account level band (§9) so a level-20 player's wider draft pool doesn't stomp a level-2 opponent's narrower one — or, alternately, normalize everyone to the *same* draft pool in ranked PvP specifically (see the fairness note below) and reserve account-level pool width for PvE runs only.
- Round-robin role assignment in 1v1 across a best-of-N set, rather than a single coin flip, so a set isn't decided by one lucky role draw.

### Progression across modes
Run-mode XP (§9) and PvP match XP feed the **same** account level and pool-unlock track — a player shouldn't need to grind both separately to unlock the same content.

### The one hard balance rule multiplayer needs that single-player doesn't
**[RECOMMENDATION, flagged clearly]:** in PvP, normalize the draft pool available to both players in a match (both draw from the same unlocked-pool snapshot, e.g. the higher-level player's pool gets temporarily capped down to the lower-level player's for that match). The "loose, some jank is fine" philosophy works against a bot because the bot is disposable and re-rolls forever; it stops being fun the instant "jank" means a human opponent had objectively fewer options than you through no skill difference. This is the one place §10's looseness should not carry over unmodified.

---

## 12. Suggested Implementation Phasing

Since the plan is "doc first, pick what to build," here's a dependency-ordered cut you can select from — each phase is playable/testable on its own:

| Phase | Scope | Depends on |
|---|---|---|
| 1 | Run loop skeleton: duel→draft→duel chain, run-ends-on-loss, run summary screen. Draft pool = existing 4 class abilities/passives only (no new content yet) as a structural proof-of-concept | — |
| 2 | New shared ability/passive pool (§5, §6) wired into the Phase 1 draft UI | Phase 1 |
| 3 | Click-to-target input layer (§3) — needed before any 🎯 ability in §5 can actually function | Phase 2 |
| 4 | Bot drafting + class re-roll (§8) — the bot's side of the same system Phase 1–2 built for the player | Phase 1–2 |
| 5 | New pickups (§7) | — (independent, can slot in anytime) |
| 6 | New classes (§4) — Trapper first (no new input needs), then Anchor (reuses 🎯 from Phase 3), then Hunter/Phantom | Phase 3 for Hunter/Anchor's aimed kit |
| 7 | Map evolution bands (§8) | — (independent) |
| 8 | Meta-progression rework (§9) | Phase 1 (needs run summary to award from) |
| 9 | Multiplayer (§11) | Everything above should be stable first — this is its own project, not a "phase" in the same sense |

Phases 1–2 alone already deliver the core "it's a roguelike now" feeling; everything after is genuine expansion rather than prerequisite.

---

## 13. Implementation Status & Post-Design Changes

All eight phases in §12 are **built and verified running**. Multiplayer (§11) remains design-only, as scoped.

Four things changed during implementation. Each is a correction to this document, not a deviation from it:

**1. The bot's draft cadence (§8).** Corrected inline — the original rule was unimplementable against an endless run that ends on your first loss. The bot now drafts every duel, keeping both tracks symmetric.

**2. Content expanded past the original targets.** The pools grew from 20 → 40 → **60 abilities** and 20 → 40 → **60 passives** (120 draftable upgrades total), across three expansion waves; the last (§17) added 4 classes (12 total), 20 abilities, 20 passives and 12 artifacts. The §5/§6 tables below describe the original 20 of each; [`src/abilities.js`](../src/abilities.js) and [`src/passives.js`](../src/passives.js) are authoritative for the full set.

The final wave took its cues from Hades and The Binding of Isaac — specifically the idea that the best roguelike pickups **change a rule** rather than adding a number. Translated into tag verbs (reach, tempo, positioning, information) rather than combat ones:

| Ability | Rarity | What it does | Lineage |
|---|---|---|---|
| BRAND | Rare | 3s timer; if they're still near you when it expires, it lands as a tag | Ares' Doom — delayed inevitability |
| THUNDER CALL | Uncommon | Telegraphed ring detonates after 1.2s: shove + slow | Zeus — dodgeable AoE |
| DRUNKARD'S TRAIL | Uncommon | You leave slow puddles behind you for 5s | Dionysus' lingering hangover |
| FROSTBITE | Uncommon | Being near them stacks a slow, up to 5 | Demeter's Chill stacks |
| TIDAL SHOVE | Uncommon | Cone blast: heavy shove and a daze | Poseidon's displacement |
| DICE SHARD | Uncommon | Teleports *both* of you somewhere random | Isaac's D20 — a gamble both ways |
| SEEKER ORB | Rare | Slow homing orb that chills on contact | Artemis / Isaac homing tears |
| SIPHON BEAM | Rare | Roots you 0.6s, then fires a rooting line | Isaac's Brimstone — charge as risk |
| HUNGRY SHADE | Rare | An orbiting familiar that chills on touch | Isaac familiars |
| REVERSAL WARD | Legendary | Their next tag swaps you and punishes them | Athena's deflect |

| Passive | Rarity | What it does | Lineage |
|---|---|---|---|
| BOILING BLOOD | Common | +25% acceleration while right on top of them | Isaac's proximity items |
| DEATH'S TOUCH | Uncommon | Tag reach grows the longer the duel runs | Isaac — power that compounds |
| QUICKSILVER | Uncommon | Each pickup: +3% speed for the rest of the duel | Isaac stacking pickups |
| THE COMPASS | Uncommon | They never leave your minimap | Isaac's Compass |
| BLOODY LUST | Rare | Close quarters stacks +4% speed, up to 5 | Isaac's Bloody Lust |
| PRIVILEGED STATUS | Rare | 2+ debuffs on them → +18% speed | Hades' Privileged Status |
| DIVINE DASH | Rare | Dashing through them slows them | Athena's deflect-dash |
| BRITTLE BONES | Rare | +25% speed, but wall hits daze you | Isaac cursed items |
| MOM'S GRIP | Legendary | +40% tag reach, but you cannot sprint | Isaac's Mom's Knife trade-off |
| APOTHEOSIS | Legendary | +6% speed per 3 same-category traits you hold | Isaac's Guppy transformation |

Two of these needed mechanics the engine didn't have, both now general-purpose: **status stacking** (chill stacks that melt over time, and a debuff count other traits can read) and **familiars** (owner-orbiting entities). `APOTHEOSIS` also reads the player's own build during modifier computation, which is what makes a focused draft beat a scattered one.

One bug this wave surfaced: `DIVINE DASH` originally tested instantaneous distance, so Rogue's Blink and Phantom's Phase Walk **teleported straight past** the opponent without ever registering a pass-through. It now measures against the dash *path* (start point → current position), which is the honest reading of "dashing through someone" and works for impulse and teleport dashes alike.

**3. Upgrade rarity added** — a system this document did not originally specify. Draftable upgrades now carry one of four tiers, and the odds shift with run depth:

| Tier | Colour | Duel 1 | Duel 16 |
|---|---|---|---|
| Common | dim grey | 56% | 26% |
| Uncommon | teal | 28% | 31% |
| Rare | purple | 12% | 26% |
| Legendary | gold | 4% | 16% |

Each of the three draft slots rolls its own tier, so a single draft can mix them. This is distinct from the two-tier *pickup* rarity in §7, which describes map spawns rather than drafts.

A design flaw surfaced here and was fixed: §9's account-level pool widening originally took a flat slice off the front of each content list. Since the lists are ordered by rarity, that made Rare and Legendary upgrades unreachable at *every* level. The slice is now taken **per rarity tier**, with higher tiers gated behind a wider pool — which is what actually paces progression, while the rarity roll controls frequency.

**4. Sprint and stamina were reworked** to model real exertion rather than a linear bar. Sprinting now raises both top speed *and* acceleration; cost climbs the longer a burst is sustained (~18/s → ~44/s); output tapers as the tank empties, so top-speed sprinting is impossible while gassed; recovery starts in oxygen debt (~6/s) and ramps to full (~32/s), roughly halved while still running hard; and blowing the tank requires regaining real breath, not just waiting out a timer. Measured curves are in the README.

One dev affordance worth noting: `src/main.js` exposes `window.__taglite` (state + a fixed-step `devStep`) under `import.meta.env.DEV` only, so the run loop can be driven deterministically while testing. It is stripped from production builds.

---

## 14. Wave 4 — Modes, Perception, and the 5-Minute Duel

A later pass changed four things this document had treated as fixed, and added two modes it never anticipated.

### 14.1 Duel length and in-duel upgrades
Duel length and upgrade timing are **per mode**, declared in `modes.js` as `duration` and `draftMarks` (elapsed-time points):

| Mode | Length | Upgrade marks |
|---|---|---|
| Classic | 2:00 | 1:00 |
| Zombie Tag | 5:00 | 2:00, 4:00 |
| Freeze Tag | 5:00 | 2:00, 4:00 |

At a mark the duel pauses, you take 1 of 3, the pick applies immediately for the rest of that same duel, and play resumes with the clock preserved. Every AI drafts at the same marks, so the symmetry from §13 holds. The longer modes therefore hand out three picks per duel (two in-duel plus the win reward), which is why the pools needed to be as deep as they are.

### 14.1b Role base stats
The two sides are no longer mechanically identical. Applied in `computeMods` **before** class traits and drafted upgrades, so they are genuinely baseline:

| | Speed | Sprint stamina | Dash CD | Ability CD |
|---|---|---|---|---|
| Hunter | +20% | +10% | −10% | — |
| Prey | — | — | — | −10% |

Hunters get the legs; prey get the toolkit — an intentional asymmetry that makes the randomised role assignment feel like two different jobs rather than a coin flip over the same kit. In Zombie Tag this is live: conversion calls `refreshMods(prey, prey.build, true)`, so turning switches your baseline mid-duel.

At +20% speed the hunter advantage is substantial: in automated chases the bot tagger now catches a fleeing player in 3 of 3 runs, up from 2 of 3 at +5%. Prey are expected to survive on the toolkit (cheaper abilities), map knowledge and stealth rather than on raw pace — **worth watching in playtest**, since it leans on drafted upgrades doing their job.

### 14.2 The AI no longer knows where you are
Previously `updateBotAI` read `player.x/player.y` directly — the bot was omniscient, and every stealth tool in the game was cosmetic. Bots now run on a **belief** (`src/perception.js`), fed by exactly the two channels the player has:

| Source | What it gives | Result |
|---|---|---|
| Line of sight | Exact position, if in range, unobstructed, and not concealed | belief snaps to truth, confidence 1.0 |
| Directional ping | A **bearing only**, on the player's own ping cadence | belief projected along the bearing with a *guessed* distance |

Between updates the belief coasts on its last heading and confidence decays to zero. Measured: a bot with no line of sight held a belief ~1000px from the player's true position while confidently hunting it. It still won 2 of 3 live chases, so the bot is fooled rather than crippled. Aim jitter now scales with `1 - confidence`, so an uncertain bot visibly flails.

**This is the change that makes §5/§6's concealment picks matter.** Smokescreen, Camouflage, Ghost Trail and Predator Sense were previously near-worthless against an omniscient opponent.

### 14.3 Decoys became a real tool
Decoys were static-speed drifters that the AI ignored outright. Now:
- They are **candidate quarries** — indistinguishable from real fighters to a bot without a clean look.
- The bot **commits**: it picks a target and chases it for 1.4–3.2s instead of re-evaluating every frame, so a decoy actually buys time.
- Fool rate scales with bot skill: **78% at duel 1 → ~10% at duel 13**, never zero.
- They move like players — velocity and momentum, committed heading changes, wall avoidance, dash-like bursts (speed ranges 7→173), and a flee bias away from whoever hunts their owner.

### 14.4 New modes (variant duels inside one run)
The engine went from two hard-coded entities (`state.player`, `state.bot`) to an **entity list** with teams, so modes are declarative (`src/modes.js`). Arena size scales per mode via ES-module live bindings on `WORLD_W`/`WORLD_H`.

| Mode | Cycle | Fighters | Arena | Length | Win condition |
|---|---|---|---|---|---|
| Classic | default | 2 | 1500×950 | 2:00 | Tag, or survive the clock |
| Zombie Tag | every 3rd duel | 6 | 2000×1250 | 5:00 | Horde converts everyone / survivors outlast |
| Freeze Tag | every 5th duel | 7 (3 v 4) | 2100×1300 | 5:00 | **All 4** frozen simultaneously / runners outlast |

- **Zombie**: being tagged converts you and you keep playing — a loss only happens if you're a zombie when the clock expires. Your side is randomised, so you may start as patient zero.
- **Freeze**: thaw by standing on a frozen ally for 0.5s, on a 3s cooldown per rescuer, so nobody chain-rescues a whole team. No auto-thaw — one free runner can keep resurrecting the side indefinitely, which is what makes the "all frozen at once" condition tense. Frozen players keep full vision plus a directional arrow to their nearest free ally.
- The rotation is **fixed and announced**: the draft screen previews the next duel's mode so you can draft for it.
- Every AI carries an **independent build and class** (`run.aiBuilds`, `run.aiClasses`), so a late horde is a mix of kits.

### 14.5 Handling and the AI sprint bug

**Friction halved** (`4.4 → 2.2`) so movement carries momentum: coasting from speed runs 1.15s / 62px, and a full reversal takes 0.45s. Snap turns are no longer free, which is the intent — chases become about angles and cutting corners.

> **Measured side effect, flagged.** Friction was previously the *actual* speed limiter, not the hard cap: the equilibrium `BASE_ACCEL/FRICTION` was ~127, below the ~162 cap. Halving friction moved the limiter to the cap, so everything got **~57% faster** (cruise 127 → 200, sprint → 293) as well as driftier. If only the drift was wanted and not the pace, dropping `BASE_ACCEL` to ~280 restores the old top speed while keeping the new handling — a one-line change in `config.js`.

**Bots now actually sprint.** They previously ran at ~0–2% sprint uptime, which read as them jogging everywhere. Two causes, both fixed:

1. The decision keyed off distance to the bot's **belief**, which is `9999` when it has no idea where anyone is. A fleeing bot that had lost track — precisely when it most needs to run — failed the `d < 200` test and jogged.
2. The reaction-delay early-return returned `sprint:false`, so every reaction window also cancelled the legs.

It's now framed as *reasons to run* (close a gap, break away, reach a frozen ally, or having lost track entirely), committed to in bursts of 0.7–1.6s with a matching rest hold, and rationed by the §14 stamina curve rather than by a hard gate. Result: **~37% sprint uptime** with 9–37 distinct bursts per duel, no self-inflicted fatigue.

### 14.6 Ability animation

Abilities previously resolved instantly with at most a particle burst. They now run a **three-beat** motion — anticipation, strike, recovery — implemented as a single timing curve in `src/anim.js` and always settling back to the rest pose so it chains into normal movement.

The source material for this was a guide on prompting an AI *sprite-generation* tool. TAGLITE has no sprite pipeline — entities are 10×10 flat-colour squares drawn procedurally at 320×200 — so the frame-extraction advice doesn't apply, but the animation grammar underneath transfers directly:

| Principle | Implementation |
|---|---|
| Three beats, ending at rest | `threeBeat(t)` returns reach in [−1, 1]: winds to −1, snaps to +1, settles to 0 |
| Uneven timing — don't miss the strike | Wind-up 30% of the timeline (eased), **strike in a 15% window**, recovery 55% |
| Direction in screen space, not character space | `playAnim(kind, owner, dir)` — direction is a required explicit vector (aim → target bearing → movement), never body-relative. Camera is axis-aligned, so world space *is* screen space |
| Leave margin in the attack direction | FX drawn in world space, reaching 20–40px past the 10px sprite, so a swing never clips at the body |
| Hit reaction as a pair | Every landing effect plays a complementary `hit` flinch on the recipient |

Seven archetypes cover all 60 abilities and 12 class signatures (`thrust`, `throw`, `slam`, `cast`, `pull`, `dash`, `shove`), mapped by ability id with category fallback. Archetype FX are drawn in the isometric view with pixel lines and ground rings; each ability and passive also has a bespoke voxel-particle effect in `src/fx.js`.

The pair is genuinely complementary rather than two unrelated motions: measured at the strike frame, the attacker is offset +8 along the aim and scaled 1.45×/0.80× (stretching into the blow) while the victim is offset −3.4 and scaled 0.86×/1.17× with a 0.17 rad lean (compressing away from it).

Verified: all 60 abilities animate with no errors, peak 4 concurrent animations across a 7-duel run, animation active on 52% of frames, and zero leaked instances at the end.

The build-defining passives also got persistent tells (Bloody Lust heat, Apotheosis motes, Cold Blood guard, Brittle Bones fracture, Mom's Grip reach ring, Quicksilver ticks), so a fight is readable at a glance.

### 14.7 Layout fix

The game screen's top was being cut off with only the lower half scrollable. Cause: `.screen` used `justify-content: center` with `overflow-y: auto` — centred flex content overflows in **both** directions, but a scroll container can only reach downward, so the top became permanently unreachable. Fixed with `justify-content: safe center`, which centres when content fits and falls back to top-aligned when it doesn't. The canvas is now also bounded by viewport height (`calc((100vh - 48px) * 1.6)`, matching its 1.6:1 ratio), so a short window no longer pushes the HUD and arena off-screen.

**Balance note, flagged for playtest:** Freeze Tag gives the player 3 AI-controlled team-mates whose rescue decisions you can't direct. If the AI rescue heuristic proves too passive, the mode will feel unwinnable through no fault of the player — this is the most likely thing to need tuning first.

---


## 17. Isometric Voxel Overhaul

The user explicitly overrode the original "flat canvas primitives, not higher fidelity" rule (§16): the whole game is now rendered as **isometric voxel pixel art**, and the movement model was reworked to feel like real running. Gameplay logic is unchanged in structure: the world is still top-down `x,y` with AABB walls and circular fighters; only presentation and input mapping are projected.

**Rendering.** Canvas2D at 640×400 internal; `ISO_X=2, ISO_Y=1, ISO_Z=2` (1 voxel = 1 world unit). `src/iso.js` holds the projection (`project`, `screenToWorld`, ground rings/discs built from pixel runs), `src/voxel.js` bakes layered ASCII voxel models into cached sprites of pre-drawn 4×4px cubes, `src/voxelmodels.js` has the 12 class fighters (4 facings, 4-frame class-specific idle, 4-frame run, dash/slide/stumble/cast/hit/air/frozen) and props, `src/themes.js` + `src/themeart.js` the six animated map themes, `src/fx.js` voxel ability/passive/status effects, `src/render.js` the depth-sorted scene (sorted by `x+y`; fighters hidden behind obstacles show an x-ray silhouette). The camera is the world point at screen centre with lerp follow and velocity lookahead. **WASD is screen-relative** (`W` = up the screen). The canvas is scaled in integer multiples when ≥2×.

**Maps.** Each duel rolls one of six themes (Glade, Crystal Caverns, Sunken Ruins, Frostfall, Neon Foundry, Emberfall; duel 1 is always Glade; never the same theme twice in a row). Obstacles are built from voxel motifs per theme (swaying oaks, pulsing crystals, flickering braziers, blinking server racks, glinting ice, glowing lava veins) with animated floors, non-colliding decor and ambient particles. Collision is still the plain wall AABBs, so the art never changes the movement rules; slow/speed/ice tiles share one readable look in every theme.

**Movement feel.** Stumbles and staggers (`applyStagger`), planted-turn braking when reversing against momentum, a stamina cost on dashes, a fatigue stumble when you blow the tank at speed, soft shoulder-bumps between same-side fighters scaled by mass (`src/bodies.js`; opposing hunter/prey pairs never bump, since tag reach equals contact distance), body-checks and counters in `canTag`, an ice surface (plus the GLAZE map modifier), hit-stop on tags, screen shake, footfall dust and sprint speed lines.

**Content.** 4 new classes (Brawler lv22, Warden lv26, Skater lv30, Chrono lv34), 20 abilities, 20 passives, 12 artifacts, including two 3-piece series with capstones (STRIDER KIT → FIRST WIND, BULWARK PLATE → IMMOVABLE). Spellwright was used for inspiration only; all names and numbers are original.
## 15. Open Items for Playtesting

These are called out throughout but worth collecting in one place — decisions made with a stated `[RECOMMENDATION]` tag that are cheap to change later and should be revisited once there's an actual build to play:

- Fixed 3:00 duel timer vs. scaling it with duel depth (§8).
- Reroll charge economy: starting count, gain rate, cap (§2).
- Rare pickup spawn chance (§7).
- Meta-progression milestone pacing (§9).
- Whether the bot's counter-drafting heuristic (§8) needs to be stronger or weaker once real playtesting shows how snowbally player builds actually get.

---

## 16. Visual & UI Design Continuity

The existing look — dark panels with hard pixel borders, `Press Start 2P` for labels, `VT323` for body text, box-shadow "pixel bevel" edges — is good and every new screen below is built to extend it, not replace it. *(Superseded in part by §17: the in-world canvas is no longer flat top-down primitives, it is an isometric voxel pixel-art scene.)* Concretely:

| New UI need | Reuses existing component | Notes |
|---|---|---|
| Draft screen ("pick 1 of 3") | `.class-card` (per-item `--card-color` accent, same hover/select treatment) laid out 3-across | Same card anatomy as class select: `Press Start 2P` name line, `VT323` description lines. A small reticle glyph in the corner marks 🎯 (aimed) options — no new icon system, just a tiny inline shape drawn the same way the existing `.swatch` color dot is |
| Run summary screen | `#screen-end` verbatim — `.pixel-panel`, `#end-result` win/lose color states, `.tree`/`.tier` rows (repurposed from "upgrade tiers" to "duels survived / build acquired / artifacts found" line items), `#end-buttons` with `.pixel-btn` + `.pixel-btn.ghost` | This screen already exists and already has the right bones; it just displays different content now |
| Click-to-target reticle & range ring | Drawn directly in `render.js` at the internal 640×400 resolution with `ctx.imageSmoothingEnabled = false`, same as every other in-world element | The range ring is a pixel-run ellipse on the isometric ground plane (`groundRing` in `iso.js`) |
| Rare vs. common pickup distinction | Commons are small voxel gems, rares are larger animated voxel crystals with a pulsing ground ring | Same pickup language, bigger and animated for rares |
| Per-duel map modifier banner | `#announce` element, unchanged (`Press Start 2P`, gold, fade in/out) | Same component that already shows "YOU ARE THE TAGGER" — just fires again at duel start with the modifier name |
| HUD ability bar generalizing from 2 fixed slots to N drafted actives | `.ability-icon` (44×44, `.cd-overlay` cooldown mask, `.key` corner keybind tag) repeated in a row inside `#hud-bl` | Same component, just no longer hardcoded to exactly `#icon-dash` + `#icon-ability` |
| New class colors (Trapper, Hunter, Phantom, Anchor) | New `--trapper`, `--hunter`, `--phantom`, `--anchor` custom properties added to `:root` alongside the existing four | Picked to stay visually distinct from both the existing class colors *and* the semantic colors (`--danger` red, `--gold`, `--accent` teal are reserved meanings — Tagger/Runner banners, timer states, UI accents — and shouldn't get reused as a class identity color) |

**Suggested new class colors**, chosen to read clearly against `--bg:#0b0d16` and not collide with existing hues:

| Class | Color | Hex |
|---|---|---|
| Trapper | Olive/khaki | `#a8a23f` |
| Hunter | Burnt orange-red | `#e0673f` |
| Phantom | Pale ice blue | `#8fd6ff` |
| Anchor | Slate blue-grey | `#5c6b9b` |

**Hard rule for implementation:** no third font, no colors outside the extended CSS-variable palette above, no departure from the pixelated/`image-rendering:pixelated` rendering approach even for entirely new visual elements (traps, projectiles, gravity wells, beacons). The in-world art is now isometric voxel pixel art (§17): new elements are baked voxel models or pixel-run ground rings and cubes, never anti-aliased vector shapes.
