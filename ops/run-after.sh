#!/bin/bash
#
# Runs one long job after another finishes, so two never compete.
#
# Each ingest is a full parse holding an ontology in memory, and BioPortal is one API — two drivers
# at once halves neither's time and doubles the chance of being throttled. This waits for the first
# to exit rather than for a guessed duration.
#
# Waits on a process id, not on a name. Matching whole command lines is how this went wrong three
# times: the pattern is one of this script's own arguments, so `pgrep -f` matched this very script
# and it waited for itself for ever — a chain whose pattern named the command it was about to launch
# never started at all. The same trap catches any shell whose command line happens to contain the
# pattern, including the one an operator types to check on it. A pid cannot match the wrong thing.
#
# Usage:
#   run-after.sh <pid> <command...>
#
# Typical use, chaining a second driver behind a first:
#   nohup bash ops/backfill-releases.sh plan-a.tsv logs/a > logs/a.out 2>&1 &
#   nohup bash ops/run-after.sh $! bash ops/backfill-releases.sh plan-b.tsv logs/b > logs/b.out 2>&1 &
#
# The pid must be a process this user can signal, which is what `kill -0` tests. A pid the kernel
# has already reused would be waited on wrongly, which needs the original to have exited and several
# tens of thousands of processes to have started since — not a risk on the timescale of an ingest,
# and the alternative is the name matching this exists to avoid.

set -u

WAIT_FOR="${1:?usage: run-after.sh <pid> <command...>}"
shift

case "$WAIT_FOR" in
  ''|*[!0-9]*)
    echo "run-after.sh: first argument must be a process id, not '$WAIT_FOR'" >&2
    echo "  (it used to take a pattern; that matched this script's own command line)" >&2
    exit 2
    ;;
esac

if ! kill -0 "$WAIT_FOR" 2>/dev/null; then
  echo "$(date '+%F %T') — pid $WAIT_FOR is not running; starting straight away: $*"
else
  echo "$(date '+%F %T') — waiting for pid $WAIT_FOR before: $*"
  while kill -0 "$WAIT_FOR" 2>/dev/null; do
    sleep 30
  done
  echo "$(date '+%F %T') — pid $WAIT_FOR finished, starting: $*"
fi

exec "$@"
