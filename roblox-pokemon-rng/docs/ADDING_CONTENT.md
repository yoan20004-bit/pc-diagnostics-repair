# Adding content

Everything here is data. None of it needs new logic.

## A creature

One line in `src/shared/Species.luau`:

```lua
{ 153, "Chikorita", "rare", "Grass" },
{ 154, "Bayleef",   "epic", "Grass", nil, 2 },
```

`{ dexNumber, name, tierId, type1, type2?, weight? }`

- `tierId` must exist in `Rarity.tiers`.
- `weight` defaults to 1 and only affects how likely this species is *within* its tier. A weight of 2 makes it twice as likely as a weight-1 sibling. It does not change the tier's own rarity.
- A second type is optional; pass `nil` for it if you need to specify a weight.

Adding a species dilutes only its own tier. Everything in other tiers keeps exactly the rarity it had.

Ids must be unique — `Species.luau` asserts this at require time, so a duplicate is a startup error, not a silent overwrite.

## A rarity tier

In `src/shared/Rarity.luau`, insert in order (most common first) and renumber the `index` fields:

```lua
{ index = 11, id = "eternal", name = "Eternal", rarity = 2500000000,
  color = { 255, 60, 160 }, glow = { 255, 140, 210 } },
```

Then give it at least one species. A tier with no species is a runtime error on the first roll that selects it — the simulator catches this before you ever launch Studio.

Colours are RGB triples rather than `Color3` because the server uses them too, for the world pillars and buddy orbs, and `Color3` in a shared module would make that module unusable in the offline simulator.

## A shop upgrade

In `src/shared/Upgrades.luau`:

```lua
{
    id = "trackerBadge",
    name = "Tracker Badge",
    description = "Increases coins from Legendary and above.",
    maxLevel = 10,
    baseCost = 5000,
    costGrowth = 1.8,
    effect = "coins",
    perLevel = 0.08,
    icon = "badge",
},
```

The shop UI picks this up automatically. The `effect` string is what wires it to a stat — it must be one `LuckService.compute` already reads (`luck`, `cooldown`, `coins`, `xp`, `variant`, `autoroll`). A brand new effect needs a matching line in `LuckService.compute`, and that is the only place to add it.

## A potion

Also in `Upgrades.luau`, under `Upgrades.potions`. Set any of `luckMult`, `speedMult`, `variantMult`. Drinking a second potion of a kind you already have running extends the timer rather than stacking the multiplier.

## A promo code

In `src/shared/Codes.luau`:

```lua
{ code = "SUMMER", coins = 25000, potions = { "luck3" }, note = "Summer event" },
```

Codes are matched case-insensitively with whitespace stripped, which covers most of what players actually paste in. Set `expires` to a Unix timestamp to retire one without deleting the row, so the list doubles as a changelog.

Redemption is validated server-side and recorded per profile, so a code can only be claimed once per player regardless of what the client sends.

## Game passes and products

In `Config.Passes` / `Config.Products`. An id of `0` means unconfigured — the shop shows **SOON** and the purchase path is skipped entirely, so a fresh clone runs without a Creator Dashboard set up. Fill in real ids to switch them on.

Products are granted in `PassService.grantProduct`. Note that it deliberately refuses to grant onto a read-only profile and returns `NotProcessedYet`, so Roblox re-delivers the receipt in a later session where the grant can actually be saved. Do not "fix" that into a success return — that is how players get charged for nothing.

## Real creature models

Buddies currently render as a coloured orb with a nameplate, because this project ships no art.

To use real models: put them in `ReplicatedStorage` under a folder named by dex number, and in `BuddyService.build`, replace the orb construction with a clone of the matching model. Everything else — the weld, the bob tween, the nameplate, the variant recolouring — already works on any `BasePart`, so you only need the model to have a `PrimaryPart`.

## A note on the roster

The default roster is the 151 original Pokémon plus MissingNo. as the one-of-a-kind Celestial.

That is Nintendo's intellectual property. Roblox routinely takes down games using it, and it is entirely at their discretion — a game can run for months and vanish overnight. If you are publishing this anywhere public, rename the roster.

The good news is that it is genuinely a one-file change, and that is by design: names, types and tiers all live in the `rows` table in `Species.luau`, and nothing else in the codebase refers to a creature by name. Swap the strings, keep the tiers, and the game plays identically.
