# Security

## Threat model

X Files handles a live X API bearer token (which can read the account's
data and spend credits) and renders reply text authored by strangers inside
the shell process. Two things must never happen: the token must never leak,
and a hostile reply must never fetch, execute, or mis-render inside the shell.

## Credential handling

- **One writer.** `bin/x-files-login` is the only code that writes
  `credentials.json`. The QML widget and the poller never write it; the
  widget never reads it at all. Settings show only the token's last four
  characters, sourced from `state.json`.
- **The token never enters an argv.** Both CLIs pass the `Authorization:
  Bearer` header to curl over stdin (`--header @-`), so the token is invisible
  to `ps` for the lifetime of every request. It appears only in
  `credentials.json`, never in `state.json`, never in a log line, never in a
  notification.
- **File modes.** `credentials.json` and its directory are mode 0600/0700;
  the atomic writer opens the tmp file `wx` (`O_CREAT|O_EXCL`), so a
  same-uid attacker cannot redirect the write through a pre-planted symlink
  at the predictable path.

## Architecture control

The QML side never touches the network and never writes a file. All I/O lives
in two auditable scripts:

- **Fetch**: `curl -sS --proto =https --max-time 20 --max-filesize 2000000`
  GET per endpoint. `--proto =https` pins the scheme, `--` closes option
  parsing before the URL, and the URL is built by `Model` from a numeric user
  id and validated fields, never from reply content.
- **State**: one JSON file, written atomically (tmp+mv) with a single writer;
  the panel only reads it.
- **Mark-done and refresh** from the panel are argv calls back into the
  poller, never file writes from QML.

## Input containment

1. Every API body is bounded in-process (2 MB) before `JSON.parse`, and every
   parser returns a zero shape on malformed or oversized input; the stored
   state keeps last-good.
2. Every reply string that reaches a QML `Text` or a notification goes
   through `Model.clean()`: angle brackets out (defuses Qt AutoText promotion
   to StyledText), ASCII controls out, bidi override marks and Unicode tag
   characters out (CVE-2021-42574 class), length capped.
3. `textFormat: Text.PlainText` on every data-bound `Text` in the panel.
4. Thread URLs are built only from a `[A-Za-z0-9_]` handle and a numeric id,
   so a reply's text can never reach a URL. Omarchy dispatches a notification
   click action as `bash -lc "<value>"`, so the URL is single-quoted in the
   `--exec` string and re-tested against the strict `x.com/…/status/…` pattern
   immediately before use; the `xdg-open` path from the panel passes an argv
   list (no shell) with the same check.
5. Notification argv safety: flags go first and the feed-derived positionals
   (author line, reply text) go last behind `--`, with a leading-dash strip,
   so a reply cannot present as a notify-send option.
6. PII redaction: any reply text headed into a BYOK completion prompt is run
   through `redactPii` first (emails, URL tokens, API keys, phone numbers), so
   a stranger's contact detail or a pasted secret never rides to a
   third-party model.
7. Bounded stores: 200 replies per post, 50 queue rows, 10 tracked posts,
   fan-out capped per poll, so a viral thread cannot blow the store, the
   render, or the budget in one cycle.

## Spend safety

The monthly ledger is charged per returned post; at the configured cap the
poller stops fetching entirely until the month rolls over (`budgetStopped`),
and the panel shows a hard-stop banner. `since_id` on every fetch and a
reply-count-gated fan-out keep the spend proportional to real new activity,
not to poll frequency.

## What this plugin reads and writes

- Reads: `api.x.com` (GET, the account's own posts, mentions, and reply
  conversations), `~/.config/omarchy/shell.json` (its own settings), and its
  own `credentials.json`.
- Writes: only `~/.local/state/omarchy/x-files/`.
- No telemetry. Nothing is sent anywhere except the authenticated GETs to
  `api.x.com` and, if configured, POSTs to the user's own completion endpoint.

## Reporting

Open an issue on this repository or email jeremy@intentsolutions.io.
