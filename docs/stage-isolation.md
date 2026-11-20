# Isolated bot staging

This repository uses the shared Rig bot-stage controller and runtime. `rig.yaml`
is the source of configuration; `.github/workflows/rig-stage-build.yml` and
`.rig/bot-stage.json` are generated together by Rig. The manifest pins the exact
Git blob of the reviewed build workflow.

## Deployment and trust

All PRs run application checks on GitHub-hosted runners, including drafts and
contributions from other repositories. An open, ready, same-repository human PR
can build its exact head only after those checks succeed and upload its image
as `stage-<sha>`. Its token has contents-read access,
checkout does not retain credentials, and the workflow does not publish an image,
connect to a deployment host, or receive a bot token.

An operator-installed controller polls successful runs and checks the PR, workflow
blob and artifact identity again before deployment. It sends a bounded image
archive to the root-owned receiver on an existing server. The receiver accepts
only installed repository policies and fixed operations. PR manifests and
artifact paths never select a command, host mount or credential file.

The shared slot is on the existing x86_64 host selected in the private operator
catalog, separate from these repositories. Provisioning a policy requires the
reviewed Rig main, a stage-only credential file, and an independently enabled
30-second expiry/resource reaper. A new PR does not displace an active lease;
the maximum lease here is 30 minutes.

## Runtime limits

The app runs as UID/GID 65532 with a read-only root filesystem, all capabilities
dropped, no privilege escalation, no published ports and no host mounts. It has
384 MiB memory, 0.5 CPU, 128 PIDs and bounded log/tmpfs storage. Its database is
temporary `/app/data/stage.db`. The receiver checks actual Docker isolation
settings after launch.

Only the dedicated `@HyperSummaryStageBot` token is allowed into the app. The receiver verifies
the token's Telegram identity with `getMe` before starting it. It does not read,
merge or mount a production environment. `RIG_STAGE_LIMITED=true` requires a
stage/test bot username and permits startup without production AI, OAuth or
Telegram account credentials. Features needing an absent provider remain
unavailable and must report their actual result; no fake provider response is
used to satisfy QA.

Egress is restricted to the installed public HTTPS allowlist. The app cannot
connect to host services, private network addresses or another production
container. Host preflight requires the app budget plus 512 MiB available reserve;
the reaper stops stage when that reserve or configured memory/I/O pressure bounds
are breached. Production images, databases and service configuration are outside
the stage receiver's cleanup scope.

## Functional verification

The policy is prepared for a dedicated stage bot, but its token has not been
verified or provisioned. Keep this app out of the live operator catalog until a
real dedicated bot identity is available. This repository currently has no
provisioned dedicated-chat browser fixture; `qa: false` makes that limitation
explicit. Hosted tests and runtime isolation alone do not constitute functional
Telegram QA. The token-only configuration supplies neither `BOT_ADMIN_ID` nor
`ALLOWED_CHAT_IDS`; those access controls remain enforced. Its available bot
surface is startup/help and honest access-denial responses. Summary generation,
connected-account features and AI conversations are not verified in this mode.
Do not copy production owner/chat identifiers or weaken access rules to obtain a
stage success.

`rig-stage/isolation` records observed container isolation. It is not a claim
that a Telegram conversation passed. A successful functional run records the
repository, exact SHA, PR number, CI run, case counts and completion time in a
root-owned private receipt. GitHub status text is only a visible summary.

## Operations and rollback

Use the installed trusted Rig CLI for status and deployment. Build a private
operator catalog from reviewed `.rig/bot-stage.json` files, preview the Rig
host/controller installation plans, then apply them through Rig's normal apply
path. Credentials and QA SSH identity/known-hosts files are installed privately
and never committed to these repositories. See Rig's `docs/bot-stage.md` for
the common installation schema and commands.

After CI and the required real QA, ship through the normal repository review and
`gh ship` gates. The production controller migration must be complete before
retiring repository-assignable runners. Stage changes do not authorize replacing
a running production image with an older source revision.

For rollback, stop the shared stage lease and its controller timer. Preserve the
receiver's install backups and any previous stage data; do not resume a legacy
workflow that combines PR execution with production credentials or a persistent
host runner. Production remains independently managed. Reinstall a previously
reviewed Rig receiver/policy if the runtime itself needs rollback.

The root-owned receiver verifies the token with Telegram `getMe`, compares the exact
username with `telegram_username`, and injects that verified `BOT_USERNAME`. The
manifest repeats the expected username so configuration-only startup checks use the
same explicit settings. A local username string is not the token identity check.
Application state is a private writable tmpfs at `/app/data`; the image filesystem
remains read-only.
