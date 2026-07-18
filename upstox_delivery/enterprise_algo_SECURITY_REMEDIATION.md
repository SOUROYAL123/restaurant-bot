# upstox_trading_bot — secret remediation & how to apply the enterprise_algo bundle

## Part 0 — Apply the committed work (`enterprise_algo.bundle`)

The new `enterprise_algo/` package + `.gitignore`/secret-cleanup are committed on
branch `claude/enterprise-algo-nse-stocks-04auq8`, delivered as a git bundle
(the web session was scoped to a different repo and could not push).

From a fresh clone of `upstox_trading_bot` (that has today's `main`):

```bash
git fetch /path/to/enterprise_algo.bundle \
    claude/enterprise-algo-nse-stocks-04auq8:claude/enterprise-algo-nse-stocks-04auq8
git checkout claude/enterprise-algo-nse-stocks-04auq8
git push -u origin claude/enterprise-algo-nse-stocks-04auq8   # from your machine
```

Verify it runs:
```bash
pip install -r requirements-algo.txt pytest
python -m pytest tests/ -q                      # 20 passing
python -m enterprise_algo.cli backtest --strategy ma_crossover --profile aggressive \
    --symbols RELIANCE,TCS,SBIN,MARUTI --days 800
```

---

## Part 1 — ROTATE these NOW (they are in git history)

The commit stops *tracking* the secrets but they remain in past commits. Anyone
with repo access can still read them. Rotate/revoke every one:

- **Upstox**: regenerate API key + secret, and invalidate the access token
  (Upstox developer console → your app → regenerate).
- **ENCRYPTION_KEY**: generate a new one; re-encrypt anything it protected.
- **SMTP_PASSWORD**: rotate the email/app password.
- **Third-party**: `ALPHA_VANTAGE_API_KEY`, `TWITTER_BEARER_TOKEN`, `NEWS_API_KEY`,
  `SMS_API_KEY`, `SLACK_WEBHOOK_URL`, `DISCORD_WEBHOOK_URL` — regenerate each.

Rotation is the real fix. History purge (below) is secondary hygiene.

---

## Part 2 — Purge secrets from git history

> Rewrites history and requires a force-push. Coordinate with anyone else on the
> repo, and make a backup clone first. Do this AFTER rotating keys.

### Option A — git filter-repo (recommended)

```bash
pip install git-filter-repo
git clone --mirror https://github.com/SOUROYAL123/upstox_trading_bot.git backup-mirror

cd upstox_trading_bot
# Remove every .env-style file and the timestamped backup dirs from all history:
git filter-repo --invert-paths \
  --path-glob '*.env' --path-glob '.env' --path-glob '.env.*' \
  --path-glob '*/.env' --path-glob '.env_backup' --path-glob '*/.env_backup' \
  --path-glob 'backup_*/**'

git push --force --all
git push --force --tags
```

### Option B — BFG Repo-Cleaner

```bash
bfg --delete-files '.env'  --delete-files '.env.*'  upstox_trading_bot.git
bfg --delete-folders 'backup_*'                     upstox_trading_bot.git
cd upstox_trading_bot.git && git reflog expire --expire=now --all && git gc --prune=now --aggressive
git push --force
```

### After the purge
- Tell collaborators to re-clone (old clones still contain the secrets).
- Confirm on GitHub that the blob is gone (open an old commit's `.env` URL → 404).
- Consider GitHub Secret Scanning + push protection so this can't recur.

---

## Part 3 — Going forward
- The new root `.gitignore` already excludes `.env`, `backup_*/`, `*.db`, `logs/`,
  `*.xlsx`. Keep real config only in a local, untracked `.env` (see `.env.example`).
- Never commit the timestamped `backup_*` dirs — they were how the secrets
  multiplied to ~90 copies.
