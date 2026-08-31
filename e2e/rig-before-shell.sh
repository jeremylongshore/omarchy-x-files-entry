#!/bin/sh
# Configure only the isolated render HOME. The credential is deliberately
# synthetic and proves the same private-file load path used in production.
set -eu

state_dir="${HOME:?}/.local/state/omarchy/x-files"
install -d -m 700 "$state_dir"
cat > "$state_dir/credentials.json" <<'JSON'
{"bearerToken":"fixture-bearer-token-XRIG","userId":"44196397","username":"testfounder"}
JSON
chmod 600 "$state_dir/credentials.json"
