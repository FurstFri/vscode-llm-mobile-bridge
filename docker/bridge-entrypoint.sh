#!/bin/sh
set -eu

# The host Codex directory is mounted read-only. Copy it into ephemeral tmpfs
# because Codex may update auxiliary state even for app-server read requests.
if [ -d /provider-state/codex ]; then
  mkdir -p "${CODEX_HOME}"
  cp -R /provider-state/codex/. "${CODEX_HOME}/"
fi

exec node dist/gateway-daemon.js "$@"
