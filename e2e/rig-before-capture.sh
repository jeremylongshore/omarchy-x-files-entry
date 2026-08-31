#!/bin/sh
# Refuse a screenshot until the real service has completed every promised
# read path and persisted a three-item queue, digest, summary, and spend meter.
set -eu

log_file="${XDG_RUNTIME_DIR:?}/x-files-fixture.log"
state_dir="${HOME:?}/.local/state/omarchy/x-files"
state_file="$state_dir/state.json"
internal_file="$state_dir/internal.json"

attempt=0
while [ "$attempt" -lt 20 ]; do
  if [ -s "$log_file" ] && [ -s "$state_file" ] && jq -e '
    .configured == true and
    .stopped == false and
    .spendMeter == "Full" and
    .account.username == "testfounder" and
    .account.last4 == "XRIG" and
    .lastError == "" and
    .ledger.posts == 10 and
    .ledger.dollars == 0.05 and
    (.queue | length) == 3 and
    ([.queue[].bucket] | sort) == ["feature_ask", "gripe", "question"] and
    (.posts | length) == 1 and
    .posts[0].totalReplies == 7 and
    (.posts[0].summary | contains("Wayland crash"))
  ' "$state_file" >/dev/null 2>&1; then
    break
  fi
  attempt=$((attempt + 1))
  sleep 1
done

test "$attempt" -lt 20
test "$(stat -c '%a' "$state_dir/credentials.json")" = 600
for expected in own mentions conversation summary; do
  grep -Fx "$expected" "$log_file" >/dev/null
done

# The service may retain reply text, but never either credential.
if grep -F 'fixture-bearer-token-XRIG' "$state_file" "$internal_file" >/dev/null 2>&1; then
  echo "x-files fixture: bearer token escaped credentials.json" >&2
  exit 1
fi
if grep -F 'fixture-ai-key-never-sent-off-rig' "$state_file" "$internal_file" >/dev/null 2>&1; then
  echo "x-files fixture: AI key escaped shell settings" >&2
  exit 1
fi
