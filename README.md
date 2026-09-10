# pc-diagnostics-repair
PC Diagnostics and Repair Software

## Local AI Chat

A fully local ChatGPT-style web app (FastAPI + Ollama + vanilla JS) lives in [`chatbot/`](chatbot/README.md).
See its README for setup: start Ollama with `ollama run llama3`, then run `uvicorn main:app --reload --port 8000` from that folder.
