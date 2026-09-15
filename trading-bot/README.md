# Phantom Solana Trading Bot

An automated, risk-managed trading bot for Solana with a **browser control panel**, trading
from a wallet you can watch in **Phantom**. It scans the market for tradeable tokens, screens
them for rug and honeypot risk, generates entries from technical signals, and manages every
position with stop-loss, laddered take-profit, trailing stop and time exits. Swaps execute
through **Jupiter Ultra** (Jupiter handles routing, priority fees, transaction landing and
MEV protection), with the classic Jupiter Swap API as a fallback.

Double-click `start.bat` (Windows) or run `./start.sh` (macOS/Linux) and the panel opens at
<http://localhost:8787>.

> **This bot can lose money.** Crypto markets are volatile, memecoins are adversarial,
> and no strategy wins consistently. Start in paper mode, fund the bot wallet only with
> what you are prepared to lose, and read the risk section before going live.

---

## How Phantom fits in

Phantom is a wallet app, not a trading API: nothing can drive the Phantom UI to click
"swap" for you. What Phantom *does* give you is the private key of any account it holds
(**Settings → Manage Accounts → your account → Show Private Key**). That base58 string is
exactly what this bot uses to sign transactions.

Recommended setup:

1. `npm run wallet:new` generates a fresh **dedicated bot wallet**.
2. Import that private key into Phantom (**Add / Connect Wallet → Import Private Key**)
   so you can watch balances and trades in the app.
3. Send only your trading budget plus ~0.05 SOL for fees to the bot wallet.

Using your main Phantom account is possible (export its key the same way) but not
recommended: the key lives in a `.env` file on your machine, and a bug or a compromised
computer can drain everything that account holds.

---

## Control panel

The bot serves a dashboard while it runs (`npm run panel`, `start.bat`, or plain `run`):

| Tab | What you can do |
|---|---|
| Overview | Market-regime status, balance, daily and all-time PnL, open positions with live gain / stop level / take-profit progress, one-click **Sell 50%** / **Close**, candle chart with entry/stop/TP/trailing lines, realised-PnL chart, engine summary |
| Market | Every tracked token with live signal (action + confidence + reasons), price, 1h/24h change, liquidity, market cap, volume, holders, organic score, safety score, buy/sell flow; **Buy** or stop tracking |
| Trades | Full trade history with PnL, fees and Solscan links |
| Analytics | PnL by strategy, exit reason, token and hour; execution quality (quote vs fill) per token; auto-blacklist management |
| Logs | Live streaming log with buy/sell highlights |
| Tools | Check any token's safety report, place a manual buy, add a token to the watchlist, run a backtest with an equity chart, run the walk-forward parameter tuner and apply its result |
| Settings | Quick settings for strategy, sizing, exits, limits and scanner filters (applied instantly), plus the full YAML config with validation |

Top bar: **Start / Stop** the trading loop, **Pause entries** (exits are still managed),
**Scan now**. Trade notifications pop up as they happen.

The panel binds to `127.0.0.1` only. To open it from your phone on the same Wi-Fi set
`PANEL_HOST=0.0.0.0` **and** `PANEL_TOKEN=<long random secret>` in `.env`, then browse to
`http://<pc-ip>:8787/?token=<secret>`. Anyone who can reach the panel can trade with the
wallet, so never expose it without a token, and use a VPN or SSH tunnel for remote access.

## What makes it good

