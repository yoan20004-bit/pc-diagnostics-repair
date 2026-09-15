# Phantom Solana Trading Bot

An automated, risk-managed trading bot for Solana that trades from a wallet you can
watch in **Phantom**. It scans the market for tradeable tokens, screens them for rug and
honeypot risk, generates entries from technical signals, and manages every position with
stop-loss, laddered take-profit, trailing stop and time exits. Swaps execute through
**Jupiter Ultra** (Jupiter handles routing, priority fees, transaction landing and MEV
protection), with the classic Jupiter Swap API as a fallback.

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
| Manual control | `buy`, `sell`, `check <mint>`, `scan`, `balance`, `positions` |

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

### Risk
| Key | Meaning |
|---|---|
| `positionSizeSol` / `positionSizePct` | SOL per entry: the smaller of the two |
| `maxOpenPositions`, `maxExposureSol` | concurrency and total capital at risk |
| `minSolReserve` | never spend below this (fees, rent) |
| `stopLossPct` | hard stop from entry; becomes a breakeven stop after the first take-profit rung |
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
npm run paper / npm run live      start the loop (or: npx tsx src/index.ts run --mode paper)
npm run scan                      discovery + safety table
npm run balance                   SOL and token balances of the bot wallet (+ paper wallet)
npm run positions                 open positions, closed positions, PnL, recent trades
npm run wallet:new [-- --save kp.json]
npx tsx src/index.ts check <mint>
npx tsx src/index.ts buy <mint> <sol>          manual entry; the running bot manages the exit
npx tsx src/index.ts sell <mint> [--pct 50]    manual exit
npm run backtest -- --mint <mint> [--strategy momentum] [--timeframe 60] [--limit 1000]
npm run backtest -- --file candles.csv         CSV columns: time,open,high,low,close,volume
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
  bot.ts              main loop (scan → prices → exits → entries)
  config.ts           zod-validated config + env
  wallet.ts           Phantom/JSON keypair loading, wallet generation
  rpc.ts              Solana RPC helpers (balances, mint info, holders, priority fees, send+confirm)
  market/             jupiter (price, tokens, shield, ultra, swap), dexscreener, geckoterminal, candles
  analysis/           indicators, safety scoring, scanner
  strategies/         momentum, meanReversion, breakout, composite
  trading/            risk manager, position exits, live + paper executors
  storage/db.ts       SQLite persistence
  notify/telegram.ts  alerts
  backtest/engine.ts  historical simulation
tests/                vitest suites
```

## Disclaimer

This software is provided for educational purposes without warranty of any kind. Trading
cryptocurrencies involves substantial risk of loss. You are solely responsible for any
trades executed with this software and for complying with the laws of your jurisdiction.
