"""Linq SMS API helper — send text messages via Linq partner API v3."""
import json
import os
import urllib.request


LINQ_API_URL = "https://api.linqapp.com/api/partner/v3/chats"


def send_sms(to_number: str, text: str, from_number: str = None, api_key: str = None):
    """Send an SMS via Linq API.

    Args:
        to_number: Recipient phone (E.164 format, e.g. "+447700900123")
        text: Message text
        from_number: Sender phone (defaults to LINQ_FROM_NUMBER env var)
        api_key: Linq bearer token (defaults to LINQ_API_KEY env var)
    """
    api_key = api_key or os.environ.get("LINQ_API_KEY", "")
    from_number = from_number or os.environ.get("LINQ_FROM_NUMBER", "")

    if not api_key:
        raise Exception("LINQ_API_KEY not configured")
    if not from_number:
        raise Exception("LINQ_FROM_NUMBER not configured")

    # Split long messages into 1600-char chunks (SMS limit)
    max_len = 1600
    chunks = []
    if len(text) <= max_len:
        chunks = [text]
    else:
        # Split on newlines when possible
        remaining = text
        while remaining:
            if len(remaining) <= max_len:
                chunks.append(remaining)
                break
            # Find a good split point
            split_at = remaining.rfind('\n', 0, max_len)
            if split_at < max_len // 2:
                split_at = max_len
            chunks.append(remaining[:split_at])
            remaining = remaining[split_at:].lstrip('\n')

    for chunk in chunks:
        body = {
            "from": from_number,
            "to": [to_number],
            "message": {
                "parts": [
                    {
                        "type": "text",
                        "value": chunk,
                    }
                ]
            },
        }

        payload = json.dumps(body).encode()
        req = urllib.request.Request(
            LINQ_API_URL,
            data=payload,
            headers={
                "Content-Type": "application/json",
                "Accept": "application/json",
                "Authorization": f"Bearer {api_key}",
            },
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=15) as resp:
            resp_data = resp.read()
            print(f"Linq API response ({resp.status}): {resp_data[:200]}")

    return len(chunks)
