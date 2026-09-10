# Local AI Chat

A fully local, self-contained ChatGPT-style web app. A small **FastAPI** backend
talks to a locally running **Ollama** instance and streams tokens to a vanilla
HTML/CSS/JS front-end in real time. No accounts, no cloud, no telemetry: nothing
leaves your machine.

![stack](https://img.shields.io/badge/stack-FastAPI%20%2B%20Ollama%20%2B%20vanilla%20JS-7c6cff)

## Features

- Token-by-token streaming responses (NDJSON over `fetch`), with a Stop button
- Persistent chat history (left sidebar) stored in `data/chats.json`
- Rename / delete chats, clear all history
- Markdown rendering with syntax-highlighted, copyable code blocks
  (`marked`, `highlight.js`, `DOMPurify` are vendored, so the UI works offline)
- Model picker: auto-selects `llama3` if installed, otherwise the first installed model
- Dark, responsive UI that works on phones (collapsible sidebar)
- Ollama health indicator with clear error messages when it is offline

## Quick start from scratch (nothing installed yet)

One script installs Ollama, downloads **llama3**, sets up Python, and opens the app.
You need Python 3.10+ (<https://www.python.org/downloads/>, tick "Add python.exe to PATH" on Windows).

**Windows** – double-click `setup.bat`, or in a terminal:

```bat
cd chatbot
setup.bat
```

**macOS / Linux**:

```bash
cd chatbot
./setup.sh
```

The script:

1. finds Python and installs Ollama if it is missing (winget on Windows, the
   official installer on Linux, Homebrew on macOS),
2. starts the Ollama server if it is not already running,
3. runs `ollama pull llama3` (about 4.7 GB, downloaded once),
4. creates `.venv/` and installs `requirements.txt`,
5. launches the app on <http://127.0.0.1:8000> and opens your browser.

Run the same script again any time to start the app; steps that are already
done are skipped. If Ollama is running but llama3 is missing, the sidebar also
shows a **Download llama3** button that pulls the model with a progress bar.

## Manual setup

### Prerequisites

| Requirement | Notes |
| --- | --- |
| Python 3.10+ | Tested on 3.11 |
| [Ollama](https://ollama.com/download) | macOS, Windows, or Linux installer |
| A model | `llama3` by default, or any model you have pulled |

### 1. Start Ollama

Install Ollama, then pull and run a model once so it is downloaded:

```bash
ollama run llama3
```

Type `/bye` to leave the interactive prompt. The Ollama server keeps running in
the background on `http://127.0.0.1:11434`. If it is not running, start it with:

```bash
ollama serve
```

Check which models you have installed:

```bash
ollama list
```

You do not have to use `llama3`. The backend picks the first installed model if
`llama3` is missing, and you can choose any installed model from the dropdown
in the top bar.

### 2. Install the Python dependencies

From this `chatbot/` directory:

```bash
python -m venv .venv
# macOS / Linux
source .venv/bin/activate
# Windows (PowerShell)
.venv\Scripts\Activate.ps1

pip install -r requirements.txt
```

### 3. Launch the web app

```bash
uvicorn main:app --reload --port 8000
```

Then open <http://127.0.0.1:8000> in your browser.

`python main.py` does the same thing (it starts uvicorn on port 8000 with reload).

## Configuration

All settings are optional environment variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `OLLAMA_HOST` | `http://127.0.0.1:11434` | Where the Ollama server listens |
| `OLLAMA_MODEL` | `llama3` | Preferred model (falls back to the first installed one) |
| `CHATBOT_SYSTEM_PROMPT` | a short helpful-assistant prompt | System prompt sent with every conversation |

Example:

```bash
OLLAMA_MODEL=mistral uvicorn main:app --port 8000
```

## Project layout

```
chatbot/
├── setup.bat            # Windows: install Ollama + llama3 + deps, then launch
├── setup.sh             # macOS / Linux: same
├── main.py              # FastAPI app: API + static file serving
├── requirements.txt
├── data/chats.json      # created on first run; your chat history
└── static/
    ├── index.html
    ├── style.css
    ├── app.js
    └── vendor/          # marked, highlight.js, DOMPurify (offline copies)
```

## API

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/api/health` | Ollama status, installed models, selected model |
| `GET` | `/api/models` | Installed models (503 if Ollama is offline) |
| `GET` | `/api/chats` | List chat sessions |
| `POST` | `/api/chats` | Create an empty chat |
| `GET` | `/api/chats/{id}` | Full chat with messages |
| `PATCH` | `/api/chats/{id}` | Rename (`{"title": "..."}`) |
| `DELETE` | `/api/chats/{id}` | Delete one chat |
| `DELETE` | `/api/chats` | Delete all chats |
| `POST` | `/api/chat` | Send a message; streams NDJSON events |
| `POST` | `/api/pull` | Download a model (`{"model": "llama3"}`); streams progress |

The stream from `POST /api/chat` is one JSON object per line:

```json
{"type": "meta",  "chat_id": "…", "title": "…", "model": "llama3:latest"}
{"type": "token", "content": "Hel"}
{"type": "token", "content": "lo"}
{"type": "done",  "chat_id": "…", "model": "llama3:latest", "length": 5}
```

An `{"type": "error", "error": "…"}` line is emitted if Ollama is unreachable or
the model fails; partial output is still saved to the chat.

Interactive API docs are available at <http://127.0.0.1:8000/docs>.

## Troubleshooting

- **"Ollama offline" in the sidebar** – run `ollama serve` (or `ollama run llama3`)
  and the indicator turns green within a few seconds.
- **"No models installed"** – click **Download llama3** in the sidebar, or run `ollama pull llama3`.
- **Ollama on another machine / port** – set `OLLAMA_HOST=http://host:11434`.
- **Port 8000 already in use** – pass a different `--port` to uvicorn.
- **Reset history** – stop the server and delete `data/chats.json`.
