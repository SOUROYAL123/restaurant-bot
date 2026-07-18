#!/usr/bin/env python3
"""Daily Upstox access-token refresh (interactive).

IMPORTANT: standard Upstox v2 apps have NO refresh-token endpoint — the old
version of this script posted to /v2/login/refresh-token, which does not exist
for regular apps, so it could never work. The access token simply expires at
~03:30 IST every day and you must redo the OAuth login once per day:

    1. This script prints the login URL — open it in a browser and log in.
    2. Upstox redirects to your UPSTOX_REDIRECT_URI with ?code=... in the URL.
    3. Paste the code (or the whole redirect URL) back here.
    4. The script exchanges it, validates it against /user/profile, stores it
       in data/token_data.json, and updates UPSTOX_ACCESS_TOKEN in .env.

Usage:
    python refresh_upstox_token.py            # interactive daily refresh
    python refresh_upstox_token.py --status   # show current token status
"""
from __future__ import annotations

import argparse
import sys
from datetime import datetime
from pathlib import Path

try:
    from dotenv import load_dotenv
    load_dotenv(Path(__file__).parent / ".env")
except ImportError:
    pass

from enterprise_algo.nse import IST
from enterprise_algo.upstox_auth import UpstoxAuth, UpstoxAuthError


def show_status(auth: UpstoxAuth) -> int:
    stored = auth.load_stored()
    if not stored:
        print("❌ No valid stored token (missing or expired). Run without --status to refresh.")
        return 1
    expires = stored["expires_at"]
    print("✅ Stored token is unexpired.")
    print(f"   issued_at:  {stored.get('issued_at', '?')}")
    print(f"   expires_at: {expires} (03:30 IST)")
    try:
        profile = auth.validate(stored["access_token"])
        print(f"   verified live for user: {profile.get('user_name', '?')} "
              f"({profile.get('user_id', '?')})")
    except UpstoxAuthError as e:
        print(f"⚠️  Upstox rejected the token when checked live: {e}")
        return 1
    return 0


def refresh(auth: UpstoxAuth, env_file: Path) -> int:
    print("Upstox daily token refresh")
    print("=" * 60)
    print("Open this URL in your browser and log in:\n")
    print(f"  {auth.login_url()}\n")
    print("After login you will be redirected to your redirect URI with")
    print("?code=... in the address bar. Paste the code or the full URL:\n")
    code = input("code> ").strip()
    if not code:
        print("No code entered; aborting.")
        return 1

    try:
        token = auth.exchange_code(code)
        profile = auth.validate(token)
    except UpstoxAuthError as e:
        print(f"❌ {e}")
        return 1

    auth.persist(token, env_file=env_file if env_file.exists() else None)
    stored = auth.load_stored() or {}
    print(f"\n✅ Token refreshed for {profile.get('user_name', '?')} "
          f"({profile.get('user_id', '?')})")
    print(f"   stored in:  {auth.token_file}")
    if env_file.exists():
        print(f"   updated:    UPSTOX_ACCESS_TOKEN in {env_file}")
    print(f"   expires_at: {stored.get('expires_at', '?')} (03:30 IST)")
    print("\nRun this again after 03:30 IST tomorrow (or when --status fails).")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--status", action="store_true",
                        help="Show current token status instead of refreshing.")
    args = parser.parse_args()

    env_file = Path(__file__).parent / ".env"
    auth = UpstoxAuth()
    if args.status:
        return show_status(auth)
    return refresh(auth, env_file)


if __name__ == "__main__":
    sys.exit(main())
