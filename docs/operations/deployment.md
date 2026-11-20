# Deployment

Production runs on the home server `bananapi-m4` (Banana Pi BPI-M4, Armbian trixie arm64,
2 GB RAM, root on a microSD card), next to ExpenseSyncBot and HyperCalendarBot.
SSH: `root@bananapi-m4` or `ultra@bananapi-m4` over Tailscale (LAN `192.168.0.42`).
The host is declared in `machines/bananapi-m4` of the homelab repository
(alex-mextner/ha-configs-rs-bg-spomenik): Bun, the `hsb` user, the systemd unit, the
sudo rule and the runner's directory come from there; this repository owns the
checkout and the deploy.

## Runtime

- Checkout: `/srv/hyper-summary-bot`, owned by `hsb`, detached at the deployed SHA.
  Untracked production files: `.env` (mode 0600), `data/` (`hyper-summary.db` + WAL,
  `mtcute-session` + WAL). The checkout is mode 0750, so the other bots' service users
  on this host can't read the database or the session.
- Bun 1.4.2 at `/usr/local/bin/bun` (the version CI tests with).
- systemd unit `hyper-summary-bot.service` (enabled): `User=hsb`, `bun src/index.ts` in
  the checkout (Bun loads `.env` from there), `NODE_ENV=production`,
  `After=`/`Wants=network-online.target`, `Restart=always` with `RestartSec=3` (so a
  late network at boot can't exhaust the default start limit of 5 starts per 10 s),
  `MemoryMax=448M`, `ConditionPathExists=` on `.env`. Logs go to the journal:
  `journalctl -u hyper-summary-bot`.
- The bot listens on `:3003` (`/webhook` with the secret header, `/healthz`).
  On start it calls `setWebhook` with `WEBHOOK_URL` and `WEBHOOK_SECRET` from `.env`.

## Ingress

Cloudflare Tunnel `bananapi-m4` (remotely managed; cloudflared runs on the host as the
Compose stack `/srv/compose/cloudflared`) routes `hyper-summary-bot.mextner.com` →
`http://localhost:3003`. There is no Caddy site for the bot.

## CI deploy

`.github/workflows/deploy.yml`: on push to `main` (or a manual dispatch on `main`; a
dispatch from another branch only runs `test`) the `test`
job runs on GitHub-hosted runners, then `deploy` runs on the repo-scoped
self-hosted runner `bananapi-hsb` (labels `bananapi-m4`, `hyper-summary-bot`; installed at
`/var/lib/hsb/actions-runner` as `hsb`, systemd unit
`actions.runner.alex-mextner-HyperSummaryBot.bananapi-hsb.service`). It checks out the
exact tested SHA, installs dependencies, runs `bun run db:migrate`, restarts the unit
with `sudo -n /usr/bin/systemctl restart hyper-summary-bot.service` (the runner user's
only root right, `/etc/sudoers.d/hsb-deploy`) and waits until `/healthz` reports the
new `buildSha`.

The repo is public. No workflow in the repo runs PR code on the self-hosted runner,
but a fork PR can add its own workflow that targets it, and that would run as
`hsb` with access to `.env` and the session. Fork runs need maintainer
approval for every external contributor (`all_external_contributors` policy):
never approve a fork run that adds or edits `.github/workflows/*`.

## Manual operations

```bash
systemctl status hyper-summary-bot
journalctl -u hyper-summary-bot -n 100
curl -s localhost:3003/healthz
```

### Keeping the bot down

Stopping the unit doesn't keep the bot down: the next deploy's `systemctl restart`
starts it again, and so does a reboot. To keep it down (MTProto account
administration, see `mtproto-admin.md`), disable the runner first. Disabling the
runner cancels a running deploy, possibly after its `git checkout` and before
`bun install`/`db:migrate`; the running bot still reports its old `buildSha`, but the
next start would run the new SHA without its install or migrations. So first check
that no deploy is running (`gh run list -R alex-mextner/HyperSummaryBot --workflow
deploy.yml --status in_progress` is empty), and wait for it if one is:

```bash
sudo systemctl disable --now actions.runner.alex-mextner-HyperSummaryBot.bananapi-hsb.service
sudo systemctl disable --now hyper-summary-bot
! systemctl is-active hyper-summary-bot
# ... work ...
sudo systemctl enable --now hyper-summary-bot
sudo systemctl enable --now actions.runner.alex-mextner-HyperSummaryBot.bananapi-hsb.service
```

If a deploy was cancelled anyway (before re-enabling, `git -C /srv/hyper-summary-bot
rev-parse HEAD` differs from the last successful deploy, `gh run list -R
alex-mextner/HyperSummaryBot --workflow deploy.yml --branch main --status success -L 1
--json headSha`), its checkout may sit at a SHA whose dependencies or
migrations didn't finish. Then bring the bot back with `sudo systemctl enable
hyper-summary-bot` (no `--now`), enable the runner, and re-run the deploy on `main`
(`gh workflow run deploy.yml -R alex-mextner/HyperSummaryBot --ref main`): its restart
starts the bot only after install and migrate.

For a consistent manual backup, keep the bot down as above (a plain stop isn't enough)
and copy each SQLite file together with its `-wal`/`-shm`, or use `sqlite3 .backup` /
`VACUUM INTO`, which are consistent while the bot runs; the nightly homelab backup
dumps `hyper-summary.db` and `mtcute-session` with `VACUUM INTO`. Avoid long bulk
operations on the SD card.

## Move of 2026-11-20 from the odroid (#48)

Until 2026-11-20 the bot ran on the odroid (Odroid N2+, `root@odroidn2`) under PM2 as
`www-data` from `/var/www/hyper-summary-bot`, behind the tunnel `odroid-home`, deployed
by the runner `odroid-hsb`. The odroid was short of memory and is being reinstalled, so
the bot moved:

1. Prepared the Banana Pi from the homelab repository and registered `bananapi-hsb`;
   cloned the repository to `/srv/hyper-summary-bot` at the commit the odroid ran and
   installed its dependencies.
2. Stopped the odroid runner, then `pm2 stop hyper-summary-bot` on the odroid; copied
   `.env` and `data/` (each SQLite file with its `-wal`/`-shm`, the bot stopped) to the
   Banana Pi and checked them with `PRAGMA quick_check`.
3. Moved the DNS record of `hyper-summary-bot.mextner.com` from tunnel `odroid-home` to
   tunnel `bananapi-m4` and started `hyper-summary-bot.service`; it registered the same
   webhook URL and Telegram redelivered the updates it had queued meanwhile (about 50 s
   of downtime).
4. Checked `/healthz` through the public name, the webhook (0 pending, no errors) and
   the MTProto sync. Then unregistered the runner `odroid-hsb`, disabled its service and
   removed the app from the odroid's PM2 list (`pm2 delete` + `pm2 save`), so nothing
   there can start a second copy. The odroid checkout (with its `ecosystem.config.cjs`),
   `.env` and `data/` stay as they were at the switch. The merge of this change is the
   first deploy on `bananapi-hsb`.

Rollback while the odroid still holds its copy. The bot must never run on both hosts:
they share the MTProto session, and Telegram can invalidate it (`AUTH_KEY_DUPLICATED`).
The odroid runs the switch commit, so this only works while no deploy since the switch
has changed the database schema (`bun run db:migrate`); otherwise move forward instead.

1. On the Banana Pi, as root, take the bot down so neither a deploy nor a reboot starts
   it again (the unit only starts while `.env` exists). First check no deploy is running,
   as in "Keeping the bot down", and re-check the precondition above once the runner is off:

   ```bash
   systemctl disable --now actions.runner.alex-mextner-HyperSummaryBot.bananapi-hsb.service
   systemctl disable --now hyper-summary-bot
   mv /srv/hyper-summary-bot/.env /srv/hyper-summary-bot/.env.rolled-back.local
   ```

2. To keep messages ingested since the move, replace the odroid's `data/` with this one
   (the bot is stopped on both hosts). Move the old copy aside, outside the checkout (it
   holds the MTProto session, which `.gitignore` doesn't cover), rather than extracting
   over it: a stale `-wal` left next to a newer database corrupts it. The copy must pass
   the same `PRAGMA quick_check` as the move before anything starts on it:

   ```bash
   set -o pipefail
   ssh root@odroidn2 'mv /var/www/hyper-summary-bot/data /var/www/hyper-summary-bot.data.at-switch && mkdir /var/www/hyper-summary-bot/data'
   ssh root@bananapi-m4 'tar -C /srv/hyper-summary-bot -cf - data' |
     ssh root@odroidn2 'cd /var/www/hyper-summary-bot && tar -xf - &&
       for f in data/hyper-summary.db data/mtcute-session; do
         test -s "$f" && [ "$(sqlite3 "$f" "PRAGMA quick_check")" = ok ] || { echo "$f failed the check"; exit 1; }
       done && chown -R www-data:www-data data'
   ```

3. Point the DNS record `hyper-summary-bot.mextner.com` back to the tunnel
   `odroid-home` (CNAME `<tunnel id>.cfargotunnel.com`), and make sure that tunnel's
   configuration still routes the name to `http://localhost:3003`.
4. On the odroid, as root, start the app from its PM2 config and save the list so a
   reboot restores it (PM2 must run under Node, with the `www-data` home):

   ```bash
   cd /var/www/hyper-summary-bot
   P='env HOME=/var/www PM2_HOME=/var/www/.pm2 PATH=/var/www/.nvm/versions/node/v22.17.0/bin:/var/www/.bun/bin:/usr/bin:/bin'
   sudo -u www-data $P pm2 start ecosystem.config.cjs && sudo -u www-data $P pm2 save
   curl -s localhost:3003/healthz
   ```

5. Deploys can't reach the odroid until the move is undone in the repository:
   `git revert` this change (it restores the PM2 workflow and `ecosystem.config.cjs`),
   cancel any deploy run still queued for `bananapi-hsb` (it holds the
   `production-deploy` concurrency group), and register an odroid runner again. A
   branch cut before this change still carries the odroid workflow (its deploy job
   targets `odroid` and would deploy that branch): cancel any run of such a branch
   before registering the runner.

End of the rollback window: once the first deploy has migrated the schema, or the
odroid is reinstalled, delete `/var/www/hyper-summary-bot` and any
`/var/www/hyper-summary-bot.data.at-switch` on the odroid, including on its old Armbian
eMMC module. They hold `.env` and the production MTProto session. If a copy ever left
your control, end that session in Telegram Settings > Devices, log in again
(`mtproto-admin.md`), and rotate `BOT_TOKEN` and `WEBHOOK_SECRET`.
