"""
Local AI Chatbot — FastAPI backend.

Serves the static front-end and exposes a small JSON API that proxies chat
requests to a locally running Ollama instance, streaming tokens back to the
browser as newline-delimited JSON (NDJSON).

Run with:
    uvicorn main:app --reload --port 8000
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import uuid
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, AsyncIterator

import httpx
import ollama
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

# --------------------------------------------------------------------------- #
# Configuration
# --------------------------------------------------------------------------- #

BASE_DIR = Path(__file__).resolve().parent
STATIC_DIR = BASE_DIR / "static"
DATA_DIR = BASE_DIR / "data"
CHATS_FILE = DATA_DIR / "chats.json"

OLLAMA_HOST = os.environ.get("OLLAMA_HOST", "http://127.0.0.1:11434")
PREFERRED_MODEL = os.environ.get("OLLAMA_MODEL", "llama3")
SYSTEM_PROMPT = os.environ.get(
    "CHATBOT_SYSTEM_PROMPT",
    "You are a helpful, concise assistant running entirely on the user's own "
    "computer. Format answers in Markdown and use fenced code blocks for code.",
)

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
log = logging.getLogger("chatbot")
logging.getLogger("httpx").setLevel(logging.WARNING)

client = ollama.AsyncClient(host=OLLAMA_HOST)

# --------------------------------------------------------------------------- #
# Persistence (simple JSON file, guarded by an asyncio lock)
# --------------------------------------------------------------------------- #

_store_lock = asyncio.Lock()
_store: dict[str, dict[str, Any]] = {}


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _load_store() -> None:
    global _store
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    if CHATS_FILE.exists():
        try:
            _store = json.loads(CHATS_FILE.read_text("utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            log.warning("Could not read %s (%s); starting with empty history", CHATS_FILE, exc)
            _store = {}
    else:
        _store = {}


def _save_store() -> None:
    tmp = CHATS_FILE.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(_store, indent=2, ensure_ascii=False), "utf-8")
    tmp.replace(CHATS_FILE)


def _summary(chat: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": chat["id"],
        "title": chat["title"],
        "model": chat.get("model"),
        "created_at": chat["created_at"],
        "updated_at": chat["updated_at"],
        "message_count": len(chat["messages"]),
    }


def _new_chat(model: str | None = None) -> dict[str, Any]:
    ts = _now()
    return {
        "id": uuid.uuid4().hex[:12],
        "title": "New chat",
        "model": model,
        "created_at": ts,
        "updated_at": ts,
        "messages": [],
    }


# --------------------------------------------------------------------------- #
# Model discovery
# --------------------------------------------------------------------------- #


async def list_models() -> list[str]:
    """Return the names of all models installed in the local Ollama instance."""
    response = await client.list()
    names: list[str] = []
    for m in response.models:
        name = getattr(m, "model", None) or getattr(m, "name", None)
        if name:
            names.append(name)
    return names


def pick_model(installed: list[str], requested: str | None = None) -> str | None:
    """
    Choose the model to use.

    Priority: explicit request (if installed) -> PREFERRED_MODEL (llama3 by
    default, matching "llama3" or "llama3:<tag>") -> first installed model.
    """
    if not installed:
        return None

    def matches(candidate: str, wanted: str) -> bool:
        return candidate == wanted or candidate.split(":", 1)[0] == wanted.split(":", 1)[0]

    for wanted in (requested, PREFERRED_MODEL):
        if not wanted:
            continue
        for name in installed:
            if name == wanted:
                return name
        for name in installed:
            if matches(name, wanted):
                return name
    return installed[0]


async def ollama_status() -> dict[str, Any]:
    try:
        installed = await list_models()
    except (httpx.HTTPError, ollama.ResponseError, OSError) as exc:
        return {
            "ok": False,
            "host": OLLAMA_HOST,
            "error": f"Cannot reach Ollama at {OLLAMA_HOST}: {exc.__class__.__name__}",
            "models": [],
            "model": None,
            "preferred_model": PREFERRED_MODEL,
        }
    return {
        "ok": True,
        "host": OLLAMA_HOST,
        "error": None,
        "models": installed,
        "model": pick_model(installed),
        "preferred_model": PREFERRED_MODEL,
    }


# --------------------------------------------------------------------------- #
# Lifecycle
# --------------------------------------------------------------------------- #


@asynccontextmanager
async def lifespan(_: FastAPI) -> AsyncIterator[None]:
    _load_store()
    status = await ollama_status()
    if status["ok"]:
        log.info("Ollama reachable at %s; models: %s; using: %s",
                 OLLAMA_HOST, ", ".join(status["models"]) or "(none)", status["model"])
        if not status["models"]:
            log.warning("No models installed. Run `ollama pull llama3` first.")
    else:
        log.warning("%s. Start it with `ollama serve` (or `ollama run llama3`).", status["error"])
    yield


app = FastAPI(title="Local AI Chatbot", version="1.0.0", lifespan=lifespan)


# --------------------------------------------------------------------------- #
# API: health & models
# --------------------------------------------------------------------------- #


@app.get("/api/health")
async def health() -> dict[str, Any]:
    return await ollama_status()


@app.get("/api/models")
async def models() -> dict[str, Any]:
    status = await ollama_status()
    if not status["ok"]:
        raise HTTPException(status_code=503, detail=status["error"])
    return {"models": status["models"], "default": status["model"]}


# --------------------------------------------------------------------------- #
# API: chat sessions
# --------------------------------------------------------------------------- #


class ChatCreate(BaseModel):
    model: str | None = None


class ChatRename(BaseModel):
    title: str = Field(min_length=1, max_length=120)


@app.get("/api/chats")
async def get_chats() -> list[dict[str, Any]]:
    async with _store_lock:
        chats = sorted(_store.values(), key=lambda c: c["updated_at"], reverse=True)
        return [_summary(c) for c in chats]


@app.post("/api/chats", status_code=201)
async def create_chat(body: ChatCreate | None = None) -> dict[str, Any]:
    chat = _new_chat(body.model if body else None)
    async with _store_lock:
        _store[chat["id"]] = chat
        _save_store()
    return chat


@app.get("/api/chats/{chat_id}")
async def get_chat(chat_id: str) -> dict[str, Any]:
    async with _store_lock:
        chat = _store.get(chat_id)
        if not chat:
            raise HTTPException(status_code=404, detail="Chat not found")
        return chat


@app.patch("/api/chats/{chat_id}")
async def rename_chat(chat_id: str, body: ChatRename) -> dict[str, Any]:
    async with _store_lock:
        chat = _store.get(chat_id)
        if not chat:
            raise HTTPException(status_code=404, detail="Chat not found")
        chat["title"] = body.title.strip()
        chat["updated_at"] = _now()
        _save_store()
        return _summary(chat)


@app.delete("/api/chats/{chat_id}", status_code=204)
async def delete_chat(chat_id: str) -> None:
    async with _store_lock:
        if chat_id not in _store:
            raise HTTPException(status_code=404, detail="Chat not found")
        del _store[chat_id]
        _save_store()


@app.delete("/api/chats", status_code=204)
async def delete_all_chats() -> None:
    async with _store_lock:
        _store.clear()
        _save_store()


# --------------------------------------------------------------------------- #
# API: streaming chat completion
# --------------------------------------------------------------------------- #


class ChatRequest(BaseModel):
    chat_id: str | None = None
    message: str = Field(min_length=1, max_length=32_000)
    model: str | None = None


def _ndjson(obj: dict[str, Any]) -> bytes:
    return (json.dumps(obj, ensure_ascii=False) + "\n").encode("utf-8")


async def _stream_chat(req: ChatRequest, request: Request) -> AsyncIterator[bytes]:
    # 1. Resolve (or create) the chat session and append the user message.
    async with _store_lock:
        chat = _store.get(req.chat_id) if req.chat_id else None
        if chat is None:
            chat = _new_chat(req.model)
            _store[chat["id"]] = chat
        if chat["title"] == "New chat" and not chat["messages"]:
            chat["title"] = req.message.strip().splitlines()[0][:48] or "New chat"
        chat["messages"].append({"role": "user", "content": req.message, "created_at": _now()})
        chat["updated_at"] = _now()
        _save_store()
        history = [{"role": m["role"], "content": m["content"]} for m in chat["messages"]]
        chat_id = chat["id"]
        title = chat["title"]

    # 2. Pick a model.
    status = await ollama_status()
    if not status["ok"]:
        yield _ndjson({"type": "meta", "chat_id": chat_id, "title": title, "model": None})
        yield _ndjson({"type": "error", "error": status["error"]
                       + ". Start Ollama with `ollama serve` (or `ollama run llama3`) and try again."})
        return
    model = pick_model(status["models"], req.model or chat.get("model"))
    if model is None:
        yield _ndjson({"type": "meta", "chat_id": chat_id, "title": title, "model": None})
        yield _ndjson({"type": "error",
                       "error": "Ollama is running but no models are installed. Run `ollama pull llama3`."})
        return

    yield _ndjson({"type": "meta", "chat_id": chat_id, "title": title, "model": model})

    # 3. Stream tokens from Ollama. Persistence happens in `finally` via a
    #    synchronous helper so partial output survives client disconnects and
    #    task cancellation (which skip any `await`).
    messages = [{"role": "system", "content": SYSTEM_PROMPT}, *history]
    parts: list[str] = []
    error: str | None = None
    try:
        stream = await client.chat(model=model, messages=messages, stream=True)
        async for chunk in stream:
            if await request.is_disconnected():
                log.info("Client disconnected; aborting stream for chat %s", chat_id)
                break
            token = chunk.message.content or ""
            if token:
                parts.append(token)
                yield _ndjson({"type": "token", "content": token})
            if chunk.done:
                break
    except ollama.ResponseError as exc:
        error = f"Ollama error: {exc.error}"
    except (httpx.HTTPError, OSError) as exc:
        error = f"Lost connection to Ollama: {exc.__class__.__name__}"
    except asyncio.CancelledError:
        log.info("Stream cancelled for chat %s (partial reply kept)", chat_id)
        raise
    except Exception as exc:  # noqa: BLE001 — surface anything unexpected to the UI
        log.exception("Unexpected error while streaming")
        error = f"Unexpected error: {exc}"
    finally:
        _persist_reply(chat_id, "".join(parts), model)

    if error:
        yield _ndjson({"type": "error", "error": error})
    yield _ndjson({"type": "done", "chat_id": chat_id, "model": model, "length": sum(len(p) for p in parts)})


def _persist_reply(chat_id: str, reply: str, model: str) -> None:
    """Append the assistant reply to the chat. Synchronous (no awaits), so it is
    atomic with respect to the event loop and safe to call without the lock."""
    chat = _store.get(chat_id)
    if chat is None:
        return
    if reply:
        chat["messages"].append(
            {"role": "assistant", "content": reply, "model": model, "created_at": _now()}
        )
    chat["model"] = model
    chat["updated_at"] = _now()
    try:
        _save_store()
    except OSError as exc:
        log.error("Failed to save chat history: %s", exc)


@app.post("/api/chat")
async def chat_endpoint(req: ChatRequest, request: Request) -> StreamingResponse:
    if req.chat_id:
        async with _store_lock:
            if req.chat_id not in _store:
                raise HTTPException(status_code=404, detail="Chat not found")
    return StreamingResponse(
        _stream_chat(req, request),
        media_type="application/x-ndjson",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


# --------------------------------------------------------------------------- #
# Static front-end
# --------------------------------------------------------------------------- #


@app.get("/", include_in_schema=False)
async def index() -> FileResponse:
    return FileResponse(STATIC_DIR / "index.html")


app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


@app.exception_handler(HTTPException)
async def _http_exc(_: Request, exc: HTTPException) -> JSONResponse:
    return JSONResponse(status_code=exc.status_code, content={"detail": exc.detail})


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("main:app", host="127.0.0.1", port=8000, reload=True)
