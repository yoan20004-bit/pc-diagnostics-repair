#!/usr/bin/env bash
# One-click launcher for macOS / Linux: installs dependencies on first run, starts the bot + control panel, opens the browser.
set -e
cd "$(dirname "$0")"
command -v node >/dev/null || { echo "Node.js 22.13+ is required: https://nodejs.org"; exit 1; }
[ -d node_modules ] || { echo "Installing dependencies..."; npm install; }
[ -f .env ] || { cp .env.example .env; echo "Created .env - add your PRIVATE_KEY, RPC_URL and JUPITER_API_KEY, then run again."; exit 0; }
( sleep 2; (command -v xdg-open >/dev/null && xdg-open http://localhost:8787) || (command -v open >/dev/null && open http://localhost:8787) ) >/dev/null 2>&1 &
exec npm run bot -- run
