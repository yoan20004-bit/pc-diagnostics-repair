# How the odds work

## Two stages, not one

The obvious way to build an RNG game is one weighted table over every creature. It falls apart as soon as you have more than a handful, because a species' displayed rarity stops meaning anything — add ten new commons and every existing creature silently gets rarer.

This game rolls in two stages instead.

**Stage 1 — tier.** Walk the rarity ladder from rarest to most common. Each tier gets one `1 in N` check, and the first success wins. `Common` is not rolled for at all; it is what you get when every other tier misses.

```
for i = #tiers, 2, -1 do
    if random() < min(1, luck / tiers[i].rarity) then return tiers[i] end
end
return tiers[1]  -- Common, the fallback
```

Because Common is the leftover, tier probabilities sum to exactly 1 no matter how you tune the ladder. The simulator asserts this on every run.

**Stage 2 — species.** Pick a species inside that tier, weighted. A tier at `1 in 12,000` holding four equally weighted species means each is `1 in 48,000`.

The payoff is that adding a species only affects its own tier. Add a fifth Legendary and the other four go from `1 in 48,000` to `1 in 60,000`; nothing else in the game moves.

## What luck does

Luck divides the `N` in every tier's check. At 100x luck, a `1 in 12,000` tier becomes `1 in 120`.

Chances are capped at 1, which produces a nice emergent behaviour at high luck: once `luck / rarity >= 1` for a tier, everything below it becomes unreachable, because the walk never gets that far. At 100x luck, Common and Uncommon stop appearing entirely. Luck does not just improve your odds, it burns off the bottom of the table.

Two multiplier layers feed in:

- **Additive** — trainer levels, index entries, completed tiers, mastered types, prestige, the Lucky Charm, your equipped buddy. These sum.
- **Multiplicative** — potions and game passes. These scale the additive total.

Keeping them separate is what stops a 750-coin potion from being worth more than an entire prestige.

## Variants

Shiny, Alpha and Shadow roll independently of the species and of each other, so they can stack. A variant multiplies both the value and the quoted rarity: a Shiny Charizard is `Charizard's 1 in 48,000` × `Shiny's 1 in 8,192`.

This is what keeps low tiers interesting for a long-term player. A Shiny Alpha Magikarp is rarer than a plain Legendary, and the personal-best record tracks effective rarity, so it counts.

## The ladder

| Tier | Rarity | Species | Each |
|---|---|---|---|
| Common | fallback (~85%) | 55 | ~1 in 17–68 |
| Uncommon | 1 in 8 | 42 | 1 in 345 |
| Rare | 1 in 45 | 20 | 1 in 347–1,040 |
| Epic | 1 in 250 | 20 | 1 in 5,004 |
| Mythic | 1 in 1,500 | 7 | 1 in 10,501 |
| Legendary | 1 in 12,000 | 4 | 1 in 48,001 |
| Ultra | 1 in 90,000 | 1 | 1 in 90,000 |
| Master | 1 in 750,000 | 1 | 1 in 750,000 |
| Ancient | 1 in 8,000,000 | 1 | 1 in 8,000,000 |
| Celestial | 1 in 100,000,000 | 1 | 1 in 100,000,000 |

Per-species rarities are monotonic across tiers — the most common Rare is still rarer than the rarest Uncommon. The simulator checks this and warns if a roster edit breaks it, because a ladder that reads as scrambled is worse than one that is merely badly tuned.

## Verifying a change

```bash
python3 tools/run_simulation.py 2000000 1      # baseline
python3 tools/run_simulation.py 500000 100     # high luck
```

It runs the real `RollEngine` — the same module the server uses, not a reimplementation — and prints observed rates against configured ones.

Sample of a healthy run at 2,000,000 rolls:

```
tier                  hits          observed          expected
Master                   4      1 in 500,000      1 in 750,000
Ultra                   18      1 in 111,111       1 in 90,000
Legendary              138       1 in 14,493       1 in 12,000
Mythic               1,372        1 in 1,458        1 in 1,500
Epic                 8,054          1 in 248          1 in 250
Rare                44,116           1 in 45           1 in 45
Uncommon           243,061            1 in 8            1 in 8
```

Rare and Uncommon land exactly. The rarest tiers swing a lot because four hits out of two million is a tiny sample — that is sampling noise, not a bug. If you want to check the deep end of the ladder, raise the luck rather than the roll count.

One warning from experience: use the simulator's own generator, not one you write. An earlier version of this file used a hand-rolled xorshift and reported Epic as never occurring in 200,000 rolls and Alpha variants at three times their configured rate. The roll table was fine; the generator was not. Measuring a distribution with a biased source tells you nothing, and it is very easy to spend an afternoon tuning a table that was never broken.

## Tuning notes

Everything below is in `src/shared/Config.luau` and `src/shared/Rarity.luau`.

- **Rolls feel too slow early.** Lower `Config.Roll.BaseCooldown` before touching rarities. Cooldown is the strongest lever on how the game feels and the weakest on how the economy behaves.
- **Progress stalls mid-game.** Raise `Config.Luck.PerIndexEntry`. It rewards the thing you want the player doing anyway.
- **Coins inflate.** `Config.Economy.CoinExponent` is the whole curve — at 0.55, a `1 in 100,000,000` roll pays about 30,000 and a common pays 3. Small changes here are large.
- **Adding a tier.** Insert it in `Rarity.tiers` in rarity order and give it at least one species. The simulator will refuse to run against an empty tier.
