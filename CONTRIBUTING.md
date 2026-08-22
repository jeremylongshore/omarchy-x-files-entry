# Contributing

Issues and pull requests are welcome. This is a small plugin, so the bar is
practical rather than bureaucratic.

## Before you open a pull request

```bash
npm test                          # offline suite, never touches the network
scripts/run-plugin-gates.sh .     # the vendored gate lane
```

Both must pass. The gate lane is vendored into this repository on purpose:
enforcement travels with the code, so it runs on your machine and in CI rather
than living in a tool only the maintainer has.

Do not hand-edit anything under `scripts/gates/`. It is synced from canonical by
`scripts/sync-gate-lane.sh` and a manifest check refuses an edited copy.

## If you change anything that renders

`omarchy-plugin-validate` and `qmllint` are static. Neither loads the plugin, so
neither can see a QML contract error, a helper missing from the QML export
surface, or a shell string the engine rejects. If you have rig access:

```bash
scripts/rig-verify.sh    # validate + qmllint against a fingerprint of the tree
scripts/rig-render.sh    # load it into a running shell and screenshot it
```

If you do not, say so in the pull request. An unverified change that admits it
is fine; one that implies verification it did not do is not.

## House rules that will otherwise surprise you

- **No runtime dependency.** A stock Omarchy install has no node, python or ruby
  on the graphical session PATH, so a plugin that shells out to one installs
  cleanly and then silently never populates. Quickshell plus `curl` is the
  stack; `jq` is fine because Omarchy ships it.
- **Untrusted text is bounded.** Anything from a network response or another
  program renders as `Text.PlainText`, with a width constraint *and* an `elide`
  or `wrapMode`. Either alone is a no-op.
- **Secrets never reach a process argument.** `/proc/<pid>/cmdline` is
  world-readable. Use stdin.
- **No em or en dashes in shipped prose.** A gate enforces it.

## Commits

Conventional commits (`feat:`, `fix:`, `docs:`, `ci:`). The changelog is
generated from them by `scripts/gen-changelog.sh`, so a clear subject line ends
up in a released document.
