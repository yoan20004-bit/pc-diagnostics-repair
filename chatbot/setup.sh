#!/usr/bin/env bash
# Local AI Chat - from-scratch setup for macOS / Linux.
# Installs Ollama (if missing), pulls llama3, creates a venv, installs deps, launches the app.
set -euo pipefail
cd "$(dirname "$0")"

MODEL="${OLLAMA_MODEL:-llama3}"
PORT="${PORT:-8000}"

say()  { printf '\033[1;35m[..]\033[0m %s\n' "$*"; }
ok()   { printf '\033[1;32m[ok]\033[0m %s\n' "$*"; }
fail() { printf '\033[1;31m[!!]\033[0m %s\n' "$*" >&2; exit 1; }

echo "============================================================"
echo "  Local AI Chat - from-scratch setup"
echo "  Installs Ollama + $MODEL, Python deps, then launches the app"
echo "============================================================"

# ---------- 1. Python ----------
PY=""
for c in python3 python; do
  if command -v "$c" >/dev/null 2>&1 && "$c" -c 'import sys; sys.exit(0 if sys.version_info >= (3,10) else 1)'; then PY="$c"; break; fi
done
[ -n "$PY" ] || fail "Python 3.10+ not found. Install it (https://www.python.org/downloads/ or your package manager) and re-run."
ok "Python: $("$PY" --version)"

# ---------- 2. Ollama ----------
if ! command -v ollama >/dev/null 2>&1; then
  case "$(uname -s)" in
    Linux)
      say "Ollama not found. Installing with the official script (may ask for sudo)..."
      curl -fsSL https://ollama.com/install.sh | sh || fail "Ollama install failed. See https://ollama.com/download"
      ;;
    Darwin)
      if command -v brew >/dev/null 2>&1; then
        say "Ollama not found. Installing with Homebrew..."
        brew install ollama || fail "brew install ollama failed. See https://ollama.com/download"
      else
        fail "Ollama not found. Download it from https://ollama.com/download, install, then re-run this script."
      fi
      ;;
    *) fail "Unsupported OS. Install Ollama from https://ollama.com/download and re-run." ;;
  esac
fi
ok "Ollama found: $(command -v ollama)"

# ---------- 3. Start the Ollama server if needed ----------
if ! curl -s -m 2 http://127.0.0.1:11434/api/tags >/dev/null; then
  say "Starting Ollama server in the background..."
  nohup ollama serve >/tmp/ollama-serve.log 2>&1 &
  for _ in $(seq 1 20); do
    curl -s -m 2 http://127.0.0.1:11434/api/tags >/dev/null && break
    sleep 1
  done
  curl -s -m 2 http://127.0.0.1:11434/api/tags >/dev/null || fail "Ollama did not start. Try 'ollama serve' manually (log: /tmp/ollama-serve.log)."
fi
ok "Ollama server is running."

# ---------- 4. Pull the model ----------
if ! ollama list | awk 'NR>1 {print $1}' | grep -q "^${MODEL}\(:\|$\)"; then
  say "Downloading model '$MODEL' (about 4.7 GB for llama3, one time only)..."
  ollama pull "$MODEL" || fail "Model download failed. Check your internet connection."
fi
ok "Model '$MODEL' is installed."

# ---------- 5. Virtual environment + deps ----------
if [ ! -x ".venv/bin/python" ]; then
  say "Creating virtual environment..."
  "$PY" -m venv .venv
fi
say "Installing Python dependencies..."
.venv/bin/python -m pip install --quiet --upgrade pip
.venv/bin/python -m pip install --quiet -r requirements.txt
ok "Dependencies installed."

# ---------- 6. Launch ----------
echo
echo "============================================================"
echo "  Starting Local AI Chat on http://127.0.0.1:$PORT"
echo "  Press Ctrl+C to stop the server."
echo "============================================================"
( sleep 2; if command -v xdg-open >/dev/null; then xdg-open "http://127.0.0.1:$PORT" >/dev/null 2>&1; elif command -v open >/dev/null; then open "http://127.0.0.1:$PORT"; fi ) &
exec .venv/bin/python -m uvicorn main:app --host 127.0.0.1 --port "$PORT"
