"""Telegram Mini App initData validation.

https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
"""
import hashlib
import hmac
import json
import time
from urllib.parse import parse_qsl

MAX_AGE = 24 * 3600


class AuthError(Exception):
    pass


def validate_init_data(init_data: str, bot_token: str, max_age: int = MAX_AGE) -> dict:
    pairs = dict(parse_qsl(init_data, keep_blank_values=True))
    received_hash = pairs.pop("hash", None)
    if not received_hash:
        raise AuthError("initData without hash")
    secret = hmac.new(b"WebAppData", bot_token.encode(), hashlib.sha256).digest()

    def matches(fields):
        check_string = "\n".join(f"{k}={fields[k]}" for k in sorted(fields))
        expected = hmac.new(secret, check_string.encode(), hashlib.sha256).hexdigest()
        return hmac.compare_digest(expected, received_hash)

    # The bot-token hash covers every field except `hash`, including the newer `signature`;
    # the variant without `signature` is kept for clients that sign the older way.
    without_signature = {k: v for k, v in pairs.items() if k != "signature"}
    if not (matches(pairs) or ("signature" in pairs and matches(without_signature))):
        raise AuthError("initData signature mismatch")
    auth_date = int(pairs.get("auth_date", "0"))
    if max_age and time.time() - auth_date > max_age:
        raise AuthError("initData expired")
    try:
        user = json.loads(pairs.get("user", "{}"))
    except json.JSONDecodeError as e:
        raise AuthError("bad user payload") from e
    if "id" not in user:
        raise AuthError("initData without user")
    return user
