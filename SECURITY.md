# Security

## Threat model

X Files handles a live X API bearer token (which can read the account's
data and spend credits) and renders reply text authored by strangers inside
the shell process. Two things must never happen: the token must never leak,
and a hostile reply must never fetch, execute, or mis-render inside the shell.

## Credential handling

- **One writer.** `bin/x-files-login` is the only code that writes
  `credentials.json`. The QML service reads it and never writes it; the panel
  never reads it at all. Only the token's last four characters reach
  `state.json` and the rendered UI.
- **The token never enters an argv, at any step.** The login command reads
  the token from **stdin** (`printf %s "$TOKEN" | x-files-login …`, or an
  interactive paste), never from `--token`, so it never lands in shell
  history or a world-readable `/proc/<pid>/cmdline`; passing `--token` is
  refused with an explanation. Both the login script and the QML service then
  hand the `Authorization: Bearer` header to curl over stdin (`--header @-`),
  so the token is invisible to `ps` for the lifetime of every request. In QML
  that is a `Process` with `stdinEnabled`, the same mechanism the first-party
  network panel uses to pass a wifi passphrase. It appears only in
  `credentials.json`, never in `state.json`, never in a log line, never in a
  notification.
- **File modes.** `credentials.json` is written to a `mktemp` file chmod-ed
  0600 inside a 0700 directory and then renamed, so the token is never
  world-readable even briefly. Plugin state is written through Quickshell's
  `FileView` with `atomicWrites: true`, inheriting the shell's own write
  discipline rather than reimplementing it.

## Architecture control

The plugin has no external runtime: no node, no python. The only shell script
it ships is the one-time login; everything else runs inside Quickshell, using
the `curl` and `jq` a stock Omarchy install already has. All I/O lives in one
small bash script and one QML file:

- **Fetch**: `curl -sS --proto =https --max-time 20 --max-filesize 2000000`
  GET per endpoint, issued from `Service.qml` through a QML `Process`.
  `--proto =https` pins the scheme, `--` closes option parsing before the URL, and the URL is built by `Model` from a numeric user
  id and validated fields, never from reply content.
- **State**: two JSON files under `~/.local/state/omarchy/x-files/`, written
  through `FileView` with `atomicWrites: true` by the service, the single
  owner of the store; the panel only reads them.
- **Mark-done and refresh** are direct in-process calls into the service, the
  single owner of the reply store, so there is no cross-process write race
  that could lose a keystroke.

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
service stops fetching entirely until the month rolls over (`budgetStopped`),
and the panel shows a hard-stop banner. Two defenses make the cap robust
against a mis-set price: `costPerPost` is clamped to a floor, and a second,
price-independent read-count ceiling (derived from the dollar cap at that
floor) also hard-stops the poll, so an implausibly low rate cannot let the
dollar meter read ~$0 while real reads run unbounded. The cap is re-checked
before every fetch within a poll, so a cycle that starts under the cap
cannot overshoot it. `since_id` on every fetch and a reply-count-gated
fan-out keep spend proportional to real new activity, not to poll frequency.

## What this plugin reads and writes

- Reads: `api.x.com` (GET, the account's own posts, mentions, and reply
  conversations), `~/.config/omarchy/shell.json` (its own settings), and its
  own `credentials.json`.
- Writes: only `~/.local/state/omarchy/x-files/`.
- No telemetry. Nothing is sent anywhere except the authenticated GETs to
  `api.x.com` and, if configured, POSTs to the user's own completion endpoint.

## Reporting

Open an issue on this repository or email jeremy@intentsolutions.io.
