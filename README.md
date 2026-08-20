# X Files

The only desktop surface that reads the replies to your own X posts and tells
you what they said: classified digests, representative quotes, and a drainable
needs-your-reply queue, for a few dollars a month of API credits with an
always-visible spend meter.

```
                    nothing waiting: the slot collapses
Replies: 3          three replies need you (questions, gripes, feature asks)
Replies: paused     the monthly spend cap was reached
X Files: setup      run x-files-login to connect your account
```

X Files keeps the file on every reply to your posts, so you read what
matters and skip what does not. It never posts, never DMs, never scores
sentiment, and never reads your whole timeline. It reads the replies to
*your* posts, buckets them, and hands you the ones that actually need an
answer.

## What it does

- **A drainable queue**, not a feed. Questions, gripes, and feature asks with
  real substance, from other people, one per near-duplicate group, sorted
  newest-first. `+1` chains, praise, and spam never reach it. Press `m` to
  clear one, `c` to clear all.
- **Per-post digests.** For each recent post: reply volume and velocity,
  bucket chips (`4 gripes · 2 questions · 1 ask`), and two verbatim quotes
  from the loudest buckets. Buckets and quotes, never a numeric sentiment
  score.
- **A live spend meter.** X API reads are pay-per-use, so X Files keeps
  a running monthly ledger and shows it: `$1.83 this month, ~$4.10
  projected · cap $8.00`. The cap is a hard stop, not a warning.

## The cost story

X API v2 is [pay-per-use credits](https://console.x.com): **$0.005 per post
read**, and just **$0.001 for "owned reads"** of your own data (verified at
`docs.x.com/x-api/getting-started/pricing`, 2026-08-20). X Files keeps
the bill small with `since_id` discipline: every poll asks only for what
arrived since the last one, an empty poll is nearly free, and the
conversation fan-out is gated on a post's reply count actually rising. A
founder with roughly 1,200 replies a month lands around **$6/month**, versus
$40/month for a dumb column reader that fetches everything every time. The
spend meter is the pitch.

Buy about $5 of credits first to confirm which rate your account bills reply
reads at (owned vs standard is a 5x swing) and to seed live fixtures. The
per-post rate is a setting, so you tune the meter to what you actually see.

## Install and connect

```bash
omarchy plugin add https://github.com/jeremylongshore/omarchy-x-files-entry --enable
```

Then connect your X account. The login command is separate on purpose: the
widget never writes or sees your token, and settings only ever show its last
four characters.

```bash
# Get an app-only bearer token and credits at https://console.x.com
~/.config/omarchy/plugins/io.github.jeremylongshore.x-files/bin/x-files-login \
  --token <your-bearer-token> --username <your-x-handle>
```

Add **X Files** to your bar layout (Omarchy menu, Bar, or
`~/.config/omarchy/shell.json`). The service starts polling every 15 minutes.

To disconnect: `x-files-login --forget`. State lives in
`~/.local/state/omarchy/x-files/` and is safe to delete.

## The panel

Standard Omarchy panel keys:

| Key | Action |
| --- | --- |
| `j` / `k` or arrows | Move the cursor in the queue |
| `Enter` or `o` | Open the reply's thread in your browser |
| `m` or `x` | Mark the selected reply done |
| `c` | Clear the whole queue |
| `r` | Refresh now (no notification) |
| `Esc` | Close |
| `Tab` / `Shift+Tab` | Switch to the neighboring bar panel |

Left-click opens a reply, right-click marks it done. Middle-click the pill to
refresh.

## Optional AI summaries (BYOK)

Point the three `ai*` settings at any OpenAI-compatible completion endpoint
and each busy post gets a two- or three-sentence summary above its quotes.
Two-pass by design: classification is local and free, and only a post whose
conversation grew is worth a completion. Every quote is PII-stripped (emails,
tokens, keys, phone numbers) before it leaves for the model. Off by default;
the widget is complete without it.

## What it will never do

Auto-reply, auto-DM, follower or viral metrics, full-timeline reading, post
scheduling, numeric sentiment scores, or cloud sync. Those were considered
and rejected: this is a reading tool, not a growth tool.

## Architecture

```
bin/x-files-login   writes credentials.json (0600), the ONLY token writer
bin/x-files-poll    the only network and the only state writer (node CLI)
        |  curl --proto =https, Authorization via stdin (never argv),
        |  since_id on every fetch, spend charged per returned post
        v
~/.local/state/omarchy/x-files/state.json   atomic tmp+mv, no token in it
        ^
        |  read only
Service.qml (timer)   BarWidget.qml + Panel.qml (render + keys)
```

The QML side never touches the network, never writes a file, and never sees
the token. The bearer token rides curl's stdin (`--header @-`), so it never
appears in a process argv, and it lives only in `credentials.json` (mode
0600), never in `state.json` or any log. Every mutation, including mark-done,
is a call into the poller CLI, so the entire I/O surface is two auditable
scripts.

Network hosts: `api.x.com` (GET only), plus your own BYOK completion endpoint
(POST, only if configured). No telemetry, nothing sent anywhere else.

## Testing

```bash
npm test
```

31 tests over the pure data layer: the X API v2 parsers, lane classification,
substance scoring, hybrid dedupe, PII redaction, digest building, the
needs-reply gate, the spend ledger and projection, and the state record.
Offline against synthesized v2 fixtures; the live-capture procedure is in
`docs/FIXTURES.md`.

## License

MIT
