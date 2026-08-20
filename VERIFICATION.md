# Verification record

What has actually been proven, how, and what remains.

## Unit suite (dev box + CI)

**31 tests, all passing** (`npm test`), offline. The whole `Model.js` data
layer: the X API v2 parsers (user lookup, tweet list with `includes.users`
join and `meta.result_count`), the reply classifier (praise / gripe /
question / feature_ask / noise, with sarcasm reading as gripe and a
"love it but it crashes" reading as gripe), substance scoring, hybrid
trigram+token dedupe, PII redaction (emails, tokens, keys, phones), digest
building (bucket counts, chips, verbatim quotes, velocity), the needs-reply
gate, the spend ledger with monthly reset and linear projection, the hard
cap, and the state record.

## X API v2 verified against live docs (2026-08-20)

The endpoints and pricing were checked against `docs.x.com`, not assumed:

- `GET /2/users/:id/tweets` (own posts; `exclude=retweets,replies`),
  `GET /2/users/:id/mentions`, and `GET /2/tweets/search/recent?query=conversation_id:<id>`
  all confirmed to support `since_id`, `max_results` 5-100, `expansions=author_id`,
  and app-only `BearerToken`.
- Pricing confirmed at `docs.x.com/x-api/getting-started/pricing`: a post
  read is `$0.005`, "owned reads" of your own data are `$0.001` (the 5x
  swing), pay-per-use is capped at 3M reads/month, and the credits portal is
  `console.x.com`. The plugin's default per-post cost (`0.005`) and monthly
  cap match; the rate is a setting so it can be tuned to `0.001` once live
  billing confirms which class reply reads fall under.
- One open item flagged in `Model.js` and `docs/FIXTURES.md`: X's current
  docs name the field selector `post.fields`; this plugin sends the
  long-standing `tweet.fields` alias (what the sibling x-bug-triage plugin
  uses live). If a live capture returns without the requested fields, switch
  the param name.

## Offline data pipeline (dev box)

Run end to end against synthesized v2 fixtures: a seven-reply conversation
(two near-duplicate Wayland-crash reports, a feature ask, a question, praise,
a bare "+1", and spam) produces a three-item needs-reply queue (the two crash
reports collapse to one canonical with a "+1 similar" tag; praise, spam, and
the "+1" never reach the queue), correct bucket chips, two verbatim quotes,
and a charged spend ledger. Fixtures are synthesized because API credits were
not yet purchased; the live-capture procedure is in `docs/FIXTURES.md`.

## Four-reviewer panel lessons applied pre-emptively

X Files shares the poller-CLI + QML-render architecture that the sibling
Listening Post plugin took through a four-reviewer panel the same day. Every
BLOCK-class finding from that review was designed into X Files from the
start rather than fixed after: the notification `--exec` URL is single-quoted
and re-tested against a strict `x.com/…/status/…` pattern (Omarchy dispatches
the click action as `bash -lc`); notification positionals go behind `--`;
the atomic writer uses the `wx` flag against symlink attacks; the poll
re-reads on-disk done flags before writing to avoid reverting a concurrent
mark-done; the panel queues mark-done keystrokes that arrive during an
in-flight write; and the panel wires only `activateRequested` (not both it
and `returnRequested`) so Enter fires once. The bearer token additionally
rides curl's stdin, never an argv.

## Proven on the Omarchy rig (2026-08-20)

- [x] `omarchy-plugin-validate .` exit 0
- [x] `qmllint BarWidget.qml Panel.qml Service.qml` 0 errors
- [x] Installed as a `service` + `bar-widget`; the pill rendered "Replies: 3"
- [x] Panel opened against a seeded configured state: the account line showing
      only the token's last four, the live spend meter
      ("$1.83 this month, ~$2.84 projected · cap $8.00"), the three-item
      NEEDS YOUR REPLY queue with the deduped gripe, and a per-post digest
      with bucket chips and two verbatim quotes
- [x] `preview.png` captured from that render
- [x] No plugin-sourced errors in the shell log

## Honest boundary

The QML layer is proven by the rig render, the data layer by 31 offline
tests. The live X API leg (auth, since_id billing, real reply capture) is
verified against the published docs but not yet exercised against a live
account with credits; that is the next step, and it is what will confirm the
owned-vs-standard read rate and the `tweet.fields`/`post.fields` question.
The BYOK summary leg is exercised by code and fixture, not by a live
completion. Nothing in CI touches the network.
