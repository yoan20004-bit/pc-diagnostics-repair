@echo off
setlocal EnableDelayedExpansion
title Local AI Chat - setup
cd /d "%~dp0"

echo ============================================================
echo   Local AI Chat - from-scratch setup (Windows)
echo   Installs Ollama + llama3, Python deps, then launches the app
echo ============================================================
echo.

REM ---------- 1. Python ----------
set PY=
py -3 --version >nul 2>&1 && set "PY=py -3"
if not defined PY ( python --version >nul 2>&1 && set "PY=python" )
if not defined PY (
  echo [!] Python 3 was not found.
  echo     Install it from https://www.python.org/downloads/ and tick
  echo     "Add python.exe to PATH", then run this script again.
  start https://www.python.org/downloads/
  pause & exit /b 1
)
echo [ok] Python: 
%PY% --version

REM ---------- 2. Ollama ----------
where ollama >nul 2>&1
if errorlevel 1 (
  echo [..] Ollama not found. Trying to install with winget...
  winget install -e --id Ollama.Ollama --accept-source-agreements --accept-package-agreements
  if errorlevel 1 (
    echo [!] Automatic install failed. Download Ollama from https://ollama.com/download
    echo     install it, then run this script again.
    start https://ollama.com/download
    pause & exit /b 1
  )
  REM refresh PATH for this session
  set "PATH=%PATH%;%LOCALAPPDATA%\Programs\Ollama"
)
where ollama >nul 2>&1 || ( echo [!] Ollama installed but not on PATH yet. Close this window and run setup.bat again. & pause & exit /b 1 )
echo [ok] Ollama found.

REM ---------- 3. Start the Ollama server if it is not running ----------
curl -s -m 2 http://127.0.0.1:11434/api/tags >nul 2>&1
if errorlevel 1 (
  echo [..] Starting Ollama server...
  start "" /min ollama serve
  for /l %%i in (1,1,20) do (
    curl -s -m 2 http://127.0.0.1:11434/api/tags >nul 2>&1 && goto :ollama_up
    timeout /t 1 /nobreak >nul
  )
  echo [!] Ollama server did not start. Try running "ollama serve" manually.
  pause & exit /b 1
)
:ollama_up
echo [ok] Ollama server is running.

REM ---------- 4. Pull llama3 ----------
set "MODEL=%OLLAMA_MODEL%"
if not defined MODEL set "MODEL=llama3"
ollama list | findstr /i /c:"%MODEL%" >nul 2>&1
if errorlevel 1 (
  echo [..] Downloading model "%MODEL%" ^(about 4.7 GB for llama3, one time only^)...
  ollama pull %MODEL%
  if errorlevel 1 ( echo [!] Model download failed. Check your internet connection. & pause & exit /b 1 )
)
echo [ok] Model "%MODEL%" is installed.

REM ---------- 5. Python virtual environment + dependencies ----------
if not exist ".venv\Scripts\python.exe" (
  echo [..] Creating virtual environment...
  %PY% -m venv .venv || ( echo [!] Could not create .venv & pause & exit /b 1 )
)
echo [..] Installing Python dependencies...
".venv\Scripts\python.exe" -m pip install --upgrade pip >nul
".venv\Scripts\python.exe" -m pip install -r requirements.txt || ( echo [!] pip install failed. & pause & exit /b 1 )
echo [ok] Dependencies installed.

REM ---------- 6. Launch ----------
echo.
echo ============================================================
echo   Starting Local AI Chat on http://127.0.0.1:8000
echo   Press Ctrl+C in this window to stop the server.
echo ============================================================
start "" http://127.0.0.1:8000
".venv\Scripts\python.exe" -m uvicorn main:app --host 127.0.0.1 --port 8000
pause
