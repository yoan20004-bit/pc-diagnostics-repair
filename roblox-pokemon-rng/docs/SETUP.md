# Getting it running

## The short version

1. Install [Rokit](https://github.com/rojo-rbx/rokit), then run `rokit install` in this folder. That gets you Rojo, Luau, StyLua and Selene at the versions this project was built against.
2. Run `rojo serve`.
3. Open Roblox Studio, install the [Rojo plugin](https://create.roblox.com/store/asset/13916111004), open the Rojo panel, and hit **Connect**.
4. Press Play.

You should spawn on a lit plaza with a glowing sphere in the middle, a HUD in the corners, and a **ROLL** button at the bottom. Press it or hit space.

If you would rather not install anything: `rojo build -o PokeRNG.rbxlx` produces a place file you can open directly, but you lose live sync, so you would have to rebuild after every edit.

## Turning on saving

Data saving is off until you allow it, and this catches everyone at least once.

In Studio: **File → Game Settings → Security → Enable Studio Access to API Services**. Without it, every DataStore call throws, and the game will (correctly) put you on a read-only profile and show a red banner saying progress will not be kept. That banner is the intended behaviour, not a bug — see the note on read-only profiles below.

DataStores also require the place to be published. A local, never-published place has nowhere to save to.

## Publishing

1. **File → Publish to Roblox As…**, create the place.
2. In the Creator Dashboard, create your game passes and developer products.
3. Copy their IDs into `src/shared/Config.luau` under `Config.Passes` and `Config.Products`.

Until you do step 3, every pass shows as **SOON** in the shop and cannot be bought. That is deliberate: an id of `0` means "not configured", and the code skips it rather than prompting a purchase that would fail.

## The read-only profile

If a profile fails to load — a DataStore outage, API access switched off, throttling — the player is **not** given a fresh save. They get a temporary profile that is never written back, plus a warning banner.

This matters more than it sounds. The alternative (hand them an empty profile and let them play) means their first roll saves an empty save over a real one, and a two-week collection is gone. A player who cannot save for ten minutes is annoyed; a player whose account is wiped does not come back.

## Session locking

A profile is claimed by one server at a time, using a lock with a heartbeat that autosave refreshes. If you join a second server while the first still holds your profile, the new server waits, then takes over once the old lock goes stale. This is what stops the classic duplication exploit where a player joins two servers, spends the same coins in both, and whichever saves last wins.

It is a light implementation, and it is honest about that. If your game gets big, swap `DataService` for [ProfileStore](https://github.com/MadStudioRoblox/ProfileStore), which handles the same problem with far more rigour. The interface here is small on purpose so that swap stays easy: `load`, `get`, `markDirty`, `save`, `unload`.

## Checking the balance without launching Studio

```bash
python3 tools/run_simulation.py 2000000 1
```

Rolls two million times through the real `RollEngine` and prints what actually came out against what the config claims. See [BALANCE.md](BALANCE.md).

## Formatting and linting

```bash
stylua src tools
selene src
```

## Layout

| Path | Becomes | Holds |
|---|---|---|
| `src/shared` | `ReplicatedStorage.PokeRNG` | Config, roster, roll maths, formatting — required by both sides |
| `src/server` | `ServerScriptService.PokeRNGServer` | All game logic and persistence |
| `src/client` | `StarterPlayerScripts.PokeRNGClient` | UI and effects only |

The split is strict: the client contains no game logic at all. It sends intent ("I want to roll", "I want to buy `luckCharm`") and renders what comes back. Every number it displays was computed on the server.
