# Delivery for SOUROYAL123/upstox_trading_bot

The `enterprise_algo` package in this repo's root was built for the
**upstox_trading_bot** repository, but the Claude Code session that produced it
was scoped to `restaurant-bot` only (pushes to upstox_trading_bot were denied
by policy), so it is parked here on the designated task branch.

Two ways to move it home:

## Option A — apply the git bundle (keeps history + commit messages)

`enterprise_algo.bundle` contains two commits on branch
`claude/enterprise-algo-nse-stocks-04auq8`, based on upstox_trading_bot
commit `0e51067` (current main):

```bash
git clone https://github.com/SOUROYAL123/upstox_trading_bot.git
cd upstox_trading_bot
git fetch /path/to/enterprise_algo.bundle \
    claude/enterprise-algo-nse-stocks-04auq8:claude/enterprise-algo-nse-stocks-04auq8
git push -u origin claude/enterprise-algo-nse-stocks-04auq8
```

## Option B — copy the files

Copy `enterprise_algo/`, `algo_tests/` (rename to `tests/`),
`requirements-algo.txt`, `refresh_upstox_token.py`, and `.env.algo.example`
(rename to `.env.example`) into upstox_trading_bot and commit.

## Security

Read `enterprise_algo_SECURITY_REMEDIATION.md` — the upstox_trading_bot repo
has live broker credentials committed in its git history that must be rotated
and purged.
