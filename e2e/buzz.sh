#!/usr/bin/env bash
# Acceptance lane: validate, lint, load the real service against a bounded
# synthetic X API, prove the queue/digest/spend state, open the panel, and
# capture the live QML result. No real X credential or network request enters
# this lane.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
"$ROOT/scripts/rig-verify.sh" "$ROOT"
"$ROOT/scripts/rig-render.sh" "$ROOT" "$ROOT/preview.png"
test -s "$ROOT/preview.png"
jq -e '
  .dimensions == "1280 x 720" and
  .sourceDirty == false and
  .sourcePackageSha256 == .remotePackageSha256 and
  .visualInspection.status == "pending" and
  (.rawShellLogSha256 | test("^[a-f0-9]{64}$"))
' "$ROOT/.render-proof.json" >/dev/null
