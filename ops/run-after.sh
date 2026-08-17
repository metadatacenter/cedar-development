#!/bin/bash
#
# Runs one ingest driver after another finishes, so two never compete.
#
# Each ingest is a full parse holding the ontology in memory, and BioPortal is one API — two drivers
# at once halves neither's time and doubles the chance of being throttled. This waits on the first
# by process rather than by a guessed duration.
#
# The pattern is matched against whole command lines, so pick one that names the driver being
# waited for and nothing else. Any process whose arguments happen to contain it counts as still
# running — including a shell that launched this one with the pattern on its own command line.
#
# Usage: run-after.sh <pattern-to-wait-for> <command...>

set -u
WAIT_FOR="${1:?usage: run-after.sh <pattern> <command...>}"
shift
# Excluding this process: the pattern is one of our own arguments, so a plain `pgrep -f` matches
# this very script and waits for itself for ever.
while pgrep -f "$WAIT_FOR" | grep -qvx "$$"; do sleep 60; done
echo "$(date '+%F %T') — $WAIT_FOR finished, starting: $*"
exec "$@"
