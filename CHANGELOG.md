# Changelog

Notable changes to X Files.

Entries are derived from this repository's commit history, so every line
corresponds to a real change. The format follows Keep a Changelog and the
project uses Semantic Versioning.

Regenerate with `scripts/gen-changelog.sh`.

## [Unreleased]

Nothing yet.

## [1.0.0] - 2026-08-22

### Security

- Address four-reviewer panel + claim audit (4 BLOCK correctness, security, taste)
- Bound every Text so the panel cannot clip its own content
- Bound the account line, stop shadowing Item.state, and record a rig receipt

### Added

- X Files v1.0.0 - reads the replies to your own X posts
- Make the spend meter customizable, default to a calm compact bar
- Colour the reply queue and quotes by the lane they were classified into

### Fixed

- Mouse click on a queue row assigned to the now-readonly selIdx
- Remove the node runtime dependency, poll from QML instead
- Correct the stale test count and the deleted-CLI references
- Honour the local endpoints the README advertises, and stop discarding valid responses

### Internal

Tooling and repository changes with no effect on the shipped plugin.

- Vendor the submission gate lane, CI and a pre-push hook
- Vendor c38 and widen the rig fingerprint to cover shipped .js
- Pin the vendored lane to a manifest and refuse to run it unverified
- Re-sync the vendored lane and add an advisory freshness check
- Vendor c40, the panel design gate, and repair the sync that dropped it
- Vendor rig-render, which loads the plugin into a real shell
- Add four-lane MiniMax review and backfill the changelog