| Upgrade | Why it matters |
|---|---|
| **ATR-scaled stops and risk-based sizing** | Each position gets its own stop from current volatility (2.5 × ATR, clamped 4–15%), and the size is capped so a stop-out costs at most `riskPerTradePct` of the balance. Calm tokens get bigger positions, wild ones smaller with wider stops. |
| **Profit-lock stops** | After each take-profit rung the stop moves to half of the banked gain instead of only breakeven, so a winner cannot turn into a loser. |
| **Higher-timeframe confirmation** | Buys are only allowed when the 5× candle trend (fast EMA above slow) agrees with the 1-minute signal. Cuts most fake breakouts. Used by the live bot and the backtester alike. |
| **SOL market-regime filter** | No new entries while SOL is below its higher-timeframe EMA or has dropped more than 4% in the last hour. Memecoins rarely rally against a falling SOL. Exits are always managed. |
| **Sell-path verification** | Before every buy the bot quotes the round trip (buy, then sell what it would receive). More than `maxRoundTripLossPct` lost means transfer tax or an unsellable token: skipped and auto-blacklisted. |
| **Execution-quality tracking** | Every fill is compared with its quote. Average shortfall per token shows on the Analytics tab, and tokens that consistently fill worse than `autoBlacklist.maxAvgSlippagePct` are blacklisted automatically. |
| **Fast exit loop** | Held tokens are re-priced every 4 s (configurable) on top of the main 15 s loop, so stops and trailing exits fire on the move. |
| **Walk-forward tuner** | `npm run tune -- --mint <a> --mint <b>` (or the panel) searches EMA/RSI/stop/trail/score combinations, ranks them only on the 30% of history they never trained on, and applies the winner with `--apply`. |
| **Feed watchdog + supervisor** | Alerts (log + Telegram) when prices stop arriving; `npm run supervise` restarts the bot if it ever crashes. `/api/health` for external monitors. |
| **Two-way Telegram** | `/status`, `/positions`, `/pause`, `/resume`, `/scan`, `/close SYMBOL [pct]`, `/stop`, `/start` from the configured chat only. |
| **Encrypted key storage** | `npm run wallet:encrypt` stores the key as `data/wallet.enc` (scrypt + AES-256-GCM); the bot asks for the password at start or reads `WALLET_PASSWORD`. `PRIVATE_KEY` can then be removed from `.env`. |
| **Charts and analytics on the panel** | Candle chart per token with entry, stop, take-profit and trailing lines; PnL by strategy, lane, exit reason, token and hour. |
| **New-launch sniping lane (opt-in)** | A second strategy with its own budget, limits and exits that buys tokens minutes after launch when the first tape looks healthy: buyer pressure, liquidity depth, holder growth, no mint/freeze authority, clean holder profile, sell path proven. Off by default. |
| **Holder-quality analysis** | Three RPC calls per candidate: excludes pools and program accounts from concentration, detects bundled launches (clusters of near-identical balances) and throwaway wallets (top holders with no SOL). Bundled tokens are hard-rejected. |
| **Streaming prices** | Subscribes to a pool's token vaults over the RPC WebSocket for sub-second prices on held and tracked tokens (PumpSwap, Orca, Meteora pool-owned vaults; Raydium v4 decoded). Held tokens get an exit check within a second of a move. Polling remains as fallback. |
| **Attention signals** | DexScreener boosts and socials plus Jupiter trader-growth and holder-change stats nudge the scanner ranking and the launch score. X and Telegram scraping are not included (they need paid API access). |

## Features

| Area | What it does |
|---|---|
| Market scanning | Pulls Jupiter's top-trending / top-organic-score / top-traded lists and DexScreener boosted tokens; merges with your watchlist |
| Safety screening | Mint & freeze authority (on-chain), Token-2022 risky extensions, Jupiter Shield warnings, liquidity, market cap, token age, holder count, top-holder concentration, organic score, buy/sell flow, honeypot heuristics |
| Market data | Jupiter Price v3 (live), DexScreener pairs (liquidity, volume, buys/sells, price change), GeckoTerminal OHLCV to bootstrap candle history so strategies can act immediately |
| Strategies | `momentum` (EMA alignment + crossover + RSI + MACD + volume/flow), `meanReversion` (RSI/Bollinger dip-buy inside an uptrend), `breakout` (range break with volume), `composite` (weighted blend, default) |
| Position management | Stop-loss, breakeven stop after first take-profit, laddered take-profit (partial exits), trailing stop, max hold time, strategy exit signals |
| Risk management | Per-trade size (fixed SOL and % of balance), max open positions, max total exposure, SOL reserve, daily loss circuit breaker, max trades/day, loss-streak cooldown, per-token re-entry cooldown, max price impact / slippage on every quote |
| Execution | Jupiter Ultra order → sign → execute (fees, landing, MEV handled by Jupiter) with retry and Swap-API fallback; real fills measured from wallet balance changes |
| Paper trading | Same loop, simulated fills with slippage and fees, persistent virtual wallet |
| Backtesting | Same strategy + exit rules over historical candles (from a CSV or fetched for any mint) |
| Persistence | SQLite (Node built-in, no native build) for positions, trades, risk state |
| Alerts | Optional Telegram messages for every buy, sell, failure, start/stop |
| Manual control | Panel buttons, or CLI: `buy`, `sell`, `check <mint>`, `scan`, `balance`, `positions` |
| Control panel | Local web dashboard (JSON API + live event stream) with every feature above |

