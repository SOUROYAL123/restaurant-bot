"""Upstox v2 authentication / daily token refresh.

How Upstox v2 auth actually works (standard apps):
  * There is NO refresh-token endpoint. The access token expires at ~03:30 IST
    the next day, and you must repeat the OAuth login once per day.
  * Flow: open the authorization dialog in a browser -> log in -> Upstox
    redirects to your app's redirect URI with ``?code=...`` -> exchange that
    code at ``/v2/login/authorization/token`` (form-encoded, not JSON).

This module wraps that flow:
  * :meth:`UpstoxAuth.login_url` builds the browser URL.
  * :meth:`UpstoxAuth.exchange_code` swaps the code for an access token.
  * :meth:`UpstoxAuth.validate` confirms a token against ``/v2/user/profile``.
  * :meth:`UpstoxAuth.persist` stores the token in ``data/token_data.json``
    and (optionally) updates the ``UPSTOX_ACCESS_TOKEN`` line of a .env file
    in place, without touching other lines.
  * :meth:`UpstoxAuth.token_expiry` reports the real expiry (03:30 IST).
"""
from __future__ import annotations

import json
import os
import re
from datetime import datetime, time, timedelta
from pathlib import Path
from typing import Optional
from urllib.parse import urlencode

from .nse import IST

BASE_URL = "https://api.upstox.com/v2"
AUTH_DIALOG = f"{BASE_URL}/login/authorization/dialog"
TOKEN_URL = f"{BASE_URL}/login/authorization/token"
PROFILE_URL = f"{BASE_URL}/user/profile"

# Upstox access tokens die at 03:30 IST on the day after issuance.
EXPIRY_TIME_IST = time(3, 30)


class UpstoxAuthError(RuntimeError):
    pass


def token_expiry(issued_at: Optional[datetime] = None) -> datetime:
    """Return the datetime (IST) at which a token issued at ``issued_at`` dies."""
    now = (issued_at or datetime.now(IST)).astimezone(IST)
    # A token issued between midnight and 03:30 dies the SAME morning;
    # otherwise it dies at 03:30 the next day.
    if now.time() < EXPIRY_TIME_IST:
        return datetime.combine(now.date(), EXPIRY_TIME_IST, tzinfo=IST)
    return datetime.combine(now.date() + timedelta(days=1), EXPIRY_TIME_IST, tzinfo=IST)


class UpstoxAuth:
    def __init__(self, api_key: Optional[str] = None, api_secret: Optional[str] = None,
                 redirect_uri: Optional[str] = None, timeout: int = 15,
                 token_file: Optional[Path] = None):
        self.api_key = api_key or os.getenv("UPSTOX_API_KEY", "")
        self.api_secret = api_secret or os.getenv("UPSTOX_API_SECRET", "")
        self.redirect_uri = redirect_uri or os.getenv(
            "UPSTOX_REDIRECT_URI", "https://127.0.0.1")
        self.timeout = timeout
        self.token_file = token_file or (
            Path(__file__).resolve().parent.parent / "data" / "token_data.json")

    # -- step 1: browser login ----------------------------------------------
    def login_url(self, state: str = "algo") -> str:
        if not self.api_key:
            raise UpstoxAuthError("UPSTOX_API_KEY not set.")
        params = {
            "response_type": "code",
            "client_id": self.api_key,
            "redirect_uri": self.redirect_uri,
            "state": state,
        }
        return f"{AUTH_DIALOG}?{urlencode(params)}"

    # -- step 2: code -> token ----------------------------------------------
    def exchange_code(self, code: str) -> str:
        """Exchange the redirect ``code`` for an access token. Form-encoded —
        posting JSON here is the classic mistake that returns UDAPI100058."""
        import requests
        if not (self.api_key and self.api_secret):
            raise UpstoxAuthError("UPSTOX_API_KEY / UPSTOX_API_SECRET not set.")
        code = code.strip()
        # Accept a full redirect URL pasted by the user and pull the code out.
        m = re.search(r"[?&]code=([^&\s]+)", code)
        if m:
            code = m.group(1)
        resp = requests.post(
            TOKEN_URL,
            headers={"accept": "application/json",
                     "Content-Type": "application/x-www-form-urlencoded"},
            data={
                "code": code,
                "client_id": self.api_key,
                "client_secret": self.api_secret,
                "redirect_uri": self.redirect_uri,
                "grant_type": "authorization_code",
            },
            timeout=self.timeout,
        )
        if resp.status_code != 200:
            raise UpstoxAuthError(
                f"Token exchange failed ({resp.status_code}): {resp.text[:300]}")
        token = resp.json().get("access_token", "")
        if not token:
            raise UpstoxAuthError(f"No access_token in response: {resp.text[:300]}")
        return token

    # -- step 3: sanity check ------------------------------------------------
    def validate(self, access_token: str) -> dict:
        """Return the user profile if the token works; raise otherwise."""
        import requests
        resp = requests.get(
            PROFILE_URL,
            headers={"Authorization": f"Bearer {access_token}",
                     "Accept": "application/json"},
            timeout=self.timeout,
        )
        if resp.status_code != 200:
            raise UpstoxAuthError(
                f"Token invalid ({resp.status_code}): {resp.text[:200]}")
        return resp.json().get("data", {})

    # -- step 4: persist -----------------------------------------------------
    def persist(self, access_token: str, env_file: Optional[Path] = None) -> None:
        issued = datetime.now(IST)
        self.token_file.parent.mkdir(parents=True, exist_ok=True)
        self.token_file.write_text(json.dumps({
            "access_token": access_token,
            "issued_at": issued.isoformat(),
            "expires_at": token_expiry(issued).isoformat(),
        }, indent=2))

        if env_file and env_file.exists():
            lines = env_file.read_text().splitlines()
            key = "UPSTOX_ACCESS_TOKEN"
            replaced = False
            for i, line in enumerate(lines):
                if line.split("=", 1)[0].strip() == key:
                    lines[i] = f'{key}="{access_token}"'
                    replaced = True
                    break
            if not replaced:
                lines.append(f'{key}="{access_token}"')
            env_file.write_text("\n".join(lines) + "\n")

    def load_stored(self) -> Optional[dict]:
        """Return stored token info if present and unexpired, else None."""
        if not self.token_file.exists():
            return None
        try:
            data = json.loads(self.token_file.read_text())
            expires = datetime.fromisoformat(data["expires_at"])
            if datetime.now(IST) < expires:
                return data
        except (KeyError, ValueError, json.JSONDecodeError):
            pass
        return None
