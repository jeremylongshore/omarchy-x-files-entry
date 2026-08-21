# Verification record

What has actually been proven, how, and what remains.

## Unit suite (dev box + CI)

**40 tests, all passing** (`npm test`), offline. The whole `Model.js` data
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

## Node-free proof (the install-actually-works test)

The plugin ships **no external runtime**: the only script is a small bash
login helper; the poll cycle, spend ledger, and reply store all live in
`Service.qml`. This matters because a stock Omarchy install has no node on the
graphical session PATH (Omarchy installs node through mise, whose shims are
not exported to the session), so a plugin with a node poller would silently
never populate for a real user even though it works on a developer box.

Proven on the Omarchy rig by installing the plugin and launching the shell
with **`node` shadowed by a stub that exits 127**:

- [x] the installed tree's only script is `bin/x-files-login` (bash)
- [x] with node shadowed out of PATH, the QML service loaded credentials,
      rebuilt the store, and wrote state: configured, a 3-item needs-reply
      queue, 1 per-post digest, ledger intact
- [x] the token never reaches `state.json` (grepped for it: absent; only the
      last four characters are stored)
- [x] the panel rendered the queue, the digest with bucket chips and verbatim
      quotes, and the Compact spend bar
- [x] no plugin-sourced errors in the shell log
- [x] `omarchy-plugin-validate` exit 0, `qmllint` 0 errors

## Four-reviewer panel + claim audit (2026-08-21) and what they changed

A full adversarial panel (security, correctness, taste, Omarchy-idiom) plus a
claim-verifier audit ran against the built plugin. The idiom seat returned
PASS with no blockers (every BarWidget/Panel/Service contract byte-verified
against the marketplace-proven sibling). The others found real defects, now
fixed:

- **Security:** the login command took the token as an argv (`--token`), which
  leaks it to shell history and `/proc/<pid>/cmdline` and contradicted the
  stated "token never enters an argv" guarantee. The token is now read from
  stdin only; `--token` is refused. The login writer also gained the `wx`
  symlink guard the poller already had. Spend safety hardened: a cost floor,
  a price-independent read-count ceiling, and a per-fetch cap re-check.
- **Correctness (4 BLOCK):** the dedup threshold shipped at 0.7 in production
  while the tests verified 0.55, so the advertised "+1 similar" collapse did
  not actually fire in the binary; there is now a single `DUP_THRESHOLD` both
  use. The panel cursor tracked a raw array index, so a background poll
  inserting a newer reply could make a keystroke act on the wrong item; it now
  tracks the reply id. An over-cap reply pool evicted the oldest item even if
  it was an unread queue item; it now evicts a done or low-value reply first.
  The internal-state write discipline did a second, un-merged write after
  notify that could revert a concurrent mark-done (and the ledger, a spend
  integrity issue); there is now one merged commit per poll.
- **Correctness (FIX):** self-thread replies are routed by the specific
  `replied_to` id, not the shared conversation id; the queue filters done and
  handled-cluster items before the cap slice; a handled dedup cluster cannot
  reopen when a fresher duplicate arrives; aged-out posts prune their reply
  pools and conversation markers; mentions/conversation fetches gained the
  missing error branches; the mark-all-done sentinel is a real boolean.
- **Taste:** bucket chips pluralize per count ("1 question", not "1
  questions"); a terse gripe ("broken") now clears the queue via a lower
  gripe floor; the cost headline is an honest "$6 to $12/month" acknowledging
  fan-out re-reads; the pill reads "Replies: at cap"; the manifest says
  "switches to an alert color" not "turns loud".
- **Claim audit:** the one refuted claim (a stale "49 tests" line in the
  Listening Post README, which is actually 56) was corrected; every
  security-sensitive claim (stdin-only token, no state.json leak, no X write
  endpoints, strict `--exec` quoting, unconditional caps) came back CONFIRMED.

The suite grew from 31 to 40 tests covering these fixes; all pass offline.

## Four-reviewer panel lessons applied pre-emptively

X Files shares its architecture with the sibling Listening Post plugin, which
took a four-reviewer panel the same day (both have since moved that logic from
a poller CLI into the QML service). Every
BLOCK-class finding from that review was designed into X Files from the
start rather than fixed after: the notification `--exec` URL is single-quoted
and re-tested against a strict `x.com/…/status/…` pattern (Omarchy dispatches
the click action as `bash -lc`); notification positionals go behind `--`;
credential writes go to a 0600 temp file inside a 0700 directory before the
rename; the service is the single owner of the store, so a mark-done can
never be reverted by a concurrent poll and no keystroke needs queueing; and
the panel wires only `activateRequested` (not both it and `returnRequested`)
so Enter fires once. The bearer token additionally
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

The QML layer is proven by the rig render, the data layer by 40 offline
tests. The live X API leg (auth, since_id billing, real reply capture) is
verified against the published docs but not yet exercised against a live
account with credits; that is the next step, and it is what will confirm the
owned-vs-standard read rate and the `tweet.fields`/`post.fields` question.
The BYOK summary leg is exercised by code and fixture, not by a live
completion. Nothing in CI touches the network.
