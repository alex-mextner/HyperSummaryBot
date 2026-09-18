# MTProto account lifecycle

The bot never asks for phone/OTP/2FA in Telegram messages. Admin login is a local,
trusted-TTY operation. These scripts recover useful unmerged work from commit
04ea4a3 and share MTPROTO_SESSION_PATH with the runtime.

1. Stop only `hyper-summary-bot` in PM2 before account administration.
2. Set `MTPROTO_ADMIN_BOT_STOPPED=YES` and run `bun run mtproto:connect` in the
   deployment directory. Enter secrets only in the trusted terminal. OTP and
   password echo is disabled; passwords are not trimmed.
3. Start the bot and verify its health and authorized message ingestion.

For intentional account revocation, keep the bot stopped, set both
`MTPROTO_ADMIN_BOT_STOPPED=YES` and `CONFIRM_REVOKE_MTPROTO=YES`, and run
`bun run mtproto:revoke`. This really logs out the session and removes local
session files; it is not a routine health check. Telegram Settings > Devices is
an alternative operator revocation surface.

New session directories use mode 0700; existing session/WAL/SHM files are hardened
to 0600 without changing permissions of an arbitrary existing parent directory.
CLI creates files with a restrictive umask and destroys its SDK client on exit.
Runtime shutdown removes its exact listeners and destroys its singleton client.
The stop flag is operator acknowledgement, not a cross-process distributed lock.
Never run the CLI concurrently with the bot. Live login/revocation was NOT run as
part of automated testing, and no active user session was replaced.

Verification: a failing SDK destroy was reproduced before the cleanup fix; both
successful and failing shutdown now clear the cached client. Revocation uses the
same restrictive umask as login. SIGINT/SIGTERM restore terminal echo. Unit tests
use only synthetic credentials and temporary files; no real account was revoked.
