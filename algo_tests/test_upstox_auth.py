import json
from datetime import datetime, timedelta

from enterprise_algo.nse import IST
from enterprise_algo.upstox_auth import UpstoxAuth, token_expiry


def test_expiry_is_next_morning_for_daytime_issue():
    issued = datetime(2026, 7, 17, 10, 0, tzinfo=IST)
    exp = token_expiry(issued)
    assert exp == datetime(2026, 7, 18, 3, 30, tzinfo=IST)


def test_expiry_is_same_morning_for_pre_330_issue():
    issued = datetime(2026, 7, 17, 1, 0, tzinfo=IST)
    exp = token_expiry(issued)
    assert exp == datetime(2026, 7, 17, 3, 30, tzinfo=IST)


def test_login_url_contains_client_and_redirect():
    auth = UpstoxAuth(api_key="k123", api_secret="s", redirect_uri="https://x.test/cb")
    url = auth.login_url()
    assert "client_id=k123" in url
    assert "response_type=code" in url
    assert "x.test" in url


def test_persist_and_load_roundtrip(tmp_path):
    auth = UpstoxAuth(api_key="k", api_secret="s",
                      token_file=tmp_path / "token.json")
    auth.persist("tok-abc")
    stored = auth.load_stored()
    assert stored is not None and stored["access_token"] == "tok-abc"


def test_load_rejects_expired(tmp_path):
    tf = tmp_path / "token.json"
    past = (datetime.now(IST) - timedelta(days=2)).isoformat()
    tf.write_text(json.dumps({"access_token": "old", "issued_at": past,
                              "expires_at": past}))
    auth = UpstoxAuth(api_key="k", api_secret="s", token_file=tf)
    assert auth.load_stored() is None


def test_persist_updates_env_in_place(tmp_path):
    env = tmp_path / ".env"
    env.write_text('FOO=1\nUPSTOX_ACCESS_TOKEN="old"\nBAR=2\n')
    auth = UpstoxAuth(api_key="k", api_secret="s",
                      token_file=tmp_path / "token.json")
    auth.persist("newtok", env_file=env)
    text = env.read_text()
    assert 'UPSTOX_ACCESS_TOKEN="newtok"' in text
    assert "FOO=1" in text and "BAR=2" in text
    assert "old" not in text


def test_exchange_code_extracts_code_from_full_url():
    # No network call here — just check the regex path by monkeypatching requests.
    auth = UpstoxAuth(api_key="k", api_secret="s", redirect_uri="https://x.test/cb")
    captured = {}

    class FakeResp:
        status_code = 200

        @staticmethod
        def json():
            return {"access_token": "tok"}

    class FakeRequests:
        @staticmethod
        def post(url, headers=None, data=None, timeout=None):
            captured.update(data)
            return FakeResp()

    import sys
    import types
    fake = types.ModuleType("requests")
    fake.post = FakeRequests.post
    real = sys.modules.get("requests")
    sys.modules["requests"] = fake
    try:
        tok = auth.exchange_code("https://x.test/cb?code=THE_CODE&state=algo")
    finally:
        if real is not None:
            sys.modules["requests"] = real
        else:
            del sys.modules["requests"]
    assert tok == "tok"
    assert captured["code"] == "THE_CODE"
    assert captured["grant_type"] == "authorization_code"
