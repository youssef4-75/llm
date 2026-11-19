# Ollama Chat GUI

Local chat UI on top of Ollama: a FastAPI proxy streams model replies to a simple browser client. Supports conversation memory, model selection, stop/cancel, temperature control, and multi-image vision uploads.

## Architecture

```
Browser (client/)  --POST /chat-->  FastAPI (:8000)  --POST /api/chat-->  Ollama (:11434)
                   <--NDJSON--                      <--NDJSON--
```

The browser never talks to Ollama directly. The backend is the place for limits, auth, and request shaping later.

## Project layout

```
llm/
├── client/           # static chat UI (HTML / CSS / JS)
├── server/           # FastAPI proxy
├── ollama/           # Dockerfile wrapping the official ollama/ollama image
└── docker-compose.yml
```

## Prerequisites

- Docker and Docker Compose
- A modern browser
- Enough RAM/VRAM for your chosen model (8 GB+ recommended)

## Quick start (Docker)

From the project root:

```bash
docker compose up --build
```

Pull a model into the Ollama container (use a vision-capable tag if you want image chat):

```bash
docker compose exec ollama ollama pull gemma4:e4b
```

Then:

1. Open [`client/index.html`](client/index.html) in the browser (or serve the `client/` folder with any static server).
2. The UI calls the API at `http://localhost:8000`.
3. Pick a model, optionally set temperature / attach images, and send a message.

### Ports

| Service  | Host port | Notes                                      |
|----------|-----------|--------------------------------------------|
| Backend  | `8000`    | FastAPI (`/chat`, `/models`)               |
| Ollama   | `11435`   | Mapped to container port `11434`           |

Inside the Compose network the backend reaches Ollama at `http://ollama:11434` (container port). The host mapping (`11435`) is only for tools on your machine, e.g. `curl http://localhost:11435/api/tags`.

## Features

- **Streaming chat** — NDJSON tokens fill the assistant bubble as they arrive
- **History** — conversation kept in `localStorage` and resent as context
- **Model selector** — filled from `GET /models`
- **Stop** — aborts the request and stops Ollama generation
- **Temperature** — slider (`0`–`2`) sent as `options.temperature`
- **Images** — attach one or many images; files are read with `FileReader`, base64 is sent as `images: [...]` on the user message (needs a vision model)

## API

### `GET /models`

Returns a JSON list of local model names.

### `POST /chat`

Request body:

```json
{
  "model": "gemma4:e4b",
  "role": "user",
  "content": "...",
  "stream": true,
  "temperature": 0.8,
  "images": ["<base64>", "..."]
}
```

- `stream: true` → `Content-Type: application/x-ndjson` (proxied Ollama chunks)
- `stream: false` → full Ollama JSON response
- Empty `images` are omitted before calling Ollama
- Max request body: 20 MB (for multi-image payloads)

## Run the backend without Docker

If Ollama is already running on the host:

```bash
cd server
pip install -r requirements.txt
set OLLAMA_BASE=http://localhost:11434
uvicorn main:app --reload --port 8000
```

On PowerShell:

```powershell
$env:OLLAMA_BASE = "http://localhost:11434"
uvicorn main:app --reload --port 8000
```

## Useful checks

```bash
# models visible to the proxy
curl http://localhost:8000/models

# Ollama on the published host port
curl http://localhost:11435/api/tags

# list models inside the container
docker compose exec ollama ollama list
```

## Notes

- Ollama is **stateless**: the client sends conversation context on every request.
- Vision only works with models that advertise the `vision` capability (`ollama show <model>`).
- First reply after a pull/load can be slow while the model is loaded into memory.
