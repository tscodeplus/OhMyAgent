#!/usr/bin/env python3
"""
Minimal FunASR HTTP server for OhMyAgent STT integration.

Uses SenseVoiceSmall — a compact Chinese ASR model (~200MB) suitable for Termux.
Exposes a multipart/form-data endpoint compatible with GenericSTTProvider.

Usage:
  python funasr-server.py [--port 8000] [--host 0.0.0.0]

Endpoints:
  POST /api/recognize  — multipart upload with field "audio"
  GET  /health          — health check
"""

import argparse
import json
import re
import sys
import os
import tempfile
from http.server import HTTPServer, BaseHTTPRequestHandler

MODEL_LOADED = False
ASR_MODEL = None


def load_model():
    """Lazy-load the SenseVoiceSmall model."""
    global MODEL_LOADED, ASR_MODEL
    if MODEL_LOADED:
        return
    print("[funasr-server] Loading SenseVoiceSmall model...", flush=True)
    from funasr import AutoModel

    ASR_MODEL = AutoModel(
        model="iic/SenseVoiceSmall",
        device="cpu",
        vad_model="fsmn-vad",
        vad_kwargs={"max_single_segment_time": 30000},
        punc_model="ct-punc",
    )
    MODEL_LOADED = True
    print("[funasr-server] Model loaded.", flush=True)


def transcribe(audio_bytes: bytes) -> dict:
    """Transcribe raw audio bytes. Auto-detects container format."""
    load_model()

    # Detect format from magic bytes
    suffix = ".wav"
    if audio_bytes[:4] == b"OggS":
        suffix = ".ogg"
    elif audio_bytes[:3] == b"ID3" or (audio_bytes[:2] == b"\xff\xfb"):
        suffix = ".mp3"

    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as f:
        f.write(audio_bytes)
        tmp_path = f.name

    try:
        result = ASR_MODEL.generate(
            input=tmp_path,
            language="auto",
            use_itn=True,
        )
        text = ""
        if result and len(result) > 0:
            text = result[0].get("text", "")

        # Strip SenseVoice emotion/language/event tags: <|X|>
        text = re.sub(r"<\s*\|[^|]*\|\s*>", "", text)
        # Remove repeated punctuation artifacts
        text = re.sub(r"[，。！？、,,.?!]{2,}", lambda m: m.group(0)[0], text)
        # Remove extra spaces from tag removal
        text = re.sub(r"\s{2,}", " ", text)

        return {"text": text.strip()}
    finally:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass


class FunASRHandler(BaseHTTPRequestHandler):

    def log_message(self, format, *args):
        """Suppress default access logging."""
        pass

    def do_GET(self):
        if self.path == "/health":
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            resp = json.dumps({"status": "ok", "model_loaded": MODEL_LOADED})
            self.wfile.write(resp.encode())
        else:
            self.send_response(404)
            self.end_headers()

    def do_POST(self):
        if self.path != "/api/recognize":
            self.send_response(404)
            self.end_headers()
            return

        content_type = self.headers.get("Content-Type", "")
        if "multipart/form-data" not in content_type:
            self.send_error(400, "Expected multipart/form-data")
            return

        try:
            content_length = int(self.headers.get("Content-Length", 0))
            raw_body = self.rfile.read(content_length)

            # Parse multipart using email parser (stdlib, no deprecated cgi)
            from email.parser import BytesParser
            from email.policy import default

            boundary = content_type.split("boundary=")[-1].strip('"').strip()
            full_body = (
                f"Content-Type: multipart/form-data; boundary={boundary}\r\n\r\n"
                .encode() + raw_body
            )
            msg = BytesParser(policy=default).parsebytes(full_body)

            audio_bytes = None
            if msg.is_multipart():
                for part in msg.iter_parts():
                    disposition = part.get("Content-Disposition", "")
                    if 'name="audio"' in disposition:
                        audio_bytes = part.get_payload(decode=True)
                        break

            if not audio_bytes or len(audio_bytes) < 100:
                self.send_error(400, "Missing or empty 'audio' field")
                return
        except Exception as e:
            self.send_error(400, f"Failed to parse request: {e}")
            return

        try:
            result = transcribe(audio_bytes)
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.end_headers()
            self.wfile.write(json.dumps(result, ensure_ascii=False).encode())
        except Exception as e:
            print(f"[funasr-server] Transcription error: {e}", flush=True, file=sys.stderr)
            self.send_error(500, f"Transcription failed: {e}")


def main():
    parser = argparse.ArgumentParser(description="FunASR HTTP Server")
    parser.add_argument("--port", type=int, default=8000)
    parser.add_argument("--host", type=str, default="127.0.0.1")
    args = parser.parse_args()

    print(
        f"[funasr-server] Starting on {args.host}:{args.port}...", flush=True
    )
    load_model()

    server = HTTPServer((args.host, args.port), FunASRHandler)
    print(
        f"[funasr-server] Ready. POST http://{args.host}:{args.port}/api/recognize",
        flush=True,
    )
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n[funasr-server] Shutting down.")
        server.shutdown()


if __name__ == "__main__":
    main()
