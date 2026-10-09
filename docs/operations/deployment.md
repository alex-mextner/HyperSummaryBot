# Deployment

Production runs on the home server `odroid` (Odroid N2+, Armbian arm64, 3.7 GB RAM).
SSH: `root@odroidn2` over Tailscale (LAN `192.168.0.38`).

## Runtime

- Checkout: `/var/www/hyper-summary-bot`, owned by `www-data`, detached at the
  deployed SHA. Untracked production files: `.env` (mode 0600), `data/`
  (`hyper-summary.db` + WAL, `mtcute-session` + WAL), `logs/`.
- Bun: `/var/www/.bun/bin/bun`. PM2: `/var/www/.bun/bin/pm2`, `PM2_HOME=/var/www/.pm2`.
  The PM2 CLI must run under Node (`/var/www/.nvm/versions/node/v22.17.0/bin` first
  in `PATH`); `ecosystem.config.cjs` is CommonJS because `package.json` is ESM.
- The PM2 daemon is shared with other apps and started by `pm2-www-data.service`,
  which resurrects the list saved by `pm2 save`.
- The bot listens on `:3003` (`/webhook` with the secret header, `/healthz`).
  On start it calls `setWebhook` with `WEBHOOK_URL` and `WEBHOOK_SECRET` from `.env`.

## Ingress

Cloudflare Tunnel `odroid-home` (remotely managed `cloudflared` service on odroid)
routes `hyper-summary-bot.mextner.com` → `http://localhost:3003`. There is no Caddy
site for the bot on odroid.

## CI deploy

`.github/workflows/deploy.yml`: on push to `main` (or manual dispatch) the `test`
job runs on GitHub-hosted runners, then `deploy` runs on the repo-scoped
self-hosted runner `odroid-hsb` (labels `odroid`, `hyper-summary-bot`; installed at
`/var/www/actions-runner-hsb` as `www-data`, systemd unit
`actions.runner.alex-mextner-HyperSummaryBot.odroid-hsb.service`). It checks out the
exact tested SHA, installs dependencies, runs `bun run db:migrate`, reloads PM2,
waits until `/healthz` reports the new `buildSha`, then runs `pm2 save`.

The repo is public: fork PRs need maintainer approval for every external
contributor (`all_external_contributors` policy), and no workflow runs untrusted
PR code on the self-hosted runner.

## Manual operations

```bash
sudo -u www-data env HOME=/var/www PM2_HOME=/var/www/.pm2 \
  PATH=/var/www/.nvm/versions/node/v22.17.0/bin:/var/www/.bun/bin:/usr/bin:/bin \
  pm2 describe hyper-summary-bot
curl -s localhost:3003/healthz
```

Take consistent backups with the bot stopped (copy each SQLite file together with
its `-wal`/`-shm`). The board is sensitive to sustained heavy IO; avoid long
bulk operations on its SD card.
