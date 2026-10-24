"""Shared environment variable validation and sanitization."""
import re
from typing import Dict, Optional

MAX_ENV_VARS = 30
MAX_VALUE_LENGTH = 5000


def sanitize_env_vars(raw: Optional[Dict] = None) -> Dict[str, str]:
    """Validate and sanitize a dict of environment variables.

    - Keys are stripped to alphanumeric + underscore, must start with letter or underscore.
    - Values are stringified and capped at MAX_VALUE_LENGTH characters.
    - At most MAX_ENV_VARS entries are kept.
    """
    if not raw:
        return {}
    result = {}
    for k, v in raw.items():
        safe_key = re.sub(r'[^A-Za-z0-9_]', '', str(k))
        if not safe_key or not re.match(r'^[A-Za-z_]', safe_key):
            continue
        result[safe_key] = str(v)[:MAX_VALUE_LENGTH]
        if len(result) >= MAX_ENV_VARS:
            break
    return result
