# PokéRNG

A complete, playable Roblox RNG game in the Sol's RNG mould, themed around collecting creatures. Roll, chase rarer and rarer results, spend the proceeds on luck, and fill the index.

Written in Luau, synced with Rojo, no external Roblox dependencies. The map builds itself at runtime, so the entire game — logic, UI and world — is text in version control.

```bash
rokit install && rojo serve      # then Connect from the Rojo Studio plugin
```

Full instructions in [docs/SETUP.md](docs/SETUP.md).

## What's in it

**Rolling.** 152 creatures across 10 rarity tiers, from `1 in 17` to `1 in 100,000,000`. Three stacking variants — Shiny (`1 in 8,192`), Alpha (`1 in 1,024`), Shadow (`1 in 4,096`) — that multiply both the value and the rarity of whatever they land on. Server-paced auto-roll once you unlock it.

**Progression.** Trainer levels, an index that pays permanent luck per entry, completion bonuses for finishing a rarity tier or mastering an elemental type, and Champion Rebirth prestige that resets progression but never your collection.

**Economy.** Coins scale with rarity on a tuned curve. Six permanent upgrades, six potions, bulk-selling of duplicates, daily login streaks and promo codes.

**Social.** Server-wide announcements for rare finds, global top-25 leaderboards on OrderedDataStores, mirrored on physical boards in the world. An equipped buddy follows you around and grants luck scaled by how rare it is.

**Interface.** Built entirely in code: HUD with live luck breakdown, bag, index, four-tab shop, leaderboards, settings, toasts, and a reveal sequence that escalates from a quiet card to a full cinematic depending on what you hit.

## How it's put together

```
src/shared    ReplicatedStorage.PokeRNG          config, roster, roll maths, formatting
src/server    ServerScriptService.PokeRNGServer  all game logic and persistence
src/client    StarterPlayerScripts.PokeRNGClient UI and effects only
```

The client contains no game logic. It sends intent — "I want to roll", "I want to buy `luckCharm`" — and renders what comes back. It cannot say what it rolled, how lucky it was, how long it waited, or what anything costs. Prices are re-derived server-side from shared config on every purchase, rolls are performed server-side and rate-limited, and auto-roll is driven by a server loop obeying the same cooldown as a manual roll, so it is a convenience rather than a rate advantage.

Two decisions worth knowing about before you change anything:

**Rolling is two stages, not one weighted table.** A tier is chosen by walking the rarity ladder from rarest to most common, then a species is chosen within that tier. This is what lets a species' displayed rarity stay honest — adding a creature dilutes only its own tier, and tier probabilities always sum to exactly 1. [docs/BALANCE.md](docs/BALANCE.md) covers the maths.

**A failed profile load never becomes a fresh profile.** If the DataStore is unavailable, the player gets a read-only session and a visible warning rather than an empty save they would immediately write over their real one. Profiles are session-locked with a heartbeat so the same save can't be live in two servers at once.

## Checking the balance

```bash
python3 tools/run_simulation.py 2000000 1
```

Runs the real `RollEngine` — the same module the server uses — a couple of million times and prints observed rates against configured ones, asserts that tier probabilities sum to 1, and warns if a roster edit has made species rarities non-monotonic across tiers.

```
tier                  hits          observed          expected
Legendary              138       1 in 14,493       1 in 12,000
Mythic               1,372        1 in 1,458        1 in 1,500
Epic                 8,054          1 in 248          1 in 250
Rare                44,116           1 in 45           1 in 45
Uncommon           243,061            1 in 8            1 in 8
```

## Adding content

Creatures, tiers, upgrades, potions and codes are all data — one line each, no new logic. See [docs/ADDING_CONTENT.md](docs/ADDING_CONTENT.md).

## Before you publish

The default roster is the 151 original Pokémon plus MissingNo. **That is Nintendo's intellectual property, and Roblox takes games down for it** — sometimes months after launch, at their discretion.

Renaming the roster is a one-file change, deliberately: names, types and tiers all live in a single table in `src/shared/Species.luau`, and nothing else in the codebase refers to a creature by name. Swap the strings, keep the tiers, and the game plays identically.

Also worth doing before launch: fill in real game pass and product IDs in `src/shared/Config.luau` (they're `0` by default, which makes the shop show them as **SOON** rather than selling something that would fail), and turn on Studio API access so saving works.
