import asyncio
import os
import threading
import requests
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import StreamingResponse
from starlette.background import BackgroundTask
from fastapi.middleware.cors import CORSMiddleware
from message import Message

# Allow large base64 image payloads (several MB)
app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

OLLAMA_BASE = os.getenv("OLLAMA_BASE", "http://localhost:11435")
OLLAMA_URL = f"{OLLAMA_BASE}/api/chat"
MAX_BODY_BYTES = 20 * 1024 * 1024  # 20 MB for multi-image base64 payloads


@app.middleware("http")
async def limit_body_size(request: Request, call_next):
    content_length = request.headers.get("content-length")
    if content_length and int(content_length) > MAX_BODY_BYTES:
        raise HTTPException(status_code=413, detail="Request body too large")
    return await call_next(request)


@app.get("/")
def read_root():
    return {"message": "Hello World"}


@app.get("/models")
def list_models():
    try:
        response = requests.get(f"{OLLAMA_BASE}/api/tags", timeout=10)
    except requests.RequestException as e:
        raise HTTPException(status_code=503, detail=f"Ollama unreachable: {e}")

    if response.status_code != 200:
        raise HTTPException(response.status_code, f"Ollama error: {response.text}")

    return [m["name"] for m in response.json().get("models", [])]


def _open_upstream(payload):
    """Open the streaming request to Ollama. Returns (response, cancelled_event)."""
    upstream = requests.post(OLLAMA_URL, json=payload, stream=True, timeout=None)
    cancelled = threading.Event()

    def close():
        cancelled.set()
        try:
            upstream.close()  # closing the socket cancels Ollama generation
        except Exception:
            pass

    return upstream, cancelled, close


def _blocking_iter(upstream, cancelled):
    try:
        for chunk in upstream.iter_content(chunk_size=None):
            if cancelled.is_set():
                return
            if chunk:
                yield chunk
    finally:
        try:
            upstream.close()
        except Exception:
            pass


@app.post("/chat")
async def answer_message(m: Message, request: Request):
    payload = m.construct()

    # ---------- non-streaming: unchanged ----------
    
    if not m.stream:
        response = await asyncio.to_thread(
            requests.post, OLLAMA_URL, json=payload, timeout=None
        )
        if response.status_code != 200:
            raise HTTPException(response.status_code, f"Ollama error: {response.text}")
        return response.json()

    # ---------- streaming ----------
    upstream, cancelled, close_upstream = await asyncio.to_thread(
        _open_upstream, payload
    )

    if upstream.status_code != 200:
        body = upstream.text
        close_upstream()
        raise HTTPException(upstream.status_code, f"Ollama error: {body}")

    async def generate():
        loop = asyncio.get_running_loop()
        iterator = _blocking_iter(upstream, cancelled)
        try:
            while True:
                try:
                    chunk = await loop.run_in_executor(None, next, iterator)
                except StopIteration:
                    return
                yield chunk
        except asyncio.CancelledError:
            close_upstream()
            raise
        finally:
            close_upstream()

    async def watch_disconnect():
        while not await request.is_disconnected():
            await asyncio.sleep(0.2)
        close_upstream()

    watcher = asyncio.create_task(watch_disconnect())

    async def cleanup():
        watcher.cancel()
        close_upstream()

    return StreamingResponse(
        generate(),
        media_type="application/x-ndjson",
        background=BackgroundTask(cleanup),
    )