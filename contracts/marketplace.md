# Marketplace contract

X Files ships one `barWidget` whose public listing and runtime widget share the
same product promise.

- Both manifest descriptions are identical and exactly 500 characters.
- The copy states the queue, digest, spend, read-scope, credential, BYOK, and
  write/privacy boundaries.
- `assets/banner.svg` depicts the reply queue, per-post digest, and spend meter.
- `preview.png` is accepted only with current-tree Buzz provenance, exact
  1280x720 dimensions, a clean shell-log hash, and explicit visual approval.
- X reads are bounded to the connected user's posts, mentions, and reply
  conversations. The plugin has no post, DM, timeline, or sentiment path.
- Optional summaries remain disabled until a user configures a compatible
  endpoint, model, and key; quoted text is PII-redacted first.

`tests/contract.test.js` and gate C43 enforce the machine-checkable portions.
