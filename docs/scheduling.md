# Scheduling `issuary sync`

`issuary` is not a daemon. To keep your local mirror fresh, let the operating
system scheduler (cron on Linux, launchd on macOS) run `issuary sync` on an
interval. This page has concrete recipes.

The key flag is `--quiet`: in quiet mode `issuary sync` prints nothing when there
was no activity across all watched repos (no new issues, closures, reopens, or
comments, and no errors), so a scheduled run does not generate noise or mail on
every cycle. It still prints a concise summary when something changed, and it
always prints failed repos. The exit code is `0` on success (even with no
changes) and non-zero when any repo failed to sync, so a monitor can detect
problems.

## What it needs

- **`GITHUB_TOKEN`** in the environment. A scheduler runs with a minimal
  environment, so set the token explicitly in the job (do not rely on your
  interactive shell profile).
- **`ISSUARY_HOME`** (optional) points at the directory holding local state. The
  SQLite database lives at `$ISSUARY_HOME/db.sqlite`, defaulting to
  `~/.issuary/db.sqlite`. Set `ISSUARY_HOME` explicitly in the job if you do not want
  to depend on `HOME` being resolved the same way it is in your shell.

## crontab (Linux, and macOS if you prefer cron)

Run every 15 minutes, quiet so a no-op cycle is silent:

```cron
# m  h  dom mon dow  command
*/15 *  *   *   *    GITHUB_TOKEN=ghp_xxx ISSUARY_HOME=/home/you/.issuary /usr/local/bin/issuary sync --quiet
```

Notes:

- Use the absolute path to the `issuary` binary (`which issuary`); cron's `PATH` is
  minimal.
- With `--quiet`, cron only mails you when there is activity or a failure. If
  you would rather capture everything to a log, redirect instead:

  ```cron
  */15 * * * * GITHUB_TOKEN=ghp_xxx /usr/local/bin/issuary sync --quiet >> /home/you/.issuary/sync.log 2>&1
  ```

- To be alerted on failures, let the non-zero exit surface. For example, wrap
  the command so a wrapper script can notify on a non-zero status, or rely on
  your cron mail (failed repos print `repo: failed (...)` to stdout/stderr and
  the process exits non-zero).

## launchd (macOS)

Create `~/Library/LaunchAgents/com.merencia.issuary-sync.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>com.merencia.issuary-sync</string>

    <key>ProgramArguments</key>
    <array>
      <string>/usr/local/bin/issuary</string>
      <string>sync</string>
      <string>--quiet</string>
    </array>

    <key>EnvironmentVariables</key>
    <dict>
      <key>GITHUB_TOKEN</key>
      <string>ghp_xxx</string>
      <key>ISSUARY_HOME</key>
      <string>/Users/you/.issuary</string>
    </dict>

    <!-- Run every 15 minutes (900 seconds). -->
    <key>StartInterval</key>
    <integer>900</integer>

    <key>StandardOutPath</key>
    <string>/Users/you/.issuary/sync.log</string>
    <key>StandardErrorPath</key>
    <string>/Users/you/.issuary/sync.err.log</string>
  </dict>
</plist>
```

Load it (and reload after edits):

```sh
launchctl unload ~/Library/LaunchAgents/com.merencia.issuary-sync.plist 2>/dev/null
launchctl load ~/Library/LaunchAgents/com.merencia.issuary-sync.plist
```

Use the absolute path to the `issuary` binary in `ProgramArguments` (run
`which issuary` to find it). With `--quiet`, `sync.log` only grows when there is
activity.

## Rate limits and cost

Quiet, frequent runs are cheap by design. `sync` fetches incrementally with the
GitHub `since` parameter and an `ETag`; when nothing changed the API returns
`304 Not Modified`, which does not spend your rate limit. Comment threads are
not pulled on every sync. So a tight schedule (every few minutes) over many
repos mostly hits `304`s and costs little, while quiet mode keeps those no-op
cycles silent.

## How failures surface

- Any repo that fails to sync (network error, 404/private, token without
  access) prints a `repo: failed (<reason>)` line. This line is printed even in
  `--quiet` mode.
- The process exits non-zero whenever at least one repo failed, so cron mail,
  launchd, or an external monitor can detect the failure. A successful run with
  no changes exits `0`.
- A failed repo never advances its `ETag` or last-synced timestamp, so the next
  scheduled run retries it cleanly.
