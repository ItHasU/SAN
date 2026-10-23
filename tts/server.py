"""Serveur HTTP TTS minimal autour de piper-tts (API Python).

Contrat (docs/DESIGN.md §5) :
  POST /  {"text": "..."}  ->  200 audio/wav (PCM s16le mono, fréquence de la voix)
  GET  /health             ->  200 "ok"
Aucun accès réseau sortant : la voix est lue sur disque.
"""
import io
import json
import logging
import os
import sys
import threading
import time
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from piper import PiperVoice

HOST = os.environ.get("HOST", "0.0.0.0")
PORT = int(os.environ.get("PORT", "5000"))
VOICE = os.environ.get("PIPER_VOICE", "fr_FR-siwis-medium")
VOICE_DIRS = [Path(d) for d in os.environ.get("PIPER_VOICE_DIRS", "/voices:/opt/voices").split(":")]
MAX_CHARS = int(os.environ.get("MAX_CHARS", "1000"))
MAX_BODY = 64 * 1024

log = logging.getLogger("tts")


def find_model() -> Path:
    p = Path(VOICE)
    if p.suffix == ".onnx" and p.exists():
        return p
    for d in VOICE_DIRS:
        m = d / f"{VOICE}.onnx"
        if m.exists() and (d / f"{VOICE}.onnx.json").exists():
            return m
    sys.exit(f"Voix introuvable: {VOICE} (cherchée dans {', '.join(map(str, VOICE_DIRS))})")


voice = PiperVoice.load(find_model())
lock = threading.Lock()  # une synthèse à la fois


class Handler(BaseHTTPRequestHandler):
    server_version = "san-tts"

    def log_message(self, fmt, *args):
        log.info("%s %s", self.address_string(), fmt % args)

    def _send(self, code, body=b"", ctype="text/plain; charset=utf-8"):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/health":
            self._send(200, b"ok")
        else:
            self._send(404, b"not found")

    def do_POST(self):
        if self.path != "/":
            return self._send(404, b"not found")
        try:
            n = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            n = -1
        if n <= 0 or n > MAX_BODY:
            return self._send(400, b"bad Content-Length")
        try:
            text = json.loads(self.rfile.read(n)).get("text", "")
        except (ValueError, AttributeError):
            return self._send(400, b"invalid JSON")
        if not isinstance(text, str) or not text.strip():
            return self._send(400, b"missing text")
        text = text.strip()
        if len(text) > MAX_CHARS:
            return self._send(413, b"text too long")
        t0 = time.monotonic()
        buf = io.BytesIO()
        try:
            with lock, wave.open(buf, "wb") as wf:
                voice.synthesize_wav(text, wf)
        except Exception:
            log.exception("synthesis failed")
            return self._send(500, b"synthesis failed")
        log.info("synthèse %d car. en %.2fs", len(text), time.monotonic() - t0)
        self._send(200, buf.getvalue(), "audio/wav")


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(message)s")
    log.info("voix=%s écoute sur %s:%d", VOICE, HOST, PORT)
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
