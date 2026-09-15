@echo off
REM One-click launcher for Windows: installs dependencies on first run, starts the bot + control panel, opens the browser.
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js 22.13+ is required. Download it from https://nodejs.org & pause & exit /b 1)
if not exist node_modules (echo Installing dependencies... & call npm install || (pause & exit /b 1))
if not exist .env (copy .env.example .env >nul & echo Created .env - open it and add your PRIVATE_KEY, RPC_URL and JUPITER_API_KEY. & notepad .env)
start "" http://localhost:8787
call npm run bot -- run
pause
