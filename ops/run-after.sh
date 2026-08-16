#!/bin/bash
#
# Runs one ingest driver after another finishes, so two never compete.
#
# Each ingest is a full parse holding the ontology in memory, and BioPortal is one API — two drivers
# at once halves neither's time and doubles the chance of being throttled. This waits on the first
# by process rather than by a guessed duration.
#
# Usage: run-after.sh <pattern-to-wait-for> <command...>

set -u
WAIT_FOR="${1:?usage: run-after.sh <pattern> <command...>}"
shift
while pgrep -f "$WAIT_FOR" >/dev/null; do sleep 60; done
echo "$(date '+%F %T') — $WAIT_FOR finished, starting: $*"
exec "$@"