---

## Requirements

- Node.js **22.13+** (uses the built-in `node:sqlite`). Node 24 works too.
- A Solana RPC endpoint. The public one works for paper testing; for live trading use a
  dedicated provider (Helius, QuickNode, Triton…). Helius endpoints automatically get
  their priority-fee estimator used by the `swap` engine.
- A free Jupiter API key from <https://portal.jup.ag>. Without one the bot falls back to
  `lite-api.jup.ag`, which Jupiter is sunsetting and rate-limits hard.

---

## Quick start

```bash
cd trading-bot
npm install
cp .env.example .env        # then edit .env
```

Fill in `.env`:

```ini
PRIVATE_KEY=<base58 from Phantom or `npm run wallet:new`>
RPC_URL=https://mainnet.helius-rpc.com/?api-key=...
JUPITER_API_KEY=...
MODE=paper
I_UNDERSTAND_THE_RISKS=no
PANEL_PORT=8787
```

Or skip the terminal entirely: `start.bat` / `./start.sh` installs dependencies, creates
`.env` from the example on first run, starts the bot and opens the panel in your browser.

Check the setup:

```bash
npm run doctor                            # verifies Node, .env, wallet, RPC, Jupiter, DexScreener, config, panel port
```

Try the tooling:

```bash
npm run scan                              # what would the bot trade right now, and why
npx tsx src/index.ts check <mint>         # full safety report for one token
npm run backtest -- --mint <mint>         # replay the strategy on that token's history
npm run paper                             # run the bot with simulated money
```

Go live only after paper results look sane:

```ini
MODE=live
I_UNDERSTAND_THE_RISKS=yes
```

```bash
npm run live
```

`Ctrl+C` stops the loop cleanly. Open positions are stored in `data/bot.db` and picked up
again on the next start.

---

## Configuration (`config.yaml`)

Everything about *what* and *how* to trade lives in `config.yaml`; secrets live in `.env`.
Every key has a sane default, so you can delete what you do not care about.

### Loop
| Key | Meaning |
|---|---|
| `pollIntervalSec` | price refresh + exit checks (default 15 s) |
| `fastExitIntervalSec` | extra price checks for held tokens only (default 4 s, 0 = off) |
| `staleFeedAlertSec` | alert when no price has arrived for this long |
| `scanIntervalSec` | how often the scanner looks for new tokens (default 180 s) |
| `candleTimeframeSec` | candle size for indicators (default 60 s) |
| `warmupCandles` | minimum history before a strategy may fire (bootstrapped from GeckoTerminal) |

### Watchlist / blacklist
`watchlist` mints are always tracked (they still must pass the safety screen).
`blacklist` mints are never traded.

### Scanner filters
Thresholds that a discovered token must pass. The defaults are deliberately conservative
(≥ $75k liquidity, ≥ 24 h old, ≥ 800 holders, organic score ≥ 35, mint & freeze
authority disabled, no Token-2022). Loosen them for a more aggressive memecoin bot,
tighten them for blue-chip only.

### Strategy
`name` picks the strategy; `minBuyScore` / `minSellScore` set how confident a signal must
be (0..1). `params` holds indicator periods and the composite weights.

### Filters (`strategy.htf`, `regime`)
`strategy.htf` gates buys on the higher-timeframe trend (`multiplier` base candles per bar,
`emaFast` / `emaSlow`). `regime` blocks entries when SOL is weak (`solEmaPeriod` on the
higher timeframe, `maxSolDrop1hPct`). Both default on.

