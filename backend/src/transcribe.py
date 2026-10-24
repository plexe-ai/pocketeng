"""
POST /transcribe — run OpenAI Whisper over an uploaded audio blob.

Called by the web composer's mic button. Flow:
  1. Client captures audio via MediaRecorder, base64-encodes the Blob.
  2. POSTs `{audio, mime}` JSON here with a Supabase JWT.
  3. We decode, forward the bytes to OpenAI's Whisper v1 endpoint as
     multipart/form-data, and return `{text}` — ready to drop into the
     textarea.

Why this lives as its own Lambda (not a chat subroute): transcription
isn't server-scoped — it has nothing to do with the user's EC2
workspace — so bundling it into the chat function would be misleading
and would also bloat that function's cold-start with an extra handler
path. A tiny dedicated function is cheap and keeps the blast radius
of OPENAI_API_KEY exposure tight.
"""
import base64
import http.client
import json
import os
import uuid
from email.parser import BytesParser
from email.policy import default as default_policy

from src.lib.auth import extract_auth_header, verify_token


OPENAI_HOST = "api.openai.com"
OPENAI_PATH = "/v1/audio/transcriptions"
OPENAI_MODEL = "whisper-1"

# Cap the uploaded audio. 25 MB is OpenAI's own limit; anything beyond
# that will be rejected upstream anyway. Base64 inflates by ~33%, so the
# encoded JSON payload we accept is effectively ~34 MB — stays under API
# Gateway's 10 MB body limit for normal prompts (a minute of opus ≈ 200KB
# encoded, 270 KB base64'd). Reject early if we see anything wild.
MAX_AUDIO_BYTES = 25 * 1024 * 1024


def respond(status, body, *, headers=None):
    h = {"Content-Type": "application/json"}
    if headers:
        h.update(headers)
    return {"statusCode": status, "headers": h, "body": json.dumps(body)}


def _extension_for_mime(mime: str) -> str:
    """OpenAI rejects uploads without a recognized filename extension.
    Map the common MediaRecorder outputs to the extension Whisper accepts."""
    m = (mime or "").lower()
    if "webm" in m: return "webm"
    if "ogg" in m: return "ogg"
    if "wav" in m: return "wav"
    if "mp4" in m or "m4a" in m or "aac" in m: return "m4a"
    if "mp3" in m or "mpeg" in m: return "mp3"
    if "flac" in m: return "flac"
    return "webm"  # MediaRecorder default in Chromium/Electron


def _post_multipart_to_openai(audio_bytes: bytes, mime: str) -> tuple[int, dict]:
    """Forward bytes to Whisper with a minimal hand-rolled multipart body.
    Avoids pulling in `requests`/`urllib3` just for this one call — keeps
    the Lambda deps at the existing tiny set."""
    key = os.environ.get("OPENAI_API_KEY", "").strip()
    if not key:
        return 500, {"error": "OPENAI_API_KEY not configured on the backend"}

    ext = _extension_for_mime(mime)
    filename = f"prompt.{ext}"
    content_type = mime if mime else f"audio/{ext}"
    boundary = "----PocketEngBoundary" + uuid.uuid4().hex

    crlf = b"\r\n"
    parts = []
    # field: model
    parts.append(f"--{boundary}".encode() + crlf)
    parts.append(b'Content-Disposition: form-data; name="model"' + crlf + crlf)
    parts.append(OPENAI_MODEL.encode() + crlf)
    # field: file
    parts.append(f"--{boundary}".encode() + crlf)
    parts.append(
        f'Content-Disposition: form-data; name="file"; filename="{filename}"'.encode()
        + crlf
    )
    parts.append(f"Content-Type: {content_type}".encode() + crlf + crlf)
    parts.append(audio_bytes + crlf)
    parts.append(f"--{boundary}--".encode() + crlf)
    body = b"".join(parts)

    conn = http.client.HTTPSConnection(OPENAI_HOST, timeout=25)
    try:
        conn.request(
            "POST",
            OPENAI_PATH,
            body=body,
            headers={
                "Authorization": f"Bearer {key}",
                "Content-Type": f"multipart/form-data; boundary={boundary}",
                "Content-Length": str(len(body)),
            },
        )
        resp = conn.getresponse()
        raw = resp.read()
        try:
            parsed = json.loads(raw.decode("utf-8") or "{}")
        except Exception:
            parsed = {"raw": raw[:500].decode("utf-8", errors="replace")}
        return resp.status, parsed
    finally:
        conn.close()


def handler(event, context):
    try:
        # Auth: Supabase JWT, same as every other endpoint.
        try:
            verify_token(extract_auth_header(event.get("headers") or {}))
        except Exception as e:
            return respond(401, {"error": f"unauthorized: {e}"})

        try:
            body = json.loads(event.get("body") or "{}")
        except Exception:
            return respond(400, {"error": "body must be JSON"})

        audio_b64 = body.get("audio")
        mime = body.get("mime") or "audio/webm"
        if not audio_b64 or not isinstance(audio_b64, str):
            return respond(400, {"error": "audio (base64 string) required"})

        try:
            audio_bytes = base64.b64decode(audio_b64, validate=False)
        except Exception:
            return respond(400, {"error": "audio is not valid base64"})

        if len(audio_bytes) == 0:
            return respond(400, {"error": "audio is empty"})
        if len(audio_bytes) > MAX_AUDIO_BYTES:
            return respond(413, {"error": f"audio exceeds {MAX_AUDIO_BYTES} bytes"})

        status, parsed = _post_multipart_to_openai(audio_bytes, mime)
        if status >= 400:
            # Surface OpenAI's error message to the client as-is so we can
            # debug from the browser devtools without reading Lambda logs.
            return respond(status, {
                "error": "openai transcription failed",
                "openai": parsed,
            })

        text = (parsed.get("text") or "").strip()
        return respond(200, {"text": text, "mime": mime, "bytes": len(audio_bytes)})

    except Exception as e:
        # Log would be more useful but Lambda captures print()s automatically.
        print(f"[transcribe] unexpected error: {type(e).__name__}: {e}")
        return respond(500, {"error": "internal error"})