### Launch lane (`launch`)
Off by default. `enabled`, `sizeSol`, `maxOpen`, `maxPerHour` bound the budget. Entry filters:
`minAgeMinutes` / `maxAgeMinutes`, `minLiquidityUsd` / `maxLiquidityUsd`, `minHolders`,
`minBuys5m`, `minBuySellRatio5m`, `minVolume5mUsd`, `maxPriceChange5mPct`, `requireSocials`,
`maxTopHoldersPct`, `maxBundledHolders`, `maxFreshWallets`, `minScore`, `maxRoundTripLossPct`,
`maxPriceImpactPct`.
`exits` is a separate profile (wide stop, aggressive ladder, short max hold). The daily loss
circuit breaker and the regime filter apply to this lane too.

### Holder analysis (`holders`) and streaming (`stream`)
`holders.enabled` runs the deep holder check on scanner candidates (`topN`,
`maxBundledHolders`, `maxFreshWallets`, `freshWalletMaxSol`). `stream.enabled` turns on the
WebSocket vault subscriptions (`maxSubscriptions`); needs an RPC with a `wss://` endpoint,
which Helius, QuickNode and the public RPC all provide.

### Risk
| Key | Meaning |
|---|---|
| `positionSizeSol` / `positionSizePct` | SOL per entry: the smaller of the two |
| `volatility` | `enabled`, `atrPeriod`, `stopAtrMultiple`, `minStopPct` / `maxStopPct`, `riskPerTradePct`: ATR-scaled stop per position and risk-based size cap |
| `lockProfitFraction` | after a take-profit rung the stop moves to rung gain × this (0 = breakeven) |
| `maxRoundTripLossPct` | sell-path check threshold on every buy |
| `autoBlacklist` | `minFills`, `maxAvgSlippagePct`: blacklist tokens that fill far worse than quoted |
| `maxOpenPositions`, `maxExposureSol` | concurrency and total capital at risk |
| `minSolReserve` | never spend below this (fees, rent) |
| `stopLossPct` | fallback stop when volatility sizing is off (or no ATR yet) |
| `takeProfitLadder` | list of `{gainPct, sellPct}`; `sellPct` is the share of the *remaining* position; last rung must be 100 |
| `trailingStop` | activates once the position is up `activationPct`; exits `trailPct` below the high |
| `maxHoldMinutes` | time-based exit |
| `maxSlippageBps`, `maxPriceImpactPct` | quote is rejected above these |
| `maxDailyLossPct` | circuit breaker: no new entries for the rest of the UTC day |
| `maxTradesPerDay`, `maxConsecutiveLosses`, `cooldownAfterLossMin`, `reentryCooldownMin` | behavioural guards |

### Execution
`engine: ultra` (recommended) or `swap`. With `swap` the bot sets a priority fee itself
(`priorityLevel`, `maxPriorityFeeLamports`), sends with re-broadcast, and polls for
confirmation. `paperSlippageBps` / `paperFeeSol` shape simulated fills.

---

## Commands

```
npm run doctor                    pass/fail report of the whole setup (secrets never printed)
npm run panel                     start the bot + control panel (same as `run`)
npm run paper / npm run live      start the loop (or: npx tsx src/index.ts run --mode paper)
                                  add --no-panel to run headless, --port 9000 to move the panel
npm run scan                      discovery + safety table
npm run balance                   SOL and token balances of the bot wallet (+ paper wallet)
npm run positions                 open positions, closed positions, PnL, recent trades
npm run wallet:new [-- --save kp.json]
npx tsx src/index.ts check <mint>
npx tsx src/index.ts buy <mint> <sol>          manual entry; the running bot manages the exit
npx tsx src/index.ts sell <mint> [--pct 50]    manual exit
npm run backtest -- --mint <mint> [--strategy momentum] [--timeframe 60] [--limit 1000]
npm run backtest -- --file candles.csv         CSV columns: time,open,high,low,close,volume
npm run tune -- --mint <a> --mint <b> [--strategy momentum] [--combos 200] [--apply]
npm run wallet:encrypt                         encrypt PRIVATE_KEY into data/wallet.enc
npm run supervise                              run the bot under an auto-restarting supervisor
```

All commands accept `--mode paper|live`, `--config path`, `--log debug`.
`npm run build` compiles to `dist/`; `node dist/index.js …` then works without `tsx`.

---

## How a trade happens

1. **Scan** (every `scanIntervalSec`): candidate mints from Jupiter categories,
   DexScreener boosts and your watchlist → cheap metadata pre-filter → for the best
   ones: DexScreener best pool, Jupiter Shield, on-chain mint account and top-10 holders
   → `assessSafety` (hard fails + 0..100 score) → up to `maxCandidates` tracked tokens.
   Candle history for new tokens is seeded from GeckoTerminal.
2. **Tick** (every `pollIntervalSec`): Jupiter Price v3 for SOL and all tracked mints →
   candles updated → pair stats refreshed every 60 s.
3. **Exits first**: each open position is checked against stop → trailing → take-profit
   ladder → time → strategy sell signal. Partial exits update cost basis and bank
   realised SOL; a sell that keeps failing backs off and raises a Telegram alert.
4. **Entries**: every tracked token without a position is scored by the strategy;
   candidates are ranked, the risk manager approves size and count, the quote is checked
   for price impact / slippage, then the swap executes. Fills are measured from the real
   SOL balance change, so fees and slippage are reflected in cost basis.
5. Everything is written to SQLite; the risk state survives restarts.

---

## Security checklist

- Use a **dedicated bot wallet** with a small balance. Never the account that holds your savings.
- Prefer `npm run wallet:encrypt` over a plain-text `PRIVATE_KEY`; the bot then asks for the password at start.
- `.env` is git-ignored. Never paste your key into chats, issues or screenshots.
- Prefer a machine you control (VPS or your own PC), not shared hosting.
- Live mode is refused unless `I_UNDERSTAND_THE_RISKS=yes`.
- The bot never asks for or uses your seed phrase.

## Known limitations / honest notes

- Token safety checks are heuristics. They catch the common rugs (mint/freeze authority,
  transfer-tax tokens, brand-new pools, no sells) but a determined scammer can pass them.
- Backtests use historical candles with fixed fee/slippage and ignore liquidity, latency
  and MEV. Treat results as an upper bound and validate in paper mode.
- Free API tiers are rate-limited (Jupiter 60 rpm with a key, DexScreener 300 rpm,
  GeckoTerminal 30 rpm). Keep `maxCandidates` modest or upgrade your plans.
- Jupiter's `lite-api` fallback is deprecated; get a key.
- The `swap` engine uses the quote's `outAmount` for the token side of a buy (SOL side is
  exact). Ultra reports both exactly.

## Development

```bash
npm test          # vitest: indicators, risk, exits, strategies, safety, paper executor, store, backtest, end-to-end paper loop
npm run typecheck
npm run build
```

Project layout:

```
src/
  index.ts            CLI
  bot.ts              main loop (scan → prices → exits → entries) + panel hooks (pause, snapshot, manual orders)
  server/             control panel: panel.ts (HTTP API + SSE), panel.html (dashboard UI)
  config.ts           zod-validated config + env
  wallet.ts           Phantom/JSON keypair loading, wallet generation
  rpc.ts              Solana RPC helpers (balances, mint info, holders, priority fees, send+confirm)
  market/             jupiter (price, tokens, shield, ultra, swap), dexscreener, geckoterminal, candles, stream (WebSocket vault prices)
  analysis/           indicators, safety scoring, scanner (+ launch discovery), market regime, holder quality
  strategies/         momentum, meanReversion, breakout, composite, filters (HTF gate, ATR helpers), launch (new-token scorer)
  trading/            risk manager, position exits, live + paper executors
  storage/db.ts       SQLite persistence
  notify/telegram.ts  alerts
  backtest/           engine.ts (historical simulation), tuner.ts (walk-forward parameter search)
  notify/             telegram alerts + two-way commands
  scripts/            supervise.mjs (auto-restart), copy-assets.mjs
tests/                vitest suites
```

## Disclaimer

This software is provided for educational purposes without warranty of any kind. Trading
cryptocurrencies involves substantial risk of loss. You are solely responsible for any
trades executed with this software and for complying with the laws of your jurisdiction.
